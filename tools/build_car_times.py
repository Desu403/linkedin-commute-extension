#!/usr/bin/env python3
"""
Build db_car.json: driving times from Rotterdam to every place in db.json.

Coordinates come from GeoNames (municipalities via their main town, see
scraper.TOWN_FOR); driving times from the public OSRM server, in a few table
requests. Run after scraper.py so both built-in files cover the same places.

Usage:  python3 tools/build_car_times.py
"""

import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from scraper import TOWN_BY_SLUG, city_slug  # noqa: E402

CACHE   = os.path.join(ROOT, "tools", ".cache", "cities1000.zip")
OSRM    = "https://router.project-osrm.org/table/v1/driving/"
NOMINATIM = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl&q="
UA      = {"User-Agent": "linkedin-commute-extension build script"}
HOME    = "Rotterdam"
BATCH   = 90   # destinations per table request
EXTRA_COORDS = {"schiphol": (52.3086, 4.7639)}  # the airport, not a town in GeoNames


def load_places():
    """slug -> [(population, lat, lon)] for Dutch places, by name and by alternate name."""
    if not os.path.exists(CACHE):
        sys.exit("Run tools/build_cities.py first (it downloads cities1000.zip).")
    by_name, by_alt = {}, {}
    with zipfile.ZipFile(CACHE) as z:
        for line in io.TextIOWrapper(z.open("cities1000.txt"), encoding="utf-8"):
            c = line.rstrip("\n").split("\t")
            if c[8] != "NL":
                continue
            entry = (int(c[14] or 0), float(c[4]), float(c[5]))
            for n in {c[1], c[2]}:
                by_name.setdefault(city_slug(n), []).append(entry)
            for n in c[3].split(","):
                if n:
                    by_alt.setdefault(city_slug(n), []).append(entry)
    return by_name, by_alt


def coords_for(key, by_name, by_alt):
    if key in EXTRA_COORDS:
        return EXTRA_COORDS[key]
    target = city_slug(TOWN_BY_SLUG.get(key, key))
    for index in (by_name, by_alt):
        if target in index:
            _, lat, lon = max(index[target])  # same name twice: the largest place
            return lat, lon
    return geocode(TOWN_BY_SLUG.get(key, key.replace("-", " ")))


def geocode(name):
    """Places GeoNames doesn't list with a population: ask OpenStreetMap (max 1 request/s)."""
    time.sleep(1.1)
    q = urllib.parse.quote(name.replace(" ad ", " aan den "))
    with urllib.request.urlopen(urllib.request.Request(NOMINATIM + q, headers=UA), timeout=30) as res:
        hits = json.load(res)
    return (float(hits[0]["lat"]), float(hits[0]["lon"])) if hits else None


def fmt(seconds):
    total = round(seconds / 60)
    if total < 60:
        return f"{total}m"
    h, m = divmod(total, 60)
    return f"{h}h {m}m" if m else f"{h}h"


def main():
    with open(os.path.join(ROOT, "db.json"), encoding="utf-8") as f:
        keys = sorted(json.load(f))
    by_name, by_alt = load_places()
    home = coords_for(city_slug(HOME), by_name, by_alt)

    located, missing = {}, []
    for k in keys:
        c = coords_for(k, by_name, by_alt)
        if c:
            located[k] = c
        else:
            missing.append(k)
    print(f"{len(located)} of {len(keys)} places located; no coordinates for: {', '.join(missing) or 'none'}")

    times = {}
    items = list(located.items())
    for i in range(0, len(items), BATCH):
        batch = items[i:i + BATCH]
        pts = ";".join(f"{lon},{lat}" for lat, lon in [home] + [c for _, c in batch])
        req = urllib.request.Request(f"{OSRM}{pts}?sources=0&annotations=duration", headers=UA)
        with urllib.request.urlopen(req, timeout=60) as res:
            data = json.load(res)
        if data.get("code") != "Ok":
            sys.exit(f"OSRM error: {data.get('code')} {data.get('message', '')}")
        for (k, _), d in zip(batch, data["durations"][0][1:]):
            if d is not None:
                times[k] = fmt(d)
        print(f"  {min(i + BATCH, len(items))}/{len(items)}")
        time.sleep(1.5)  # the public server asks for light use

    out = os.path.join(ROOT, "db_car.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(times.items())), f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(times)} driving times to {out}")


if __name__ == "__main__":
    main()
