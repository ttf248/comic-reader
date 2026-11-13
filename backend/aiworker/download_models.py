"""Download the pinned AI model files and verify their SHA256 digests."""

from __future__ import annotations

import hashlib
import os
import sys
import time
import urllib.request
from pathlib import Path

from model_cache import resolve_model_dir


MODELS = (
    (
        "Chinese-CLIP",
        "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/957be8390cef5bab9ddd2dd36ca81a8622f966e7/clip_cn_vit-b-16.pt?download=true",
        "clip_cn_vit-b-16.pt",
        "5997ef32c50de18f3ac06eb5d746c324a639053c3bed8f2986f97ebb22b2ecde",
    ),
    (
        "YuNet 人脸检测",
        "https://huggingface.co/opencv/opencv_zoo/resolve/d4938dfc9d4ec5d098bfa33e98b3f3345a236586/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "face/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    (
        "SFace 人脸特征",
        "https://huggingface.co/opencv/opencv_zoo/resolve/d4938dfc9d4ec5d098bfa33e98b3f3345a236586/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "face/face_recognition_sface_2021dec.onnx",
        "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    ),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(name: str, url: str, destination: Path, expected: str) -> None:
    if destination.is_file() and sha256(destination) == expected:
        print(f"[已就绪] {name}")
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".download")
    request = urllib.request.Request(url, headers={"User-Agent": "local-gallery-setup"})
    print(f"[下载] {name}（代理：{os.environ.get('https_proxy', '系统设置')}）")
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(request, timeout=90) as response, partial.open("wb") as target:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
            if sha256(partial) != expected:
                raise ValueError(f"{name} SHA256 校验失败")
            partial.replace(destination)
            break
        except Exception:
            partial.unlink(missing_ok=True)
            if attempt == 4:
                raise
            time.sleep(attempt * 2)
    print(f"[完成] {name}")


def main() -> int:
    model_dir = resolve_model_dir()
    for name, url, relative_path, digest in MODELS:
        download(name, url, model_dir / relative_path, digest)
    print(f"模型目录：{model_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"[错误] {error}", file=sys.stderr)
        raise SystemExit(1)
