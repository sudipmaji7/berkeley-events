/**
 * Berkeley Events scraper
 * ------------------------
 * Pulls events from the official UC Berkeley events calendar
 * (events.berkeley.edu, which runs on LiveWhale and aggregates
 * all campus calendars) via its JSON API, then writes a clean,
 * normalized site/events.json for the website to read.
 *
 * Runs on Node 18+ (uses built-in fetch). No npm packages needed.
 */

const fs = require("fs");
const path = require("path");

const BASE = "https://events.berkeley.edu";
const OUTPUT = path.join(__dirname, "site", "events.json");
const DAYS_AHEAD = 60; // how far into the future to fetch
const PAGE_SIZE = 100;
const MAX_PAGES = 30; // safety cap (30 x 100 = 3000 events max)

/** Format a Date as YYYY-MM-DD in the America/Los_Angeles timezone. */
function campusDateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Fetch a URL and return parsed JSON, or null on any failure. */
async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "berkeley-events-dashboard (personal project)",
      },
    });
    if (!res.ok) {
      console.warn(`  -> HTTP ${res.status} for ${url}`);
      return null;
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      console.warn(`  -> Response was not JSON for ${url}`);
      return null;
    }
  } catch (err) {
    console.warn(`  -> Network error for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Extract the array of event objects from a LiveWhale API response,
 * which differs between API v1 and v2:
 *   v1: a plain top-level array
 *   v2: { meta: {...}, data: [...] }  or  { meta, data: { results: [...] } }
 */
function extractEvents(json) {
  if (!json) return null;
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (json.data && Array.isArray(json.data.results)) return json.data.results;
  if (Array.isArray(json.results)) return json.results;
  return null;
}

/** Strip HTML tags and collapse whitespace. */
function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Make a URL absolute against events.berkeley.edu. */
function absoluteUrl(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return BASE + (u.startsWith("/") ? u : "/" + u);
}

/**
 * Convert LiveWhale's date fields into an ISO 8601 UTC string.
 * Handles: numeric epoch seconds, epoch milliseconds, and date strings.
 */
function toIsoUtc(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    let n = Number(value);
    if (n < 1e12) n *= 1000; // seconds -> milliseconds
    const d = new Date(n);
    return isNaN(d) ? null : d.toISOString();
  }
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString();
}

/** Normalize one raw LiveWhale event into the shape the website uses. */
function normalizeEvent(raw) {
  const title = stripHtml(raw.title || raw.event_title || "");
  if (!title) return null;

  const startsUtc =
    toIsoUtc(raw.date_utc) ||
    toIsoUtc(raw.date_ts) ||
    toIsoUtc(raw.date_time) ||
    toIsoUtc(raw.date);
  if (!startsUtc) return null;

  const endsUtc =
    toIsoUtc(raw.date2_utc) || toIsoUtc(raw.date2_ts) || toIsoUtc(raw.date2);

  // Best link for "view & RSVP": explicit registration link if present,
  // otherwise the event's own page (which carries the RSVP/register button).
  const eventPage =
    absoluteUrl(raw.url) ||
    absoluteUrl(raw.href) ||
    absoluteUrl(raw.permalink) ||
    null;
  let registration = null;
  if (raw.registration_url) registration = absoluteUrl(raw.registration_url);
  if (!registration && raw.custom_fields) {
    for (const [key, val] of Object.entries(raw.custom_fields)) {
      if (/regist|rsvp|ticket/i.test(key) && typeof val === "string" && /^https?:/i.test(val)) {
        registration = val;
        break;
      }
    }
  }

  const categories = []
    .concat(raw.event_types || [], raw.categories || [], raw.tags || [])
    .map((c) => (typeof c === "string" ? c : c && (c.title || c.name)))
    .filter(Boolean)
    .map(stripHtml);

  return {
    id: raw.id || null,
    title,
    starts_utc: startsUtc,
    ends_utc: endsUtc,
    all_day: Boolean(raw.is_all_day || raw.all_day),
    location: stripHtml(raw.location || raw.location_title || ""),
    calendar: stripHtml(
      (raw.group && (raw.group.title || raw.group.name || raw.group)) ||
        raw.group_title ||
        ""
    ),
    url: eventPage,
    registration_url: registration,
    summary: stripHtml(raw.summary || raw.description || "").slice(0, 400),
    categories: [...new Set(categories)].slice(0, 6),
    has_registration: Boolean(raw.has_registration || registration),
  };
}

async function main() {
  const now = new Date();
  const startDate = campusDateString(now);
  const endDate = campusDateString(
    new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000)
  );
  console.log(`Fetching Berkeley events ${startDate} -> ${endDate}`);

  // Candidate URL builders, tried in order until one works.
  // LiveWhale passes parameters as /key/value/ path segments.
  const builders = [
    (page) =>
      `${BASE}/live/json/v2/events/start_date/${startDate}/end_date/${endDate}/paginate/${PAGE_SIZE}/page/${page}`,
    (page) =>
      `${BASE}/live/json/events/start_date/${startDate}/end_date/${endDate}/paginate/${PAGE_SIZE}/page/${page}`,
    (page) => (page === 1 ? `${BASE}/live/json/events` : null), // last resort: default feed, single page
  ];

  let allRaw = [];
  let usedBuilder = null;

  for (const build of builders) {
    const firstUrl = build(1);
    if (!firstUrl) continue;
    console.log(`Trying: ${firstUrl}`);
    const events = extractEvents(await fetchJson(firstUrl));
    if (events && events.length) {
      console.log(`  -> OK, ${events.length} events on page 1`);
      allRaw = events;
      usedBuilder = build;
      break;
    }
  }

  if (!usedBuilder) {
    console.error(
      "ERROR: Could not fetch events from any known endpoint. " +
        "The calendar API may have changed - check the URLs above in a browser."
    );
    process.exit(1);
  }

  // Fetch remaining pages until a short/empty page.
  for (let page = 2; page <= MAX_PAGES; page++) {
    const url = usedBuilder(page);
    if (!url) break;
    const events = extractEvents(await fetchJson(url));
    if (!events || events.length === 0) break;
    console.log(`  -> page ${page}: ${events.length} events`);
    allRaw = allRaw.concat(events);
    if (events.length < PAGE_SIZE) break;
  }

  // Normalize + de-duplicate (same id, or same title+start).
  const seen = new Set();
  const events = [];
  for (const raw of allRaw) {
    const ev = normalizeEvent(raw);
    if (!ev) continue;
    const key = ev.id ? `id:${ev.id}:${ev.starts_utc}` : `t:${ev.title}:${ev.starts_utc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(ev);
  }
  events.sort((a, b) => a.starts_utc.localeCompare(b.starts_utc));

  const output = {
    generated_at_utc: new Date().toISOString(),
    source: "events.berkeley.edu (official campuswide calendar, LiveWhale JSON API)",
    range: { start: startDate, end: endDate },
    count: events.length,
    events,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 1));
  console.log(`Wrote ${events.length} events to ${OUTPUT}`);
}

main();
