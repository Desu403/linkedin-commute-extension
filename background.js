const browserAPI = typeof browser !== "undefined" ? browser : chrome;

// ─── Preloaded DB ────────────────────────────────────────────────────────────

let preloadedDb = null;
async function getPreloadedDb() {
  if (preloadedDb !== null) return preloadedDb;
  try {
    const res  = await fetch(browserAPI.runtime.getURL("db.json"));
    preloadedDb = await res.json();
  } catch {
    preloadedDb = {};
  }
  return preloadedDb;
}

// ─── Commute Lookup (DB / CSV) ───────────────────────────────────────────────

async function handleGetCommuteTimes({ locations }) {
  if (!locations?.length) return {};

  const preloaded = await getPreloadedDb();
  const { customDb = {}, homeCity } = await browserAPI.storage.local.get(["customDb", "homeCity"]);
  const activeDb = { ...preloaded, ...customDb };

  const aliases = {
    "the-hague":    "den-haag",
    "s-gravenhage": "den-haag",
  };

  let currentHome = (homeCity || "Rotterdam")
    .toLowerCase().replace(/netherlands/g, "").replace(/on-site/g, "").trim()
    .split(",")[0].trim().replace(/\s+/g, "-");

  aliases[currentHome] = "0m";

  const results = {};
  for (const loc of locations) {
    let clean = loc.toLowerCase().replace(/netherlands/g, "").replace(/on-site/g, "").trim();
    clean = clean.split(",")[0].trim().replace(/\s+/g, "-");

    let hit = activeDb[clean] || activeDb[loc];

    if (!hit && aliases[clean]) {
      hit = activeDb[aliases[clean]] || aliases[clean];
    }

    if (!hit) {
      for (const dbKey in activeDb) {
        const escaped = dbKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex   = new RegExp(`(?:^|[- ])${escaped}(?:[- ]|$)`, "i");
        if (regex.test(clean) || (clean.length > 4 && dbKey.includes(clean))) {
          hit = activeDb[dbKey];
          break;
        }
      }
    }

    if (hit) results[loc] = hit;
  }

  return results;
}

// ─── Application Tracker ─────────────────────────────────────────────────────

// ─── Application Tracker ─────────────────────────────────────────────────────

// Entries are keyed "id:<LinkedIn job id>". Entries from before v1.3.0 are keyed
// "title|||company" and get folded into the id entry the first time that job is seen.
// Fields: appliedDate / viewedDate (first view) / savedDate, plus views[] = every
// day the job was opened.

const MAX_VIEW_DATES = 30;

function localDate() {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time, not UTC
}

function legacyKey(title, company) {
  return ((title || "") + "|||" + (company || "")).toLowerCase().replace(/\s+/g, " ");
}

function addView(entry, day) {
  entry.views = entry.views || (entry.viewedDate ? [entry.viewedDate] : []);
  if (!entry.views.includes(day)) {
    entry.views.push(day);
    entry.views.sort();
    if (entry.views.length > MAX_VIEW_DATES) entry.views.splice(0, entry.views.length - MAX_VIEW_DATES);
  }
  entry.viewedDate = entry.viewedDate || entry.views[0];
}

// Tabs send batches concurrently; serialize read-modify-write so one can't clobber another.
let trackerQueue = Promise.resolve();
function serialized(fn) {
  const run = trackerQueue.then(fn);
  trackerQueue = run.catch(() => {});
  return run;
}

function handleTrackJobsBatch(msg) {
  return serialized(() => trackJobsBatch(msg));
}

