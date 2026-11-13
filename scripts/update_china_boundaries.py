#!/usr/bin/env python3
"""Convert AreaCity ok_geo.csv into the embedded GeoJSON boundary archive."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import os
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any


FIELD_NAMES = ["id", "pid", "deep", "name", "ext_path", "geo", "polygon"]
EMPTY_VALUES = {"", "EMPTY"}
MIN_AREA_COUNT = 3_000


def normalize_adcode(raw_id: str, depth: int) -> str:
    if not raw_id.isdigit():
        raise ValueError(f"non-numeric administrative id: {raw_id!r}")
    if depth == 2 and len(raw_id) == 9:
        return raw_id[:6]
    if len(raw_id) > 6:
        raise ValueError(f"unexpected id length at depth {depth}: {raw_id!r}")
    return raw_id.ljust(6, "0")


def parse_ring(raw_ring: str, row_id: str) -> list[list[float]]:
    points: list[list[float]] = []
    for raw_point in raw_ring.split(","):
        pair = raw_point.strip().split()
        if len(pair) != 2:
            raise ValueError(f"malformed coordinate in {row_id}: {raw_point!r}")
        longitude, latitude = (float(value) for value in pair)
        if not math.isfinite(longitude) or not math.isfinite(latitude):
            raise ValueError(f"non-finite coordinate in {row_id}")
        if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise ValueError(f"coordinate outside longitude/latitude bounds in {row_id}")
        points.append([longitude, latitude])
    if len(points) < 3 or len({(point[0], point[1]) for point in points}) < 3:
        raise ValueError(f"ring has fewer than three distinct points in {row_id}")
    if points[0] != points[-1]:
        points.append(points[0])
    return points


def parse_geometry(raw_polygon: str, row_id: str) -> dict[str, Any]:
    polygons: list[list[list[list[float]]]] = []
    for raw_polygon_part in raw_polygon.split(";"):
        rings = [
            parse_ring(raw_ring, row_id)
            for raw_ring in raw_polygon_part.split("~")
            if raw_ring.strip()
        ]
        if not rings:
            raise ValueError(f"empty polygon part in {row_id}")
        polygons.append(rings)
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_csv", type=Path, help="AreaCity ok_geo.csv extracted from ok_geo.csv.7z")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "backend/internal/services/geodata/china-admin.geojson.gz",
        help="destination GeoJSON gzip file",
    )
    args = parser.parse_args()
    csv.field_size_limit(100_000_000)

    metadata: list[dict[str, Any]] = []
    by_key: dict[tuple[int, str], dict[str, Any]] = {}
    with args.input_csv.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != FIELD_NAMES:
            raise ValueError(f"unexpected CSV fields: {reader.fieldnames!r}")
        for row_number, row in enumerate(reader, start=2):
            depth = int(row["deep"])
            if depth not in (0, 1, 2):
                raise ValueError(f"unsupported depth {depth} at CSV line {row_number}")
            raw_id = row["id"]
            key = (depth, raw_id)
            if key in by_key:
                raise ValueError(f"duplicate source id at depth {depth}: {raw_id}")
            polygon = row["polygon"].strip()
            item = {
                "depth": depth,
                "id": raw_id,
                "pid": row["pid"],
                "name": row["name"].strip(),
                "polygon_hash": hashlib.sha256(polygon.encode("utf-8")).digest()
                if polygon not in EMPTY_VALUES
                else None,
                "include": False,
                "adcode": None,
                "parent_adcode": 0,
                "level": None,
            }
            if not item["name"]:
                raise ValueError(f"empty name at CSV line {row_number}")
            by_key[key] = item
            metadata.append(item)

    canonical_by_key: dict[tuple[int, str], str | None] = {}
    features_by_adcode: dict[str, tuple[str, bytes]] = {}
    aliases = 0
    empty = 0
    for item in sorted(metadata, key=lambda entry: (entry["depth"], entry["id"])):
        depth = item["depth"]
        key = (depth, item["id"])
        if item["polygon_hash"] is None:
            canonical_by_key[key] = None
            empty += 1
            continue

        parent = None
        if depth > 0:
            parent = by_key.get((depth - 1, item["pid"]))
            if parent is None:
                raise ValueError(f"missing parent for {item['id']} ({item['name']})")
            parent_code = canonical_by_key.get((depth - 1, item["pid"]))
            if parent_code is None:
                raise ValueError(f"boundary parent has no geometry for {item['id']} ({item['name']})")
            item["parent_adcode"] = int(parent_code)

            same_as_parent = (
                item["name"] == parent["name"]
                and item["polygon_hash"] == parent["polygon_hash"]
            )
            normalized = normalize_adcode(item["id"], depth)
            if same_as_parent:
                canonical_by_key[key] = parent_code
                aliases += 1
                continue
            if normalized == parent_code:
                raise ValueError(
                    f"normalized code collides with a non-identical parent boundary: {item['id']}"
                )

        adcode = normalize_adcode(item["id"], depth)
        if adcode in features_by_adcode:
            previous_name, previous_hash = features_by_adcode[adcode]
            if item["name"] == previous_name and item["polygon_hash"] == previous_hash:
                raise ValueError(f"duplicate canonical administrative code: {adcode}")
            raise ValueError(f"administrative code collision: {adcode} ({item['name']})")
        features_by_adcode[adcode] = (item["name"], item["polygon_hash"])
        canonical_by_key[key] = adcode
        item["adcode"] = int(adcode)
        item["include"] = True
        if depth == 0:
            item["level"] = "province"
        elif depth == 1 and len(item["id"]) < 6:
            item["level"] = "city"
        else:
            item["level"] = "district"

    level_counts = Counter(item["level"] for item in metadata if item["include"])
    area_count = level_counts["city"] + level_counts["district"]
    if level_counts["province"] != 34 or area_count < MIN_AREA_COUNT:
        raise ValueError(
            f"converted boundary set is incomplete: provinces={level_counts['province']}, areas={area_count}"
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output = args.output.resolve()
    temporary_path: Path | None = None
    feature_count = 0
    point_count = 0
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=args.output.name + ".", suffix=".tmp", dir=args.output.parent, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            with gzip.GzipFile(fileobj=temporary, mode="wb", filename="", mtime=0, compresslevel=9) as archive:
                archive.write(b'{"type":"FeatureCollection","features":[')
                with args.input_csv.open("r", encoding="utf-8-sig", newline="") as source:
                    reader = csv.DictReader(source)
                    for row in reader:
                        item = by_key[(int(row["deep"]), row["id"])]
                        if not item["include"]:
                            continue
                        geometry = parse_geometry(row["polygon"].strip(), row["id"])
                        coordinates = geometry["coordinates"]
                        if geometry["type"] == "Polygon":
                            point_count += sum(len(ring) for ring in coordinates)
                        else:
                            point_count += sum(
                                len(ring) for polygon in coordinates for ring in polygon
                            )
                        feature = {
                            "type": "Feature",
                            "properties": {
                                "adcode": item["adcode"],
                                "name": item["name"],
                                "level": item["level"],
                                "parent": {"adcode": item["parent_adcode"]},
                            },
                            "geometry": geometry,
                        }
                        if feature_count:
                            archive.write(b",")
                        archive.write(
                            json.dumps(feature, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                        )
                        feature_count += 1
                archive.write(b"]}")
        os.replace(temporary_path, args.output)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    print(
        f"Wrote {args.output}: {feature_count} features "
        f"({level_counts['province']} provinces, {level_counts['city']} cities, "
        f"{level_counts['district']} districts), {empty} empty geometries skipped, "
        f"{aliases} duplicate boundary rows folded, {point_count:,} ring points"
    )


if __name__ == "__main__":
    main()
