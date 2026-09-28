const browserAPI = typeof browser !== "undefined" ? browser : chrome;

function $(id) { return document.getElementById(id); }
function setStatus(el, msg, type) {
  el.textContent = msg;
  el.className = "status-text" + (type ? " " + type : "");
}
function flashSaved(el) {
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2000);
}

// ─── Mode Tabs ────────────────────────────────────────────────────────────────

const tabCsv   = $("tabCsv"),   tabApi   = $("tabApi");
const panelCsv = $("panelCsv"), panelApi = $("panelApi");

async function setMode(mode) {
  const csv = mode === "csv";
  tabCsv.classList.toggle("active", csv);
  tabApi.classList.toggle("active", !csv);
  panelCsv.classList.toggle("active", csv);
  panelApi.classList.toggle("active", !csv);
  await browserAPI.storage.local.set({ activeMode: mode });
}
tabCsv.addEventListener("click", () => setMode("csv"));
tabApi.addEventListener("click", () => setMode("api"));

// ─── Main Tabs (Jobs / Commute setup) ─────────────────────────────────────────

function setMainTab(tab) {
  const jobs = tab !== "setup";
  $("tabJobs").classList.toggle("active", jobs);
  $("tabSetup").classList.toggle("active", !jobs);
  $("panelJobs").classList.toggle("active", jobs);
  $("panelSetup").classList.toggle("active", !jobs);
  browserAPI.storage.local.set({ popupTab: jobs ? "jobs" : "setup" });
}
$("tabJobs").addEventListener("click", () => setMainTab("jobs"));
$("tabSetup").addEventListener("click", () => setMainTab("setup"));

// ─── Display preferences (read live by the content script) ────────────────────

const DEFAULT_PREFS = { fadeApplied: true, hideApplied: false, markNew: true, maxCommute: 0, titleFilter: "" };

async function loadPrefs() {
  const { displayPrefs = {} } = await browserAPI.storage.local.get("displayPrefs");
  const p = { ...DEFAULT_PREFS, ...displayPrefs };
  $("prefFadeApplied").checked = p.fadeApplied;
  $("prefHideApplied").checked = p.hideApplied;
  $("prefMarkNew").checked     = p.markNew;
  $("prefMaxCommute").value    = p.maxCommute || "";
  $("prefTitleFilter").value   = p.titleFilter || "";
}

async function savePrefs() {
  const max = parseInt($("prefMaxCommute").value, 10);
  await browserAPI.storage.local.set({ displayPrefs: {
    fadeApplied: $("prefFadeApplied").checked,
    hideApplied: $("prefHideApplied").checked,
    markNew:     $("prefMarkNew").checked,
    maxCommute:  max > 0 ? max : 0,
    titleFilter: $("prefTitleFilter").value.trim(),
  }});
}
for (const id of ["prefFadeApplied", "prefHideApplied", "prefMarkNew"]) $(id).addEventListener("change", savePrefs);
$("prefMaxCommute").addEventListener("change", savePrefs);
$("prefTitleFilter").addEventListener("change", async () => { await savePrefs(); flashSaved($("titleFilterSaved")); });

// ─── Company rules (hide / note), shared with the content script ──────────────

// Must match companyKey() in content_script.js
function companyKey(name) {
  return (name || "").toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+(bv|nv|inc|ltd|llc|gmbh|ag|sa|srl|plc|co)$/, "")
    .replace(/\s+/g, " ").trim();
}

async function updateCompany(name, patch) {
  const { companyRules = {} } = await browserAPI.storage.local.get("companyRules");
  const key = companyKey(name);
  const rule = { ...(companyRules[key] || {}), name, ...patch };
  if (!rule.hidden && !rule.note) delete companyRules[key];
  else companyRules[key] = rule;
  await browserAPI.storage.local.set({ companyRules });
  renderCompanies();
}

