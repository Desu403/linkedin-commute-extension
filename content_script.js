// LinkedIn's markup isn't public or versioned and changes without notice, so
// the selectors below are a best effort. If badges stop appearing: right-click
// a job card (or the detail pane) -> Inspect, find the element holding the
// location text, and update the selectors in getJobCards().

const browserAPI = typeof browser !== "undefined" ? browser : chrome;

const STRIP_PATTERNS = [
  /\bhybrid\b/gi,
  /\bremote\b/gi,
  /\bon[- ]site\b/gi,
  /\bgreater\s+/gi,
  /\s+area\b/gi,
  /\([^)]*\)/g, // leftover parentheticals, e.g. "(Hybrid)"
];

function sanitizeLocation(raw) {
  let text = raw.replace(/[·|]/g, ",");
  for (const pattern of STRIP_PATTERNS) text = text.replace(pattern, " ");
  return text
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

// Trailing debounce with a max wait, so a page under constant mutation
// (LinkedIn re-renders a lot) still gets processed at least every 2s
// instead of the timer resetting forever.
function debounceWithMaxWait(fn, wait, maxWait) {
  let timer = null;
  let lastRun = 0;
  return (...args) => {
    clearTimeout(timer);
    const now = Date.now();
    if (now - lastRun >= maxWait) {
      lastRun = now;
      fn(...args);
    } else {
      timer = setTimeout(() => {
        lastRun = Date.now();
        fn(...args);
      }, wait);
    }
  };
}



function log(msg) {
  console.log("[Commute Extension] " + msg);
}

function requestCommuteTimes(locations) {
  log(`Requesting times for ${locations.length} locations...`);
  try {
    return browserAPI.runtime.sendMessage({ type: "GET_COMMUTE_TIMES", locations });
  } catch (e) {
    log("Service worker unavailable, will retry on next cycle.");
    return Promise.resolve(null);
  }
}

const MODE_INFO = {
  transit: { icon: "🚆", label: "Public transport" },
  car:     { icon: "🚗", label: "Car" },
  cycling: { icon: "🚴", label: "Bike" },
  walking: { icon: "🚶", label: "Walking" },
  home:    { icon: "🏠", label: "Home" },
};

// Saved times or the modes to show changed: drop the badges and let the next pass redraw them
function clearCommuteBadges() {
  for (const badge of document.querySelectorAll(".commute-badge")) badge.remove();
  for (const el of document.querySelectorAll("[data-commute-badge]")) delete el.dataset.commuteBadge;
}

// Display preferences, set on the popup's Jobs tab
const DEFAULT_PREFS = { fadeApplied: true, hideApplied: false, markNew: true, maxCommute: 0, maxCommuteMode: "transit", titleFilter: "" };
let prefs = { ...DEFAULT_PREFS };
let companyRules = {}; // companyKey -> { name, hidden, note }
async function loadPrefs() {
  try {
    const { displayPrefs = {}, companyRules: rules = {} } = await browserAPI.storage.local.get(["displayPrefs", "companyRules"]);
    prefs = { ...DEFAULT_PREFS, ...displayPrefs };
    companyRules = rules;
  } catch { /* keep defaults */ }
}
const prefsReady = loadPrefs();

// "Acknowledge Benelux B.V." and "Acknowledge Benelux BV" are the same company
function companyKey(name) {
  return (name || "").toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+(bv|nv|inc|ltd|llc|gmbh|ag|sa|srl|plc|co)$/, "")
    .replace(/\s+/g, " ").trim();
}

async function updateCompanyRule(name, patch) {
  const { companyRules: rules = {} } = await browserAPI.storage.local.get("companyRules");
  const key = companyKey(name);
  const rule = { ...(rules[key] || {}), name, ...patch };
  if (!rule.hidden && !rule.note) delete rules[key];
  else rules[key] = rule;
  await browserAPI.storage.local.set({ companyRules: rules });
}