async function trackJobsBatch({ jobs }) {
  const { jobTracker = {} } = await browserAPI.storage.local.get("jobTracker");
  if (!jobs?.length) return jobTracker;
  const today = localDate();
  let changed = false;

  for (const item of jobs) {
    const { jobId, title, company, location, status, viewedNow, seen } = item;
    if (!jobId) continue;
    const key = "id:" + jobId;
    let existing = jobTracker[key];

    if (!existing) {
      existing = { jobId, title, company, location };
      const old = title && company && jobTracker[legacyKey(title, company)];
      if (old) {
        for (const f of ["appliedDate", "viewedDate", "savedDate"]) if (old[f]) existing[f] = old[f];
        if (old.viewedDate) existing.views = [old.viewedDate];
        delete jobTracker[legacyKey(title, company)];
      }
      changed = true;
    }

    for (const [f, v] of [["title", title], ["company", company], ["location", location]]) {
      if (v && existing[f] !== v) { existing[f] = v; changed = true; }
    }

    const before = JSON.stringify(existing);
    if (status === "Applied" && !existing.appliedDate) existing.appliedDate = today;
    if (status === "Saved" && !existing.savedDate) existing.savedDate = today;
    // LinkedIn's "Viewed" label on a job we have no view for yet (viewed before the extension ran)
    if (status === "Viewed" && !existing.viewedDate) addView(existing, today);
    if (viewedNow) addView(existing, today);
    // Sighting history: how long a posting keeps showing up in your lists
    if (seen && existing.lastSeen !== today) {
      existing.firstSeen = existing.firstSeen || today;
      existing.lastSeen = today;
      existing.seenDays = (existing.seenDays || 0) + 1;
    }
    if (JSON.stringify(existing) !== before) changed = true;

    jobTracker[key] = existing;
  }

  // Seen-only jobs pile up fast (every card you scroll past), so they're pruned
  // first, oldest sighting first; jobs you viewed/saved/applied to are kept.
  const keys = Object.keys(jobTracker);
  if (keys.length > 6000) {
    const rank = (e) => (e.appliedDate || e.viewedDate || e.savedDate ? "1" : "0") +
      (e.lastSeen || e.appliedDate || e.viewedDate || e.savedDate || "0");
    const sorted = keys.sort((a, b) => rank(jobTracker[a]).localeCompare(rank(jobTracker[b])));
    for (let i = 0; i < sorted.length - 5000; i++) delete jobTracker[sorted[i]];
    changed = true;
  }

  if (changed) await browserAPI.storage.local.set({ jobTracker });
  return jobTracker;
}

async function handleTrackJobStatus({ jobId, title, company, location, status }) {
  if (!jobId) return null;
  const tracker = await handleTrackJobsBatch({ jobs: [{ jobId, title, company, location, status }] });
  return tracker["id:" + jobId] || null;
}

async function handleGetJobTracker() {
  const { jobTracker = {} } = await browserAPI.storage.local.get("jobTracker");
  return jobTracker;
}

// ─── ORS API Fetch Engine ────────────────────────────────────────────────────

const ORS_BASE            = "https://api.openrouteservice.org";
const GOOGLE_BASE         = "https://maps.googleapis.com/maps/api";
const REQUEST_INTERVAL_MS = 1800; // ~33 req/min → safely under 40/min limit

// Generic profile → provider-specific value
const PROFILE_MAP = {
  ors: {
    car:     "driving-car",
    cycling: "cycling-regular",
    walking: "foot-walking",
    transit: null, // not supported
  },
  google: {
    car:     "driving",
    cycling: "bicycling",
    walking: "walking",
    transit: "transit",
  },
};

// Fetch state (persists in session storage across service worker dormant cycles)
const sessionStore = browserAPI.storage?.session || browserAPI.storage?.local;

let fetchState = {
  running: false,
  done:    0,
  total:   0,
  saved:   0,
  error:   null,
  log:     [],
};

async function saveFetchState() {
  try {
    if (sessionStore) {
      await sessionStore.set({ fetchState });
    }
  } catch (e) {}
}

async function loadFetchState() {
  try {
    if (sessionStore) {
      const data = await sessionStore.get("fetchState");
      if (data?.fetchState) {
        fetchState = { ...fetchState, ...data.fetchState };
      }
    }
  } catch (e) {}
}