async function renderCompanies() {
  const { companyRules = {} } = await browserAPI.storage.local.get("companyRules");
  const list = $("companyList");
  list.replaceChildren();
  const rules = Object.values(companyRules).sort((a, b) => a.name.localeCompare(b.name));
  for (const r of rules) {
    const row = document.createElement("div");
    row.className = "company-row";
    const main = document.createElement("span");
    main.className = "cr-main";
    const name = document.createElement("span"); name.className = "cr-name"; name.textContent = r.name;
    const note = document.createElement("span");
    note.className = "cr-note" + (r.note ? "" : " empty");
    note.textContent = r.note ? "📝 " + r.note : "+ add note";
    note.title = "Click to edit the note";
    note.addEventListener("click", () => {
      const v = prompt(`Note on ${r.name}:`, r.note || "");
      if (v !== null) updateCompany(r.name, { note: v.trim() });
    });
    main.append(name, note);
    const hide = document.createElement("button");
    hide.className = "chip-btn" + (r.hidden ? " on" : "");
    hide.textContent = r.hidden ? "Hidden" : "Shown";
    hide.title = r.hidden ? "Click to show this company's jobs again" : "Click to hide this company's jobs";
    hide.addEventListener("click", () => updateCompany(r.name, { hidden: !r.hidden }));
    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "×"; del.title = "Remove";
    del.addEventListener("click", () => updateCompany(r.name, { hidden: false, note: "" }));
    row.append(main, hide, del);
    list.append(row);
  }
}

$("hideCompanyBtn").addEventListener("click", async () => {
  const name = $("companyInput").value.trim();
  if (!name) return;
  await updateCompany(name, { hidden: true });
  $("companyInput").value = "";
});
$("companyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("hideCompanyBtn").click(); });

// ─── CSV Panel ────────────────────────────────────────────────────────────────

const homeCityEl     = $("homeCity");
const saveHomeCityBtn = $("saveHomeCity");
const homeCityStatus  = $("homeCityStatus");
const csvStatus       = $("status");
const uploadZone      = $("uploadZone");
const csvFileEl       = $("csvFile");

async function checkCustomData() {
  const { customDb, homeCity } = await browserAPI.storage.local.get(["customDb","homeCity"]);
  homeCityEl.value = homeCity || "Rotterdam";
  if (customDb) {
    setStatus(csvStatus, `Custom data loaded: ${Object.keys(customDb).length} locations.`, "success");
  } else {
    setStatus(csvStatus, "Using default database.", "");
  }
}

saveHomeCityBtn.addEventListener("click", async () => {
  const city = homeCityEl.value.trim();
  if (!city) { setStatus(homeCityStatus, "Enter a city name.", "error"); return; }
  await browserAPI.storage.local.set({ homeCity: city });
  setStatus(homeCityStatus, "Home city saved!", "success");
  setTimeout(checkCustomData, 2000);
});

$("clearData").addEventListener("click", async () => {
  await browserAPI.storage.local.remove(["customDb"]);
  csvFileEl.value = "";
  setStatus(csvStatus, "Data cleared.", "");
  checkCustomData();
});

uploadZone.addEventListener("dragover", e => { e.preventDefault(); uploadZone.classList.add("dragover"); });
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("dragover"));
uploadZone.addEventListener("drop", e => {
  e.preventDefault(); uploadZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file?.name.endsWith(".csv")) handleCSVFile(file);
  else setStatus(csvStatus, "Please drop a .csv file.", "error");
});
csvFileEl.addEventListener("change", e => { if (e.target.files[0]) handleCSVFile(e.target.files[0]); });