// Title filter "senior, lead, german" -> regexes matching whole words
function titleFilterRegexes() {
  return (prefs.titleFilter || "").split(",").map(t => t.trim()).filter(Boolean)
    .map(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
}

if (browserAPI.storage?.onChanged) {
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const modesChanged = changes.displayPrefs &&
      JSON.stringify(changes.displayPrefs.oldValue?.showModes) !== JSON.stringify(changes.displayPrefs.newValue?.showModes);
    if (changes.commuteTimes || modesChanged) {
      clearCommuteBadges();
      scheduleProcess();
    }
    if (changes.displayPrefs || changes.companyRules) {
      if (changes.displayPrefs) prefs = { ...DEFAULT_PREFS, ...(changes.displayPrefs.newValue || {}) };
      if (changes.companyRules) companyRules = changes.companyRules.newValue || {};
      scheduleProcess(); // defined below; storage events only arrive after this script ran
    }
  });
}

// "1h 30m" / "42m" / "2h" -> minutes
function commuteMinutes(text) {
  const h = (text || "").match(/(\d+)\s*h/), m = (text || "").match(/(\d+)\s*m\b/);
  if (!h && !m) return null;
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}

const durationClass = (mins) => mins == null ? "" : mins <= 45 ? " is-short" : mins <= 90 ? " is-mid" : " is-long";

// One pill per transport mode, each colored by its own duration: "🚆 42m" "🚗 25m"
function injectBadge(afterEl, times) {
  const badge = document.createElement("span");
  // Minutes per mode, for the "commute over X min" filter
  const minutes = {};
  for (const t of times) { const m = commuteMinutes(t.time); if (m != null) minutes[t.mode] = m; }
  badge.dataset.minutes = JSON.stringify(minutes);
  badge.title = times.map(t => `${MODE_INFO[t.mode]?.label || t.mode}: ${t.time}`).join(" · ");
  const text  = t => `${MODE_INFO[t.mode]?.icon || ""} ${t.time}`;
  if (times.length === 1) {
    badge.className = "commute-badge" + durationClass(commuteMinutes(times[0].time));
    badge.textContent = text(times[0]);
  } else {
    badge.className = "commute-badge is-multi";
    for (const t of times) {
      const pill = document.createElement("span");
      pill.className = "commute-time" + durationClass(commuteMinutes(t.time));
      pill.textContent = text(t);
      badge.appendChild(pill);
    }
  }
  afterEl.appendChild(badge);
}


// The time the "fade jobs over X min" filter judges a card by: the chosen mode
// (or the fastest shown). A card without a time for that mode isn't faded.
function filterMinutes(badge) {
  if (!badge?.dataset.minutes) return null;
  const minutes = JSON.parse(badge.dataset.minutes);
  if ("home" in minutes) return 0;
  const values = Object.values(minutes);
  if (prefs.maxCommuteMode === "fastest") return values.length ? Math.min(...values) : null;
  return minutes[prefs.maxCommuteMode] ?? null;
}

// ── Job card discovery ──────────────────────────────────────────────
// Every card is tied to LinkedIn's numeric job id, so the same job is never
// treated as two cards (the nested-wrapper bug that made badges flip):
//   - search results: the outermost [componentkey="job-card-component-ref-<id>"]
//   - Jobs home / collections: the largest block around a job link that
//     contains no other job
//   - older layouts: [data-job-id] / [data-occludable-job-id]

const JOB_REF = "job-card-component-ref-";
const OUR_BADGES = ".commute-badge, .tracker-date-badge, .tracker-age-badge, .tracker-note-badge";
const DETAIL_PANE_SEL = ".jobs-search__job-details--container, .scaffold-layout__detail, .jobs-details__main-content, .job-view-layout";
const MAX_CARD_TEXT = 1500;

function jobIdFromHref(href) {
  const m = (href || "").match(/currentJobId=(\d+)|\/jobs\/view\/(\d+)/);
  return m ? m[1] || m[2] : null;
}

