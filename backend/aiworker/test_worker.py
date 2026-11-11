import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
original_argv = sys.argv
sys.argv = [str(Path(__file__).with_name("worker.py")), tempfile.gettempdir()]
import worker
sys.argv = original_argv


class FakeOutOfMemoryError(RuntimeError):
    pass


class FakeCuda:
    OutOfMemoryError = FakeOutOfMemoryError

    @staticmethod
    def empty_cache():
        return None

    @staticmethod
    def is_available():
        return False


class FakeTorch:
    cuda = FakeCuda()
    version = None
    __version__ = "2.7.1"


class FakeModel:
    def __init__(self):
        self.device = "cuda"
        self.is_float = False

    def to(self, device):
        self.device = device
        return self

    def float(self):
        self.is_float = True
        return self


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.originals = {
            "device": worker.device,
            "model": worker.model,
            "model_dir": worker.model_dir,
            "model_validation": worker.model_validation,
            "runtime_error": worker.runtime_error,
            "torch": worker.torch,
        }
        worker.device = "cuda"
        worker.model = FakeModel()
        worker.model_validation = None
        worker.runtime_error = ""
        worker.torch = FakeTorch()

    def tearDown(self):
        for name, value in self.originals.items():
            setattr(worker, name, value)

    def test_corrupted_model_checksum_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / worker.MODEL_FILE
            model_path.write_bytes(b"not a model")
            worker.model_dir = Path(directory)
            worker.model_validation = None

            state = worker.model_state()

        self.assertTrue(state["modelAvailable"])
        self.assertFalse(state["modelValid"])
        self.assertNotEqual(state["modelSha256"], worker.MODEL_SHA256)

    def test_unavailable_gpu_reports_cpu_fallback(self):
        worker.device = "cpu"
        worker.model = None
        worker.model_dir = Path(tempfile.gettempdir()) / "local-gallery-missing-model"
        worker.model_validation = None

        state = worker.status()

        self.assertTrue(state["runtimeReady"])
        self.assertFalse(state["cudaAvailable"])
        self.assertEqual("cpu", state["device"])

    def test_cuda_oom_reduces_image_batch_size(self):
        batch_sizes = []

        def encode(items):
            batch_sizes.append(len(items))
            if len(items) > 2:
                raise FakeOutOfMemoryError("CUDA out of memory")
            return [[1.0] + [0.0] * (worker.DIMENSION - 1) for _ in items]

        results = worker.run_with_fallback(["a", "b", "c", "d"], encode, lambda item: item)

        self.assertEqual([4, 2, 2], batch_sizes)
        self.assertTrue(all(not item["error"] and len(item["vector"]) == worker.DIMENSION for item in results))
        self.assertEqual("cuda", worker.device)

    def test_single_item_cuda_oom_retries_on_cpu(self):
        def encode(items):
            if worker.device == "cuda":
                raise FakeOutOfMemoryError("CUDA out of memory")
            return [[1.0] + [0.0] * (worker.DIMENSION - 1) for _ in items]

        results = worker.run_with_fallback(["a"], encode, lambda item: item)

        self.assertFalse(results[0]["error"])
        self.assertEqual(worker.DIMENSION, len(results[0]["vector"]))
        self.assertEqual("cpu", worker.device)
        self.assertEqual("cpu", worker.model.device)
        self.assertTrue(worker.model.is_float)

    def test_unreadable_image_does_not_abort_other_items(self):
        results = worker.run_with_fallback(
            ["bad", "good"],
            lambda items: [[1.0] + [0.0] * (worker.DIMENSION - 1) for _ in items],
            lambda item: (_ for _ in ()).throw(ValueError()) if item == "bad" else item,
        )

        self.assertEqual("image_unreadable", results[0]["error"])
        self.assertEqual(worker.DIMENSION, len(results[1]["vector"]))


if __name__ == "__main__":
    unittest.main()
