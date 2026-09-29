#!/usr/bin/env python3
"""
Fill cities_by_country.json with every country and territory from GeoNames.

Countries already in the file are kept exactly as they are; only missing ones
are added. Per new country: places with >= MIN_POP people, largest first, at
most MAX_PER_COUNTRY (each city costs one routing request when fetching). Small
countries/islands with few such places are topped up with smaller towns so
they still get at least MIN_PER_COUNTRY entries.

Data: GeoNames (https://www.geonames.org), CC BY 4.0.

Usage:  python3 tools/build_cities.py [--dry-run]
"""

import argparse
import io
import json
import os
import urllib.request
import zipfile

ROOT        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_FILE    = os.path.join(ROOT, "cities_by_country.json")
CACHE_DIR   = os.path.join(ROOT, "tools", ".cache")
GEONAMES    = "https://download.geonames.org/export/dump/"

MIN_POP         = 15000
MAX_PER_COUNTRY = 300
MIN_PER_COUNTRY = 25
# Neighbourhoods, historical, abandoned and destroyed places aren't commute targets
SKIP_FEATURES   = {"PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"}


def download(name):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, name)
    if not os.path.exists(path):
        print(f"Downloading {name}...")
        urllib.request.urlretrieve(GEONAMES + name, path)
    return path


def flag(code):
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in code)


def load_countries():
    names = {}
    with open(download("countryInfo.txt"), encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            cols = line.rstrip("\n").split("\t")
            names[cols[0]] = cols[4]
    return names


def load_places():
    """Yields (country, name, lat, lon, population) for every populated place with >= 1000 people."""
    with zipfile.ZipFile(download("cities1000.zip")) as z:
        with z.open("cities1000.txt") as raw:
            for line in io.TextIOWrapper(raw, encoding="utf-8"):
                cols = line.rstrip("\n").split("\t")
                if cols[7] in SKIP_FEATURES:
                    continue
                yield cols[8], cols[1], float(cols[4]), float(cols[5]), int(cols[14] or 0)


def pick(places):
    places.sort(key=lambda p: -p[3])
    seen, out = set(), []
    for name, lat, lon, pop in places:
        if len(out) >= MAX_PER_COUNTRY:
            break
        if pop < MIN_POP and len(out) >= MIN_PER_COUNTRY:
            break
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "lat": round(lat, 4), "lon": round(lon, 4)})
    return sorted(out, key=lambda c: c["name"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="print what would be added, don't write")
    args = ap.parse_args()

    with open(OUT_FILE, encoding="utf-8") as f:
        data = json.load(f)

    country_names = load_countries()
    by_country = {}
    for cc, name, lat, lon, pop in load_places():
        if cc not in data["cities"]:
            by_country.setdefault(cc, []).append((name, lat, lon, pop))

    added = 0
    for cc in sorted(by_country):
        if cc not in country_names:
            continue
        cities = pick(by_country[cc])
        data["cities"][cc] = cities
        data["names"][cc]  = f"{flag(cc)} {country_names[cc]}"
        added += 1
        if args.dry_run:
            print(f"  + {cc} {country_names[cc]}: {len(cities)} cities")

    total = sum(len(v) for v in data["cities"].values())
    print(f"Added {added} countries/territories -> {len(data['cities'])} total, {total} cities")

    if not args.dry_run:
        with open(OUT_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        print(f"Wrote {OUT_FILE} ({os.path.getsize(OUT_FILE) // 1024} KB)")


if __name__ == "__main__":
    main()