function jobIdsIn(el) {
  const ids = new Set();
  const add = (id) => id && ids.add(id);
  const scan = (node) => {
    const ck = node.getAttribute?.("componentkey");
    if (ck?.startsWith(JOB_REF)) add(ck.slice(JOB_REF.length));
    if (node.tagName === "A") add(jobIdFromHref(node.getAttribute("href")));
    add(node.getAttribute?.("data-job-id") || node.getAttribute?.("data-occludable-job-id"));
  };
  scan(el);
  el.querySelectorAll(`[componentkey^="${JOB_REF}"], a[href*="currentJobId="], a[href*="/jobs/view/"], [data-job-id], [data-occludable-job-id]`).forEach(scan);
  return ids;
}

function getJobCards() {
  const cards = [];
  const taken = new Set();
  const push = (id, el) => {
    if (!/^\d+$/.test(id) || taken.has(el)) return;
    for (const t of taken) if (t.contains(el)) return;
    taken.add(el);
    cards.push({ jobId: id, el });
  };

  // 1. Search results (keyed wrappers, nested twice — keep the outermost)
  for (const el of document.querySelectorAll(`[componentkey^="${JOB_REF}"]`)) {
    const key = el.getAttribute("componentkey");
    if (el.parentElement?.closest(`[componentkey="${key}"]`)) continue;
    push(key.slice(JOB_REF.length), el);
  }

  // 2. Older layouts
  for (const el of document.querySelectorAll("[data-occludable-job-id], [data-job-id]")) {
    const id = el.getAttribute("data-occludable-job-id") || el.getAttribute("data-job-id");
    if (el.parentElement?.closest(`[data-occludable-job-id="${id}"], [data-job-id="${id}"]`)) continue;
    push(id, el);
  }

  // 3. Everything else with a job link (Jobs home sections, collections).
  //    Links to the job that's open are the detail pane's own links, not cards.
  const openId = currentlyOpenJobId();
  for (const a of document.querySelectorAll('a[href*="currentJobId="], a[href*="/jobs/view/"]')) {
    if (a.closest(DETAIL_PANE_SEL)) continue;
    const id = jobIdFromHref(a.getAttribute("href"));
    if (!id || id === openId) continue;
    let card = a;
    while (card.parentElement && card.parentElement !== document.body) {
      const p = card.parentElement;
      if ((p.textContent || "").length > MAX_CARD_TEXT) break;
      if (p.querySelector("h1, h2, h3") && !card.querySelector("h1, h2, h3")) break; // section header
      const ids = jobIdsIn(p);
      if (ids.size > 1 || !ids.has(id)) break;
      card = p;
    }
    if ((card.textContent || "").length > MAX_CARD_TEXT) continue; // detail pane, not a card
    push(id, card);
  }

  return cards;
}

// Wrappers with display:contents have no box, so borders/backgrounds set on
// them never render (why "More jobs for you" stayed uncolored). Style the first
// real box inside instead.
function visualBox(el) {
  while (el.firstElementChild && getComputedStyle(el).display === "contents") el = el.firstElementChild;
  return el;
}

// ── Reading a card ──────────────────────────────────────────────────

const STATUS_WORDS = {
  Applied: ["applied", "gesolliciteerd", "beworben", "candidature envoyée", "postulé", "solicitud enviada", "solicitado"],
  Viewed:  ["viewed", "bekeken", "angesehen", "consulté", "visto"],
  Saved:   ["saved", "opgeslagen", "gespeichert", "enregistré", "guardado"],
};

// Only an element whose whole text is a status word counts — never a word
// inside a title ("Applied Scientist") or inside our own date badge.
function statusOf(text) {
  const t = text.trim().toLowerCase();
  for (const [status, words] of Object.entries(STATUS_WORDS)) if (words.includes(t)) return status;
  return null;
}

function ownText(el) {
  let text = "";
  for (const n of el.childNodes) {
    if (n.nodeType === 3) text += n.textContent;
    else if (n.nodeType === 1 && !n.matches(OUR_BADGES)) text += ownText(n);
  }
  return text.replace(/\s+/g, " ").trim();
}

// Text sitting directly in the element. Titles share their element with icon
// children (the "verified" check), so "has no child elements" misses them.
function directText(el) {
  let text = "";
  for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent;
  return text.replace(/\s+/g, " ").trim();
}

