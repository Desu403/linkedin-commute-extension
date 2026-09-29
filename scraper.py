"""
Builds db.json: public transport times from a home place to Dutch towns, via 9292.nl.

    python scraper.py --home Rotterdam [--workers 3] [--only Hoofddorp,Schiphol]

Destinations: the NL towns in cities_by_country.json, the places already in
db.json, and EXTRA_PLACES. Each is matched to 9292's "Place" suggestion (not a
random stop with a similar name) and the time is read from the planned-journey
block. 9292 plans from "now", so run it on a weekday during the day.
"""

import argparse
import datetime as dt
import json
import multiprocessing as mp
import re
import sys
import time
import unicodedata


DB_FILE     = "db.json"
EXTRA_PLACES = ["Schiphol"]
SKIP_PLACES  = {"zandberg"}  # a Breda neighbourhood; 9292 only knows a far-away namesake

# Municipalities aren't places on 9292; their key gets the time to the main town.
TOWN_FOR = {
    "Texel": "Den Burg", "Meierijstad": "Veghel", "Hoeksche Waard": "Oud-Beijerland",
    "Haarlemmermeer": "Hoofddorp", "Berkelland": "Eibergen", "Velsen": "IJmuiden",
    "Zaanstad": "Zaandam", "Gilze en Rijen": "Rijen", "Geldrop-Mierlo": "Geldrop",
    "Heeze-Leende": "Heeze", "Ameland": "Nes", "Edam-Volendam": "Volendam",
    "Leidschendam-Voorburg": "Leidschendam", "Gemert-Bakel": "Gemert",
    "Terschelling": "West-Terschelling", "Lansingerland": "Berkel en Rodenrijs",
    "Halderberge": "Oudenbosch", "Smallingerland": "Drachten", "Pijnacker-Nootdorp": "Pijnacker",
    "Cranendonck": "Budel", "Lingewaard": "Huissen", "Teylingen": "Sassenheim",
    "Ouder-Amstel": "Ouderkerk aan de Amstel", "Reusel-De Mierden": "Reusel",
    "Leudal": "Heythuysen", "Gulpen-Wittem": "Gulpen", "Gooise Meren": "Bussum",
    "Midden-Drenthe": "Beilen", "Noordoostpolder": "Emmeloord", "Drechterland": "Hoogkarspel",
    "Westland": "Naaldwijk", "Nissewaard": "Spijkenisse", "Krimpenerwaard": "Schoonhoven",
    "Vijfheerenlanden": "Vianen", "West Betuwe": "Geldermalsen", "Altena": "Werkendam",
    "Land van Cuijk": "Cuijk", "Maashorst": "Uden", "Dijk en Waard": "Heerhugowaard",
    "Het Hogeland": "Uithuizen", "Eemsdelta": "Delfzijl", "Midden-Groningen": "Hoogezand",
    "Westerkwartier": "Leek", "Noardeast-Fryslân": "Dokkum", "Waadhoeke": "Franeker",
    "Súdwest-Fryslân": "Sneek", "De Friese Meren": "Joure", "Beekdaelen": "Nuth",
    "Peel en Maas": "Panningen", "Horst aan de Maas": "Horst", "Echt-Susteren": "Echt",
    "Sittard-Geleen": "Sittard", "Valkenburg aan de Geul": "Valkenburg",
    "Eijsden-Margraten": "Eijsden", "Goeree-Overflakkee": "Middelharnis",
    "Schouwen-Duiveland": "Zierikzee", "Voorne aan Zee": "Hellevoetsluis",
    "Steenwijkerland": "Steenwijk", "Zwartewaterland": "Genemuiden", "Twenterand": "Vriezenveen",
    "Dinkelland": "Denekamp", "Hof van Twente": "Goor", "Rijssen-Holten": "Rijssen",
    "Oost Gelre": "Groenlo", "Oude IJsselstreek": "Ulft", "Bernheze": "Heesch",
    "Mill en Sint Hubert": "Mill", "Dongeradeel": "Dokkum", "Achtkarspelen": "Buitenpost",
    "Tietjerksteradeel": "Burgum", "Opsterland": "Gorredijk", "Weststellingwerf": "Wolvega",
    "Ooststellingwerf": "Oosterwolde", "Borger-Odoorn": "Borger", "Aa en Hunze": "Gieten",
    "Noordenveld": "Roden", "Overbetuwe": "Elst", "Olst-Wijhe": "Olst", "Montferland": "Didam",
    "Laarbeek": "Beek en Donk", "Reimerswaal": "Yerseke", "Stichtse Vecht": "Maarssen",
    # Names 9292 spells differently
    "Almere Stad": "Almere", "Katwijk aan Zee": "Katwijk", "Nieuwerkerk aan den IJssel": "Nieuwerkerk ad IJssel",
    "Zuidplas": "Nieuwerkerk ad IJssel",
}
# Names that exist in several provinces: the one people usually mean
PROVINCE_FOR = {"Buren": "Gelderland", "Valkenburg": "Limburg", "Hengelo": "Overijssel",
                "Elst": "Gelderland", "Nes": "Friesland", "Borger": "Drenthe", "Horst": "Limburg"}
DURATION_RE = re.compile(
    r"Planned journey from .+?\n.*?Open map\n[^\n]+\n((?:\d+h )?\d+m|\d+h)\n", re.S)


