/**
 * Berkeley Day Board scraper — v2 (multi-source)
 * -----------------------------------------------
 * Sources:
 *   1. UC Berkeley official calendar (events.berkeley.edu, LiveWhale JSON API)
 *   2. Ticketmaster Discovery API  (concerts/sports/shows within RADIUS_MILES
 *      of campus; needs a free API key provided as the TICKETMASTER_API_KEY
 *      environment variable — set it as a GitHub Actions secret, never in code)
 *   3. Any iCal (.ics) feeds listed in ICAL_FEEDS below
 *   4. Manual events from extra-events.json (optional, repo root)
 *
 * Every source is optional: if one fails or isn't configured, the others
 * still run and the script only fails if NO source produced any events.
 *
 * Runs on Node 18+ (built-in fetch). No npm packages needed.
 */

const fs = require("fs");
const path = require("path");

/* ============================== SETTINGS ============================== */

const OUTPUT = path.join(__dirname, "site", "events.json");
const DAYS_AHEAD = 60;
const CAMPUS_TZ = "America/Los_Angeles";

// Campus coordinates (UC Berkeley) + search radius for Ticketmaster
const CAMPUS_LAT = 37.8719;
const CAMPUS_LNG = -122.2585;
const RADIUS_MILES = 10;

// Berkeley LiveWhale settings
const UCB_BASE = "https://events.berkeley.edu";
const UCB_PAGE_SIZE = 100;
const UCB_MAX_PAGES = 30;

// iCal feeds: add as many as you like. "calendar" is the label shown on the
// site (and in the filter dropdown); "url" is the feed's .ics address.
// Find these on calendar websites as "Subscribe", "iCal", or "Add to calendar"
// links — copy the link address, not the page URL.
const ICAL_FEEDS = [
  // { calendar: "Berkeley Public Library", url: "https://example.org/calendar.ics" },
  // { calendar: "City of Berkeley",        url: "https://example.org/city.ics" },
];

/* ======================= SHARED SMALL HELPERS ======================== */

function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  fmt.formatToParts(date).forEach((x) => (p[x.type] = x.value));
  if (p.hour === "24") p.hour = "00"; // some engines report midnight as 24
  return p;
}

function campusDateString(date) {
  const p = tzParts(date, CAMPUS_TZ);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Convert a "wall clock" time in a named timezone into a real UTC Date.
 * e.g. (2026, 8, 20, 18, 0, 0, "America/Los_Angeles") -> the UTC moment
 * when clocks in California show 6:00 PM on Aug 20. Uses a standard
 * guess-and-correct trick so daylight saving is handled automatically.
 */
function wallTimeToUtc(y, mo, d, hh, mi, ss, tz) {
  const target = Date.UTC(y, mo - 1, d, hh, mi, ss);
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(new Date(ts), tz);
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    ts += target - shown;
  }
  return new Date(ts);
}

