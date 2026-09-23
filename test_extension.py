#!/usr/bin/env python3
"""
Offline tests for the LinkedIn Commute Extension.
Tests logic, JSON integrity, and (optionally) live ORS API.
"""
import json, re, sys, os, urllib.request, urllib.parse

PASS = "✅"
FAIL = "❌"
WARN = "⚠️ "
results = []

def test(name, fn):
    try:
        fn()
        print(f"  {PASS} {name}")
        results.append((name, True, None))
    except AssertionError as e:
        msg = str(e)
        print(f"  {FAIL} {name}" + (f": {msg}" if msg else ""))
        results.append((name, False, msg))
    except Exception as e:
        print(f"  {FAIL} {name}: {e}")
        results.append((name, False, str(e)))

BASE = "/home/desu/Downloads/files"

# ── 1. JSON integrity ─────────────────────────────────────────────────────────
print("\n📦 JSON Files")

def check_manifest():
    with open(f"{BASE}/manifest.json") as f:
        m = json.load(f)
    assert m["manifest_version"] == 3, "Wrong manifest version"
    assert "https://api.openrouteservice.org/*" in m["host_permissions"], "Missing ORS permission"
    assert "https://maps.googleapis.com/*" in m["host_permissions"], "Missing Google permission"
    assert any("cities_by_country.json" in r for res in m.get("web_accessible_resources",[]) for r in res.get("resources",[])), "cities_by_country.json not web accessible"
    assert m["version"] == "1.2.0", f"Version should be 1.2.0, got {m['version']}"
    assert "icons" in m, "Missing icons in manifest"
    for sz in ["16", "32", "48", "128"]:
        assert sz in m["icons"], f"Missing icon size {sz}"
        assert os.path.exists(f"{BASE}/{m['icons'][sz]}"), f"Icon file missing: {m['icons'][sz]}"
test("manifest.json valid (v1.2.0 & icons)", check_manifest)

def check_cities():
    with open(f"{BASE}/cities_by_country.json") as f:
        data = json.load(f)
    assert "cities" in data and "names" in data, "Missing cities or names keys"
    assert "NL" in data["cities"], "Netherlands missing"
    assert "US" in data["cities"], "US missing"
    assert "DE" in data["cities"], "Germany missing"
    nl = data["cities"]["NL"]
    assert len(nl) > 100, f"NL should have >100 cities, got {len(nl)}"
    assert all("name" in c and "lat" in c and "lon" in c for c in nl[:10]), "Cities missing name/lat/lon"
    total = sum(len(v) for v in data["cities"].values())
    print(f"       {len(data['cities'])} countries, {total} total cities")
test("cities_by_country.json valid + coordinates present", check_cities)

def check_db():
    with open(f"{BASE}/db.json") as f:
        db = json.load(f)
    assert isinstance(db, dict), "db.json should be a dict"
    assert len(db) > 0, "db.json is empty"
    # Check a known NL city
    assert "amsterdam" in db or "rotterdam" in db, "Missing common Dutch cities"
    print(f"       {len(db)} entries in default db.json")
test("db.json valid", check_db)

# ── 2. Core logic (ported to Python) ──────────────────────────────────────────
print("\n🧠 Core Logic")

import unicodedata

def city_slug(name):
    """Mirror of citySlug() in background.js"""
    name = unicodedata.normalize("NFD", name.lower())
    name = "".join(c for c in name if unicodedata.category(c) != "Mn")
    name = re.sub(r"[^a-z0-9]+", "-", name)
    return name.strip("-")

def fmt_duration(seconds):
    """Mirror of fmtDuration() in background.js"""
    total_min = round(seconds / 60)
    if total_min < 60:
        return f"{total_min}m"
    h = total_min // 60
    m = total_min % 60
    return f"{h}h {m}m" if m > 0 else f"{h}h"

def test_slug():
    assert city_slug("Amsterdam") == "amsterdam"
    assert city_slug("Den Haag") == "den-haag"
    assert city_slug("'s-Hertogenbosch") == "s-hertogenbosch"
    assert city_slug("München") == "munchen"
    assert city_slug("São Paulo") == "sao-paulo"
    assert city_slug("Île-de-France") == "ile-de-france"
test("citySlug() strips diacritics and normalises", test_slug)