def city_slug(name):
    """Same as citySlug() in background.js."""
    s = unicodedata.normalize("NFD", name.lower())
    s = re.sub(r"[\u0300-\u036f]", "", s)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


TOWN_BY_SLUG = {city_slug(k): v for k, v in TOWN_FOR.items()}


def destinations():
    with open("cities_by_country.json", encoding="utf-8") as f:
        names = [c["name"] for c in json.load(f)["cities"]["NL"]]
    with open("municipalities.json", encoding="utf-8") as f:
        by_slug = {city_slug(n): n for n in json.load(f)}
    with open(DB_FILE, encoding="utf-8") as f:
        for key in json.load(f):
            names.append(by_slug.get(city_slug(key), key.replace("-", " ").title()))
    out = {}
    for n in names + EXTRA_PLACES + list(TOWN_FOR):
        if city_slug(n) not in SKIP_PLACES:
            out.setdefault(city_slug(n), query_name(n))
    return out


def query_name(name):
    """What to look up on 9292 for this key: the main town for a municipality."""
    return TOWN_BY_SLUG.get(city_slug(name), name.strip())


def accept_cookies(page):
    page.evaluate("""() => {
        const b = document.querySelector("#usercentrics-root")?.shadowRoot
            ?.querySelector('button[data-testid="uc-accept-all-button"]');
        if (b) b.click();
    }""")


def pick_place(page, field, name):
    """Types the name and clicks 9292's 'Place' suggestion for it. False if there is none."""
    field.click()
    field.fill("")
    field.press_sequentially(name, delay=40)
    want = city_slug(name)
    options = page.locator("[role=option]")
    for _ in range(16):  # suggestions arrive asynchronously; give them up to ~8s
        page.wait_for_timeout(500)
        # Compare as slugs: 9292 writes "'s-Hertogenbosch" as "s Hertogenbosch", and
        # duplicates as "Oosterhout (NB)" or with the province on the second line
        matches = []
        for i, text in enumerate(options.all_inner_texts()):
            title, _, detail = text.partition("\n")
            t = city_slug(title)
            if detail.strip().startswith("Place") and (t == want or t.startswith(want + "-")):
                matches.append((i, detail))
        if matches:
            break
    if not matches:
        return False
    province = PROVINCE_FOR.get(name)
    pick = next((i for i, d in matches if province and province in d), matches[0][0])
    options.nth(pick).click()
    page.wait_for_timeout(400)
    return True


def travel_time(page, home, dest):
    page.goto("https://9292.nl/en", wait_until="domcontentloaded")
    page.wait_for_selector("input[type='text']", timeout=15000)
    fields = page.locator("input[type='text']")
    if not pick_place(page, fields.nth(0), home):
        raise RuntimeError(f"home '{home}' not found as a place")
    if not pick_place(page, fields.nth(1), dest):
        return None, "no such place on 9292"
    page.locator("button[type=submit]").first.click()
    page.wait_for_url("**/planner/**", timeout=20000)
    for _ in range(10):
        page.wait_for_timeout(1000)
        m = DURATION_RE.search(page.evaluate("document.body.innerText"))
        if m:
            return m.group(1), None
    return None, "no journey found"


def worker(args):
    home, items, idx = args
    results, problems = {}, {}
    from playwright.sync_api import sync_playwright  # only needed for scraping; tools import TOWN_FOR
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(locale="en-GB")
        page.goto("https://9292.nl/en", wait_until="domcontentloaded")
        page.wait_for_timeout(3000)
        accept_cookies(page)
        for n, (slug, name) in enumerate(items, 1):
            for attempt in range(2):
                try:
                    t, why = travel_time(page, home, name)
                    break
                except RuntimeError:
                    raise
                except Exception as e:
                    t, why = None, f"error: {str(e).splitlines()[0][:80]}"
            if t:
                results[slug] = t
            else:
                problems[slug] = f"{name}: {why}"
            print(f"[w{idx} {n}/{len(items)}] {name}: {t or why}", flush=True)
            time.sleep(1.5)
        browser.close()
    return results, problems


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--home", required=True, help="Home place, e.g. Rotterdam")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--only", help="comma-separated places to (re)do; others in db.json are kept")
    args = ap.parse_args()

    now = dt.datetime.now()
    if now.weekday() >= 5 or not 7 <= now.hour < 19:
        print("Warning: 9292 plans from now; weekend/evening times are longer than a weekday commute.")

    if args.only:
        todo = {city_slug(n): query_name(n) for n in args.only.split(",")}
    else:
        todo = destinations()
    todo.pop(city_slug(args.home), None)
    items = sorted(todo.items())
    print(f"{len(items)} destinations from {args.home}, {args.workers} workers")

    shards = [(args.home, items[i::args.workers], i + 1) for i in range(args.workers)]
    with mp.Pool(args.workers) as pool:
        parts = pool.map(worker, shards)

    with open(DB_FILE, encoding="utf-8") as f:
        db = json.load(f) if args.only else {}
    problems = {}
    for res, prob in parts:
        db.update(res)
        problems.update(prob)
    db = dict(sorted(db.items()))
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)
    print(f"\nSaved {len(db)} places to {DB_FILE}. Not found: {len(problems)}")
    for v in sorted(problems.values()):
        print("  -", v)


if __name__ == "__main__":
    main()