async function fetchText(url, headers) {
  try {
    const res = await fetch(url, {
      headers: Object.assign(
        { "User-Agent": "berkeley-day-board (personal project)" },
        headers || {}
      ),
    });
    if (!res.ok) {
      console.warn(`  -> HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`  -> Network error for ${url}: ${err.message}`);
    return null;
  }
}

async function fetchJson(url, headers) {
  const text = await fetchText(url, headers);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`  -> Response was not JSON for ${url}`);
    return null;
  }
}

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

function toIsoUtc(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    let n = Number(value);
    if (n < 1e12) n *= 1000;
    const d = new Date(n);
    return isNaN(d) ? null : d.toISOString();
  }
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString();
}

/* ============================ SOURCE 1: UCB =========================== */

async function fetchBerkeley(startDate, endDate) {
  const absoluteUrl = (u) =>
    !u ? null : /^https?:\/\//i.test(u) ? u : UCB_BASE + (u.startsWith("/") ? u : "/" + u);

  const extract = (json) => {
    if (!json) return null;
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.data)) return json.data;
    if (json.data && Array.isArray(json.data.results)) return json.data.results;
    if (Array.isArray(json.results)) return json.results;
    return null;
  };

  const builders = [
    (page) =>
      `${UCB_BASE}/live/json/v2/events/start_date/${startDate}/end_date/${endDate}/paginate/${UCB_PAGE_SIZE}/page/${page}`,
    (page) =>
      `${UCB_BASE}/live/json/events/start_date/${startDate}/end_date/${endDate}/paginate/${UCB_PAGE_SIZE}/page/${page}`,
    (page) => (page === 1 ? `${UCB_BASE}/live/json/events` : null),
  ];

  let raw = [];
  let used = null;
  for (const build of builders) {
    const url = build(1);
    if (!url) continue;
    console.log(`  Trying: ${url}`);
    const events = extract(await fetchJson(url, { Accept: "application/json" }));
    if (events && events.length) {
      raw = events;
      used = build;
      break;
    }
  }
  if (!used) return [];

  for (let page = 2; page <= UCB_MAX_PAGES; page++) {
    const url = used(page);
    if (!url) break;
    const events = extract(await fetchJson(url, { Accept: "application/json" }));
    if (!events || events.length === 0) break;
    raw = raw.concat(events);
    if (events.length < UCB_PAGE_SIZE) break;
  }

  return raw
    .map((r) => {
      const title = stripHtml(r.title || r.event_title || "");
      const startsUtc =
        toIsoUtc(r.date_utc) || toIsoUtc(r.date_ts) || toIsoUtc(r.date_time) || toIsoUtc(r.date);
      if (!title || !startsUtc) return null;

      let registration = r.registration_url ? absoluteUrl(r.registration_url) : null;
      if (!registration && r.custom_fields) {
        for (const [key, val] of Object.entries(r.custom_fields)) {
          if (/regist|rsvp|ticket/i.test(key) && typeof val === "string" && /^https?:/i.test(val)) {
            registration = val;
            break;
          }
        }
      }

      const categories = []
        .concat(r.event_types || [], r.categories || [], r.tags || [])
        .map((c) => (typeof c === "string" ? c : c && (c.title || c.name)))
        .filter(Boolean)
        .map(stripHtml);

      return {
        id: r.id ? "ucb-" + r.id : null,
        title,
        starts_utc: startsUtc,
        ends_utc: toIsoUtc(r.date2_utc) || toIsoUtc(r.date2_ts) || toIsoUtc(r.date2),
        all_day: Boolean(r.is_all_day || r.all_day),
        location: stripHtml(r.location || r.location_title || ""),
        calendar: stripHtml(
          (r.group && (r.group.title || r.group.name || r.group)) || r.group_title || "UC Berkeley"
        ),
        url: absoluteUrl(r.url) || absoluteUrl(r.href) || null,
        registration_url: registration,
        summary: stripHtml(r.summary || r.description || "").slice(0, 400),
        categories: [...new Set(categories)].slice(0, 6),
        has_registration: Boolean(r.has_registration || registration),
      };
    })
    .filter(Boolean);
}

/* ======================= SOURCE 2: TICKETMASTER ======================= */

async function fetchTicketmaster(startDate, endDate) {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) {
    console.log("  Skipped: no TICKETMASTER_API_KEY secret is set.");
    return [];
  }

  const out = [];
  let page = 0;
  let totalPages = 1;
  const SIZE = 100;

  while (page < totalPages && page * SIZE < 1000) {
    const url =
      "https://app.ticketmaster.com/discovery/v2/events.json" +
      `?apikey=${key}` +
      `&latlong=${CAMPUS_LAT},${CAMPUS_LNG}` +
      `&radius=${RADIUS_MILES}&unit=miles` +
      `&startDateTime=${startDate}T00:00:00Z` +
      `&endDateTime=${endDate}T23:59:59Z` +
      `&sort=date,asc&size=${SIZE}&page=${page}`;

    const json = await fetchJson(url);
    if (!json) break;
    totalPages = (json.page && json.page.totalPages) || 1;
    const events = (json._embedded && json._embedded.events) || [];
    console.log(`  page ${page + 1}/${totalPages}: ${events.length} events`);
    if (!events.length) break;

    for (const e of events) {
      const startsUtc =
        toIsoUtc(e.dates && e.dates.start && e.dates.start.dateTime) ||
        (e.dates && e.dates.start && e.dates.start.localDate
          ? wallTimeToUtc(
              ...e.dates.start.localDate.split("-").map(Number),
              ...(e.dates.start.localTime || "12:00:00").split(":").map(Number),
              CAMPUS_TZ
            ).toISOString()
          : null);
      if (!e.name || !startsUtc) continue;

      const venue = e._embedded && e._embedded.venues && e._embedded.venues[0];
      const cls = (e.classifications && e.classifications[0]) || {};
      const categories = [cls.segment, cls.genre]
        .map((c) => c && c.name)
        .filter((n) => n && n !== "Undefined");

      out.push({
        id: "tm-" + e.id,
        title: stripHtml(e.name),
        starts_utc: startsUtc,
        ends_utc: null,
        all_day: Boolean(e.dates && e.dates.start && e.dates.start.dateTBA),
        location: venue
          ? stripHtml([venue.name, venue.city && venue.city.name].filter(Boolean).join(", "))
          : "",
        calendar: "Ticketmaster",
        url: e.url || null,
        registration_url: e.url || null, // ticket page = the "RSVP"
        summary: stripHtml(e.info || e.pleaseNote || "").slice(0, 400),
        categories,
        has_registration: true,
      });
    }
    page++;
  }
  return out;
}

/* ========================= SOURCE 3: iCAL FEEDS ======================= */

/** Parse the two common iCal date forms into an ISO UTC string. */
function icsDateToIso(value, tzid) {
  if (!value) return null;
  let m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const [, y, mo, d, hh, mi, ss, z] = m;
    if (z === "Z") return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss)).toISOString();
    return wallTimeToUtc(+y, +mo, +d, +hh, +mi, +ss, tzid || CAMPUS_TZ).toISOString();
  }
  m = value.match(/^(\d{4})(\d{2})(\d{2})$/); // date-only = all-day
  if (m) {
    const [, y, mo, d] = m;
    return wallTimeToUtc(+y, +mo, +d, 0, 0, 0, tzid || CAMPUS_TZ).toISOString();
  }
  return null;
}

/** Minimal .ics parser: enough for standard VEVENT blocks. */
function parseIcs(text, calendarLabel) {
  const unfolded = text.replace(/\r?\n[ \t]/g, ""); // joined continuation lines
  const events = [];
  const blocks = unfolded.split("BEGIN:VEVENT").slice(1);

  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const fields = {};
    for (const line of body.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const left = line.slice(0, idx); // e.g. "DTSTART;TZID=America/Los_Angeles"
      const value = line.slice(idx + 1);
      const [name, ...params] = left.split(";");
      const tzParam = params.find((p) => p.startsWith("TZID="));
      fields[name] = { value, tzid: tzParam ? tzParam.slice(5) : null, params };
    }

    const title = stripHtml((fields.SUMMARY && fields.SUMMARY.value) || "");
    const dtstart = fields.DTSTART;
    if (!title || !dtstart) continue;
    const startsUtc = icsDateToIso(dtstart.value, dtstart.tzid);
    if (!startsUtc) continue;
    const allDay = dtstart.params.some((p) => p === "VALUE=DATE") || /^\d{8}$/.test(dtstart.value);

    events.push({
      id: fields.UID ? "ics-" + fields.UID.value : null,
      title,
      starts_utc: startsUtc,
      ends_utc: fields.DTEND ? icsDateToIso(fields.DTEND.value, fields.DTEND.tzid) : null,
      all_day: allDay,
      location: stripHtml((fields.LOCATION && fields.LOCATION.value) || "").replace(/\\,/g, ","),
      calendar: calendarLabel,
      url: (fields.URL && fields.URL.value) || null,
      registration_url: null,
      summary: stripHtml((fields.DESCRIPTION && fields.DESCRIPTION.value) || "")
        .replace(/\\n/g, " ")
        .replace(/\\,/g, ",")
        .slice(0, 400),
      categories: [],
      has_registration: false,
    });
  }
  return events;
}

async function fetchIcalFeeds() {
  const out = [];
  for (const feed of ICAL_FEEDS) {
    console.log(`  Feed: ${feed.calendar} (${feed.url})`);
    const text = await fetchText(feed.url);
    if (!text || text.indexOf("BEGIN:VCALENDAR") === -1) {
      console.warn(`  -> Not a valid iCal feed, skipped.`);
      continue;
    }
    const events = parseIcs(text, feed.calendar);
    console.log(`  -> ${events.length} events`);
    out.push(...events);
  }
  return out;
}

/* ===================== SOURCE 4: MANUAL EVENTS FILE =================== */

function loadManualEvents() {
  const EXTRA = path.join(__dirname, "extra-events.json");
  if (!fs.existsSync(EXTRA)) return [];
  try {
    const extra = JSON.parse(fs.readFileSync(EXTRA, "utf8"));
    const out = [];
    for (const m of extra.events || []) {
      const starts = toIsoUtc(m.starts);
      if (!m.title || !starts) continue;
      out.push({
        id: null,
        title: String(m.title),
        starts_utc: starts,
        ends_utc: toIsoUtc(m.ends) || null,
        all_day: Boolean(m.all_day),
        location: m.location || "",
        calendar: m.calendar || "Added by me",
        url: m.url || null,
        registration_url: m.rsvp || null,
        summary: m.summary || "",
        categories: m.categories || [],
        has_registration: Boolean(m.rsvp),
      });
    }
    console.log(`  -> ${out.length} manual events`);
    return out;
  } catch (e) {
    console.warn(`  Could not read extra-events.json: ${e.message}`);
    return [];
  }
}

/* ================================ MAIN ================================ */

async function main() {
  const now = new Date();
  const startDate = campusDateString(now);
  const endDate = campusDateString(new Date(now.getTime() + DAYS_AHEAD * 864e5));
  console.log(`Range: ${startDate} -> ${endDate}\n`);

  const sources = [
    ["UC Berkeley calendar", () => fetchBerkeley(startDate, endDate)],
    ["Ticketmaster", () => fetchTicketmaster(startDate, endDate)],
    ["iCal feeds", () => fetchIcalFeeds()],
    ["Manual events", () => Promise.resolve(loadManualEvents())],
  ];

  let all = [];
  for (const [name, run] of sources) {
    console.log(`Source: ${name}`);
    try {
      const events = await run();
      console.log(`  => ${events.length} events\n`);
      all = all.concat(events);
    } catch (err) {
      console.warn(`  => FAILED (${err.message}) — continuing with other sources\n`);
    }
  }

  // De-duplicate across all sources.
  const seen = new Set();
  const events = [];
  for (const ev of all) {
    const key = ev.id ? `id:${ev.id}` : `t:${ev.title.toLowerCase()}:${ev.starts_utc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(ev);
  }
  events.sort((a, b) => a.starts_utc.localeCompare(b.starts_utc));

  if (events.length === 0) {
    console.error("ERROR: every source returned zero events — keeping yesterday's data.");
    process.exit(1);
  }

  const output = {
    generated_at_utc: new Date().toISOString(),
    source:
      "events.berkeley.edu + Ticketmaster Discovery + iCal feeds + manual entries",
    range: { start: startDate, end: endDate },
    count: events.length,
    events,
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 1));
  console.log(`Wrote ${events.length} events to ${OUTPUT}`);
}

main();
