#!/usr/bin/env python3
"""Derive the drawing outline archive from the embedded China boundary archive.

The matching archive keeps every vertex of every administrative boundary:
point-in-polygon tests need that precision, but the browser only ever draws
the outline of the level it is showing. This script produces a second archive
with the same features and the same properties, simplified per level, so the
drawing data can be served without dragging 18 MB of coordinates to the client.

Only the Python standard library is used, matching the rest of the boundary
tooling.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import time
from pathlib import Path
from typing import Any, Iterator


# 容差按层级分档，单位是度。
#
# 分档的意义是「每层只画它该有的精度」：DP 允许边界偏移到容差量级，
# 全国图上省界偏移 0.01°（≈1.1km）看不出来，但在市图上就会在相邻
# 区县之间裂出可见的缝。各档取值对照地图的实际像素尺度：
#
#   全国图 东西跨度约 62° 画在 1000 宽的画布上 → 约 16 px/°
#     省 0.01° ≈ 0.16 px
#   省图   跨度约 6°                        → 约 170 px/°
#     市 0.004° ≈ 0.7 px
#   市图   跨度约 2°                        → 约 500 px/°
#     区县 0.002° ≈ 1.0 px
OUTLINE_TOLERANCE_DEGREES = {"province": 0.01, "city": 0.004, "district": 0.002}


def simplify_ring(points: list[list[float]], tolerance: float) -> list[list[float]]:
    """Douglas-Peucker 简化一个环。

    环是闭合的（首尾同点），保留首尾点即保留了闭合性。用显式栈而不是
    递归：十万点的环递归会爆栈。
    """
    if len(points) <= 4:
        return points
    keep = [False] * len(points)
    keep[0] = True
    keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        ax, ay = points[start]
        bx, by = points[end]
        dx = bx - ax
        dy = by - ay
        denominator = dx * dx + dy * dy
        best_distance = -1.0
        best_index = -1
        for index in range(start + 1, end):
            px, py = points[index]
            if denominator == 0:
                distance = math.hypot(px - ax, py - ay)
            else:
                ratio = ((px - ax) * dx + (py - ay) * dy) / denominator
                if ratio < 0:
                    ratio = 0.0
                elif ratio > 1:
                    ratio = 1.0
                distance = math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy))
            if distance > best_distance:
                best_distance = distance
                best_index = index
        if best_distance > tolerance:
            keep[best_index] = True
            stack.append((start, best_index))
            stack.append((best_index, end))
    return [point for index, point in enumerate(points) if keep[index]]


def simplify_geometry(geometry: dict[str, Any], tolerance: float) -> dict[str, Any]:
    """按容差简化一个要素的几何，结构保持不变。"""
    if geometry["type"] == "Polygon":
        rings = [simplify_ring(ring, tolerance) for ring in geometry["coordinates"]]
        return {"type": "Polygon", "coordinates": rings}
    polygons = [
        [simplify_ring(ring, tolerance) for ring in polygon]
        for polygon in geometry["coordinates"]
    ]
    return {"type": "MultiPolygon", "coordinates": polygons}


def count_points(geometry: dict[str, Any]) -> int:
    if geometry["type"] == "Polygon":
        return sum(len(ring) for ring in geometry["coordinates"])
    return sum(len(ring) for polygon in geometry["coordinates"] for ring in polygon)


def iter_features(text: str) -> Iterator[dict[str, Any]]:
    """逐个解析 FeatureCollection 里的 feature。

    整份 GeoJSON 解压后有 180MB，一次性 json.loads 会把它整个变成 Python
    对象（几 GB 内存）。这里按 feature 逐个解析，峰值只剩源文本加一个要素。
    """
    marker = '"features":['
    start = text.index(marker) + len(marker)
    decoder = json.JSONDecoder()
    length = len(text)
    index = start
    while True:
        while index < length and text[index] in " \t\r\n,":
            index += 1
        if index >= length or text[index] == "]":
            return
        feature, index = decoder.raw_decode(text, index)
        yield feature


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "backend/internal/services/geodata/china-admin.geojson.gz",
        help="source boundary archive (full precision, used for matching)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "backend/internal/services/geodata/china-admin-outline.geojson.gz",
        help="destination outline archive (simplified, used for drawing)",
    )
    args = parser.parse_args()

    started = time.monotonic()
    with gzip.open(args.source, "rt", encoding="utf-8") as source:
        text = source.read()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    feature_count = 0
    source_points = 0
    outline_points = 0
    per_level: dict[str, list[int]] = {}
    # 用 GzipFile 显式关掉文件名与时间戳：同样的输入要产出同样的字节，
    # 否则这份内嵌数据的指纹每次生成都变。
    with args.output.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0, compresslevel=9) as archive:
            archive.write(b'{"type":"FeatureCollection","features":[')
            for feature in iter_features(text):
                level = feature["properties"]["level"]
                tolerance = OUTLINE_TOLERANCE_DEGREES[level]
                geometry = feature["geometry"]
                source_points += count_points(geometry)
                simplified = simplify_geometry(geometry, tolerance)
                outline_points += count_points(simplified)
                counts = per_level.setdefault(level, [0, 0, 0])
                counts[0] += 1
                counts[1] += count_points(geometry)
                counts[2] += count_points(simplified)
                outline_feature = {
                    "type": "Feature",
                    "properties": feature["properties"],
                    "geometry": simplified,
                }
                if feature_count:
                    archive.write(b",")
                archive.write(
                    json.dumps(outline_feature, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                )
                feature_count += 1
            archive.write(b"]}")

    elapsed = time.monotonic() - started
    print(f"Wrote {args.output}: {feature_count} features, "
          f"{outline_points:,} ring points (source {source_points:,}), "
          f"{args.output.stat().st_size:,} bytes")
    for level in ("province", "city", "district"):
        counts = per_level.get(level)
        if not counts:
            continue
        print(
            f"  {level:9s} {counts[0]:5d} features  "
            f"{counts[1]:>10,} -> {counts[2]:>9,} points  "
            f"(tolerance {OUTLINE_TOLERANCE_DEGREES[level]} deg)"
        )
    print(f"  took {elapsed:.1f}s")


if __name__ == "__main__":
    main()
