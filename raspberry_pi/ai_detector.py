"""
ai_detector.py — Real-time person detection for SAR drone.

Supports three backends, auto-selected at startup (best available first):
  1. YOLOv8n (ultralytics) — primary; ~800ms/frame on Pi 4, ~60ms on Jetson Nano
  2. MobileNet SSD (OpenCV DNN) — fallback, no ultralytics dependency needed
  3. HOG+SVM (OpenCV) — emergency fallback, no external models needed

The camera on a SAR drone faces downward, so people appear small and
foreshortened. Inference frames are resized to 320x320 for YOLO, which is
fast and adequate for aerial footage. For truly good aerial detection, use
weights fine-tuned on a top-down dataset such as VisDrone — see
https://github.com/ultralytics/ultralytics for training instructions, then
pass the resulting .pt file via `model_path`.
"""

from __future__ import annotations

import base64
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np

try:
    import cv2
except Exception:  # pragma: no cover - optional dependency
    cv2 = None

log = logging.getLogger("ai_detector")

YOLO_INFERENCE_SIZE = 320
MOBILENET_PERSON_CLASS = 15
HIGH_CONFIDENCE = 0.8


@dataclass
class Detection:
    label: str
    confidence: float
    bbox: Tuple[int, int, int, int]  # x, y, w, h in pixels (relative to frame)
    bbox_norm: Tuple[float, float, float, float]  # normalized 0-1

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "confidence": round(float(self.confidence), 3),
            "bbox": [int(v) for v in self.bbox],
            "bbox_norm": [round(float(v), 4) for v in self.bbox_norm],
        }


@dataclass
class DetectionResult:
    detections: List[Detection]
    frame_jpeg: Optional[bytes]  # annotated frame as JPEG bytes
    inference_ms: float
    backend: str
    timestamp: float = field(default_factory=time.time)

    @property
    def frame_jpeg_b64(self) -> Optional[str]:
        if self.frame_jpeg is None:
            return None
        return base64.b64encode(self.frame_jpeg).decode("ascii")


