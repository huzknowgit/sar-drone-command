"""
eval_dataset.py — Offline accuracy harness for the SAR drone person detector.

Runs the AIDetector (raspberry_pi/ai_detector.py) over a labeled image dataset
in YOLO format (one .txt per image, lines of "class cx cy w h" normalized,
single class 0 = person) and reports detection accuracy. No camera or inference
thread is used: each image is fed straight through AIDetector.detect().

Detection is run once per image at a very low internal confidence so the raw
(confidence, bbox) predictions can be re-thresholded in software. From those raw
predictions the harness computes:

  * precision / recall / F1 at the --conf operating threshold (greedy IoU
    matching at --iou, highest-confidence predictions matched first),
  * AP@0.5 via the standard all-points precision-recall curve over
    confidence-ranked predictions across the whole dataset,
  * inference timing (mean / median ms per image),
  * totals: images, ground-truth boxes, and TP / FP / FN at the operating
    threshold.

Usage:
    python eval_dataset.py --images <dir> --labels <dir> \
        [--backend auto|yolo|mobilenet|hog] [--conf 0.45] [--imgsz 320] \
        [--iou 0.5] [--limit N] [--model weights.pt] \
        [--out results.json] [--md results.md]

Example (VisDrone val baseline):
    python eval_dataset.py \
        --images ../datasets/VisDrone2019-DET-val/images \
        --labels ../datasets/VisDrone2019-DET-val/labels \
        --backend yolo --imgsz 320 --conf 0.45
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

# ---- Defensive dependency imports (clear message instead of a traceback) ----

try:
    import numpy as np
except ImportError:
    print(
        "numpy is required for evaluation. Install it with: pip install numpy",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    import cv2
except ImportError:
    print(
        "OpenCV is required for evaluation. Install it with: pip install opencv-python",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from ai_detector import AIDetector, Detection
except ImportError as exc:  # pragma: no cover - environment/pathing issue
    print(
        f"Could not import ai_detector ({exc}). Run this script from the "
        "raspberry_pi/ directory (where ai_detector.py lives).",
        file=sys.stderr,
    )
    sys.exit(1)

log = logging.getLogger("eval_dataset")

# Internal confidence used at inference time. Kept far below any sane operating
# threshold so precision/recall/AP can be computed from the raw predictions.
LOW_CONF = 0.001

# AP is reported at the conventional IoU 0.5, independent of the --iou used for
# the precision/recall operating point.
AP_IOU = 0.5

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}
PERSON_CLASS = 0  # YOLO-format class id for "person"

# Bounding boxes are carried around as pixel-space (x1, y1, x2, y2).
BBox = Tuple[float, float, float, float]


@dataclass
class ImageResult:
    """Per-image evaluation record (serialized into the JSON output)."""

    image: str
    gt_count: int
    predictions: List[Tuple[float, Tuple[int, int, int, int]]]  # (conf, x,y,w,h px)
    inference_ms: float
    tp: int  # at the operating threshold
    fp: int
    fn: int


@dataclass
class Metrics:
    """Dataset-level metrics."""

    images: int
    gt_boxes: int
    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    f1: float
    ap50: float
    inference_ms_mean: float
    inference_ms_median: float

    def to_dict(self) -> dict:
        return {
            "images": self.images,
            "gt_boxes": self.gt_boxes,
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "ap50": round(self.ap50, 4),
            "inference_ms_mean": round(self.inference_ms_mean, 2),
            "inference_ms_median": round(self.inference_ms_median, 2),
        }


# ------------------------------------------------------------------ geometry


def _iou(a: BBox, b: BBox) -> float:
    """Intersection-over-union of two pixel-space (x1, y1, x2, y2) boxes."""
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    if union <= 0.0:
        return 0.0
    return inter / union


def _detection_to_xyxy(det: Detection) -> BBox:
    x, y, w, h = det.bbox
    return (float(x), float(y), float(x + w), float(y + h))


# --------------------------------------------------------------- data loading


def load_ground_truth(label_path: Path, img_w: int, img_h: int) -> List[BBox]:
    """
    Parse a YOLO-format label file into pixel-space (x1, y1, x2, y2) boxes.

    A missing file yields zero boxes (the image is still evaluated for false
    positives). Only class 0 (person) rows are kept.
    """
    boxes: List[BBox] = []
    if not label_path.is_file():
        return boxes

    for line in label_path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            cls = int(float(parts[0]))
            cx, cy, bw, bh = (float(v) for v in parts[1:5])
        except ValueError:
            log.warning("Skipping malformed label line in %s: %r", label_path.name, line)
            continue
        if cls != PERSON_CLASS:
            continue
        x1 = (cx - bw / 2.0) * img_w
        y1 = (cy - bh / 2.0) * img_h
        x2 = (cx + bw / 2.0) * img_w
        y2 = (cy + bh / 2.0) * img_h
        boxes.append((x1, y1, x2, y2))
    return boxes


def find_images(images_dir: Path) -> List[Path]:
    return sorted(
        p for p in images_dir.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    )


# ------------------------------------------------------------------- matching


def evaluate_image(
    preds: List[Tuple[float, BBox]],
    gts: List[BBox],
    conf_threshold: float,
    iou_threshold: float,
) -> Tuple[int, int, int]:
    """
    Greedy IoU matching at a single operating threshold. Highest-confidence
    predictions are matched first, each ground-truth box at most once.

    Returns (tp, fp, fn).
    """
    kept = sorted(
        (p for p in preds if p[0] >= conf_threshold),
        key=lambda p: p[0],
        reverse=True,
    )
    matched: set[int] = set()
    tp = 0
    fp = 0
    for _conf, pbox in kept:
        best_iou = 0.0
        best_j = -1
        for j, gbox in enumerate(gts):
            if j in matched:
                continue
            iou = _iou(pbox, gbox)
            if iou > best_iou:
                best_iou = iou
                best_j = j
        if best_j >= 0 and best_iou >= iou_threshold:
            tp += 1
            matched.add(best_j)
        else:
            fp += 1
    fn = len(gts) - len(matched)
    return tp, fp, fn


def compute_ap(
    all_preds: List[Tuple[float, int, BBox]],
    gts_per_image: List[List[BBox]],
    total_gt: int,
    iou_threshold: float,
) -> float:
    """
    Standard all-points (VOC 2010+) average precision over the whole dataset.

    Predictions are ranked by confidence across all images and matched greedily
    per image at `iou_threshold`; the resulting precision-recall curve is
    integrated with the continuous all-points method.
    """
    if total_gt == 0 or not all_preds:
        return 0.0

    order = sorted(range(len(all_preds)), key=lambda k: all_preds[k][0], reverse=True)
    matched: List[set] = [set() for _ in gts_per_image]

    tp = np.zeros(len(all_preds), dtype=np.float64)
    fp = np.zeros(len(all_preds), dtype=np.float64)

    for rank, k in enumerate(order):
        _conf, img_idx, pbox = all_preds[k]
        gts = gts_per_image[img_idx]
        best_iou = 0.0
        best_j = -1
        for j, gbox in enumerate(gts):
            if j in matched[img_idx]:
                continue
            iou = _iou(pbox, gbox)
            if iou > best_iou:
                best_iou = iou
                best_j = j
        if best_j >= 0 and best_iou >= iou_threshold:
            tp[rank] = 1.0
            matched[img_idx].add(best_j)
        else:
            fp[rank] = 1.0

    tp_cum = np.cumsum(tp)
    fp_cum = np.cumsum(fp)
    recall = tp_cum / float(total_gt)
    precision = tp_cum / np.maximum(tp_cum + fp_cum, np.finfo(np.float64).eps)

    # All-points interpolation: wrap with sentinels, make precision monotonic
    # non-increasing, then integrate over recall.
    mrec = np.concatenate(([0.0], recall, [1.0]))
    mpre = np.concatenate(([1.0], precision, [0.0]))
    for i in range(mpre.size - 1, 0, -1):
        mpre[i - 1] = max(mpre[i - 1], mpre[i])
    idx = np.where(mrec[1:] != mrec[:-1])[0]
    ap = float(np.sum((mrec[idx + 1] - mrec[idx]) * mpre[idx + 1]))
    return ap


# ----------------------------------------------------------------- reporting


def _safe_div(num: float, den: float) -> float:
    return num / den if den else 0.0


def build_metrics(
    results: List[ImageResult],
    all_preds: List[Tuple[float, int, BBox]],
    gts_per_image: List[List[BBox]],
    total_gt: int,
    timings: List[float],
) -> Metrics:
    tp = sum(r.tp for r in results)
    fp = sum(r.fp for r in results)
    fn = sum(r.fn for r in results)
    precision = _safe_div(tp, tp + fp)
    recall = _safe_div(tp, tp + fn)
    f1 = _safe_div(2.0 * precision * recall, precision + recall)
    ap50 = compute_ap(all_preds, gts_per_image, total_gt, AP_IOU)

    return Metrics(
        images=len(results),
        gt_boxes=total_gt,
        tp=tp,
        fp=fp,
        fn=fn,
        precision=precision,
        recall=recall,
        f1=f1,
        ap50=ap50,
        inference_ms_mean=statistics.mean(timings) if timings else 0.0,
        inference_ms_median=statistics.median(timings) if timings else 0.0,
    )


def print_summary(metrics: Metrics, args: argparse.Namespace, backend: str) -> None:
    rows = [
        ("Backend", backend),
        ("Inference size", str(args.imgsz)),
        ("Operating conf", f"{args.conf:.3f}"),
        ("Match IoU", f"{args.iou:.2f}"),
        ("Images", str(metrics.images)),
        ("Ground-truth boxes", str(metrics.gt_boxes)),
        ("True positives", str(metrics.tp)),
        ("False positives", str(metrics.fp)),
        ("False negatives", str(metrics.fn)),
        ("Precision", f"{metrics.precision:.4f}"),
        ("Recall", f"{metrics.recall:.4f}"),
        ("F1", f"{metrics.f1:.4f}"),
        (f"AP@{AP_IOU:.1f}", f"{metrics.ap50:.4f}"),
        ("Inference mean (ms)", f"{metrics.inference_ms_mean:.1f}"),
        ("Inference median (ms)", f"{metrics.inference_ms_median:.1f}"),
    ]
    width = max(len(name) for name, _ in rows)
    print("\n" + "=" * (width + 20))
    print("  Person-detection evaluation")
    print("=" * (width + 20))
    for name, value in rows:
        print(f"  {name.ljust(width)} : {value}")
    print("=" * (width + 20))


def write_json(
    path: Path,
    metrics: Metrics,
    results: List[ImageResult],
    args: argparse.Namespace,
    backend: str,
) -> None:
    payload = {
        "config": {
            "backend": backend,
            "requested_backend": args.backend,
            "images_dir": str(args.images),
            "labels_dir": str(args.labels),
            "conf": args.conf,
            "imgsz": args.imgsz,
            "iou": args.iou,
            "ap_iou": AP_IOU,
            "low_conf": LOW_CONF,
            "model_path": args.model,
            "tiled": args.tiled,
            "tile_size": args.tile_size if args.tiled else None,
            "tile_overlap": args.tile_overlap if args.tiled else None,
            "limit": args.limit,
        },
        "summary": metrics.to_dict(),
        "images": [
            {
                "image": r.image,
                "gt": r.gt_count,
                "predictions": [
                    [round(conf, 4), list(bbox)] for conf, bbox in r.predictions
                ],
                "inference_ms": round(r.inference_ms, 2),
                "tp": r.tp,
                "fp": r.fp,
                "fn": r.fn,
            }
            for r in results
        ],
    }
    path.write_text(json.dumps(payload, indent=2))
    log.info("Wrote full JSON results to %s", path)


def write_markdown(
    path: Path,
    metrics: Metrics,
    args: argparse.Namespace,
    backend: str,
) -> None:
    lines = [
        "# Person Detection Evaluation",
        "",
        f"- Backend: `{backend}`",
        f"- Dataset: `{args.images}`",
        f"- Images: {metrics.images}",
        f"- Ground-truth boxes: {metrics.gt_boxes}",
        f"- Inference size: {args.imgsz}",
        f"- Operating confidence: {args.conf:.3f}",
        f"- Match IoU: {args.iou:.2f}",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        f"| Precision | {metrics.precision:.4f} |",
        f"| Recall | {metrics.recall:.4f} |",
        f"| F1 | {metrics.f1:.4f} |",
        f"| AP@{AP_IOU:.1f} | {metrics.ap50:.4f} |",
        f"| TP / FP / FN | {metrics.tp} / {metrics.fp} / {metrics.fn} |",
        f"| Inference mean (ms) | {metrics.inference_ms_mean:.1f} |",
        f"| Inference median (ms) | {metrics.inference_ms_median:.1f} |",
        "",
    ]
    path.write_text("\n".join(lines))
    log.info("Wrote markdown summary to %s", path)


# ---------------------------------------------------------------------- main


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate the SAR drone person detector on a YOLO-format dataset.",
    )
    parser.add_argument("--images", required=True, type=Path, help="Directory of images.")
    parser.add_argument("--labels", required=True, type=Path, help="Directory of YOLO label .txt files.")
    parser.add_argument(
        "--backend", default="auto", choices=["auto", "yolo", "mobilenet", "hog"],
        help="Detection backend (default: auto).",
    )
    parser.add_argument("--conf", type=float, default=0.45, help="Operating confidence threshold (default: 0.45).")
    parser.add_argument("--imgsz", type=int, default=320, help="YOLO inference size (default: 320).")
    parser.add_argument("--iou", type=float, default=0.5, help="IoU threshold for matching (default: 0.5).")
    parser.add_argument("--limit", type=int, default=None, help="Evaluate at most N images.")
    parser.add_argument("--model", default=None, help="Optional custom YOLO weights (.pt) path.")
    parser.add_argument("--tiled", action="store_true", help="SAHI-style sliced inference (detect_tiled).")
    parser.add_argument("--tile-size", type=int, default=640, help="Tile edge in source pixels (default: 640).")
    parser.add_argument("--tile-overlap", type=float, default=0.2, help="Fractional tile overlap (default: 0.2).")
    parser.add_argument("--out", type=Path, default=None, help="Write full JSON results to this path.")
    parser.add_argument("--md", type=Path, default=None, help="Write a short markdown summary to this path.")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    args = parse_args(argv)

    if not args.images.is_dir():
        print(f"Images directory not found: {args.images}", file=sys.stderr)
        return 1
    if not args.labels.is_dir():
        print(f"Labels directory not found: {args.labels}", file=sys.stderr)
        return 1

    # The yolo backend hard-depends on ultralytics; fail early with guidance.
    if args.backend == "yolo" and importlib.util.find_spec("ultralytics") is None:
        print(
            "The 'yolo' backend requires ultralytics. Install it with: "
            "pip install ultralytics",
            file=sys.stderr,
        )
        return 1

    images = find_images(args.images)
    if not images:
        print(f"No images found in {args.images}", file=sys.stderr)
        return 1
    if args.limit is not None:
        images = images[: args.limit]

    detector = AIDetector(
        camera_stream=None,
        confidence_threshold=LOW_CONF,  # capture raw predictions; re-threshold in software
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

    log.info("Evaluating %d image(s) with backend '%s'.", len(images), backend)

    results: List[ImageResult] = []
    gts_per_image: List[List[BBox]] = []
    all_preds: List[Tuple[float, int, BBox]] = []
    timings: List[float] = []
    total_gt = 0

    for i, image_path in enumerate(images):
        frame = cv2.imread(str(image_path))
        if frame is None:
            log.warning("Could not read image %s; skipping.", image_path.name)
            continue

        img_h, img_w = frame.shape[:2]
        label_path = args.labels / (image_path.stem + ".txt")
        gts = load_ground_truth(label_path, img_w, img_h)

        started = time.perf_counter()
        detections = detector.detect_tiled(frame) if args.tiled else detector.detect(frame)
        inference_ms = (time.perf_counter() - started) * 1000.0

        preds: List[Tuple[float, BBox]] = [
            (float(det.confidence), _detection_to_xyxy(det)) for det in detections
        ]

        img_idx = len(gts_per_image)
        gts_per_image.append(gts)
        for conf, pbox in preds:
            all_preds.append((conf, img_idx, pbox))

        tp, fp, fn = evaluate_image(preds, gts, args.conf, args.iou)
        total_gt += len(gts)
        timings.append(inference_ms)

        results.append(
            ImageResult(
                image=image_path.name,
                gt_count=len(gts),
                predictions=[(float(det.confidence), det.bbox) for det in detections],
                inference_ms=inference_ms,
                tp=tp,
                fp=fp,
                fn=fn,
            )
        )

        if (i + 1) % 50 == 0:
            log.info("Processed %d / %d images...", i + 1, len(images))

    if not results:
        print("No images could be evaluated.", file=sys.stderr)
        return 1

    metrics = build_metrics(results, all_preds, gts_per_image, total_gt, timings)
    print_summary(metrics, args, backend)

    if args.out is not None:
        write_json(args.out, metrics, results, args, backend)
    if args.md is not None:
        write_markdown(args.md, metrics, args, backend)

    return 0


if __name__ == "__main__":
    sys.exit(main())
