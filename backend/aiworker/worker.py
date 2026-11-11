"""Local JSONL worker for Chinese-CLIP. It never downloads model files."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sys
from pathlib import Path


MODEL_FILE = "clip_cn_vit-b-16.pt"
MODEL_SHA256 = "5997ef32c50de18f3ac06eb5d746c324a639053c3bed8f2986f97ebb22b2ecde"
MODEL_VERSION = "chinese-clip-vit-b-16@957be8390cef5bab9ddd2dd36ca81a8622f966e7"
DIMENSION = 512
INITIAL_BATCH_SIZE = 8

model_dir = Path(sys.argv[1]).resolve()
model = None
preprocess = None
clip = None
torch = None
Image = None
device = "cpu"
runtime_error = ""
model_validation = None


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def model_state() -> dict:
    global model_validation
    path = model_dir / MODEL_FILE
    if not path.is_file():
        model_validation = {"modelAvailable": False, "modelValid": False, "modelVersion": MODEL_VERSION}
        return model_validation
    try:
        info = path.stat()
    except OSError:
        model_validation = {"modelAvailable": True, "modelValid": False, "modelVersion": MODEL_VERSION}
        return model_validation
    signature = (info.st_size, info.st_mtime_ns)
    if model_validation and model_validation.get("signature") == signature:
        return {key: value for key, value in model_validation.items() if key != "signature"}
    digest = file_sha256(path)
    model_validation = {
        "modelAvailable": True,
        "modelValid": digest == MODEL_SHA256,
        "modelVersion": MODEL_VERSION,
        "modelSha256": digest,
        "signature": signature,
    }
    return {key: value for key, value in model_validation.items() if key != "signature"}


def status() -> dict:
    state = model_state()
    result = {
        "pythonAvailable": True,
        "pythonVersion": sys.version.split()[0],
        "device": device,
        "cudaAvailable": bool(torch is not None and torch.cuda.is_available()),
        "cudaVersion": getattr(getattr(torch, "version", None), "cuda", None),
        "runtimeReady": not runtime_error,
        "modelLoaded": model is not None,
        "runtimeError": runtime_error,
    }
    if torch is not None:
        result["torchVersion"] = torch.__version__
        if torch.cuda.is_available():
            try:
                result["gpuName"] = torch.cuda.get_device_name(0)
                result["gpuMemoryBytes"] = int(torch.cuda.get_device_properties(0).total_memory)
            except Exception:
                pass
    result.update(state)
    return result


def load_model() -> None:
    global clip, model, preprocess, torch, Image, device, runtime_error
    state = model_state()
    if not state.get("modelValid"):
        raise RuntimeError("model_missing_or_checksum_invalid")
    if model is not None:
        return
    try:
        import torch as torch_module
        from PIL import Image as image_module
        import cn_clip.clip as clip_module
        from cn_clip.clip import load_from_name
    except Exception:
        runtime_error = "python_dependencies_missing"
        raise RuntimeError(runtime_error) from None
    torch, Image, clip = torch_module, image_module, clip_module
    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        with contextlib.redirect_stdout(sys.stderr):
            model, preprocess = load_from_name("ViT-B-16", device=device, download_root=str(model_dir))
    except Exception as error:
        if device == "cuda" and "out of memory" in str(error).lower():
            torch.cuda.empty_cache()
            device = "cpu"
            with contextlib.redirect_stdout(sys.stderr):
                model, preprocess = load_from_name("ViT-B-16", device="cpu", download_root=str(model_dir))
        else:
            runtime_error = "model_load_failed"
            raise RuntimeError(runtime_error) from None
    model.eval()


def normalize_rows(features):
    norms = features.norm(p=2, dim=-1, keepdim=True).clamp_min(1e-12)
    return features / norms


def encode_image_batch(images):
    tensor = torch.stack(images).to(device)
    with torch.inference_mode():
        features = normalize_rows(model.encode_image(tensor)).float().cpu()
    return features.tolist()


def encode_text_batch(texts):
    tokens = clip.tokenize(texts).to(device)
    with torch.inference_mode():
        features = normalize_rows(model.encode_text(tokens)).float().cpu()
    return features.tolist()


def is_cuda_oom(error: Exception) -> bool:
    return bool(torch is not None and isinstance(error, torch.cuda.OutOfMemoryError)) or "out of memory" in str(error).lower()


def run_with_fallback(items, encode, prepare):
    global device, model
    batch_size = INITIAL_BATCH_SIZE
    results = [None] * len(items)
    errors = [""] * len(items)
    prepared = {}
    for index, item in enumerate(items):
        try:
            prepared[index] = prepare(item)
        except Exception:
            errors[index] = "image_unreadable"

    pending = list(prepared)
    while pending:
        size = min(batch_size, len(pending))
        chunk = pending[:size]
        try:
            vectors = encode([prepared[index] for index in chunk])
            for index, vector in zip(chunk, vectors, strict=True):
                if len(vector) != DIMENSION:
                    errors[index] = "invalid_vector_dimension"
                else:
                    results[index] = vector
            pending = pending[size:]
        except Exception as error:
            if not is_cuda_oom(error) or device != "cuda":
                for index in chunk:
                    errors[index] = "inference_failed"
                pending = pending[size:]
                continue
            torch.cuda.empty_cache()
            if batch_size > 1:
                batch_size = max(1, batch_size // 2)
                continue
            device = "cpu"
            model = model.to("cpu").float()
            batch_size = 1
    return [{"vector": results[index], "error": errors[index]} for index in range(len(items))]


def prepare_image(path: str):
    with Image.open(path) as source:
        source.load()
        return preprocess(source.convert("RGB"))


def process(request: dict) -> dict:
    action = request.get("action")
    if action == "status":
        return {"status": status()}
    if action not in ("embed_images", "embed_texts"):
        return {"error": "unknown_action"}
    if runtime_error:
        return {"error": runtime_error}
    try:
        load_model()
    except Exception as error:
        return {"error": str(error) if str(error) in ("model_missing_or_checksum_invalid", "python_dependencies_missing", "model_load_failed") else "model_load_failed"}
    if action == "embed_images":
        paths = request.get("paths")
        if not isinstance(paths, list) or len(paths) > 32 or not all(isinstance(path, str) for path in paths):
            return {"error": "invalid_image_batch"}
        return {"items": run_with_fallback(paths, encode_image_batch, prepare_image), "status": status()}
    texts = request.get("texts")
    if not isinstance(texts, list) or not texts or len(texts) > 64 or not all(isinstance(text, str) for text in texts):
        return {"error": "invalid_text_batch"}
    return {"items": run_with_fallback(texts, encode_text_batch, lambda text: text), "status": status()}


def main() -> None:
    global torch, runtime_error, device, clip, Image
    try:
        import torch as torch_module
        from PIL import Image as image_module
        import cn_clip.clip as clip_module
        torch = torch_module
        Image = image_module
        clip = clip_module
        device = "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        runtime_error = "python_dependencies_missing"
    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request.get("id", "")
            response = process(request)
            response["id"] = request_id
        except Exception:
            response = {"id": "", "error": "worker_request_failed"}
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
