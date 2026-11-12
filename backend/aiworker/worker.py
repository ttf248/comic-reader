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
model_device = None
preprocess = None
clip = None
torch = None
Image = None
device = "cpu"
runtime_error = ""
model_validation = None
rapid_ocr = {}
face_models = {}
cuda_dll_handles = []
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
    cuda_provider_available = False
    try:
        import onnxruntime
        cuda_provider_available = "CUDAExecutionProvider" in onnxruntime.get_available_providers()
    except Exception:
        pass
    result = {
        "pythonAvailable": True,
        "pythonVersion": sys.version.split()[0],
        "device": device,
        "cudaAvailable": bool(torch is not None and torch.cuda.is_available()),
        "cudaExecutionProviderAvailable": cuda_provider_available,
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
        return {"ready": False, "version": "rapidocr-3.10.0-onnxruntime-1.20.2", "error": error}
    try:
        if (
            importlib.util.find_spec("rapidocr") is None
            or importlib.util.find_spec("onnxruntime") is None
            or importlib.util.find_spec("cv2") is None
        ):
            error = "ocr_dependencies_missing"
        else:
            version = importlib.metadata.version("rapidocr")
            try:
                runtime_version = importlib.metadata.version("onnxruntime-gpu")
            except importlib.metadata.PackageNotFoundError:
                runtime_version = importlib.metadata.version("onnxruntime")
            if version != "3.10.0" or runtime_version != "1.20.2":
                error = "ocr_dependency_version_mismatch"
    except Exception:
        error = "ocr_dependencies_missing"
    return {
        "ready": not error,
        "version": "rapidocr-3.10.0-onnxruntime-1.20.2",
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


def cuda_provider_available() -> bool:
    try:
        configure_cuda_dlls()
        import onnxruntime
        return "CUDAExecutionProvider" in onnxruntime.get_available_providers()
    except Exception:
        return False


def configure_cuda_dlls() -> None:
    if os.name != "nt" or cuda_dll_handles:
        return
    site_packages = Path(sys.prefix) / "Lib" / "site-packages"
    candidates = [site_packages / "torch" / "lib"]
    candidates.extend((site_packages / "nvidia").glob("*"))
    for candidate in candidates:
        if candidate.name != "lib" and candidate.is_dir():
            candidates.extend(candidate.glob("bin"))
    for directory in candidates:
        if directory.is_dir():
            try:
                cuda_dll_handles.append(os.add_dll_directory(str(directory)))
            except OSError:
                continue


def gpu_available(require_onnx: bool = False) -> bool:
    if torch is None or not torch.cuda.is_available():
        return False
    return not require_onnx or cuda_provider_available()


def load_model(device_mode: str = "auto") -> None:
    global clip, model, model_device, preprocess, torch, Image, device, runtime_error
    state = model_state()
    if not state.get("modelValid"):
        raise RuntimeError("model_missing_or_checksum_invalid")
    try:
        import torch as torch_module
        from PIL import Image as image_module
        import cn_clip.clip as clip_module
        from cn_clip.clip import load_from_name
    except Exception:
        runtime_error = "python_dependencies_missing"
        raise RuntimeError(runtime_error) from None
    torch, Image, clip = torch_module, image_module, clip_module
    if device_mode == "gpu" and not torch.cuda.is_available():
        raise RuntimeError("gpu_unavailable")
    target_device = "cuda" if device_mode == "gpu" or (device_mode == "auto" and torch.cuda.is_available()) else "cpu"
    if model is not None and model_device == target_device:
        device = target_device
        return
    model = None
    preprocess = None
    model_device = None
    device = target_device
    try:
        with contextlib.redirect_stdout(sys.stderr):
            model, preprocess = load_from_name("ViT-B-16", device=device, download_root=str(model_dir))
    except Exception as error:
        if device_mode == "auto" and device == "cuda" and "out of memory" in str(error).lower():
            torch.cuda.empty_cache()
            device = "cpu"
            with contextlib.redirect_stdout(sys.stderr):
                model, preprocess = load_from_name("ViT-B-16", device="cpu", download_root=str(model_dir))
        elif device_mode == "gpu":
            torch.cuda.empty_cache()
            raise RuntimeError("gpu_inference_failed") from None
        else:
            runtime_error = "model_load_failed"
            raise RuntimeError(runtime_error) from None
    model.eval()
    model_device = device


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


def run_with_fallback(items, encode, prepare, device_mode="auto"):
    global device, model, model_device
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
                    errors[index] = "gpu_inference_failed" if device_mode == "gpu" else "inference_failed"
                pending = pending[size:]
                continue
            torch.cuda.empty_cache()
            if size > 1:
                batch_size = max(1, size // 2)
                continue
            if device_mode == "gpu":
                errors[chunk[0]] = "gpu_out_of_memory"
                pending = pending[size:]
                continue
            device = "cpu"
            model = model.to("cpu").float()
            model_device = "cpu"
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


def load_ocr_engine(device_mode="cpu"):
    global rapid_ocr, ocr_runtime_error
    state = ocr_module_status()
    if not state["ready"]:
        ocr_runtime_error = state.get("error", "ocr_dependencies_missing")
        raise RuntimeError(ocr_runtime_error)
    mode = "gpu" if device_mode == "gpu" else "cpu"
    if mode == "gpu" and not gpu_available(require_onnx=True):
        raise RuntimeError("gpu_unavailable")
    if mode not in rapid_ocr:
        try:
            from rapidocr import RapidOCR
            params = {"EngineConfig.onnxruntime.use_cuda": mode == "gpu"}
            with contextlib.redirect_stdout(sys.stderr):
                rapid_ocr[mode] = RapidOCR(params=params)
        except Exception:
            if mode == "gpu":
                raise RuntimeError("gpu_inference_failed") from None
            ocr_runtime_error = "ocr_model_load_failed"
            raise RuntimeError(ocr_runtime_error) from None
    return rapid_ocr[mode]


def load_face_models(device_mode="cpu"):
    global face_models, cv2, np, face_runtime_error
    state = face_module_status()
    if not state["ready"]:
        face_runtime_error = state.get("error", "face_dependencies_missing")
        raise RuntimeError(face_runtime_error)
    mode = "gpu" if device_mode == "gpu" else "cpu"
    if mode == "gpu" and not gpu_available(require_onnx=True):
        raise RuntimeError("gpu_unavailable")
    if mode in face_models:
        return face_models[mode]
    try:
        import cv2 as cv2_module
        import numpy as numpy_module
        cv2, np = cv2_module, numpy_module
        detector_path = str(model_dir / "face" / YUNET_FILE)
        recognizer_path = str(model_dir / "face" / SFACE_FILE)
        if mode == "gpu":
            import onnxruntime
            detector = onnxruntime.InferenceSession(
                detector_path, providers=["CUDAExecutionProvider"]
            )
            recognizer = onnxruntime.InferenceSession(
                recognizer_path, providers=["CUDAExecutionProvider"]
            )
            if any(
                not session.get_providers()
                or session.get_providers()[0] != "CUDAExecutionProvider"
                for session in (detector, recognizer)
            ):
                raise RuntimeError("gpu_unavailable")
            face_models[mode] = {"device": mode, "detector": detector, "recognizer": recognizer}
        else:
            face_models[mode] = {
                "device": mode,
                "detector": cv2.FaceDetectorYN_create(detector_path, "", (320, 320), 0.65, 0.3, 5000),
                "recognizer": cv2.FaceRecognizerSF_create(recognizer_path, ""),
            }
    except RuntimeError:
        raise
    except Exception:
        if mode == "gpu":
            raise RuntimeError("gpu_inference_failed") from None
        face_runtime_error = "face_model_load_failed"
        raise RuntimeError(face_runtime_error) from None
    return face_models[mode]


def analyze_ocr_image(path: str, device_mode="cpu") -> dict:
    image = read_cv_image(path)
    if image is None:
        return {"data": None, "error": "image_unreadable"}
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = load_ocr_engine(device_mode)(image)
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
    except RuntimeError as error:
        code = str(error)
        if code in ("gpu_unavailable", "gpu_inference_failed"):
            return {"data": None, "error": code}
        return {"data": None, "error": "ocr_inference_failed"}
    except Exception:
        return {"data": None, "error": "gpu_inference_failed" if device_mode == "gpu" else "ocr_inference_failed"}


def tile_offsets(length, tile_size=640):
    if length <= tile_size:
        return [0]
    stride = tile_size - 128
    offsets = list(range(0, length - tile_size + 1, stride))
    final = length - tile_size
    if offsets[-1] != final:
        offsets.append(final)
    return offsets


def yunet_nms(faces, threshold=0.3, limit=5000):
    faces.sort(key=lambda face: face[14], reverse=True)
    kept = []
    for face in faces:
        x, y, width, height = face[:4]
        area = max(0.0, width) * max(0.0, height)
        suppressed = False
        for selected in kept:
            sx, sy, sw, sh = selected[:4]
            left, top = max(x, sx), max(y, sy)
            right, bottom = min(x + width, sx + sw), min(y + height, sy + sh)
            intersection = max(0.0, right - left) * max(0.0, bottom - top)
            selected_area = max(0.0, sw) * max(0.0, sh)
            union = area + selected_area - intersection
            if union > 0 and intersection / union > threshold:
                suppressed = True
                break
        if not suppressed:
            kept.append(face)
            if len(kept) >= limit:
                break
    return kept


def detect_yunet_gpu(image, session):
    input_meta = session.get_inputs()[0]
    outputs = {output.name: index for index, output in enumerate(session.get_outputs())}
    faces = []
    height, width = image.shape[:2]
    for top in tile_offsets(height):
        for left in tile_offsets(width):
            tile = image[top:min(top + 640, height), left:min(left + 640, width)]
            tile_height, tile_width = tile.shape[:2]
            if tile_height != 640 or tile_width != 640:
                tile = cv2.copyMakeBorder(
                    tile, 0, 640 - tile_height, 0, 640 - tile_width,
                    cv2.BORDER_CONSTANT, value=(0, 0, 0),
                )
            blob = cv2.dnn.blobFromImage(tile)
            predictions = session.run(None, {input_meta.name: blob})
            for stride in (8, 16, 32):
                cls = predictions[outputs[f"cls_{stride}"]].reshape(-1)
                obj = predictions[outputs[f"obj_{stride}"]].reshape(-1)
                bbox = predictions[outputs[f"bbox_{stride}"]].reshape(-1, 4)
                keypoints = predictions[outputs[f"kps_{stride}"]].reshape(-1, 10)
                columns = 640 // stride
                for index, (class_score, object_score) in enumerate(zip(cls, obj)):
                    score = float(np.sqrt(np.clip(class_score, 0.0, 1.0) * np.clip(object_score, 0.0, 1.0)))
                    if score < 0.65:
                        continue
                    row, column = divmod(index, columns)
                    center_x = (column + float(bbox[index, 0])) * stride
                    center_y = (row + float(bbox[index, 1])) * stride
                    box_width = float(np.exp(bbox[index, 2])) * stride
                    box_height = float(np.exp(bbox[index, 3])) * stride
                    face = [
                        center_x - box_width / 2 + left,
                        center_y - box_height / 2 + top,
                        box_width,
                        box_height,
                    ]
                    for point in range(5):
                        face.extend([
                            (float(keypoints[index, point * 2]) + column) * stride + left,
                            (float(keypoints[index, point * 2 + 1]) + row) * stride + top,
                        ])
                    face.append(score)
                    faces.append(face)
    return yunet_nms(faces)


def align_sface_crop(image, detection):
    source = np.asarray(detection[4:14], dtype=np.float64).reshape(5, 2)
    destination = np.asarray([
        [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
        [41.5493, 92.3655], [70.7299, 92.2041],
    ], dtype=np.float64)
    source_mean = source.mean(axis=0)
    destination_mean = np.asarray([56.0262, 71.9008], dtype=np.float64)
    source_centered = source - source_mean
    destination_centered = destination - destination_mean
    covariance = destination_centered.T @ source_centered / 5
    u, singular_values, vt = np.linalg.svd(covariance)
    signs = np.asarray([1.0, -1.0 if np.linalg.det(covariance) < 0 else 1.0])
    rotation = u @ np.diag(signs) @ vt
    variance = float(np.square(source_centered).sum() / 5)
    scale = float((singular_values * signs).sum() / variance)
    matrix = np.empty((2, 3), dtype=np.float64)
    matrix[:, :2] = scale * rotation
    matrix[:, 2] = destination_mean - scale * rotation @ source_mean
    return cv2.warpAffine(image, matrix, (112, 112), flags=cv2.INTER_LINEAR)


def analyze_face_image(path: str, device_mode="cpu") -> dict:
    image = read_cv_image(path)
    if image is None:
        return {"data": None, "error": "image_unreadable"}
    try:
        runtime = load_face_models(device_mode)
        original_height, original_width = image.shape[:2]
        scale = min(1.0, 2048.0 / max(original_width, original_height))
        if scale < 1.0:
            image = cv2.resize(image, (round(original_width * scale), round(original_height * scale)), interpolation=cv2.INTER_AREA)
        if runtime["device"] == "gpu":
            detections = detect_yunet_gpu(image, runtime["detector"])
        else:
            height, width = image.shape[:2]
            runtime["detector"].setInputSize((width, height))
            _, detections = runtime["detector"].detect(image)
        faces = []
        if detections is not None:
            for detection in detections:
                if runtime["device"] == "gpu":
                    aligned = align_sface_crop(image, detection)
                    blob = cv2.dnn.blobFromImage(aligned, 1.0, (112, 112), (0, 0, 0), True, False)
                    feature = runtime["recognizer"].run(
                        None, {runtime["recognizer"].get_inputs()[0].name: blob}
                    )[0].reshape(-1).astype(np.float32)
                else:
                    aligned = runtime["recognizer"].alignCrop(image, detection)
                    feature = runtime["recognizer"].feature(aligned).reshape(-1).astype(np.float32)
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
    except RuntimeError as error:
        code = str(error)
        if code in ("gpu_unavailable", "gpu_inference_failed"):
            return {"data": None, "error": code}
        return {"data": None, "error": "face_inference_failed"}
    except Exception:
        return {"data": None, "error": "gpu_inference_failed" if device_mode == "gpu" else "face_inference_failed"}


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
    ocr_result = load_ocr_engine("cpu")(probe)
    if not ocr_result.txts:
        raise RuntimeError("OCR smoke image produced no text")

    face_runtime = load_face_models("cpu")
    face_runtime["detector"].setInputSize((320, 320))
    face_runtime["detector"].detect(np.full((320, 320, 3), 255, dtype=np.uint8))
    face_feature = face_runtime["recognizer"].feature(np.zeros((112, 112, 3), dtype=np.uint8)).reshape(-1)
    if face_feature.size != 128 or not np.isfinite(face_feature).all():
        raise RuntimeError("SFace inference returned an invalid feature")

    gpu_verified = False
    if gpu_available(require_onnx=True):
        gpu_ocr_result = load_ocr_engine("gpu")(probe)
        if not gpu_ocr_result.txts:
            raise RuntimeError("GPU OCR smoke image produced no text")

        gpu_face_runtime = load_face_models("gpu")
        detector_input = cv2.dnn.blobFromImage(np.full((640, 640, 3), 255, dtype=np.uint8))
        detector_output = gpu_face_runtime["detector"].run(
            None,
            {gpu_face_runtime["detector"].get_inputs()[0].name: detector_input},
        )
        if len(detector_output) != 12:
            raise RuntimeError("GPU YuNet inference returned unexpected outputs")
        recognizer_input = cv2.dnn.blobFromImage(
            np.zeros((112, 112, 3), dtype=np.uint8), 1.0, (112, 112), (0, 0, 0), True, False
        )
        gpu_face_feature = gpu_face_runtime["recognizer"].run(
            None,
            {gpu_face_runtime["recognizer"].get_inputs()[0].name: recognizer_input},
        )[0].reshape(-1)
        if gpu_face_feature.size != 128 or not np.isfinite(gpu_face_feature).all():
            raise RuntimeError("GPU SFace inference returned an invalid feature")
        gpu_verified = True

    print(json.dumps({
        "ok": True,
        "ocrText": " ".join(ocr_result.txts),
        "faceEmbeddingDimension": int(face_feature.size),
        "gpuVerified": gpu_verified,
    }, ensure_ascii=False))


def process(request: dict) -> dict:
    action = request.get("action")
    if action == "status":
        return {"status": status()}
    device_mode = request.get("device", "auto")
    if device_mode not in ("auto", "cpu", "gpu"):
        return {"error": "invalid_device_mode"}
    if action == "ocr_images":
        if not ocr_module_status()["ready"]:
            return {"error": ocr_module_status().get("error", "ocr_dependencies_missing")}
        if device_mode == "gpu" and not gpu_available(require_onnx=True):
            return {"error": "gpu_unavailable", "status": status()}
        return run_image_analysis(request.get("paths"), lambda path: analyze_ocr_image(path, device_mode))
    if action == "face_images":
        if not face_module_status()["ready"]:
            return {"error": face_module_status().get("error", "face_dependencies_missing")}
        if device_mode == "gpu" and not gpu_available(require_onnx=True):
            return {"error": "gpu_unavailable", "status": status()}
        return run_image_analysis(request.get("paths"), lambda path: analyze_face_image(path, device_mode))
    if action not in ("embed_images", "embed_texts"):
        return {"error": "unknown_action"}
    if runtime_error:
        return {"error": runtime_error}
    if device_mode == "gpu" and not gpu_available():
        return {"error": "gpu_unavailable", "status": status()}
    try:
        load_model(device_mode)
    except Exception as error:
        code = str(error)
        if code in ("gpu_unavailable", "gpu_inference_failed", "model_missing_or_checksum_invalid", "python_dependencies_missing", "model_load_failed"):
            return {"error": code, "status": status()}
        return {"error": "model_load_failed", "status": status()}
    if action == "embed_images":
        paths = request.get("paths")
        if not isinstance(paths, list) or len(paths) > 32 or not all(isinstance(path, str) for path in paths):
            return {"error": "invalid_image_batch"}
        return {"items": run_with_fallback(paths, encode_image_batch, prepare_image, device_mode), "status": status()}
    texts = request.get("texts")
    if not isinstance(texts, list) or not texts or len(texts) > 64 or not all(isinstance(text, str) for text in texts):
        return {"error": "invalid_text_batch"}
    return {"items": run_with_fallback(texts, encode_text_batch, lambda text: text, device_mode), "status": status()}


def configure_worker_stdio() -> None:
    for stream in (sys.stdin, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")


def main() -> None:
    global torch, runtime_error, device, clip, Image
    configure_worker_stdio()
    configure_cuda_dlls()
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
