# Page tests

LinkedIn changes its page markup without notice. When badges or colors stop
appearing (or the toolbar icon shows a red **!**), this is how to find out
what changed in a few minutes instead of guessing.

## Setup (once)

```
pip install playwright
python -m playwright install chromium
```

## Run

1. On LinkedIn, open the page that's broken (e.g. a job search, or `/jobs/`)
   and scroll so the job cards are loaded.
2. Press **Ctrl+S**, choose **Webpage, Complete**, and save it into
   `tests/fixtures/`. Save a few different pages: search results with some
   Viewed/Applied jobs, and the Jobs home page.
3. Run:

```
python tests/test_pages.py          # pass/fail per page
python tests/test_pages.py --show   # plus every card it read
```

The test loads the real `content_script.js` and `background.js` into each saved
page and checks that every job card is found once, with title, company,
location, color and at most one badge of each kind, and that a second pass
changes nothing (no badge flip-flop).

Saved pages contain your own LinkedIn data, so `tests/fixtures/` is in
`.gitignore` and never goes to GitHub.

## Where to look when it fails

All LinkedIn-specific assumptions are at the top of the card-discovery section
in `content_script.js`:

- `JOB_REF`: the `componentkey="job-card-component-ref-<id>"` attribute on
  search-result cards. If LinkedIn renames it, search pages lose their cards
  (the test's "breakage alarm" check simulates exactly this).
- Job links `currentJobId=<id>` / `/jobs/view/<id>`: how cards are found on
  the Jobs home page.
- `STATUS_WORDS`: the exact "Viewed / Applied / Saved" labels per language.
- `readCard()`: expects title, then company, then location, in that order.