class AIDetector:
    """
    Thread-safe detector. Call start() once, then get_latest_result()
    in a loop. Internally runs inference on a background thread.
    """

    def __init__(
        self,
        camera_stream=None,  # CameraStream from video_server.py; optional for offline detect()
        confidence_threshold: float = 0.45,
        inference_interval_s: float = 0.5,  # run inference every N seconds
        annotate_frame: bool = True,  # draw boxes on JPEG output
        model_path: Optional[str] = None,  # path to custom YOLO weights
        jpeg_quality: int = 60,
        backend: str = "auto",  # "auto", "yolo", "mobilenet", "hog"
        thermal_camera=None,  # Optional ThermalCamera (thermal.py)
        inference_size: int = YOLO_INFERENCE_SIZE,  # YOLO inference resolution (square)
        tiling: bool = False,  # SAHI-style sliced inference for small/distant people
        tile_size: int = 640,  # tile edge in source pixels; only useful when frames exceed this
        tile_overlap: float = 0.2,  # fractional overlap between adjacent tiles
    ) -> None:
        self.camera_stream = camera_stream
        self.confidence_threshold = confidence_threshold
        self.inference_interval_s = max(0.05, inference_interval_s)
        self.annotate_frame = annotate_frame
        self.model_path = model_path or None
        self.jpeg_quality = max(20, min(95, jpeg_quality))
        self.requested_backend = (backend or "auto").strip().lower()
        self.thermal_camera = thermal_camera
        self.inference_size = int(inference_size)
        self.tiling = bool(tiling)
        self.tile_size = max(64, int(tile_size))
        self.tile_overlap = min(0.9, max(0.0, float(tile_overlap)))
        # "normal" or "thermal" — toggled remotely via set_camera_mode command.
        self.thermal_mode: str = "normal"

        self.backend_name: str = "none"
        self._model = None
        self._latest_result: Optional[DetectionResult] = None
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    # ------------------------------------------------------------------ API

    def initialize(self) -> str:
        """
        Load and select the detection backend. Returns the backend name chosen.

        Safe to call without a camera and without starting the inference thread;
        this is the entry point used by offline, single-frame evaluation. start()
        calls it internally, so live behavior is unchanged.
        """
        if cv2 is None:
            raise RuntimeError("OpenCV is required for AI detection but is not installed.")

        self.backend_name = self._select_backend()
        log.info("AI detector backend: %s", self.backend_name)
        return self.backend_name

    def detect(self, frame: np.ndarray) -> List[Detection]:
        """
        Run person detection on a single frame using the initialized backend.

        Requires initialize() (or start()) to have been called first. Unlike the
        threaded loop, this does not touch the camera, thermal boost, annotation,
        or shared state — it is a pure frame-in / detections-out call.
        """
        if self.backend_name == "yolov8n":
            return self._detect_yolo(frame)
        if self.backend_name == "mobilenet-ssd":
            return self._detect_mobilenet(frame)
        if self.backend_name == "hog-svm":
            return self._detect_hog(frame)
        raise RuntimeError("Detector not initialized; call initialize() or start() first.")

    def detect_tiled(self, frame: np.ndarray, include_full_frame: bool = True) -> List[Detection]:
        """
        SAHI-style sliced detection: run the backend on overlapping tiles of the
        frame (plus, by default, one full-frame pass for large subjects), map the
        boxes back to frame coordinates, and merge duplicates with NMS.

        People far below a drone occupy few pixels; slicing keeps them large
        relative to the network input. Costs one inference per tile, so this only
        pays off when the frame is meaningfully larger than tile_size — otherwise
        it degrades to a single detect() call.
        """
        frame_h, frame_w = frame.shape[:2]
        tiles = _compute_tiles(frame_w, frame_h, self.tile_size, self.tile_overlap)
        if len(tiles) <= 1:
            return self.detect(frame)

        detections: List[Detection] = []
        if include_full_frame:
            detections.extend(self.detect(frame))

        for x0, y0, x1, y1 in tiles:
            for det in self.detect(frame[y0:y1, x0:x1]):
                bx, by, bw, bh = det.bbox
                detections.append(
                    self._make_detection(
                        det.label, det.confidence,
                        x0 + bx, y0 + by, x0 + bx + bw, y0 + by + bh,
                        frame_w, frame_h,
                    )
                )

        return _nms_detections(detections, iou_threshold=0.5)

    def start(self) -> str:
        """Start the inference loop. Returns the backend name chosen."""
        if cv2 is None:
            raise RuntimeError("OpenCV is required for AI detection but is not installed.")

        if self._thread and self._thread.is_alive():
            return self.backend_name

        self.initialize()

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._inference_loop, name="ai-inference", daemon=True)
        self._thread.start()
        return self.backend_name

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=3.0)

    def get_latest_result(self) -> Optional[DetectionResult]:
        """Thread-safe. Returns None if no inference has completed yet."""
        with self._lock:
            return self._latest_result

    # ------------------------------------------------------- backend setup

    def _select_backend(self) -> str:
        order = {
            "auto": ("yolo", "mobilenet", "hog"),
            "yolo": ("yolo",),
            "mobilenet": ("mobilenet",),
            "hog": ("hog",),
        }.get(self.requested_backend, ("yolo", "mobilenet", "hog"))

        for name in order:
            try:
                if name == "yolo" and self._init_yolo():
                    return "yolov8n"
                if name == "mobilenet" and self._init_mobilenet():
                    return "mobilenet-ssd"
                if name == "hog" and self._init_hog():
                    return "hog-svm"
            except Exception:
                log.exception("Failed to initialize %s backend; trying next.", name)

        raise RuntimeError("No AI detection backend could be initialized.")

    def _init_yolo(self) -> bool:
        try:
            from ultralytics import YOLO
        except ImportError:
            log.info("ultralytics not installed; skipping YOLO backend.")
            return False

        weights = self.model_path or "yolov8n.pt"
        self._model = YOLO(weights)
        # Warm up once so the first live frame is not slow.
        self._model.predict(
            np.zeros((self.inference_size, self.inference_size, 3), dtype=np.uint8),
            conf=self.confidence_threshold,
            classes=[0],
            imgsz=self.inference_size,
            verbose=False,
        )
        return True

    def _init_mobilenet(self) -> bool:
        models_dir = Path(__file__).resolve().parent / "models"
        prototxt = models_dir / "MobileNetSSD_deploy.prototxt"
        caffemodel = models_dir / "MobileNetSSD_deploy.caffemodel"
        if not prototxt.is_file() or not caffemodel.is_file():
            log.info("MobileNet SSD weights not found in %s; see models/README.md.", models_dir)
            return False

        self._model = cv2.dnn.readNetFromCaffe(str(prototxt), str(caffemodel))
        return True

    def _init_hog(self) -> bool:
        if not hasattr(cv2, "HOGDescriptor"):
            # Removed from the main namespace in OpenCV 5.x; requirements.txt
            # pins 4.10 where it exists.
            log.info("cv2.HOGDescriptor not available in this OpenCV build; skipping HOG backend.")
            return False

        hog = cv2.HOGDescriptor()
        hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        self._model = hog
        return True

    # ------------------------------------------------------ inference loop

    def _inference_loop(self) -> None:
        while not self._stop_event.is_set():
            started = time.monotonic()
            try:
                self._run_one_inference()
            except Exception:
                # Never let a single bad frame kill the loop.
                log.exception("Inference iteration failed; continuing.")

            elapsed = time.monotonic() - started
            self._stop_event.wait(max(0.05, self.inference_interval_s - elapsed))

    def _run_one_inference(self) -> None:
        frame = self._grab_frame()
        if frame is None:
            return

        started = time.monotonic()
        detections = self.detect_tiled(frame) if self.tiling else self.detect(frame)
        inference_ms = (time.monotonic() - started) * 1000.0

        detections = self._apply_thermal_boost(frame, detections)

        frame_jpeg = None
        if self.annotate_frame:
            annotated = self._annotate(frame, detections, inference_ms)
            ok, encoded = cv2.imencode(
                ".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality]
            )
            if ok:
                frame_jpeg = encoded.tobytes()

        result = DetectionResult(
            detections=detections,
            frame_jpeg=frame_jpeg,
            inference_ms=inference_ms,
            backend=self.backend_name,
        )
        with self._lock:
            self._latest_result = result

    def _grab_frame(self) -> Optional[np.ndarray]:
        jpeg = self.camera_stream.get_jpeg()
        if jpeg is None:
            return None

        frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        return frame

    # ---------------------------------------------------------- detectors

    def _detect_yolo(self, frame: np.ndarray) -> List[Detection]:
        results = self._model.predict(
            frame,
            conf=self.confidence_threshold,
            classes=[0],  # class 0 = person
            imgsz=self.inference_size,
            verbose=False,
        )
        detections: List[Detection] = []
        frame_h, frame_w = frame.shape[:2]

        for result in results:
            if result.boxes is None:
                continue
            for box in result.boxes:
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
                confidence = float(box.conf[0])
                detections.append(self._make_detection("person", confidence, x1, y1, x2, y2, frame_w, frame_h))

        return detections

    def _detect_mobilenet(self, frame: np.ndarray) -> List[Detection]:
        frame_h, frame_w = frame.shape[:2]
        blob = cv2.dnn.blobFromImage(
            cv2.resize(frame, (300, 300)), 0.007843, (300, 300), 127.5
        )
        self._model.setInput(blob)
        output = self._model.forward()

        detections: List[Detection] = []
        for i in range(output.shape[2]):
            confidence = float(output[0, 0, i, 2])
            class_id = int(output[0, 0, i, 1])
            if class_id != MOBILENET_PERSON_CLASS or confidence < self.confidence_threshold:
                continue

            x1 = output[0, 0, i, 3] * frame_w
            y1 = output[0, 0, i, 4] * frame_h
            x2 = output[0, 0, i, 5] * frame_w
            y2 = output[0, 0, i, 6] * frame_h
            detections.append(self._make_detection("person", confidence, x1, y1, x2, y2, frame_w, frame_h))

        return detections

    def _detect_hog(self, frame: np.ndarray) -> List[Detection]:
        frame_h, frame_w = frame.shape[:2]
        rects, weights = self._model.detectMultiScale(
            frame, winStride=(8, 8), padding=(4, 4), scale=1.05
        )

        detections: List[Detection] = []
        for (x, y, w, h), weight in zip(rects, np.asarray(weights).flatten()):
            # HOG weights are SVM scores, not probabilities; squash to 0-1.
            confidence = float(min(1.0, max(0.0, weight / 2.0)))
            if confidence < self.confidence_threshold:
                continue
            detections.append(self._make_detection("person", confidence, x, y, x + w, y + h, frame_w, frame_h))

        return detections

    @staticmethod
    def _make_detection(
        label: str,
        confidence: float,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        frame_w: int,
        frame_h: int,
    ) -> Detection:
        x1 = max(0.0, min(x1, frame_w - 1.0))
        y1 = max(0.0, min(y1, frame_h - 1.0))
        x2 = max(x1 + 1.0, min(x2, float(frame_w)))
        y2 = max(y1 + 1.0, min(y2, float(frame_h)))
        w = x2 - x1
        h = y2 - y1
        return Detection(
            label=label,
            confidence=float(confidence),
            bbox=(int(x1), int(y1), int(w), int(h)),
            bbox_norm=(x1 / frame_w, y1 / frame_h, w / frame_w, h / frame_h),
        )

    # ------------------------------------------------------------ thermal

    def _apply_thermal_boost(self, frame: np.ndarray, detections: List[Detection]) -> List[Detection]:
        """Boost confidence of detections that overlap thermal hotspots."""
        if self.thermal_camera is None:
            return detections

        try:
            hotspots = self.thermal_camera.get_hotspots(frame.shape[1], frame.shape[0])
        except Exception:
            log.exception("Thermal hotspot read failed; skipping boost.")
            return detections

        if not hotspots:
            return detections

        boosted: List[Detection] = []
        for det in detections:
            if any(_boxes_overlap(det.bbox, spot) for spot in hotspots):
                boosted.append(
                    Detection(
                        label=det.label,
                        confidence=min(1.0, det.confidence + 0.15),
                        bbox=det.bbox,
                        bbox_norm=det.bbox_norm,
                    )
                )
            else:
                boosted.append(det)
        return boosted

    # --------------------------------------------------------- annotation

    def _annotate(self, frame: np.ndarray, detections: List[Detection], inference_ms: float) -> np.ndarray:
        annotated = frame.copy()

        if self.thermal_mode == "thermal" and self.thermal_camera is not None:
            try:
                annotated = self.thermal_camera.overlay_on_rgb(annotated)
            except Exception:
                log.exception("Thermal overlay failed; using RGB frame.")

        high_confidence = any(det.confidence > HIGH_CONFIDENCE for det in detections)
        if high_confidence:
            red = np.zeros_like(annotated)
            red[:, :, 2] = 255
            annotated = cv2.addWeighted(annotated, 0.85, red, 0.15, 0)

        for det in detections:
            x, y, w, h = det.bbox
            cv2.rectangle(annotated, (x, y), (x + w, y + h), (0, 255, 0), 2)
            label = f"{det.label.upper()} {det.confidence * 100:.0f}%"
            cv2.putText(
                annotated,
                label,
                (x, max(14, y - 6)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 255, 0),
                1,
                cv2.LINE_AA,
            )

        footer = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {self.backend_name}  {inference_ms:.0f}ms"
        cv2.putText(
            annotated,
            footer,
            (8, annotated.shape[0] - 10),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (200, 240, 255),
            1,
            cv2.LINE_AA,
        )
        return annotated


