"""
thermal.py — Thermal imaging support for SAR drone.

Supported hardware:
  - AMG8833 (8x8 thermal grid, I2C, ~$40)
  - FLIR Lepton 2.5/3.5 (160x120 via PureThermal USB board, ~$200)
  - Software simulation fallback (generates a fake thermal overlay from RGB
    brightness — clearly labelled SIMULATED THERMAL)

Usage:
    from thermal import ThermalCamera, ThermalMode
    cam = ThermalCamera(mode=ThermalMode.AMG8833)
    cam.start()
    frame = cam.get_thermal_frame()          # (H, W, 3) uint8 BGR heatmap
    overlay = cam.overlay_on_rgb(rgb_frame)  # heatmap blended onto RGB
    hotspots = cam.get_hotspots(w, h)        # [(x, y, w, h), ...] pixel boxes
"""

from __future__ import annotations

import enum
import logging
import threading
import time
from typing import List, Optional, Tuple

import numpy as np

try:
    import cv2
except Exception:  # pragma: no cover - optional dependency
    cv2 = None

log = logging.getLogger("thermal")

AMG8833_I2C_ADDR = 0x69
AMG8833_PIXEL_REG = 0x80
AMG8833_GRID = 8
LEPTON_HOTSPOT_C = 32.0
SIM_BRIGHTNESS_THRESHOLD = 200
MIN_HOTSPOT_AREA_PX = 16


class ThermalMode(str, enum.Enum):
    AMG8833 = "amg8833"
    LEPTON = "lepton"
    SIMULATE = "simulate"