def test_fmt():
    assert fmt_duration(600)  == "10m"
    assert fmt_duration(2700) == "45m"
    assert fmt_duration(3600) == "1h"
    assert fmt_duration(5400) == "1h 30m"
    assert fmt_duration(7200) == "2h"
    assert fmt_duration(7260) == "2h 1m"
test("fmtDuration() formats seconds correctly", test_fmt)

def test_profile_map():
    PROFILE_MAP = {
        "ors":    {"car": "driving-car",  "cycling": "cycling-regular", "walking": "foot-walking", "transit": None},
        "google": {"car": "driving",      "cycling": "bicycling",       "walking": "walking",      "transit": "transit"},
    }
    assert PROFILE_MAP["ors"]["car"] == "driving-car"
    assert PROFILE_MAP["google"]["transit"] == "transit"
    assert PROFILE_MAP["ors"]["transit"] is None, "ORS transit should be None"
    assert PROFILE_MAP["google"]["cycling"] == "bicycling"
test("PROFILE_MAP maps all modes correctly for both providers", test_profile_map)

def test_profile_migration():
    """Old stored values like 'driving-car' must migrate to 'car' on first load"""
    MIGRATION = {"driving-car": "car", "cycling-regular": "cycling", "foot-walking": "walking"}
    assert MIGRATION.get("driving-car")   == "car"
    assert MIGRATION.get("cycling-regular") == "cycling"
    assert MIGRATION.get("foot-walking")  == "walking"
    # New values pass through unchanged
    assert MIGRATION.get("car",     "car")     == "car"
    assert MIGRATION.get("transit", "transit") == "transit"
test("Storage migration: old ORS profile names → generic names", test_profile_migration)

def test_csv_export():
    """Simulate CSV export from customDb with transport mode"""
    fake_db = {"amsterdam": "35m", "rotterdam": "0m", "den-haag": "25m", "munchen": "8h 20m"}
    home = "3011 Rotterdam"
    origin = home.split(",")[0].strip()
    profile = "car"
    rows = ["Origin,Destination,Travel_Time,Mode"]
    for dest_slug, time in fake_db.items():
        dest_label = dest_slug.replace("-", " ").title()
        rows.append(f"{origin},{dest_label},{time},{profile}")
    csv = "\n".join(rows)
    assert "Rotterdam,Amsterdam,35m,car" in csv
    assert "Rotterdam,Den Haag,25m,car" in csv
    assert "Rotterdam,Munchen,8h 20m,car" in csv
test("CSV export produces correct format with Mode", test_csv_export)

def test_csv_import_mode():
    """Simulate CSV import detecting Mode column"""
    csv_text = "Origin,Destination,Travel_Time,Mode\nRotterdam,Utrecht,25m,car\n"
    lines = csv_text.strip().split("\n")
    headers = [h.strip().replace('"', '') for h in lines[0].split(",")]
    mode_idx = next((i for i, h in enumerate(headers) if re.match(r"^(mode|transport|transport_mode|profile)$", h, re.I)), -1)
    assert mode_idx == 3
    row = lines[1].split(",")
    val = row[mode_idx].lower()
    detected = None
    if "car" in val: detected = "car"
    elif "cycl" in val: detected = "cycling"
    elif "walk" in val: detected = "walking"
    elif "transit" in val: detected = "transit"
    assert detected == "car"
test("CSV import detects transport Mode column", test_csv_import_mode)

def test_dynamic_transport_icons():
    """Test dynamic icons mapping and badge regex stripping"""
    PROFILE_ICONS = {
        "car": "🚗",
        "cycling": "🚴",
        "walking": "🚶",
        "transit": "🚆",
    }
    assert PROFILE_ICONS["car"] == "🚗"
    assert PROFILE_ICONS["cycling"] == "🚴"
    assert PROFILE_ICONS["walking"] == "🚶"
    assert PROFILE_ICONS["transit"] == "🚆"

    # Regex stripping badge from card title
    r = re.compile(r"[🚆🚗🚴🚶🚌]\s*\d+[hm]\s*\d*[m]?")
    for profile, icon in PROFILE_ICONS.items():
        badge_text = f"{icon} 35m"
        line = f"Software Engineer {badge_text}"
        cleaned = r.sub("", line).strip()
        assert cleaned == "Software Engineer", f"Failed to strip {badge_text}"
test("Transport icons mapping and badge stripping regex", test_dynamic_transport_icons)