loadFetchState();

function addLog(msg) {
  const t = new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  fetchState.log.push(`[${t}] ${msg}`);
  if (fetchState.log.length > 300) fetchState.log = fetchState.log.slice(-300);
  saveFetchState();
}

function fmtDuration(seconds) {
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return totalMin + "m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function citySlug(name) {
  return name.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── ORS functions ─────────────────────────────────────────────────────────────

async function orsGeocode(apiKey, text) {
  const url = `${ORS_BASE}/geocode/search?api_key=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(text)}&size=1`;
  const res  = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`ORS geocode HTTP ${res.status}`);
  const json = await res.json();
  const feat  = json.features?.[0];
  if (!feat) throw new Error(`No ORS geocode result for: ${text}`);
  const [lon, lat] = feat.geometry.coordinates;
  return { lat, lon };
}

async function orsDirections(apiKey, orsProfile, originCoord, destCoord) {
  const url = `${ORS_BASE}/v2/directions/${orsProfile}?start=${originCoord.lon},${originCoord.lat}&end=${destCoord.lon},${destCoord.lat}`;
  const res  = await fetch(url, { headers: { Authorization: apiKey, Accept: "application/json, application/geo+json" } });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`ORS directions HTTP ${res.status}`);
  }
  const json     = await res.json();
  const duration = json.features?.[0]?.properties?.summary?.duration;
  return duration != null ? duration : null;
}

// ── Google Maps functions ─────────────────────────────────────────────────────