const BULLET_RE = /^[•·|]$/;
const NOT_LOCATION_RE = /^(Promoted|Easy Apply|Actively reviewing.*|Posted.*|Be an early applicant|.*\bago|.*alumni.*|.*connections?.*|.*top applicant.*|.*matching skills.*|.*applicants?)$/i;
const SALARY_RE = /\d.*(EUR|USD|GBP|€|\$|£|\/(yr|year|month|mo|hr|hour))/i;

function readCard(el) {
  const leaves = [];
  for (const node of el.querySelectorAll("p, span, strong, h3, a, div")) {
    if (node.closest(OUR_BADGES)) continue;
    const text = directText(node);
    if (!text || text.startsWith("Selected,")) continue;               // screen-reader duplicate
    if (leaves.length && leaves[leaves.length - 1].text === text) continue; // visible + hidden copy
    leaves.push({ node, text });
  }

  const clean = (t) => t.replace(/\s*\((Verified job|Geverifieerde vacature)\)\s*$/i, "").trim();
  let title = "", company = "", locationEl = null, statusEl = null, status = null, companyEl = null;
  let i = 0;
  for (; i < leaves.length; i++) {
    if (!statusOf(leaves[i].text)) { title = clean(leaves[i].text); break; }
  }
  for (i++; i < leaves.length; i++) {
    const t = clean(leaves[i].text);
    if (t && t !== title && !BULLET_RE.test(t) && !statusOf(t)) { company = t; companyEl = leaves[i].node; break; }
  }
  for (i++; i < leaves.length; i++) {
    const t = leaves[i].text;
    if (BULLET_RE.test(t)) continue;
    if (!statusOf(t) && !NOT_LOCATION_RE.test(t) && !SALARY_RE.test(t) && t.length < 80) locationEl = leaves[i].node;
    break;
  }
  for (const { node, text } of leaves) {
    const s = statusOf(text);
    if (s && (!status || s === "Applied")) { status = s; statusEl = node; }
  }
  return { title, company, companyEl, locationEl, status, statusEl };
}

function currentlyOpenJobId() {
  return jobIdFromHref(location.href);
}

// ── Commute badges ──────────────────────────────────────────────────

async function addCommuteBadges(cards) {
  const locations = new Map(); // sanitized location -> [locEl]
  const want = (locEl) => {
    if (!locEl || locEl.dataset.commuteBadge || locEl.querySelector(".commute-badge")) return;
    const clean = sanitizeLocation(ownText(locEl));
    if (!clean) return;
    if (!locations.has(clean)) locations.set(clean, []);
    locations.get(clean).push(locEl);
    locEl.dataset.commuteBadge = "pending";
  };

  for (const { info } of cards) want(info.locationEl);

  // Detail pane (older layout selectors; harmless when absent)
  const detail = document.querySelector(DETAIL_PANE_SEL);
  want(detail?.querySelector(".job-details-jobs-unified-top-card__primary-description-container span, .jobs-unified-top-card__bullet, .jobs-unified-top-card__subtitle-primary-grouping span"));

  if (locations.size === 0) return;
  log(`Found ${locations.size} unique locations to process.`);
  const results = await requestCommuteTimes([...locations.keys()]);
  if (!results) {
    for (const els of locations.values()) for (const el of els) delete el.dataset.commuteBadge;
    return;
  }
  for (const [loc, els] of locations) {
    for (const el of els) {
      if (results[loc] && !el.querySelector(".commute-badge")) {
        injectBadge(el, results[loc]);
        el.dataset.commuteBadge = "1";
      } else if (!results[loc]) {
        el.dataset.commuteBadge = "none"; // unknown place; don't re-ask every cycle
      }
    }
  }
}

// ── Colors + date badges ────────────────────────────────────────────

