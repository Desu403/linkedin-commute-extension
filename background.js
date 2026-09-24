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

async function handleTrackJobsBatch({ jobs }) {
  if (!jobs?.length) return {};
  const { jobTracker = {} } = await browserAPI.storage.local.get("jobTracker");
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;

  for (const item of jobs) {
    const { jobKey, title, company, location, status } = item;
    if (!jobKey) continue;
    const existing = jobTracker[jobKey] || { title, company, location };

    existing.title    = title    || existing.title;
    existing.company  = company  || existing.company;
    existing.location = location || existing.location;

    if (status === "Applied" && !existing.appliedDate) {
      existing.appliedDate = today;
      changed = true;
    } else if (status === "Viewed" && !existing.viewedDate) {
      existing.viewedDate = today;
      changed = true;
    } else if (status === "Saved" && !existing.savedDate) {
      existing.savedDate = today;
      changed = true;
    }

    jobTracker[jobKey] = existing;
  }

  const keys = Object.keys(jobTracker);
  if (keys.length > 2000) {
    const sorted = keys.sort((a, b) => {
      const dA = jobTracker[a].appliedDate || jobTracker[a].viewedDate || jobTracker[a].savedDate || "0";
      const dB = jobTracker[b].appliedDate || jobTracker[b].viewedDate || jobTracker[b].savedDate || "0";
      return dA.localeCompare(dB);
    });
    for (let i = 0; i < sorted.length - 1500; i++) delete jobTracker[sorted[i]];
    changed = true;
  }

  await browserAPI.storage.local.set({ jobTracker });
  return jobTracker;
}

async function handleTrackJobStatus({ jobKey, title, company, location, status }) {
  if (!jobKey) return null;
  const tracker = await handleTrackJobsBatch({ jobs: [{ jobKey, title, company, location, status }] });
  return tracker[jobKey] || null;
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

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {

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