async function googleGeocode(apiKey, text) {
  const url = `${GOOGLE_BASE}/geocode/json?address=${encodeURIComponent(text)}&key=${encodeURIComponent(apiKey)}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Google geocode HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "OK" || !json.results?.length) throw new Error(`No Google geocode result for: ${text} (${json.status})`);
  const loc = json.results[0].geometry.location;
  return { lat: loc.lat, lon: loc.lng };
}

async function googleDirections(apiKey, googleMode, originCoord, destCoord) {
  const url = `${GOOGLE_BASE}/directions/json?origin=${originCoord.lat},${originCoord.lon}&destination=${destCoord.lat},${destCoord.lon}&mode=${googleMode}&key=${encodeURIComponent(apiKey)}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Google directions HTTP ${res.status}`);
  const json = await res.json();
  if (json.status === "ZERO_RESULTS") return null;
  if (json.status !== "OK") throw new Error(`Google directions: ${json.status}`);
  const duration = json.routes?.[0]?.legs?.[0]?.duration?.value; // seconds
  return duration != null ? duration : null;
}

// ── Unified fetch runner ──────────────────────────────────────────────────────

async function runFetch({ cities, homeAddress, apiKey, profile, provider = "ors" }) {
  fetchState = { running: true, done: 0, total: cities.length, saved: 0, error: null, log: [] };

  const profileMap    = PROFILE_MAP[provider] || PROFILE_MAP.ors;
  const mappedProfile = profileMap[profile] || profileMap.car;

  if (!mappedProfile) {
    fetchState.running = false;
    fetchState.error   = `Transport mode "${profile}" is not supported by ${provider}.`;
    return;
  }

  const geocodeFn    = provider === "google" ? googleGeocode    : orsGeocode;
  const directionsFn = provider === "google"
    ? (key, _, orig, dest) => googleDirections(key, mappedProfile, orig, dest)
    : (key, prof, orig, dest) => orsDirections(key, prof, orig, dest);

  // Load existing customDb so we merge, not wipe
  const { customDb = {} } = await browserAPI.storage.local.get("customDb");
  const db = { ...customDb };

  addLog(`Starting: ${cities.length} cities via ${provider === "google" ? "Google Maps" : "OpenRouteService"} (${mappedProfile})`);

  // Geocode home once
  let homeCoord;
  try {
    addLog(`Geocoding home: ${homeAddress}`);
    homeCoord = await geocodeFn(apiKey, homeAddress);
    addLog(`Home located: ${homeCoord.lat.toFixed(4)}, ${homeCoord.lon.toFixed(4)}`);
    await sleep(REQUEST_INTERVAL_MS);
  } catch (err) {
    addLog(`Could not geocode home: ${err.message}`);
    fetchState.running = false;
    fetchState.error   = "Could not geocode home address: " + err.message;
    return;
  }

  for (let i = 0; i < cities.length; i++) {
    if (!fetchState.running) { addLog("Stopped."); break; }

    const city = cities[i];
    fetchState.done = i;

    try {
      // Use bundled coords if available (skips one API call), else geocode
      let destCoord;
      if (city.lat != null && city.lon != null) {
        destCoord = { lat: city.lat, lon: city.lon };
      } else {
        destCoord = await geocodeFn(apiKey, city.name);
        await sleep(REQUEST_INTERVAL_MS);
      }

      const duration = await directionsFn(apiKey, mappedProfile, homeCoord, destCoord);
      await sleep(REQUEST_INTERVAL_MS);

      if (duration != null) {
        const time = fmtDuration(duration);
        db[citySlug(city.name)] = time;
        fetchState.saved++;
        addLog(`${city.name}: ${time}`);
        if (fetchState.saved % 10 === 0) {
          await browserAPI.storage.local.set({ customDb: db, transportProfile: profile });
          await saveFetchState();
        }
      } else {
        addLog(`${city.name}: no route found`);
      }
    } catch (err) {
      addLog(`${city.name}: ${err.message}`);
      console.warn(`[commute-ext] fetch failed for ${city.name}:`, err.message);
    }
  }

  await browserAPI.storage.local.set({ customDb: db, transportProfile: profile });
  fetchState.done    = cities.length;
  fetchState.running = false;
  addLog(`Finished: ${fetchState.saved} / ${cities.length} cities saved.`);
  await saveFetchState();
}


// ─── Message Router ───────────────────────────────────────────────────────────

// A "!" on the toolbar icon when a jobs page clearly lists jobs but the content
// script found no cards: LinkedIn changed its markup and the selectors need updating.
function setPageHealth(tabId, ok) {
  if (tabId == null || !browserAPI.action) return;
  browserAPI.action.setBadgeText({ tabId, text: ok ? "" : "!" });
  browserAPI.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
  browserAPI.action.setTitle({ tabId, title: ok
    ? "LinkedIn Commute Time settings"
    : "LinkedIn Commute Time can't find the job cards on this page. LinkedIn probably changed its layout; see tests/README.md." });
}

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message?.type === "PAGE_HEALTH") {
    setPageHealth(_sender?.tab?.id, message.ok);
    return false;
  }

  if (message?.type === "GET_COMMUTE_TIMES") {
    handleGetCommuteTimes(message)
      .then(sendResponse)
      .catch((err) => { console.error("[commute-ext] lookup failed:", err.message); sendResponse({}); });
    return true;
  }

  if (message?.type === "TRACK_JOBS_BATCH") {
    handleTrackJobsBatch(message)
      .then(sendResponse)
      .catch(() => sendResponse({}));
    return true;
  }

  if (message?.type === "TRACK_JOB_STATUS") {
    handleTrackJobStatus(message)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }

  if (message?.type === "GET_JOB_TRACKER") {
    handleGetJobTracker()
      .then(sendResponse)
      .catch(() => sendResponse({}));
    return true;
  }

  if (message?.type === "START_API_FETCH") {
    if (fetchState.running) { sendResponse({ ok: false, reason: "already running" }); return true; }
    runFetch(message).catch(err => {
      fetchState.running = false;
      fetchState.error   = err.message;
      saveFetchState();
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "STOP_API_FETCH") {
    fetchState.running = false;
    saveFetchState();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "GET_FETCH_PROGRESS") {
    sendResponse({ ...fetchState });
    return true;
  }
});
