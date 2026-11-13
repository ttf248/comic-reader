"""Resolve the model cache directory from the adjacent application config."""

from __future__ import annotations

import os
import re
from pathlib import Path


def resolve_model_dir() -> Path:
    worker_dir = Path(__file__).resolve().parent
    config_root = worker_dir.parent
    config_path = config_root / "config.yaml"
    cache_value = ".local-gallery"

    if config_path.is_file():
        for line in config_path.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^\s*cacheDir\s*:\s*(.*?)\s*$", line)
            if not match:
                continue
            cache_value = match.group(1).split(" #", 1)[0].strip()
            if len(cache_value) >= 2 and cache_value[0] == cache_value[-1] and cache_value[0] in "\"'":
                cache_value = cache_value[1:-1]
            if not cache_value:
                cache_value = ".local-gallery"
            break

    cache_root = Path(os.path.expandvars(os.path.expanduser(cache_value)))
    if not cache_root.is_absolute():
        cache_root = config_root / cache_root
    return (cache_root / "derived" / "ai" / "models").resolve()


if __name__ == "__main__":
    print(resolve_model_dir())