// Thin bars only, no background tint: faint green for untouched jobs, stronger
// green for ones first seen today, amber for viewed/saved, red for applied
// (which can also fade/hide, since they're done).
const BAR = {
  applied: "rgba(217, 48, 37, 0.7)",
  seen:    "rgba(251, 188, 4, 0.75)",
  new:     "rgba(46, 160, 67, 0.85)",
  fresh:   "rgba(46, 160, 67, 0.35)",
};
const FOLLOW_UP_DAYS = 14;
const LINGER_DAYS = 14; // "keeps popping up" once a posting has been around this long

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmt(day) {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}
function localDate() {
  return new Date().toLocaleDateString("sv-SE");
}
function daysBetween(a, b) {
  const t = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86400000);
}

function normKey(title, company) {
  return (title + "|||" + company).toLowerCase().replace(/\s+/g, " ").trim();
}

// Latest application to the same title at the same company under another job id
// (LinkedIn reposts), including entries from before v1.3.0.
function buildAppliedIndex(tracker) {
  const idx = new Map();
  for (const [key, e] of Object.entries(tracker)) {
    if (!e?.appliedDate || !e.title || !e.company) continue;
    const k = normKey(e.title, e.company);
    const prev = idx.get(k);
    if (!prev || e.appliedDate > prev.date) idx.set(k, { date: e.appliedDate, key });
  }
  return idx;
}

function describe(entry, repost, isNew, today) {
  const views = entry?.views || (entry?.viewedDate ? [entry.viewedDate] : []);
  const lines = [];
  if (entry?.appliedDate) lines.push(`Applied: ${fmt(entry.appliedDate)} (${daysBetween(entry.appliedDate, today)}d ago)`);
  if (views.length) lines.push("Viewed: " + views.map(fmt).join(", "));
  if (entry?.savedDate) lines.push("Saved: " + fmt(entry.savedDate));
  if (repost) lines.push("Same title & company applied on " + fmt(repost.date) + " (earlier posting)");
  if (entry?.firstSeen) lines.push(`First seen ${fmt(entry.firstSeen)} · in your lists on ${entry.seenDays || 1} day${entry.seenDays > 1 ? "s" : ""}`);

  let text = null, kind = null;
  if (entry?.appliedDate) {
    const age = daysBetween(entry.appliedDate, today);
    text = "Applied " + fmt(entry.appliedDate) + (age >= 7 ? ` · ${age}d` : "");
    kind = age >= FOLLOW_UP_DAYS ? "followup" : "applied";
    if (kind === "followup") lines.push("No news after two weeks? Worth a follow-up.");
  }
  else if (repost)           { text = "Applied before " + fmt(repost.date); kind = "repost"; }
  else if (views.length)     { text = "Viewed " + fmt(views[views.length - 1]) + (views.length > 1 ? ` ×${views.length}` : ""); kind = "viewed"; }
  else if (entry?.savedDate) { text = "Saved " + fmt(entry.savedDate); kind = "viewed"; }
  else if (isNew)            { text = "New"; kind = "new"; }
  return { text, kind, tooltip: lines.join("\n") };
}

function lingerBadge(entry, today) {
  if (!entry?.firstSeen || (entry.seenDays || 0) < 3) return { text: null };
  const days = daysBetween(entry.firstSeen, today);
  if (days < LINGER_DAYS) return { text: null };
  const text = days >= 28 ? `↻ ${Math.floor(days / 7)} wks` : `↻ ${days}d`;
  return { text, kind: "linger",
    tooltip: `Keeps showing up: first seen ${fmt(entry.firstSeen)}, in your lists on ${entry.seenDays} days.\nOften a hard-to-fill role or a repeatedly reposted ad.` };
}

function setStyle(el, prop, value) {
  if (value == null) el.style.removeProperty(prop);
  else el.style.setProperty(prop, value, "important");
}

