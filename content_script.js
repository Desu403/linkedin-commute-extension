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

const PROFILE_ICONS = {
  car: "🚗",
  cycling: "🚴",
  walking: "🚶",
  transit: "🚆",
};

let currentTransportIcon = "🚆";

async function updateCurrentTransportIcon() {
  try {
    const { transportProfile, customDb } = await browserAPI.storage.local.get([
      "transportProfile",
      "customDb",
    ]);
    if (transportProfile && PROFILE_ICONS[transportProfile]) {
      currentTransportIcon = PROFILE_ICONS[transportProfile];
    } else if (customDb && Object.keys(customDb).length > 0) {
      currentTransportIcon = "🚗";
    } else {
      currentTransportIcon = "🚆";
    }
  } catch (e) {
    currentTransportIcon = "🚆";
  }
}

function refreshAllBadges() {
  const badges = document.querySelectorAll(".commute-badge");
  for (const badge of badges) {
    const text = badge.textContent || "";
    const match = text.match(/\d+[hm].*$/);
    if (match) {
      badge.textContent = `${currentTransportIcon} ${match[0]}`;
    }
  }
}

if (browserAPI.storage?.onChanged) {
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.transportProfile || changes.customDb)) {
      updateCurrentTransportIcon().then(() => {
        refreshAllBadges();
      });
    }
  });
}

function injectBadge(afterEl, timeText) {
  const badge = document.createElement("span");
  badge.className = "commute-badge";
  badge.textContent = `${currentTransportIcon} ${timeText}`;
  afterEl.appendChild(badge);
}

function getJobCards() {
  const containers = new Set();
  
  // 1. Find containers using legacy classes
  document.querySelectorAll("[data-job-id], [data-occludable-job-id], li.jobs-search-results__list-item, div.job-card-container, div.base-card, div.job-card-square, div.discovery-job-card").forEach(c => containers.add(c));
  
  // 2. Find containers using SDUI heuristic (look for ANY bullet point, it's always inside a job card)
  document.querySelectorAll("p, span").forEach(el => {
    const text = el.innerText?.trim();
    if (text === "•" || text === "·") {
      const c = el.closest('div[componentkey]') || el.closest('li, .job-card-container');
      if (c && c.innerText.length > 20) containers.add(c);
    }
  });

  // 3. Detail Pane
  const detailPane = document.querySelector(".jobs-search__job-details--container, .scaffold-layout__detail, .jobs-details__main-content, .job-view-layout");
  if (detailPane) containers.add(detailPane);

  const cards = [];

  // For each container, extract candidate location elements
  for (const container of containers) {
    let locEls = [];
    
    // Try legacy specific selectors first
    const specificLoc = container.querySelector(".job-card-container__metadata-item, .job-card-square__text, .discovery-job-card__location, .base-search-card__metadata span");
    if (specificLoc) {
      locEls.push(specificLoc);
    } else {
      // SDUI Fallback: get all candidate text nodes
      const leaves = Array.from(container.querySelectorAll("p, span")).filter(el => {
        const t = el.innerText?.trim();
        return t && t.length > 0 && t.length < 60 && !el.querySelector("p, div, ul, li");
      });
      
      for (let i = 1; i < Math.min(leaves.length, 12); i++) {
        const text = leaves[i].innerText.trim();
        if (text === "•" || text === "·") continue;
        if (text === leaves[i-1].innerText.trim()) continue; // skip aria-hidden duplicates
        if (/^(Promoted|Easy Apply|Applied|Saved|Viewed|Hide job|Actively reviewing.*|Posted.*)$/i.test(text)) continue;
        if (text.includes("ago") || text.includes("alumni") || text.includes("connections") || text.includes("Top applicant") || text.includes("matching skills")) continue;
        
        locEls.push(leaves[i]);
      }
    }
    
    // Detail pane fallback
    if (locEls.length === 0 && container === detailPane) {
      const dLoc = container.querySelector(".job-details-jobs-unified-top-card__primary-description-container span, .jobs-unified-top-card__bullet, .jobs-unified-top-card__subtitle-primary-grouping span");
      if (dLoc) locEls.push(dLoc);
    }

    if (locEls.length > 0) {
      cards.push({ container, locEls });
    }
  }
  
  return cards;
}

