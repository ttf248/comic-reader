"""Reproducible local Chinese-CLIP and OCR quality/performance evaluation."""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


EVAL_FILE = Path(__file__).with_name("search_eval.json")
WORKER_FILE = Path(__file__).with_name("worker.py")


def find_cjk_font(explicit: str | None = None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    if os.name == "nt":
        windows = Path(os.environ.get("WINDIR", "C:/Windows"))
        candidates.extend(windows / "Fonts" / name for name in ("msyh.ttc", "simhei.ttf", "simsun.ttc"))
    elif sys.platform == "darwin":
        candidates.extend(
            Path(path)
            for path in (
                "/System/Library/Fonts/PingFang.ttc",
                "/System/Library/Fonts/STHeiti Medium.ttc",
            )
        )
    else:
        candidates.extend(
            Path(path)
            for path in (
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/arphic/ukai.ttc",
            )
        )
    for candidate in candidates:
        if candidate.is_file():
            try:
                ImageFont.truetype(str(candidate), 24)
                return candidate
            except OSError:
                continue
    return None


def load_font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def draw_scene(scene: str, seed: int, size: tuple[int, int], font_path: Path) -> Image.Image:
    width, height = size
    rng = random.Random(seed)
    image = Image.new("RGB", size, (235, 239, 242))
    draw = ImageDraw.Draw(image)

    if scene == "street":
        draw.rectangle((0, 0, width, height * 2 // 3), fill=(170, 211, 235))
        draw.rectangle((0, height * 2 // 3, width, height), fill=(67, 72, 77))
        for x in range(-20, width, 72):
            top = rng.randrange(30, 92)
            draw.rectangle((x, top, x + 58, height * 2 // 3), fill=(177, 176, 165))
            for wx in range(x + 8, x + 52, 18):
                for wy in range(top + 12, height * 2 // 3 - 8, 22):
                    draw.rectangle((wx, wy, wx + 8, wy + 10), fill=(219, 221, 201))
        for x in (60, 190, 300):
            y = height * 2 // 3 + rng.randrange(20, 48)
            color = rng.choice(((198, 65, 52), (62, 117, 164), (215, 192, 65)))
            draw.rounded_rectangle((x, y, x + 66, y + 27), radius=7, fill=color)
            draw.ellipse((x + 10, y + 21, x + 24, y + 36), fill=(28, 29, 32))
            draw.ellipse((x + 45, y + 21, x + 59, y + 36), fill=(28, 29, 32))
    elif scene == "beach":
        draw.rectangle((0, 0, width, height * 3 // 5), fill=(122, 190, 223))
        sun_x = rng.randrange(width // 3, width * 2 // 3)
        draw.ellipse((sun_x - 28, 42, sun_x + 28, 98), fill=(255, 191, 95))
        draw.rectangle((0, height * 3 // 5, width, height * 4 // 5), fill=(57, 139, 181))
        draw.rectangle((0, height * 4 // 5, width, height), fill=(223, 194, 137))
        for y in range(height * 3 // 5 + 8, height * 4 // 5, 16):
            draw.arc((rng.randrange(-30, 30), y, width, y + 18), 5, 175, fill=(202, 227, 229), width=2)
    elif scene == "forest":
        draw.rectangle((0, 0, width, height * 3 // 5), fill=(165, 208, 223))
        draw.rectangle((0, height * 3 // 5, width, height), fill=(68, 151, 171))
        for x in range(-12, width + 20, 34):
            tree_height = rng.randrange(80, 150)
            base = height * 3 // 5 + 12
            draw.rectangle((x + 12, base - tree_height // 2, x + 21, base), fill=(93, 75, 54))
            draw.polygon(((x, base - tree_height // 3), (x + 17, base - tree_height), (x + 34, base - tree_height // 3)), fill=(49, rng.randrange(103, 147), 74))
        for y in range(height * 3 // 5 + 12, height, 24):
            draw.line((0, y, width, y + rng.randrange(-3, 4)), fill=(130, 198, 201), width=2)
    elif scene == "mountain":
        draw.rectangle((0, 0, width, height * 3 // 4), fill=(170, 208, 236))
        draw.polygon(((0, 180), (90, 46), (170, 180)), fill=(104, 126, 148))
        draw.polygon(((63, 88), (90, 46), (116, 88), (97, 77), (90, 91), (81, 76)), fill=(246, 248, 244))
        draw.polygon(((105, 188), (236, 30), (width, 188)), fill=(119, 139, 157))
        draw.polygon(((190, 85), (236, 30), (282, 86), (253, 73), (236, 91), (218, 72)), fill=(246, 248, 244))
        draw.rectangle((0, 190, width, height), fill=(62, 131, 165))
        draw.line((0, 207, width, 202), fill=(188, 219, 220), width=3)
    elif scene == "building":
        draw.rectangle((0, 0, width, height), fill=(185, 218, 235))
        draw.rectangle((0, height * 4 // 5, width, height), fill=(112, 127, 125))
        for x, top, building_width in ((25, 56, 72), (112, 24, 86), (215, 67, 64), (288, 41, 78)):
            draw.rectangle((x, top, x + building_width, height * 4 // 5), fill=(104, 132, 145))
            for wx in range(x + 9, x + building_width - 5, 17):
                for wy in range(top + 12, height * 4 // 5 - 8, 20):
                    draw.rectangle((wx, wy, wx + 8, wy + 10), fill=(219, 222, 201))
    elif scene == "temple":
        draw.rectangle((0, 0, width, height), fill=(183, 215, 230))
        draw.rectangle((0, height * 3 // 4, width, height), fill=(97, 144, 87))
        draw.rectangle((87, 100, 297, 205), fill=(226, 192, 102))
        draw.polygon(((50, 111), (112, 62), (260, 62), (336, 111), (300, 128), (90, 128)), fill=(153, 54, 45))
        draw.polygon(((67, 105), (112, 76), (260, 76), (319, 105), (289, 116), (96, 116)), fill=(197, 74, 52))
        for x in (122, 174, 226, 274):
            draw.rectangle((x, 127, x + 13, 203), fill=(239, 224, 184))
        draw.rectangle((168, 157, 218, 205), fill=(109, 60, 42))
    elif scene == "game":
        draw.rectangle((0, 0, width, height), fill=(17, 20, 43))
        for _ in range(44):
            x, y = rng.randrange(width), rng.randrange(height)
            draw.rectangle((x, y, x + 2, y + 2), fill=(207, 219, 237))
        ship_x = rng.randrange(width // 3, width * 2 // 3)
        draw.polygon(((ship_x, 168), (ship_x - 28, 220), (ship_x, 207), (ship_x + 28, 220)), fill=(73, 208, 219))
        draw.rectangle((ship_x - 6, 177, ship_x + 6, 199), fill=(220, 237, 245))
        for x, y in ((85, 75), (276, 96), (320, 52)):
            draw.rectangle((x, y, x + 30, y + 10), fill=(214, 67, 85))
            draw.rectangle((x + 8, y - 6, x + 22, y + 16), fill=(214, 67, 85))
    elif scene == "screenshot":
        draw.rectangle((0, 0, width, height), fill=(245, 247, 249))
        draw.rectangle((0, 0, width, 34), fill=(40, 57, 74))
        draw.rectangle((18, 52, 160, 105), fill=(255, 255, 255), outline=(204, 212, 218), width=2)
        draw.rectangle((174, 52, 360, 105), fill=(255, 255, 255), outline=(204, 212, 218), width=2)
        draw.rectangle((18, 118, 360, 235), fill=(255, 255, 255), outline=(204, 212, 218), width=2)
        for x in range(44, 343, 42):
            bar_height = rng.randrange(28, 83)
            draw.rectangle((x, 218 - bar_height, x + 22, 218), fill=rng.choice(((57, 135, 190), (238, 143, 75), (85, 170, 132))))
        for y in (146, 174, 202):
            draw.line((34, y, 344, y), fill=(224, 229, 233), width=1)
        draw.text((31, 8), "REPORT", font=load_font(font_path, 17), fill=(246, 249, 250))
    elif scene == "text":
        draw.rectangle((0, 0, width, height), fill=(194, 215, 221))
        draw.rectangle((28, 47, width - 28, height - 48), fill=(245, 235, 209), outline=(99, 70, 51), width=5)
        draw.rectangle((43, 60, width - 43, height - 61), outline=(155, 111, 61), width=2)
        message = "咖啡入口" if seed % 2 else "今日营业"
        draw.text((58, 105), message, font=load_font(font_path, 35), fill=(80, 46, 37))
        draw.text((70, 159), "09:00-21:00", font=load_font(font_path, 20), fill=(80, 46, 37))
    else:
        raise ValueError(f"unknown scene: {scene}")

    return image


def generate_corpus(root: Path, spec: dict, font_path: Path) -> tuple[list[tuple[str, Path]], list[tuple[str, Path, str]]]:
    width, height = spec["imageSize"]
    images: list[tuple[str, Path]] = []
    for category_index, category in enumerate(spec["categories"]):
        for index in range(spec["imagesPerCategory"]):
            image_path = root / f"{category['id']}-{index:03d}.png"
            draw_scene(category["scene"], spec["seed"] + category_index * 10_000 + index, (width, height), font_path).save(image_path)
            images.append((category["id"], image_path))

    ocr_images: list[tuple[str, Path, str]] = []
    for index, expected in enumerate(spec["ocrSamples"]):
        image_path = root / f"ocr-{index:03d}.png"
        image = Image.new("RGB", (960, 220), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((12, 12, 948, 208), outline=(72, 72, 72), width=3)
        draw.text((38, 72), expected, font=load_font(font_path, 44), fill=(28, 28, 28))
        image.save(image_path)
        ocr_images.append((f"ocr-{index:03d}", image_path, expected))
    return images, ocr_images


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * fraction) - 1)
    return ordered[index]


def normalize_ocr(value: str) -> str:
    return "".join(
        char.casefold()
        for char in value
        if not char.isspace() and not unicodedata.category(char).startswith(("P", "Z"))
    )


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, 1):
        current = [row]
        for column, right_char in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[column] + 1, previous[column - 1] + (left_char != right_char)))
        previous = current
    return previous[-1]


def setup_worker(model_dir: Path):
    sys.path.insert(0, str(WORKER_FILE.parent))
    sys.argv = [str(WORKER_FILE), str(model_dir)]
    import worker

    worker.configure_cuda_dlls()
    import torch
    import cn_clip.clip as clip

    worker.torch = torch
    worker.clip = clip
    worker.Image = Image
    worker.device = "cuda" if torch.cuda.is_available() else "cpu"
    load_events: list[dict] = []
    original_load = worker.load_model

    def timed_load(device_mode: str = "auto") -> None:
        target = "cuda" if device_mode == "gpu" or (device_mode == "auto" and torch.cuda.is_available()) else "cpu"
        if worker.model is not None and worker.model_device == target:
            original_load(device_mode)
            return
        if target in worker.model_cache:
            original_load(device_mode)
            return
        started = time.perf_counter()
        original_load(device_mode)
        if worker.model_device == "cuda":
            torch.cuda.synchronize()
        load_events.append({"device": worker.model_device, "loadMs": round((time.perf_counter() - started) * 1000, 2)})

    worker.load_model = timed_load
    return worker, torch, load_events


def run_action(worker, torch, action: str, device: str, **payload):
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    started = time.perf_counter()
    response = worker.process({"action": action, "device": device, **payload})
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    elapsed_ms = (time.perf_counter() - started) * 1000
    if response.get("error"):
        raise RuntimeError(f"{action} failed: {response['error']}")
    return response, elapsed_ms


def require_vectors(response: dict) -> list[list[float]]:
    vectors = []
    for item in response.get("items", []):
        if item.get("error") or not item.get("vector"):
            raise RuntimeError(f"image embedding failed: {item.get('error', 'missing vector')}")
        vectors.append(item["vector"])
    return vectors


def evaluate_semantics(worker, torch, spec: dict, corpus: list[tuple[str, Path]], device: str) -> dict:
    paths = [str(path) for _, path in corpus]
    image_vectors: list[list[float]] = []
    image_batch_ms: list[float] = []
    for start in range(0, len(paths), 32):
        response, elapsed = run_action(worker, torch, "embed_images", device, paths=paths[start : start + 32])
        image_vectors.extend(require_vectors(response))
        image_batch_ms.append(elapsed)

    per_query = []
    query_latency_ms = []
    retrieval_latency_ms = []
    for category in spec["categories"]:
        query_vectors = []
        for _ in range(5):
            response, elapsed = run_action(worker, torch, "embed_texts", device, texts=[category["query"]])
            query_latency_ms.append(elapsed)
            query_vectors.append(require_vectors(response)[0])
        query = query_vectors[-1]
        started = time.perf_counter()
        ranked = sorted(
            (
                (sum(float(left) * float(right) for left, right in zip(query, vector)), index, label)
                for index, (label, _) in enumerate(corpus)
                for vector in (image_vectors[index],)
            ),
            key=lambda hit: (-hit[0], corpus[hit[1]][1].name),
        )
        retrieval_latency_ms.append((time.perf_counter() - started) * 1000)
        top = ranked[:10]
        relevant = sum(label == category["id"] for _, _, label in top)
        expected_count = sum(label == category["id"] for label, _ in corpus)
        per_query.append(
            {
                "queryId": category["id"],
                "precisionAt10": relevant / 10,
                "recallAt10": relevant / expected_count,
                "relevantAt10": relevant,
                "expectedRelevant": expected_count,
                "top1Similarity": round(ranked[0][0], 5) if ranked else None,
            }
        )

    return {
        "queryCount": len(per_query),
        "imageCount": len(corpus),
        "precisionAt10": statistics.mean(item["precisionAt10"] for item in per_query),
        "recallAt10": statistics.mean(item["recallAt10"] for item in per_query),
        "zeroResultRate": 0.0 if image_vectors else 1.0,
        "zeroRelevantAt10Rate": sum(item["relevantAt10"] == 0 for item in per_query) / len(per_query),
        "queryEmbeddingP50Ms": round(percentile(query_latency_ms, 0.50) or 0, 2),
        "queryEmbeddingP95Ms": round(percentile(query_latency_ms, 0.95) or 0, 2),
        "retrievalP50Ms": round(percentile(retrieval_latency_ms, 0.50) or 0, 2),
        "retrievalP95Ms": round(percentile(retrieval_latency_ms, 0.95) or 0, 2),
        "imageBatchP50Ms": round(percentile(image_batch_ms, 0.50) or 0, 2),
        "imageBatchP95Ms": round(percentile(image_batch_ms, 0.95) or 0, 2),
        "perQuery": per_query,
    }


def evaluate_ocr(worker, torch, samples: list[tuple[str, Path, str]], device: str) -> dict:
    response, elapsed = run_action(
        worker,
        torch,
        "ocr_images",
        device,
        paths=[str(path) for _, path, _ in samples],
    )
    distances = []
    exact = 0
    details = []
    for sample, item in zip(samples, response.get("items", []), strict=True):
        sample_id, _, expected = sample
        actual = item.get("data", {}).get("text", "") if item.get("data") else ""
        normalized_expected = normalize_ocr(expected)
        normalized_actual = normalize_ocr(actual)
        distance = edit_distance(normalized_expected, normalized_actual)
        cer = distance / max(1, len(normalized_expected))
        distances.append(cer)
        exact += cer == 0
        details.append({"sampleId": sample_id, "cer": round(cer, 4), "error": item.get("error")})
    return {
        "device": device,
        "loadAndBatchMs": round(elapsed, 2),
        "sampleCount": len(samples),
        "exactRate": exact / max(1, len(samples)),
        "characterErrorRate": statistics.mean(distances) if distances else None,
        "samples": details,
    }


def gpu_memory(torch) -> dict:
    if not torch.cuda.is_available():
        return {"allocatedBytes": 0, "reservedBytes": 0, "peakAllocatedBytes": 0, "totalBytes": 0}
    torch.cuda.synchronize()
    return {
        "allocatedBytes": int(torch.cuda.memory_allocated()),
        "reservedBytes": int(torch.cuda.memory_reserved()),
        "peakAllocatedBytes": int(torch.cuda.max_memory_allocated()),
        "totalBytes": int(torch.cuda.get_device_properties(0).total_memory),
    }


def profile_device_switches(worker, torch, load_events: list[dict]) -> dict:
    if not torch.cuda.is_available():
        return {"available": False}
    first_event = len(load_events)
    measurements = {}
    for label, target in (("cpuCold", "cpu"), ("gpuWarm", "gpu"), ("cpuWarm", "cpu"), ("gpuWarmRepeat", "gpu")):
        response, elapsed = run_action(worker, torch, "embed_texts", target, texts=["测试模型切换"])
        require_vectors(response)
        cache_key = "cuda" if target == "gpu" else "cpu"
        measurements[f"{label}RequestMs"] = round(elapsed, 2)
        measurements[f"{label}ModelCached"] = cache_key in worker.model_cache
    measurements["modelLoadEvents"] = load_events[first_event:]
    return {"available": True, **measurements}


def run(args: argparse.Namespace) -> dict:
    spec = json.loads(EVAL_FILE.read_text(encoding="utf-8"))
    if args.images_per_category:
        spec["imagesPerCategory"] = args.images_per_category
    font_path = find_cjk_font(args.font)
    if font_path is None:
        raise RuntimeError("no CJK font was found; pass --font with a local Chinese font file")
    worker, torch, load_events = setup_worker(args.model_dir)
    if args.device == "gpu" and not torch.cuda.is_available():
        raise RuntimeError("GPU evaluation was requested but CUDA is unavailable")

    with tempfile.TemporaryDirectory(prefix="local-gallery-search-eval-") as temporary:
        corpus, ocr_samples = generate_corpus(Path(temporary), spec, font_path)
        worker_status = worker.status()
        if not worker_status.get("modelValid"):
            raise RuntimeError("Chinese-CLIP model is missing or failed its checksum")
        semantic = evaluate_semantics(worker, torch, spec, corpus, args.device)
        ocr = evaluate_ocr(worker, torch, ocr_samples, args.device)
        device_switch = profile_device_switches(worker, torch, load_events) if args.profile_device_switches else None
        memory = gpu_memory(torch)
        return {
            "datasetVersion": spec["version"],
            "seed": spec["seed"],
            "imagesPerCategory": spec["imagesPerCategory"],
            "fontAvailable": True,
            "worker": {
                "device": args.device,
                "gpuName": worker_status.get("gpuName"),
                "gpuTotalBytes": worker_status.get("gpuMemoryBytes", 0),
                "modelVersion": worker_status.get("modelVersion"),
                "modelValid": worker_status.get("modelValid"),
                "modelLoadEvents": load_events,
                "gpuMemory": memory,
            },
            "semantic": semantic,
            "ocr": ocr,
            "deviceSwitch": device_switch,
            "limitations": [
                "The corpus uses deterministic synthetic illustrations and signs; it measures repeatable model/search regressions, not relevance on a user's unlabeled photo library.",
                "zeroResultRate counts an empty vector corpus; zeroRelevantAt10Rate separately measures queries with no labeled hit in the first ten results.",
            ],
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True, help="Local cacheDir/derived/ai/models directory")
    parser.add_argument("--device", choices=("gpu", "cpu", "auto"), default="gpu")
    parser.add_argument("--font", help="Optional local CJK font for generated text images")
    parser.add_argument("--images-per-category", type=int, help="Override the reproducible dataset size")
    parser.add_argument("--profile-device-switches", action="store_true", help="Measure CPU/GPU model reuse after one load per device")
    parser.add_argument("--output", type=Path, help="Write JSON metrics to this path instead of stdout")
    args = parser.parse_args()
    if args.images_per_category is not None and args.images_per_category <= 0:
        parser.error("--images-per-category must be positive")
    try:
        result = run(args)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