class ThermalCamera:
    """
    Thread-safe thermal frame source. In AMG8833/Lepton modes a background
    thread keeps the latest heatmap current; in SIMULATE mode frames are
    derived on demand from the RGB frame passed to overlay_on_rgb().
    """

    def __init__(
        self,
        mode: ThermalMode | str = ThermalMode.SIMULATE,
        i2c_bus: int = 1,
        device_path: str = "/dev/video1",
        hotspot_threshold_c: float = 35.0,
        output_size: Tuple[int, int] = (160, 120),  # (width, height)
    ) -> None:
        self.mode = ThermalMode(mode)
        self.i2c_bus = i2c_bus
        self.device_path = device_path
        self.hotspot_threshold_c = hotspot_threshold_c
        self.output_size = output_size

        self._bus = None
        self._capture = None
        self._latest_temps: Optional[np.ndarray] = None  # Celsius grid
        self._latest_frame: Optional[np.ndarray] = None  # BGR heatmap
        self._latest_hotspot_mask: Optional[np.ndarray] = None
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    # ------------------------------------------------------------------ API

    def start(self) -> None:
        if cv2 is None:
            raise RuntimeError("OpenCV is required for thermal imaging but is not installed.")

        if self.mode == ThermalMode.SIMULATE:
            log.info("Thermal camera in SIMULATED mode (no hardware).")
            return

        if self._thread and self._thread.is_alive():
            return

        if self.mode == ThermalMode.AMG8833:
            self._open_amg8833()
        elif self.mode == ThermalMode.LEPTON:
            self._open_lepton()

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._capture_loop, name="thermal-capture", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        if self._capture is not None:
            self._capture.release()
            self._capture = None
        if self._bus is not None:
            try:
                self._bus.close()
            except Exception:
                pass
            self._bus = None

    def get_thermal_frame(self) -> Optional[np.ndarray]:
        """Latest (H, W, 3) uint8 BGR heatmap, or None if unavailable.

        In SIMULATE mode there is no standalone thermal source; use
        overlay_on_rgb() instead, which synthesizes the heatmap from RGB.
        """
        with self._lock:
            return None if self._latest_frame is None else self._latest_frame.copy()

    def overlay_on_rgb(self, rgb_frame: np.ndarray, alpha: float = 0.55) -> np.ndarray:
        """Blend the thermal heatmap over an RGB (BGR) frame."""
        height, width = rgb_frame.shape[:2]

        if self.mode == ThermalMode.SIMULATE:
            heatmap, hotspot_mask = self._simulate_from_rgb(rgb_frame)
            with self._lock:
                self._latest_frame = heatmap
                self._latest_hotspot_mask = hotspot_mask
        else:
            heatmap = self.get_thermal_frame()
            if heatmap is None:
                return rgb_frame
            heatmap = cv2.resize(heatmap, (width, height), interpolation=cv2.INTER_LINEAR)

        blended = cv2.addWeighted(rgb_frame, 1.0 - alpha, heatmap, alpha, 0)

        if self.mode == ThermalMode.SIMULATE:
            cv2.putText(
                blended,
                "SIMULATED THERMAL",
                (8, 22),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )
        return blended

    def get_hotspots(self, frame_width: int, frame_height: int) -> List[Tuple[int, int, int, int]]:
        """Bounding boxes of hot regions, scaled to the given frame size.

        AMG8833/Lepton: regions above hotspot_threshold_c (potential person).
        SIMULATE: bright regions from the last overlay_on_rgb() call.
        """
        with self._lock:
            mask = self._latest_hotspot_mask
            mask = None if mask is None else mask.copy()

        if mask is None or cv2 is None:
            return []

        mask = cv2.resize(mask, (frame_width, frame_height), interpolation=cv2.INTER_NEAREST)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        boxes: List[Tuple[int, int, int, int]] = []
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if w * h >= MIN_HOTSPOT_AREA_PX:
                boxes.append((x, y, w, h))
        return boxes

    # ------------------------------------------------------------ hardware

    def _open_amg8833(self) -> None:
        try:
            from smbus2 import SMBus
        except ImportError as exc:
            raise RuntimeError("smbus2 is required for AMG8833 (pip install smbus2).") from exc

        self._bus = SMBus(self.i2c_bus)
        log.info("AMG8833 opened on I2C bus %d.", self.i2c_bus)

    def _read_amg8833_grid(self) -> Optional[np.ndarray]:
        """Read the 8x8 temperature grid in Celsius."""
        if self._bus is None:
            return None

        try:
            raw = []
            # 64 pixels x 2 bytes; read in 32-byte chunks (SMBus block limit).
            for offset in range(0, 128, 32):
                raw.extend(self._bus.read_i2c_block_data(AMG8833_I2C_ADDR, AMG8833_PIXEL_REG + offset, 32))
        except OSError:
            log.warning("AMG8833 I2C read failed.")
            return None

        temps = np.zeros(AMG8833_GRID * AMG8833_GRID, dtype=np.float32)
        for i in range(64):
            value = raw[2 * i] | (raw[2 * i + 1] << 8)
            if value & 0x800:  # 12-bit two's complement
                value -= 0x1000
            temps[i] = value * 0.25
        return temps.reshape(AMG8833_GRID, AMG8833_GRID)

    def _open_lepton(self) -> None:
        source = self.device_path
        if isinstance(source, str) and source.isdigit():
            source = int(source)

        self._capture = cv2.VideoCapture(source)
        if not self._capture.isOpened():
            raise RuntimeError(f"FLIR Lepton device {self.device_path!r} did not open.")

        # PureThermal exposes raw 14-bit radiometric data as Y16.
        self._capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"Y16 "))
        self._capture.set(cv2.CAP_PROP_CONVERT_RGB, 0)
        log.info("FLIR Lepton opened at %s.", self.device_path)

    def _read_lepton(self) -> Optional[Tuple[np.ndarray, np.ndarray]]:
        """Return (heatmap BGR, hotspot mask) from one Lepton frame."""
        if self._capture is None:
            return None

        ok, raw = self._capture.read()
        if not ok or raw is None:
            return None

        raw = raw.astype(np.float32)
        if raw.ndim == 3:
            raw = raw[:, :, 0]

        # Radiometric Lepton output is centikelvin: T(C) = raw/100 - 273.15.
        temps_c = raw / 100.0 - 273.15
        hotspot_mask = (temps_c > max(LEPTON_HOTSPOT_C, self.hotspot_threshold_c)).astype(np.uint8) * 255

        normalized = cv2.normalize(raw, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        heatmap = cv2.applyColorMap(normalized, cv2.COLORMAP_INFERNO)
        return heatmap, hotspot_mask

    # -------------------------------------------------------- capture loop

    def _capture_loop(self) -> None:
        interval = 0.1 if self.mode == ThermalMode.AMG8833 else 0.033
        while not self._stop_event.is_set():
            try:
                self._capture_one()
            except Exception:
                log.exception("Thermal capture iteration failed; continuing.")
            self._stop_event.wait(interval)

    def _capture_one(self) -> None:
        if self.mode == ThermalMode.AMG8833:
            temps = self._read_amg8833_grid()
            if temps is None:
                return

            width, height = self.output_size
            # Bilinear upsample the 8x8 grid to a viewable heatmap.
            upsampled = cv2.resize(temps, (width, height), interpolation=cv2.INTER_LINEAR)
            hotspot_mask = (upsampled > self.hotspot_threshold_c).astype(np.uint8) * 255

            normalized = cv2.normalize(upsampled, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
            heatmap = cv2.applyColorMap(normalized, cv2.COLORMAP_INFERNO)

            with self._lock:
                self._latest_temps = upsampled
                self._latest_frame = heatmap
                self._latest_hotspot_mask = hotspot_mask
            return

        if self.mode == ThermalMode.LEPTON:
            result = self._read_lepton()
            if result is None:
                return
            heatmap, hotspot_mask = result
            with self._lock:
                self._latest_frame = heatmap
                self._latest_hotspot_mask = hotspot_mask

    # ---------------------------------------------------------- simulation

    def _simulate_from_rgb(self, rgb_frame: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Fake a thermal look from RGB brightness (for testing without hardware)."""
        gray = cv2.cvtColor(rgb_frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (21, 21), 0)
        hotspot_mask = (blurred > SIM_BRIGHTNESS_THRESHOLD).astype(np.uint8) * 255
        heatmap = cv2.applyColorMap(blurred, cv2.COLORMAP_INFERNO)
        return heatmap, hotspot_mask


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

    cam = ThermalCamera(mode=ThermalMode.SIMULATE)
    cam.start()

    test = np.random.randint(0, 255, (120, 160, 3), dtype=np.uint8)
    overlaid = cam.overlay_on_rgb(test)
    print(f"Simulated thermal overlay: {overlaid.shape}, hotspots: {cam.get_hotspots(160, 120)}")
    cam.stop()