async function processVisibleJobs() {
  await updateCurrentTransportIcon();
  const locations = new Map(); // sanitized location -> [{container, locEl}]

  const cards = getJobCards();
  
  for (const { container, locEls } of cards) {
    for (const locEl of locEls) {
      if (locEl.dataset.commuteBadge) continue; // already handled or pending
      const clean = sanitizeLocation(locEl.textContent || "");
      if (!clean) continue;
      if (!locations.has(clean)) locations.set(clean, []);
      locations.get(clean).push({ locEl, container });
      locEl.dataset.commuteBadge = "pending";
    }
  }

  if (locations.size === 0) return;

  log(`Found ${locations.size} unique locations to process.`);
  const results = await requestCommuteTimes([...locations.keys()]);
  if (!results) {
    log("Received empty results from background.");
    return;
  }

  for (const [loc, entries] of locations) {
    const time = results[loc];
    if (!time) {
      // Clear pending state if no time found
      for (const { locEl } of entries) delete locEl.dataset.commuteBadge;
      continue;
    }
    for (const { locEl } of entries) {
      if (locEl.dataset.commuteBadge === "1") continue; // already injected
      injectBadge(locEl, time);
      locEl.dataset.commuteBadge = "1";
    }
  }
}

// ── Multilingual Status Detection ──────────────────────────────────
const STATUS_KEYWORDS = {
  Applied: [
    "applied", "gesolliciteerd", "beworben", "candidature envoyée", "postulé", "solicitud enviada", "solicitado"
  ],
  Viewed: [
    "viewed", "bekeken", "angesehen", "consulté", "visto"
  ],
  Saved: [
    "saved", "opgeslagen", "gespeichert", "enregistré", "guardado"
  ],
};

function detectJobStatus(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const kw of STATUS_KEYWORDS.Applied) {
    if (lower.includes(kw)) return "Applied";
  }
  for (const kw of STATUS_KEYWORDS.Viewed) {
    if (lower.includes(kw)) return "Viewed";
  }
  for (const kw of STATUS_KEYWORDS.Saved) {
    if (lower.includes(kw)) return "Saved";
  }
  return null;
}

function updateJobColors() {
  const cards = getJobCards();
  cards.forEach(({ container }) => {
    const text = container.innerText || "";
    const status = detectJobStatus(text);
    
    let color = "5, 118, 66"; // Green for not applied/seen
    if (status === "Applied") {
      color = "217, 48, 37"; // Red for applied
    } else if (status === "Saved" || status === "Viewed") {
      color = "251, 188, 4"; // Yellow for saved/viewed
    }
    container.style.setProperty("border-left", `4px solid rgba(${color}, 0.6)`, "important");
    container.style.setProperty("background", `linear-gradient(90deg, rgba(${color}, 0.15) 0%, rgba(${color}, 0.05) 60%, transparent 100%)`, "important");
  });
}

// ── Application Date Tracker ────────────────────────────────────────