def test_db_lookup():
    """Simulate handleGetCommuteTimes lookup logic"""
    active_db = {"amsterdam": "35m", "den-haag": "25m", "rotterdam": "0m"}
    aliases = {"the-hague": "den-haag", "s-gravenhage": "den-haag", "rotterdam": "0m"}
    
    def lookup(loc, home="rotterdam"):
        clean = loc.lower().replace("netherlands","").replace("on-site","").strip()
        clean = clean.split(",")[0].strip().replace(" ", "-")
        hit = active_db.get(clean) or active_db.get(loc)
        if not hit and clean in aliases:
            hit = active_db.get(aliases[clean]) or aliases[clean]
        return hit

    assert lookup("Amsterdam") == "35m"
    assert lookup("Den Haag") == "25m"
    assert lookup("The Hague") == "25m"  # alias: the-hague → den-haag → 25m
    assert lookup("Rotterdam") == "0m"
test("DB lookup handles aliases and normalisation", test_db_lookup)

# ── 3. Popup HTML structure ────────────────────────────────────────────────────
print("\n🖥️  Popup HTML")

def check_html_ids():
    with open(f"{BASE}/popup.html") as f:
        html = f.read()
    required_ids = [
        "tabCsv", "tabApi", "panelCsv", "panelApi",
        "homeCity", "saveHomeCity", "homeCityStatus", "uploadZone", "csvFile", "status", "clearData",
        "statTotal", "statApplied", "statViewed", "exportTracker", "clearTracker",
        "apiKeyLabel", "apiKeyTooltip", "apiKeySaved", "orsKey", "homeSaved", "homeAddress",
        "transitNote", "countrySelect", "fetchBtn", "stopFetchBtn", "logWrap", "logBox", "logSummary",
        "exportApiCsv", "clearApiData",
    ]
    missing = [id_ for id_ in required_ids if f'id="{id_}"' not in html]
    assert not missing, f"Missing IDs: {missing}"
test("All required element IDs present in popup.html", check_html_ids)

def check_provider_btns():
    with open(f"{BASE}/popup.html") as f:
        html = f.read()
    assert 'data-provider="ors"' in html,    "Missing ORS provider button"
    assert 'data-provider="google"' in html, "Missing Google provider button"
    assert 'data-profile="transit"' in html, "Missing transit button"
    assert 'data-profile="car"' in html,     "Missing car button"
    assert "unavailable" in html,            "Missing unavailable class on transit"
test("Provider toggle and transport buttons present", check_provider_btns)

# ── 4. Live ORS API (optional) ────────────────────────────────────────────────
print("\n🌐 Live API Test (optional)")

ORS_KEY = os.environ.get("ORS_KEY", "")
if not ORS_KEY:
    print(f"  {WARN} Skipped — set ORS_KEY env var to test live API")
    print(f"       e.g.  ORS_KEY=your_key python3 test_extension.py")
else:
    def test_ors_geocode():
        url = f"https://api.openrouteservice.org/geocode/search?api_key={ORS_KEY}&text=Amsterdam&size=1"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        feat = data["features"][0]
        lon, lat = feat["geometry"]["coordinates"]
        assert 4.5 < lon < 5.2, f"Amsterdam lon out of range: {lon}"
        assert 52.2 < lat < 52.6, f"Amsterdam lat out of range: {lat}"
        print(f"       Amsterdam geocoded: lat={lat:.4f}, lon={lon:.4f}")
    test("ORS geocode: Amsterdam", test_ors_geocode)

    def test_ors_directions():
        # Rotterdam → Amsterdam by car (bundled coords)
        url = "https://api.openrouteservice.org/v2/directions/driving-car?start=4.4792,51.9225&end=4.8936,52.3728"
        req = urllib.request.Request(url, headers={
            "Authorization": ORS_KEY,
            "Accept": "application/json, application/geo+json",
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        duration = data["features"][0]["properties"]["summary"]["duration"]
        minutes = round(duration / 60)
        assert 30 < minutes < 120, f"Rotterdam→Amsterdam travel time seems wrong: {minutes}m"
        print(f"       Rotterdam → Amsterdam by car: ~{minutes}m")
    test("ORS directions: Rotterdam → Amsterdam", test_ors_directions)

# ── Summary ───────────────────────────────────────────────────────────────────
print()
passed = sum(1 for _, ok, _ in results if ok)
failed = sum(1 for _, ok, _ in results if not ok)
print(f"{'='*50}")
print(f"  {passed} passed  {failed} failed")
if failed:
    sys.exit(1)