function handleCSVFile(file) {
  setStatus(csvStatus, "Parsing CSV…", "");
  const reader = new FileReader();
  reader.onload = async evt => {
    try {
      const lines   = evt.target.result.split("\n");
      const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ''));
      const destIdx = headers.indexOf("Destination");
      const timeIdx = headers.indexOf("Travel_Time");
      const modeIdx = headers.findIndex(h => /^(mode|transport|transport_mode|profile)$/i.test(h));
      if (destIdx === -1 || timeIdx === -1)
        throw new Error("CSV must have 'Destination' and 'Travel_Time' columns.");

      const db = {}; let autoOrigin = null; let detectedMode = null;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim(); if (!line) continue;
        const vals = []; let cur = "", inQ = false;
        for (const c of line) {
          if (c === '"') inQ = !inQ;
          else if (c === "," && !inQ) { vals.push(cur); cur = ""; }
          else cur += c;
        }
        vals.push(cur);
        const oi = headers.indexOf("Origin");
        if (oi !== -1 && vals[oi] && !autoOrigin) {
          autoOrigin = vals[oi].toLowerCase().replace(/netherlands/g,"").replace(/on-site/g,"")
            .trim().split(",")[0].trim().replace(/\s+/g,"-");
        }
        if (modeIdx !== -1 && vals[modeIdx] && !detectedMode) {
          const m = vals[modeIdx].toLowerCase();
          if (m.includes("car") || m.includes("driving") || m.includes("🚗")) detectedMode = "car";
          else if (m.includes("cycl") || m.includes("bike") || m.includes("bicycl") || m.includes("🚴")) detectedMode = "cycling";
          else if (m.includes("walk") || m.includes("foot") || m.includes("🚶")) detectedMode = "walking";
          else if (m.includes("transit") || m.includes("train") || m.includes("bus") || m.includes("🚆")) detectedMode = "transit";
        }
        if (vals.length > Math.max(destIdx, timeIdx)) {
          let dest = vals[destIdx], time = vals[timeIdx];
          if (time && time !== "N/A" && time !== "No Results" && time.trim()) {
            dest = dest.toLowerCase().replace(/netherlands/g,"").replace(/on-site/g,"")
              .trim().split(",")[0].trim().replace(/\s+/g,"-");
            if (dest) db[dest] = time;
          }
        }
      }
      if (!Object.keys(db).length) throw new Error("No valid data found.");
      const toSet = { customDb: db };
      if (autoOrigin) { toSet.homeCity = autoOrigin; homeCityEl.value = autoOrigin; }
      if (detectedMode) {
        toSet.transportProfile = detectedMode;
        transportBtns.forEach(b => b.classList.toggle("active", b.dataset.profile === detectedMode));
      }
      await browserAPI.storage.local.set(toSet);
      setStatus(csvStatus, `Loaded ${Object.keys(db).length} locations${detectedMode ? ` (${detectedMode})` : ""}.`, "success");
    } catch (err) { setStatus(csvStatus, err.message, "error"); }
  };
  reader.readAsText(file);
}

// ─── API Panel ────────────────────────────────────────────────────────────────

const orsKeyEl       = $("orsKey");
const homeAddressEl  = $("homeAddress");
const apiKeyLabel    = $("apiKeyLabel");
const apiKeyTooltip  = $("apiKeyTooltip");
const apiKeySaved    = $("apiKeySaved");
const homeSaved      = $("homeSaved");
const transitBtn     = document.querySelector("[data-profile='transit']");
const transitNote    = $("transitNote");
const transportBtns  = document.querySelectorAll(".transport-btn[data-profile]");
const providerBtns   = document.querySelectorAll(".provider-btn[data-provider]");
const countrySelect  = $("countrySelect");
const fetchBtn       = $("fetchBtn");
const stopFetchBtn   = $("stopFetchBtn");
const logWrap        = $("logWrap");
const logBox         = $("logBox");
const logSummary     = $("logSummary");
const exportBtn      = $("exportApiCsv");
const clearApiBtn    = $("clearApiData");

let citiesData   = null;
let pollTimer    = null;
let lastLogLen   = 0;

// ── Provider ─────────────────────────────────────────────────────────────────

const PROVIDER_META = {
  ors: {
    label: "ORS API Key",
    tooltipHTML: "<strong>OpenRouteService (Free)</strong><br>Sign up at openrouteservice.org — 2000 directions/day, 3000 geocoding/day. No credit card.",
    placeholder: "Paste your ORS API key",
    transit: false,
  },
  google: {
    label: "Google Maps API Key",
    tooltipHTML: "<strong>Google Maps (Paid)</strong><br>Get a key at console.cloud.google.com. Enable Directions API + Geocoding API. ~$5 per 1000 requests. Supports transit.",
    placeholder: "Paste your Google Maps API key",
    transit: true,
  },
};

