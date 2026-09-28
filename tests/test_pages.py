#!/usr/bin/env python3
"""
Runs the real content_script.js + background.js against LinkedIn pages you
saved with Ctrl+S ("Webpage, Complete") into tests/fixtures/, and checks that
every job card is found and read correctly. See tests/README.md.

    python tests/test_pages.py            # all fixtures
    python tests/test_pages.py --show     # also print every card
"""
import json, pathlib, re, sys, tempfile

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Needs Playwright:  pip install playwright && python -m playwright install chromium")

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
SHOW = "--show" in sys.argv

# Minimal extension runtime: in-memory storage, messages routed to background.js,
# fake commute times so badges render without API keys.
STUB = """
(() => {
  const store = %s;
  const listeners = [];
  window.__store = store;
  window.browser = {
    storage: { local: {
      get: async (keys) => { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); return o; },
      set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
      remove: async (k) => { delete store[k]; },
    }, onChanged: { addListener() {} } },
    runtime: {
      getURL: (p) => p,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener() {} },
      sendMessage: (msg) => {
        if (msg.type === "GET_COMMUTE_TIMES") {
          const r = {}; for (const l of msg.locations) r[l] = "42m"; return Promise.resolve(r);
        }
        if (msg.type === "PAGE_HEALTH") return Promise.resolve();
        return new Promise((resolve) => { for (const fn of listeners) fn(msg, {}, resolve); });
      },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  };
})();
"""

REPORT = """
() => {
  const cards = getJobCards().map(c => ({ ...c, info: readCard(c.el) }));
  return {
    nested: cards.filter(a => cards.some(b => b !== a && b.el.contains(a.el))).length,
    duplicateIds: cards.length - new Set(cards.map(c => c.jobId)).size,
    multiDateBadges: cards.filter(c => c.el.querySelectorAll('.tracker-date-badge').length > 1).length,
    multiCommute: cards.filter(c => c.el.querySelectorAll('.commute-badge').length > 1).length,
    cards: cards.map(c => ({
      id: c.jobId, title: c.info.title, company: c.info.company,
      loc: c.info.locationEl ? ownText(c.info.locationEl) : null,
      status: c.info.status, state: c.el.dataset.lcState || null,
      badges: [...c.el.querySelectorAll('.tracker-date-badge, .tracker-age-badge')].map(b => b.textContent),
    })),
  };
}
"""


def prepare(src: pathlib.Path, out_dir: pathlib.Path, break_keys=False) -> pathlib.Path:
    """Strip LinkedIn's scripts/CSP and anything an older extension version injected."""
    html = src.read_text(encoding="utf-8", errors="ignore")
    html = re.sub(r"<meta[^>]+Content-Security-Policy[^>]*>", "", html, flags=re.I)
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", html, flags=re.S | re.I)
    html = re.sub(r'<span class="(commute-badge|tracker-date-badge|tracker-age-badge)[^"]*"[^>]*>.*?</span>', "", html, flags=re.S)
    html = re.sub(r'\s(data-commute-badge|data-tracked-status|data-badge-text|data-lc-[a-z-]+)="[^"]*"', "", html)
    html = re.sub(r'(style="[^"]*?)border-left:[^;"]*;?', r"\1", html)
    if break_keys:  # simulate LinkedIn renaming its card keys
        html = html.replace("job-card-component-ref-", "renamed-card-ref-")
    html = html.replace("<head>", f'<head><base href="{src.parent.as_uri()}/">', 1)
    out = out_dir / src.name
    out.write_text(html, encoding="utf-8")
    return out


def saved_url(src: pathlib.Path) -> str:
    m = re.search(r"saved from url=\(\d+\)(\S+)", src.read_text(encoding="utf-8", errors="ignore")[:3000])
    return m.group(1) if m else ""