function extractCardInfo(container) {
  const text = container.innerText || "";
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  
  // Title is usually the first meaningful line
  let title = "";
  let company = "";
  const SKIP_RE = /^(Promoted|Easy Apply|Applied|Saved|Viewed|Hide|Dismiss|More options|Gepromoot|Eenvoudig solliciteren|Gesolliciteerd|Bekeken|Opgeslagen|Beworben|Angesehen|Gespeichert|Anzeige|Gesponsert|Einfach bewerben|Sponsorisé|Postulé|Candidature simplifiée|Candidature envoyée|Consulté|Enregistré|Promocionado|Solicitud sencilla|Solicitado|Visto|Guardado)$/i;
  for (const line of lines) {
    // Strip any injected badge text so it doesn't corrupt the key
    const clean = line.replace(/[🚆🚗🚴🚶🚌]\s*\d+[hm]\s*\d*[m]?/gu, "").replace(/Applied \d+ \w+/g, "").replace(/Viewed \d+ \w+/g, "").replace(/\s*[·]\s*/g, " ").trim();
    if (!clean) continue;
    if (!title && clean.length > 2 && clean.length < 120 && !SKIP_RE.test(clean)) {
      title = clean;
      continue;
    }
    if (title && !company && clean.length > 1 && clean.length < 80
        && clean !== title && !SKIP_RE.test(clean)
        && !/^[•·]$/.test(clean)) {
      company = clean;
      break;
    }
  }
  
  const status = detectJobStatus(text);
  
  // Build a stable key from title + company
  const jobKey = (title + "|||" + company).toLowerCase().replace(/\s+/g, " ");
  
  return { title, company, status, jobKey };
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${day} ${months[d.getMonth()]}`;
}

async function trackAndDisplayDates() {
  // Find ALL job card containers independently (not limited to cards with location elements)
  const containers = new Set();
  
  // Legacy selectors
  document.querySelectorAll("[data-job-id], [data-occludable-job-id], li.jobs-search-results__list-item, div.job-card-container, div.base-card, div.job-card-square, div.discovery-job-card").forEach(c => containers.add(c));
  
  // SDUI containers
  document.querySelectorAll('div[componentkey]').forEach(c => {
    if (c.innerText && c.innerText.length > 20 && c.innerText.length < 2000) containers.add(c);
  });
  
  // Also grab any <li> that contains status text
  document.querySelectorAll("li").forEach(li => {
    const t = li.innerText || "";
    if (t.length > 20 && t.length < 2000 && detectJobStatus(t)) {
      containers.add(li);
    }
  });

  // 1. Batch save all new statuses in a single atomic request (no race conditions)
  const jobsToTrack = [];
  for (const container of containers) {
    const { title, company, status, jobKey } = extractCardInfo(container);
    if (!title || !company || !status) continue;
    
    // If we've already tracked THIS EXACT status on this DOM node, skip it
    if (container.dataset.trackedStatus === status) continue;
    
    jobsToTrack.push({ jobKey, title, company, status });
    container.dataset.trackedStatus = status;
  }
  
  if (jobsToTrack.length > 0) {
    try {
      await browserAPI.runtime.sendMessage({
        type: "TRACK_JOBS_BATCH",
        jobs: jobsToTrack
      });
    } catch (e) {
      // background service worker unavailable
    }
  }
  
  // 2. Fetch the full tracker and inject date badges
  let tracker;
  try {
    tracker = await browserAPI.runtime.sendMessage({ type: "GET_JOB_TRACKER" });
  } catch { return; }
  if (!tracker || Object.keys(tracker).length === 0) return;
  
  for (const container of containers) {
    const { jobKey, status } = extractCardInfo(container);
    if (!jobKey || !status) continue;
    
    const entry = tracker[jobKey];
    if (!entry) continue;
    if (!entry.appliedDate && !entry.viewedDate) continue;
    
    const parts = [];
    if (entry.appliedDate) parts.push("Applied " + formatDate(entry.appliedDate));
    if (entry.viewedDate) parts.push("Viewed " + formatDate(entry.viewedDate));
    const badgeText = parts.join(" / ");
    
    // Skip if we already injected this exact badge text
    if (container.dataset.badgeText === badgeText) continue;
    
    // Remove old badge if it exists
    const oldBadge = container.querySelector(".tracker-date-badge");
    if (oldBadge) oldBadge.remove();
    
    // Find the status text element to inject next to
    let statusEl = null;
    const candidates = container.querySelectorAll("p, span, div");
    for (const el of candidates) {
      const t = (el.innerText || "").trim();
      if (detectJobStatus(t) && !el.querySelector("p, span, div")) {
        statusEl = el;
        break;
      }
    }
    
    // Fallback: inject after the company name area (second text element)
    if (!statusEl) {
      const textEls = Array.from(container.querySelectorAll("p, span")).filter(el => {
        const t = (el.innerText || "").trim();
        return t.length > 2 && t.length < 100 && !el.querySelector("p, span, div");
      });
      if (textEls.length >= 2) statusEl = textEls[1];
      else if (textEls.length >= 1) statusEl = textEls[0];
    }
    
    if (!statusEl) continue;
    
    const dateBadge = document.createElement("span");
    dateBadge.className = "tracker-date-badge";
    dateBadge.textContent = badgeText;
    
    statusEl.insertAdjacentElement("afterend", dateBadge);
    container.dataset.badgeText = badgeText;
  }
}

const scheduleProcess = debounceWithMaxWait(async () => {
  try {
    await processVisibleJobs();
    updateJobColors();
    await trackAndDisplayDates();
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

const targetNode = document.querySelector(".scaffold-layout__main") ||
                   document.querySelector("main") ||
                   document.body;

new MutationObserver(onDomMutation).observe(targetNode, { childList: true, subtree: true });

scheduleProcess();