function applyProvider(provider) {
  const meta = PROVIDER_META[provider] || PROVIDER_META.ors;
  providerBtns.forEach(b => b.classList.toggle("active", b.dataset.provider === provider));
  apiKeyLabel.textContent = meta.label;
  apiKeyTooltip.innerHTML = meta.tooltipHTML;
  orsKeyEl.placeholder    = meta.placeholder;

  if (meta.transit) {
    transitBtn.classList.remove("unavailable");
    transitNote.style.display = "none";
  } else {
    transitBtn.classList.add("unavailable");
    if (transitBtn.classList.contains("active")) {
      transitBtn.classList.remove("active");
      document.querySelector("[data-profile='car']").classList.add("active");
      browserAPI.storage.local.set({ transportProfile: "car" });
    }
    transitNote.style.display = "";
  }
}

providerBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    applyProvider(btn.dataset.provider);
    await browserAPI.storage.local.set({ apiProvider: btn.dataset.provider });
  });
});

// ── Auto-save on blur ─────────────────────────────────────────────────────────

orsKeyEl.addEventListener("blur", async () => {
  const key = orsKeyEl.value.trim();
  if (key) { await browserAPI.storage.local.set({ orsApiKey: key }); flashSaved(apiKeySaved); }
});

homeAddressEl.addEventListener("blur", async () => {
  const addr = homeAddressEl.value.trim();
  if (addr) { await browserAPI.storage.local.set({ homeAddress: addr }); flashSaved(homeSaved); }
});

// ── Transport ─────────────────────────────────────────────────────────────────

transportBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    if (btn.classList.contains("unavailable")) return;
    transportBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    await browserAPI.storage.local.set({ transportProfile: btn.dataset.profile });
  });
});

// ── Country → city list ───────────────────────────────────────────────────────

async function loadCitiesData() {
  if (citiesData) return citiesData;
  const res = await fetch(browserAPI.runtime.getURL("cities_by_country.json"));
  citiesData = await res.json();
  return citiesData;
}

