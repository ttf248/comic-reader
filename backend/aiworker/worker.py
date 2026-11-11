"""Local JSONL worker for Chinese-CLIP. It never downloads model files."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import sys
from pathlib import Path


MODEL_FILE = "clip_cn_vit-b-16.pt"
MODEL_SHA256 = "5997ef32c50de18f3ac06eb5d746c324a639053c3bed8f2986f97ebb22b2ecde"
MODEL_VERSION = "chinese-clip-vit-b-16@957be8390cef5bab9ddd2dd36ca81a8622f966e7"
DIMENSION = 512
INITIAL_BATCH_SIZE = 8
YUNET_FILE = "face_detection_yunet_2023mar.onnx"
YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
SFACE_FILE = "face_recognition_sface_2021dec.onnx"
SFACE_SHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"
FACE_VERSION = "yunet-2023mar+sface-2021dec"

model_dir = Path(sys.argv[1]).resolve()
model = None
preprocess = None
clip = None
torch = None
Image = None
device = "cpu"
runtime_error = ""
model_validation = None
rapid_ocr = None
face_detector = None
face_recognizer = None
cv2 = None
np = None
ocr_runtime_error = ""
face_runtime_error = ""
face_model_validation = {}


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
        "modules": {
            "ocr": ocr_module_status(),
            "face": face_module_status(),
        },
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


def module_error(module: str) -> str:
    if module == "ocr" and ocr_runtime_error:
        return ocr_runtime_error
    if module == "face" and face_runtime_error:
        return face_runtime_error
    return ""


def ocr_module_status() -> dict:
    error = module_error("ocr")
    if error:
        return {"ready": False, "version": "rapidocr-3.10.0-onnxruntime-1.31.1", "error": error}
    try:
        if (
            importlib.util.find_spec("rapidocr") is None
            or importlib.util.find_spec("onnxruntime") is None
            or importlib.util.find_spec("cv2") is None
        ):
            error = "ocr_dependencies_missing"
        else:
            version = importlib.metadata.version("rapidocr")
            runtime_version = importlib.metadata.version("onnxruntime")
            if version != "3.10.0" or runtime_version != "1.31.1":
                error = "ocr_dependency_version_mismatch"
    except Exception:
        error = "ocr_dependencies_missing"
    return {
        "ready": not error,
        "version": "rapidocr-3.10.0-onnxruntime-1.31.1",
        **({"error": error} if error else {}),
    }


def file_state(path: Path, expected_sha256: str) -> bool:
    key = str(path)
    try:
        info = path.stat()
        if not path.is_file():
            return False
        signature = (info.st_size, info.st_mtime_ns)
        cached = face_model_validation.get(key)
        if cached and cached[0] == signature:
            return cached[1]
        valid = file_sha256(path) == expected_sha256
        face_model_validation[key] = (signature, valid)
        return valid
    except OSError:
        return False


def face_module_status() -> dict:
    error = module_error("face")
    detector_path = model_dir / "face" / YUNET_FILE
    recognizer_path = model_dir / "face" / SFACE_FILE
    if not error:
        try:
            if importlib.util.find_spec("cv2") is None:
                error = "face_dependencies_missing"
            else:
                import cv2 as cv2_module
                if not hasattr(cv2_module, "FaceDetectorYN_create") or not hasattr(cv2_module, "FaceRecognizerSF_create"):
                    error = "face_dependencies_missing"
                elif not file_state(detector_path, YUNET_SHA256) or not file_state(recognizer_path, SFACE_SHA256):
                    error = "face_model_missing_or_checksum_invalid"
        except Exception:
            error = "face_dependencies_missing"
    return {
        "ready": not error,
        "version": FACE_VERSION,
        **({"error": error} if error else {}),
    }


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
            if size > 1:
                batch_size = max(1, size // 2)
                continue
            device = "cpu"
            model = model.to("cpu").float()
            batch_size = 1
    return [{"vector": results[index], "error": errors[index]} for index in range(len(items))]


def prepare_image(path: str):
    with Image.open(path) as source:
        source.load()
        return preprocess(source.convert("RGB"))


def read_cv_image(path: str):
    global cv2, np
    if cv2 is None or np is None:
        import cv2 as cv2_module
        import numpy as numpy_module
        cv2, np = cv2_module, numpy_module
    try:
        encoded = np.fromfile(path, dtype=np.uint8)
        return cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    except Exception:
        return None


def load_ocr_engine():
    global rapid_ocr, ocr_runtime_error
    state = ocr_module_status()
    if not state["ready"]:
        ocr_runtime_error = state.get("error", "ocr_dependencies_missing")
        raise RuntimeError(ocr_runtime_error)
    if rapid_ocr is None:
        try:
            from rapidocr import RapidOCR
            with contextlib.redirect_stdout(sys.stderr):
                rapid_ocr = RapidOCR()
        except Exception:
            ocr_runtime_error = "ocr_model_load_failed"
            raise RuntimeError(ocr_runtime_error) from None
    return rapid_ocr


def load_face_models():
    global face_detector, face_recognizer, cv2, np, face_runtime_error
    state = face_module_status()
    if not state["ready"]:
        face_runtime_error = state.get("error", "face_dependencies_missing")
        raise RuntimeError(face_runtime_error)
    if face_detector is not None and face_recognizer is not None:
        return
    try:
        import cv2 as cv2_module
        import numpy as numpy_module
        cv2, np = cv2_module, numpy_module
        detector_path = str(model_dir / "face" / YUNET_FILE)
        recognizer_path = str(model_dir / "face" / SFACE_FILE)
        face_detector = cv2.FaceDetectorYN_create(detector_path, "", (320, 320), 0.65, 0.3, 5000)
        face_recognizer = cv2.FaceRecognizerSF_create(recognizer_path, "")
    except Exception:
        face_runtime_error = "face_model_load_failed"
        raise RuntimeError(face_runtime_error) from None


def analyze_ocr_image(path: str) -> dict:
    image = read_cv_image(path)
    if image is None:
        return {"data": None, "error": "image_unreadable"}
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = load_ocr_engine()(image)
        texts = list(result.txts) if result.txts is not None else []
        scores = list(result.scores) if result.scores is not None else []
        boxes = list(result.boxes) if result.boxes is not None else []
        lines = []
        for index, text in enumerate(texts):
            normalized = str(text).strip()
            if not normalized:
                continue
            box = boxes[index].tolist() if index < len(boxes) and hasattr(boxes[index], "tolist") else boxes[index] if index < len(boxes) else []
            try:
                confidence = float(scores[index]) if index < len(scores) else 0.0
            except (TypeError, ValueError):
                confidence = 0.0
            lines.append({"text": normalized, "confidence": confidence, "box": box})
        lines = lines[:512]
        return {"data": {"text": "\n".join(line["text"] for line in lines), "lines": lines}}
    except Exception:
        return {"data": None, "error": "ocr_inference_failed"}


def analyze_face_image(path: str) -> dict:
    global face_runtime_error
    image = read_cv_image(path)
    if image is None:
        return {"data": None, "error": "image_unreadable"}
    try:
        load_face_models()
        original_height, original_width = image.shape[:2]
        scale = min(1.0, 2048.0 / max(original_width, original_height))
        if scale < 1.0:
            image = cv2.resize(image, (round(original_width * scale), round(original_height * scale)), interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]
        face_detector.setInputSize((width, height))
        _, detections = face_detector.detect(image)
        faces = []
        if detections is not None:
            for detection in detections:
                aligned = face_recognizer.alignCrop(image, detection)
                feature = face_recognizer.feature(aligned).reshape(-1).astype(np.float32)
                norm = float(np.linalg.norm(feature))
                if not norm or not np.isfinite(norm):
                    continue
                embedding = (feature / norm).tolist()
                x, y, box_width, box_height = [float(value) / scale for value in detection[:4]]
                faces.append({
                    "box": [x, y, box_width, box_height],
                    "score": float(detection[-1]),
                    "embedding": embedding,
                })
                if len(faces) == 64:
                    break
        return {"data": {"faces": faces}}
    except Exception:
        return {"data": None, "error": face_runtime_error or "face_inference_failed"}


def run_image_analysis(paths, analyze):
    if not isinstance(paths, list) or not paths or len(paths) > 32 or not all(isinstance(path, str) for path in paths):
        return {"error": "invalid_image_batch"}
    return {"items": [analyze(path) for path in paths], "status": status()}


def verify_installation() -> None:
    global cv2, np
    modules = status()["modules"]
    if not modules["ocr"]["ready"] or not modules["face"]["ready"]:
        raise RuntimeError("OCR or face dependencies/models are unavailable")
    import cv2 as cv2_module
    import numpy as numpy_module
    cv2, np = cv2_module, numpy_module

    probe = np.full((240, 960, 3), 255, dtype=np.uint8)
    cv2.putText(probe, "LOCAL GALLERY 2026", (36, 150), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 0), 4, cv2.LINE_AA)
    ocr_result = load_ocr_engine()(probe)
    if not ocr_result.txts:
        raise RuntimeError("OCR smoke image produced no text")

    load_face_models()
    face_detector.setInputSize((320, 320))
    face_detector.detect(np.full((320, 320, 3), 255, dtype=np.uint8))
    face_feature = face_recognizer.feature(np.zeros((112, 112, 3), dtype=np.uint8)).reshape(-1)
    if face_feature.size != 128 or not np.isfinite(face_feature).all():
        raise RuntimeError("SFace inference returned an invalid feature")
    print(json.dumps({"ok": True, "ocrText": " ".join(ocr_result.txts), "faceEmbeddingDimension": int(face_feature.size)}, ensure_ascii=False))


def process(request: dict) -> dict:
    action = request.get("action")
    if action == "status":
        return {"status": status()}
    if action == "ocr_images":
        if not ocr_module_status()["ready"]:
            return {"error": ocr_module_status().get("error", "ocr_dependencies_missing")}
        return run_image_analysis(request.get("paths"), analyze_ocr_image)
    if action == "face_images":
        if not face_module_status()["ready"]:
            return {"error": face_module_status().get("error", "face_dependencies_missing")}
        return run_image_analysis(request.get("paths"), analyze_face_image)
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


def configure_worker_stdio() -> None:
    for stream in (sys.stdin, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")


def main() -> None:
    global torch, runtime_error, device, clip, Image
    configure_worker_stdio()
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
    if len(sys.argv) > 2 and sys.argv[2] == "--verify-install":
        try:
            verify_installation()
        except Exception as error:
            sys.stderr.write(f"安装验证失败: {error}\n")
            raise SystemExit(1) from error
        return
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