def run_page(browser, path, url, seed):
    open_id = (re.search(r"currentJobId=(\d+)", url) or [None, None])[1]
    pg = browser.new_page(viewport={"width": 1400, "height": 2400}, bypass_csp=True)
    pg.route(re.compile(r"^https?://"), lambda r: r.abort())
    errors = []  # only the extension's own: LinkedIn's leftover code in saved pages throws plenty
    pg.on("console", lambda m: errors.append(m.text) if m.type in ("warning", "error") and "[Commute Extension]" in m.text else None)
    pg.goto(path.as_uri() + (f"?currentJobId={open_id}" if open_id else ""), wait_until="load")
    pg.add_script_tag(content=STUB % json.dumps(seed))
    pg.add_script_tag(content="(() => {\n" + (ROOT / "background.js").read_text() + "\n})();")
    pg.add_style_tag(path=str(ROOT / "badge.css"))
    pg.add_script_tag(content=(ROOT / "content_script.js").read_text())
    pg.wait_for_timeout(2000)
    pg.evaluate("processPage()")
    pg.wait_for_timeout(500)
    pg.evaluate("""() => { window.__muts = 0; new MutationObserver(m => window.__muts += m.length)
      .observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); }""")
    pg.evaluate("processPage()"); pg.wait_for_timeout(400)
    pg.evaluate("processPage()"); pg.wait_for_timeout(400)
    rep = pg.evaluate(REPORT)
    rep["domChangesOnRerun"] = pg.evaluate("window.__muts")
    rep["looksLikeJobList"] = pg.evaluate("looksLikeJobList()")
    rep["ourErrors"] = errors
    pg.close()
    return rep


def main():
    pages = sorted(p for p in FIXTURES.glob("*.html"))
    if not pages:
        sys.exit(f"No fixtures. Save LinkedIn job pages (Ctrl+S, 'Webpage, Complete') into {FIXTURES}")

    failures = []
    def check(cond, msg):
        if not cond: failures.append(msg)
        return cond

    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
        browser = pw.chromium.launch()
        for src in pages:
            url = saved_url(src)
            is_job_list = "/jobs/" in url
            rep = run_page(browser, prepare(src, pathlib.Path(tmp)), url, {})
            cards = rep["cards"]
            name = src.stem[:50]
            print(f"\n{name}\n  {url[:90]}\n  {len(cards)} cards")
            if not is_job_list:
                print("  (not a jobs list page, only checking for errors)")
            else:
                check(len(cards) > 0, f"{name}: no job cards found")
                check(rep["nested"] == 0, f"{name}: {rep['nested']} cards nested inside other cards")
                check(rep["duplicateIds"] == 0, f"{name}: {rep['duplicateIds']} duplicate job ids")
                check(rep["multiDateBadges"] == 0, f"{name}: cards with more than one date badge")
                check(rep["multiCommute"] == 0, f"{name}: cards with more than one commute badge")
                check(rep["domChangesOnRerun"] == 0, f"{name}: re-running changed the page {rep['domChangesOnRerun']} times (badge flip-flop)")
                missing = [c for c in cards if not c["title"] or not c["company"]]
                check(not missing, f"{name}: {len(missing)} cards without title/company, e.g. {missing[:1]}")
                no_loc = [c for c in cards if not c["loc"]]
                check(len(no_loc) <= len(cards) // 10, f"{name}: {len(no_loc)} cards without a location")
                unstyled = [c for c in cards if not c["state"]]
                check(not unstyled, f"{name}: {len(unstyled)} cards not colored")
            check(not rep["ourErrors"], f"{name}: JS errors {rep['ourErrors'][:2]}")

            if SHOW:
                for c in cards:
                    print(f"    {c['id']} {(c['status'] or ''):7} {c['title'][:40]:40} | {c['company'][:22]:22} | {(c['loc'] or '-')[:30]:30} | {' + '.join(c['badges'])}")

            # The breakage alarm must fire when LinkedIn renames its card keys
            if "/jobs/search" in url:
                broken = run_page(browser, prepare(src, pathlib.Path(tmp), break_keys=True), url, {})
                check(broken["looksLikeJobList"] and len(broken["cards"]) == 0,
                      f"{name}: breakage alarm would not fire (cards={len(broken['cards'])}, looksLikeJobList={broken['looksLikeJobList']})")
        browser.close()

    print()
    if failures:
        print("FAILED:")
        for f in failures: print("  ✗", f)
        sys.exit(1)
    print(f"All {len(pages)} fixture pages passed.")


if __name__ == "__main__":
    main()