async function populateCountries() {
  const data   = await loadCitiesData();
  const sorted = Object.entries(data.names).sort((a,b) => a[1].localeCompare(b[1]));
  for (const [code, label] of sorted) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${label} (${data.cities[code]?.length || 0} cities)`;
    countrySelect.appendChild(opt);
  }
}

countrySelect.addEventListener("change", async () => {
  await browserAPI.storage.local.set({ selectedCountry: countrySelect.value });
});

// ── Log helpers ───────────────────────────────────────────────────────────────

function appendLog(lines) {
  for (const line of lines) {
    const div = document.createElement("div");
    if (line.includes("saved") || line.includes("Home located") || line.includes("Exported")) div.className = "log-ok";
    else if (line.includes("Error") || line.toLowerCase().includes("fail") || line.includes("Could not") || line.includes("Please")) div.className = "log-err";
    else if (line.includes("Starting") || line.includes("Geocoding")) div.className = "log-info";
    div.textContent = line;
    logBox.appendChild(div);
  }
  logBox.scrollTop = logBox.scrollHeight;
}

// ── Fetch & Apply ─────────────────────────────────────────────────────────────

fetchBtn.addEventListener("click", async () => {
  // Read current values directly from inputs (and save them)
  const apiKey = orsKeyEl.value.trim();
  const homeAddress = homeAddressEl.value.trim();
  const { transportProfile = "car", apiProvider = "ors" } =
    await browserAPI.storage.local.get(["transportProfile", "apiProvider"]);

  if (!apiKey)      { appendLog(["Please paste your API key first."]); logWrap.classList.add("visible"); return; }
  if (!homeAddress) { appendLog(["Please enter your home address first."]); logWrap.classList.add("visible"); return; }
  if (!countrySelect.value) { appendLog(["Please select a country."]); logWrap.classList.add("visible"); return; }

  // Save inputs before fetching
  await browserAPI.storage.local.set({ orsApiKey: apiKey, homeAddress });
  flashSaved(apiKeySaved); flashSaved(homeSaved);

  const data  = await loadCitiesData();
  const cities = data.cities[countrySelect.value] || [];
  if (!cities.length) { appendLog(["No cities found for selected country."]); return; }

  // Reset log
  logBox.innerHTML = "";
  logWrap.classList.add("visible");
  exportBtn.style.display = "none";
  logSummary.textContent  = "";
  lastLogLen = 0;
  fetchBtn.disabled = true;
  stopFetchBtn.style.display = "";

  await browserAPI.runtime.sendMessage({
    type: "START_API_FETCH",
    cities, homeAddress, apiKey,
    profile: transportProfile,
    provider: apiProvider,
  });

  startPolling();
});

stopFetchBtn.addEventListener("click", async () => {
  await browserAPI.runtime.sendMessage({ type: "STOP_API_FETCH" });
  stopPolling();
  fetchBtn.disabled = false;
  stopFetchBtn.style.display = "none";
  appendLog(["Stopped by user."]);
  logSummary.textContent = "Stopped.";
});

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    let resp;
    try { resp = await browserAPI.runtime.sendMessage({ type: "GET_FETCH_PROGRESS" }); }
    catch { return; }
    if (!resp) return;

    // Append new log lines
    if (resp.log && resp.log.length > lastLogLen) {
      appendLog(resp.log.slice(lastLogLen));
      lastLogLen = resp.log.length;
    }

    // Update summary
    if (resp.total > 0) {
      logSummary.textContent = `${resp.done} / ${resp.total} cities`;
    }

    if (!resp.running) {
      stopPolling();
      fetchBtn.disabled = false;
      stopFetchBtn.style.display = "none";
      if (resp.error) {
        appendLog([`Error: ${resp.error}`]);
        logSummary.textContent = "Failed.";
      } else {
        logSummary.textContent = `${resp.saved} cities saved`;
        exportBtn.style.display = "";
        checkCustomData(); // refresh CSV tab count too
      }
    }
  }, 800);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Export CSV ────────────────────────────────────────────────────────────────

exportBtn.addEventListener("click", async () => {
  const { customDb = {}, homeAddress = "Home", transportProfile = "car" } =
    await browserAPI.storage.local.get(["customDb","homeAddress","transportProfile"]);
  const entries = Object.entries(customDb);
  if (!entries.length) { appendLog(["No data to export."]); return; }
  const origin = homeAddress.split(/[,\n]/)[0].trim() || "Home";
  const rows   = ["Origin,Destination,Travel_Time,Mode"];
  for (const [dest, time] of entries) {
    rows.push(`${origin},${dest.replace(/-/g," ").replace(/\b\w/g, c=>c.toUpperCase())},${time},${transportProfile}`);
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: "commute_times.csv" });
  a.click(); URL.revokeObjectURL(url);
  appendLog([`Exported ${entries.length} cities to commute_times.csv`]);
});

clearApiBtn.addEventListener("click", async () => {
  if (!confirm("Clear all fetched commute data?")) return;
  await browserAPI.storage.local.remove(["customDb"]);
  appendLog(["Data cleared."]);
  logWrap.classList.add("visible");
  exportBtn.style.display = "none";
  checkCustomData();
});

// ─── Application Tracker ─────────────────────────────────────────────────────

const FOLLOW_UP_DAYS = 14;

function daysSince(day) {
  const [y, m, d] = day.split("-").map(Number);
  const then = new Date(y, m - 1, d), now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((now - then) / 86400000);
}

// Jobs the tracker only ever saw scroll past aren't "tracked" in any useful sense.
const hasActivity = e => e.appliedDate || e.viewedDate || e.savedDate;

async function updateTrackerStatus() {
  const { jobTracker = {} } = await browserAPI.storage.local.get("jobTracker");
  const entries = Object.values(jobTracker);
  const applied = entries.filter(e => e.appliedDate);
  $("statApplied").textContent = applied.length;
  $("statWeek").textContent    = applied.filter(e => daysSince(e.appliedDate) < 7).length;
  $("statViewed").textContent  = entries.filter(e => e.viewedDate && !e.appliedDate).length;

  const due = applied
    .map(e => ({ ...e, age: daysSince(e.appliedDate) }))
    .filter(e => e.age >= FOLLOW_UP_DAYS)
    .sort((a, b) => a.age - b.age);
  $("followupCount").textContent = due.length ? `· ${due.length}` : "";
  const list = $("followupList");
  list.replaceChildren();
  if (!due.length) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = `Applications from ${FOLLOW_UP_DAYS}+ days ago show up here.`;
    list.append(p);
    return;
  }
  for (const e of due.slice(0, 6)) {
    const a = document.createElement(e.jobId ? "a" : "div");
    a.className = "job-item";
    if (e.jobId) { a.href = `https://www.linkedin.com/jobs/view/${e.jobId}/`; a.target = "_blank"; }
    const main = document.createElement("span");
    main.className = "ji-main";
    const t = document.createElement("span"); t.className = "ji-title"; t.textContent = e.title || "(untitled)";
    const s = document.createElement("span"); s.className = "ji-sub";   s.textContent = e.company || "";
    main.append(t, s);
    const age = document.createElement("span"); age.className = "ji-age"; age.textContent = `${e.age}d ago`;
    a.append(main, age);
    list.append(a);
  }
  if (due.length > 6) {
    const more = document.createElement("p");
    more.className = "empty-note";
    more.textContent = `+${due.length - 6} more in the CSV export`;
    list.append(more);
  }
}

