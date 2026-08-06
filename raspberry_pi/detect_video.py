"""
detect_video.py — Run the SAR person detector over a video file and write an
annotated copy (bounding boxes + confidence + a running detection counter).

Made for demos on recorded aerial/thermal SAR footage: point it at an .mp4,
pick a model, and it produces a side-by-side-ready annotated video plus a JSON
timeline of detections. Works with the same AIDetector pipeline the drone
runs, including SAHI-style tiling for high-resolution footage.

Examples (from raspberry_pi/):
  # thermal helicopter footage with a custom-trained model
  python detect_video.py --input flir_clip.mp4 --model models/your_model.pt

  # high-res footage with tiling, sampling every 2nd frame
  python detect_video.py --input 4k_sweep.mp4 --model models/your_model.pt \
      --tiled --frame-step 2

Notes for thermal footage: the models are RGB-trained, so white-hot mode
(bright people on dark ground) works best; try --conf 0.20 if recall is low,
and expect better results than black-hot or rainbow palettes.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import List, Optional

log = logging.getLogger("detect_video")

try:
    import numpy as np
except ImportError:
    print("numpy is required: pip install numpy", file=sys.stderr)
    sys.exit(1)

try:
    import cv2
except ImportError:
    print("OpenCV is required: pip install opencv-python", file=sys.stderr)
    sys.exit(1)

try:
    from ai_detector import AIDetector, Detection
except ImportError as exc:
    print(f"Could not import ai_detector ({exc}); run from the raspberry_pi/ directory.", file=sys.stderr)
    sys.exit(1)

BOX_COLOR = (0, 255, 0)
HUD_COLOR = (200, 240, 255)


def annotate(
    frame: np.ndarray,
    detections: List[Detection],
    frame_idx: int,
    timestamp_s: float,
    inference_ms: float,
    backend: str,
    total_hits: int,
) -> np.ndarray:
    out = frame.copy()
    scale = max(0.5, out.shape[1] / 1280.0)  # keep text readable at any resolution
    thickness = max(1, round(2 * scale))

    for det in detections:
        x, y, w, h = det.bbox
        cv2.rectangle(out, (x, y), (x + w, y + h), BOX_COLOR, thickness)
        label = f"PERSON {det.confidence * 100:.0f}%"
        cv2.putText(
            out, label, (x, max(int(16 * scale), y - 6)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5 * scale, BOX_COLOR, thickness, cv2.LINE_AA,
        )

    hud = (
        f"t={timestamp_s:6.1f}s  frame {frame_idx}  "
        f"{len(detections)} in frame / {total_hits} total  "
        f"{backend} {inference_ms:.0f}ms"
    )
    cv2.putText(
        out, hud, (int(10 * scale), out.shape[0] - int(12 * scale)),
        cv2.FONT_HERSHEY_SIMPLEX, 0.55 * scale, HUD_COLOR, thickness, cv2.LINE_AA,
    )
    return out


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Annotate a video with SAR person detections.")
    parser.add_argument("--input", required=True, type=Path, help="Input video file.")
    parser.add_argument("--output", type=Path, default=None,
                        help="Output video path (default: <input>_detected.mp4).")
    parser.add_argument("--model", default=None, help="YOLO weights (.pt); default stock yolov8n.")
    parser.add_argument("--backend", default="yolo", choices=["auto", "yolo", "mobilenet", "hog"])
    parser.add_argument("--conf", type=float, default=0.30, help="Confidence threshold (default: 0.30).")
    parser.add_argument("--imgsz", type=int, default=640, help="YOLO inference size (default: 640).")
    parser.add_argument("--tiled", action="store_true", help="SAHI-style sliced inference (high-res footage).")
    parser.add_argument("--tile-size", type=int, default=640)
    parser.add_argument("--tile-overlap", type=float, default=0.2)
    parser.add_argument("--frame-step", type=int, default=1,
                        help="Run detection every Nth frame; skipped frames reuse the last boxes (default: 1).")
    parser.add_argument("--max-frames", type=int, default=None, help="Stop after N source frames.")
    parser.add_argument("--timeline", type=Path, default=None,
                        help="Write a JSON timeline of detections to this path.")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    args = parse_args(argv)

    if not args.input.is_file():
        print(f"Input video not found: {args.input}", file=sys.stderr)
        return 1
    output = args.output or args.input.with_name(f"{args.input.stem}_detected.mp4")

    capture = cv2.VideoCapture(str(args.input))
    if not capture.isOpened():
        print(f"Could not open video: {args.input}", file=sys.stderr)
        return 1

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    log.info("Input: %s  %dx%d @ %.1f fps, %d frames", args.input.name, width, height, fps, frame_count)

    detector = AIDetector(
        camera_stream=None,
        confidence_threshold=args.conf,
        annotate_frame=False,
        model_path=args.model,
        backend=args.backend,
        inference_size=args.imgsz,
        tiling=args.tiled,
        tile_size=args.tile_size,
        tile_overlap=args.tile_overlap,
    )
    try:
        backend = detector.initialize()
    except RuntimeError as exc:
        print(f"Detector initialization failed: {exc}", file=sys.stderr)
        return 1
    log.info("Backend: %s  model: %s  tiled: %s", backend, args.model or "(default)", args.tiled)

    writer = cv2.VideoWriter(str(output), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        print(f"Could not open output for writing: {output}", file=sys.stderr)
        return 1

    timeline: List[dict] = []
    detections: List[Detection] = []
    inference_ms = 0.0
    total_hits = 0
    frame_idx = 0

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if args.max_frames is not None and frame_idx >= args.max_frames:
                break

            timestamp_s = frame_idx / fps
            if frame_idx % max(1, args.frame_step) == 0:
                started = time.perf_counter()
                detections = detector.detect_tiled(frame) if args.tiled else detector.detect(frame)
                inference_ms = (time.perf_counter() - started) * 1000.0
                total_hits += len(detections)
                if detections:
                    timeline.append(
                        {
                            "frame": frame_idx,
                            "time_s": round(timestamp_s, 2),
                            "inference_ms": round(inference_ms, 1),
                            "detections": [det.to_dict() for det in detections],
                        }
                    )

            writer.write(annotate(frame, detections, frame_idx, timestamp_s, inference_ms, backend, total_hits))
            frame_idx += 1
            if frame_idx % 100 == 0:
                log.info("Processed %d / %d frames...", frame_idx, frame_count)
    finally:
        capture.release()
        writer.release()

    log.info("Wrote %s (%d frames, %d detection events).", output, frame_idx, len(timeline))
    if args.timeline:
        args.timeline.write_text(json.dumps({"video": str(args.input), "events": timeline}, indent=1))
        log.info("Wrote timeline to %s", args.timeline)

    print(f"\nDone: {output}")
    print(f"Frames: {frame_idx}   frames with detections: {len(timeline)}   total boxes: {total_hits}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