function paint(card, state, faded, hidden) {
  const sig = `${state}|${faded}|${hidden}`;
  if (card.el.dataset.lcState === sig) return;
  const box = visualBox(card.el);
  setStyle(box, "border-left", BAR[state] ? `3px solid ${BAR[state]}` : null);
  setStyle(box, "background", null); // clear the old gradient from v1.2.x
  setStyle(box, "opacity", faded ? "0.45" : null);
  setStyle(box, "transition", faded ? "opacity .15s" : null);
  setStyle(card.el, "display", hidden ? "none" : null);
  card.el.dataset.lcState = sig;
  // Faded cards come back to full strength on hover
  if (faded && !box.dataset.lcHover) {
    box.dataset.lcHover = "1";
    box.addEventListener("mouseenter", () => { if (box.style.opacity) box.style.setProperty("opacity", "1", "important"); });
    box.addEventListener("mouseleave", () => { if (box.style.opacity) box.style.setProperty("opacity", "0.45", "important"); });
  }
}

// One badge of a given class per card, updated in place so our own edits don't
// keep retriggering the MutationObserver.
function placeBadge(card, cls, badge, anchor) {
  const existing = card.el.querySelectorAll("." + cls);
  if (!badge.text || !anchor) { existing.forEach(b => b.remove()); return null; }
  let node = existing[0];
  existing.forEach((b, i) => i > 0 && b.remove());
  if (!node) {
    node = document.createElement("span");
    anchor.insertAdjacentElement("afterend", node);
  }
  if (node.textContent !== badge.text) node.textContent = badge.text;
  if (node.title !== (badge.tooltip || "")) node.title = badge.tooltip || "";
  const className = `${cls} is-${badge.kind}`;
  if (node.className !== className) node.className = className;
  return node;
}

// Breakage alarm: job-list vocabulary on screen but zero cards found means
// LinkedIn changed its markup. Checked only after the page had time to load.
const LOAD_GRACE_MS = 8000;
let lastHealth = null;
function looksLikeJobList() {
  let hits = 0;
  for (const el of document.querySelectorAll("main p, main span, main li")) {
    const t = directText(el);
    if ((t === "Easy Apply" || t === "Promoted" || statusOf(t)) && ++hits >= 3) return true;
  }
  return false;
}
function reportHealth(cardCount) {
  if (performance.now() < LOAD_GRACE_MS) return;
  const ok = cardCount > 0 || !looksLikeJobList();
  if (ok === lastHealth) return;
  lastHealth = ok;
  if (!ok) log("Job list on screen but no cards detected; LinkedIn markup probably changed.");
  browserAPI.runtime.sendMessage({ type: "PAGE_HEALTH", ok }).catch(() => {});
}

const reported = new Set(); // what this page session already sent to the tracker

async function processPage() {
  await prefsReady;
  const today = localDate();
  const cards = getJobCards().map(c => ({ ...c, info: readCard(c.el) }));
  const openId = currentlyOpenJobId();
  reportHealth(cards.length);

  const batch = [];
  for (const { jobId, info } of cards) {
    const viewedNow = jobId === openId;
    const sig = `${jobId}|${info.status}|${viewedNow}|${today}`;
    if (reported.has(sig)) continue;
    reported.add(sig);
    batch.push({ jobId, title: info.title, company: info.company, status: info.status, viewedNow, seen: true });
  }
  if (openId && !cards.some(c => c.jobId === openId) && !reported.has(`open|${openId}|${today}`)) {
    reported.add(`open|${openId}|${today}`);
    batch.push({ jobId: openId, viewedNow: true });
  }

  let tracker;
  try {
    tracker = await browserAPI.runtime.sendMessage(
      batch.length ? { type: "TRACK_JOBS_BATCH", jobs: batch } : { type: "GET_JOB_TRACKER" }
    );
  } catch { tracker = null; }
  tracker = tracker || {};
  const appliedIdx = buildAppliedIndex(tracker);
  // "New" only means something once there's history from earlier days
  const hasHistory = Object.values(tracker).some(e => e.firstSeen && e.firstSeen < today);

  await addCommuteBadges(cards);
  const filters = titleFilterRegexes();

  for (const card of cards) {
    const entry = tracker["id:" + card.jobId];
    const k = card.info.title && card.info.company ? normKey(card.info.title, card.info.company) : null;
    const hit = k && appliedIdx.get(k);
    const repost = hit && hit.key !== "id:" + card.jobId && !entry?.appliedDate ? hit : null;

    const applied = card.info.status === "Applied" || !!entry?.appliedDate;
    const seen = !!card.info.status || !!entry?.viewedDate || !!entry?.savedDate || !!repost;
    const isNew = prefs.markNew && hasHistory && !seen && entry?.firstSeen === today;

    const commuteEl = card.el.querySelector(".commute-badge");
    const mins = filterMinutes(commuteEl);
    const tooFar = prefs.maxCommute > 0 && mins != null && mins > prefs.maxCommute;

    const rule = companyRules[companyKey(card.info.company)];
    const titleFiltered = filters.some(re => re.test(card.info.title));

    paint(card, applied ? "applied" : seen ? "seen" : isNew ? "new" : "fresh",
          (applied && prefs.fadeApplied) || tooFar || titleFiltered,
          (applied && prefs.hideApplied) || !!rule?.hidden);

    placeBadge(card, "tracker-note-badge",
               rule?.note ? { text: "📝 " + (rule.note.length > 30 ? rule.note.slice(0, 29) + "…" : rule.note), kind: "note", tooltip: `${rule.name}: ${rule.note}` } : { text: null },
               card.info.companyEl);

    const dateNode = placeBadge(card, "tracker-date-badge", describe(entry, repost, isNew, today),
                                card.info.statusEl || card.info.companyEl);
    placeBadge(card, "tracker-age-badge", applied ? { text: null } : lingerBadge(entry, today),
               dateNode || card.info.statusEl || card.info.companyEl);
  }
}