$("exportTracker").addEventListener("click", async () => {
  const { jobTracker = {} } = await browserAPI.storage.local.get("jobTracker");
  const entries = Object.values(jobTracker).filter(hasActivity);
  if (!entries.length) return;
  const esc  = s => `"${(s||"").replace(/"/g,'""')}"`;
  const link = e => e.jobId ? `https://www.linkedin.com/jobs/view/${e.jobId}/` : "";
  const rows = ["Title,Company,Applied Date,Viewed Date,Saved Date,All View Dates,Link",
    ...entries.map(e => [esc(e.title),esc(e.company),e.appliedDate||"",e.viewedDate||"",e.savedDate||"",
      esc((e.views||[]).join(" ")),link(e)].join(","))];
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: "linkedin_applications.csv" });
  a.click(); URL.revokeObjectURL(url);
});

$("clearTracker").addEventListener("click", async () => {
  if (!confirm("Clear all tracked application dates? This cannot be undone.")) return;
  await browserAPI.storage.local.remove("jobTracker");
  updateTrackerStatus();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await browserAPI.storage.local.get([
    "activeMode","orsApiKey","homeAddress","transportProfile",
    "selectedCountry","homeCity","apiProvider",
  ]);

  await setMode(stored.activeMode || "csv");

  // CSV tab
  homeCityEl.value = stored.homeCity || "Rotterdam";
  checkCustomData();

  // API tab — provider first
  applyProvider(stored.apiProvider || "ors");
  if (stored.orsApiKey)    orsKeyEl.value      = stored.orsApiKey;
  if (stored.homeAddress)  homeAddressEl.value = stored.homeAddress;

  // Migrate old ORS profile names
  const MIGRATE = {"driving-car":"car","cycling-regular":"cycling","foot-walking":"walking"};
  const rawProfile = stored.transportProfile || "car";
  const profile    = MIGRATE[rawProfile] || rawProfile;
  if (MIGRATE[rawProfile]) await browserAPI.storage.local.set({ transportProfile: profile });
  transportBtns.forEach(b => b.classList.toggle("active", b.dataset.profile === profile));

  await populateCountries();
  if (stored.selectedCountry) countrySelect.value = stored.selectedCountry;

  // Resume polling if fetch is already running, or show completed log
  try {
    const prog = await browserAPI.runtime.sendMessage({ type: "GET_FETCH_PROGRESS" });
    if (prog?.running) {
      logWrap.classList.add("visible");
      fetchBtn.disabled = true;
      stopFetchBtn.style.display = "";
      if (prog.log?.length) { appendLog(prog.log); lastLogLen = prog.log.length; }
      logSummary.textContent = `${prog.done} / ${prog.total} cities`;
      startPolling();
    } else if (prog?.log?.length) {
      logWrap.classList.add("visible");
      appendLog(prog.log);
      lastLogLen = prog.log.length;
      if (prog.done) logSummary.textContent = `${prog.done} / ${prog.total} cities`;
      if (prog.saved > 0) exportBtn.style.display = "";
    }
  } catch { /* service worker dormant */ }

  updateTrackerStatus();
}

// The Jobs tab doesn't depend on the commute setup loading, so it starts on its
// own: a failure in init() can't leave the toggles unloaded (and then saved blank).
async function initJobsTab() {
  const { popupTab } = await browserAPI.storage.local.get("popupTab");
  setMainTab(popupTab || "jobs");
  await loadPrefs();
  await renderCompanies();
  await updateTrackerStatus();
}

initJobsTab();
init();