def _boxes_overlap(a: Tuple[int, int, int, int], b: Tuple[int, int, int, int]) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah


def _compute_tiles(
    frame_w: int, frame_h: int, tile_size: int, overlap: float
) -> List[Tuple[int, int, int, int]]:
    """Overlapping tile grid as (x0, y0, x1, y1); a single tile if the frame fits."""
    if frame_w <= tile_size and frame_h <= tile_size:
        return [(0, 0, frame_w, frame_h)]

    stride = max(1, int(tile_size * (1.0 - overlap)))

    def _positions(extent: int) -> List[int]:
        if extent <= tile_size:
            return [0]
        positions = list(range(0, extent - tile_size, stride))
        positions.append(extent - tile_size)  # flush-fit final tile, no padding
        return sorted(set(positions))

    return [
        (x, y, min(x + tile_size, frame_w), min(y + tile_size, frame_h))
        for y in _positions(frame_h)
        for x in _positions(frame_w)
    ]


def _nms_detections(detections: List[Detection], iou_threshold: float = 0.5) -> List[Detection]:
    """Greedy NMS over pixel bboxes; keeps the highest-confidence duplicate."""
    if len(detections) <= 1:
        return detections

    boxes = np.asarray([det.bbox for det in detections], dtype=np.float64)
    x1, y1 = boxes[:, 0], boxes[:, 1]
    x2, y2 = x1 + boxes[:, 2], y1 + boxes[:, 3]
    areas = boxes[:, 2] * boxes[:, 3]
    order = np.argsort([-det.confidence for det in detections])

    keep: List[int] = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        rest = order[1:]
        inter_w = np.maximum(0.0, np.minimum(x2[i], x2[rest]) - np.maximum(x1[i], x1[rest]))
        inter_h = np.maximum(0.0, np.minimum(y2[i], y2[rest]) - np.maximum(y1[i], y1[rest]))
        inter = inter_w * inter_h
        union = areas[i] + areas[rest] - inter
        iou = np.where(union > 0, inter / union, 0.0)
        order = rest[iou <= iou_threshold]

    return [detections[i] for i in keep]


if __name__ == "__main__":
    import argparse

    from video_server import CameraStream

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

    parser = argparse.ArgumentParser(description="Run the AI detector standalone against a camera.")
    parser.add_argument("--camera-source", default="0", help="Camera index or path")
    parser.add_argument("--backend", default="auto", choices=["auto", "yolo", "mobilenet", "hog"])
    parser.add_argument("--fake-video", action="store_true", help="Use generated test frames")
    args = parser.parse_args()

    source = int(args.camera_source) if args.camera_source.isdigit() else args.camera_source
    camera = CameraStream(source=source, fake_video=args.fake_video)
    camera.start()

    detector = AIDetector(camera, backend=args.backend)
    chosen = detector.start()
    print(f"Backend: {chosen}. Press Ctrl+C to stop.")

    try:
        while True:
            time.sleep(1.0)
            result = detector.get_latest_result()
            if result:
                print(
                    f"[{result.backend}] {len(result.detections)} detections, "
                    f"{result.inference_ms:.0f}ms"
                )
    except KeyboardInterrupt:
        detector.stop()
        camera.stop()