// Right-click menu (see background.js): remember which card was right-clicked,
// then act on its company when the menu item arrives.
let contextCompany = null;
document.addEventListener("contextmenu", (e) => {
  const card = getJobCards().find(c => c.el.contains(e.target));
  contextCompany = card ? readCard(card.el).company || null : null;
}, true);

browserAPI.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "CONTEXT_ACTION") return;
  const company = contextCompany;
  if (!company) { alert("Right-click on a job card to use this."); return; }
  if (msg.action === "lc-hide-company") {
    updateCompanyRule(company, { hidden: true });
  } else if (msg.action === "lc-note-company") {
    const current = companyRules[companyKey(company)]?.note || "";
    const note = prompt(`Note on ${company} (shown on all its job cards; leave empty to remove):`, current);
    if (note !== null) updateCompanyRule(company, { note: note.trim() });
  }
});

const scheduleProcess = debounceWithMaxWait(async () => {
  try {
    await processPage();
  } catch (e) {
    // Extension context invalidated (e.g. after update) -- silently ignore
    if (e.message?.includes("Extension context invalidated")) return;
    console.warn("[Commute Extension]", e.message);
  }
}, 400, 1500);

// Detect SPA URL changes
let currentHref = location.href;
function checkNavigation() {
  if (location.href !== currentHref) {
    currentHref = location.href;
    scheduleProcess();
  }
}
window.addEventListener("popstate", checkNavigation);

function onDomMutation(mutations) {
  checkNavigation();
  let hasRelevant = false;
  for (const m of mutations) {
    if (m.type === "childList" && m.addedNodes.length > 0) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          const tag = node.tagName;
          if (tag !== "SCRIPT" && tag !== "STYLE" && tag !== "LINK") {
            hasRelevant = true;
            break;
          }
        }
      }
    }
    if (hasRelevant) break;
  }
  if (hasRelevant) scheduleProcess();
}

// Watch the whole body: LinkedIn replaces <main> on SPA navigation and streams
// lazy sections (e.g. "More jobs for you" on /jobs/) in later, so an observer
// on the element that existed at load time goes deaf.
new MutationObserver(onDomMutation).observe(document.body, { childList: true, subtree: true });

// Lazy sections render as you scroll; rescan then, plus a slow safety net for
// updates that arrive without a detectable mutation.
window.addEventListener("scroll", () => scheduleProcess(), { passive: true });
setInterval(() => { if (!document.hidden) scheduleProcess(); }, 4000);

scheduleProcess();
