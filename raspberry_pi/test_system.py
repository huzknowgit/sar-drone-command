"""
test_system.py — SAR Drone system diagnostic tool.

Checks and reports on:
  1. Camera connectivity
  2. AI backend availability and speed
  3. Thermal camera (if enabled)
  4. Flight controller connection
  5. WebSocket server reachability

Run: python test_system.py --server-url ws://192.168.1.50:8080
Exit code is 0 when every enabled check passes, 1 otherwise.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from typing import Optional

from config import Settings

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"

results: list[tuple[str, str, str]] = []


def record(name: str, status: str, detail: str = "") -> None:
    results.append((name, status, detail))
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))


def check_camera(settings: Settings) -> Optional["object"]:
    """Open the camera and wait for a frame. Returns the CameraStream on success."""
    print("\n[1/5] Camera connectivity")
    try:
        from video_server import CameraStream
    except Exception as exc:
        record("camera import", FAIL, str(exc))
        return None

    camera = CameraStream(
        source=settings.camera_source,
        backend=settings.camera_backend,
        fourcc=settings.camera_fourcc,
        width=settings.video_width,
        height=settings.video_height,
        fps=settings.video_fps,
        fake_video=settings.fake_video,
    )
    camera.start()

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if camera.get_jpeg() is not None:
            source = "FAKE frames" if camera.fake_video else f"source {settings.camera_source!r}"
            record("camera frame", PASS, f"{source}, {settings.video_width}x{settings.video_height}")
            return camera
        time.sleep(0.2)

    record("camera frame", FAIL, "no frame within 5s")
    camera.stop()
    return None


def check_ai(settings: Settings, camera) -> None:
    print("\n[2/5] AI backend availability and speed")
    if not settings.ai_enabled:
        record("AI detection", SKIP, "AI_ENABLED=false")
        return
    if camera is None:
        record("AI detection", SKIP, "no camera frame available")
        return

    try:
        from ai_detector import AIDetector
    except Exception as exc:
        record("AI import", FAIL, str(exc))
        return

    detector = AIDetector(
        camera_stream=camera,
        confidence_threshold=settings.ai_confidence,
        inference_interval_s=0.2,
        backend=settings.ai_backend,
        model_path=settings.ai_model_path or None,
    )
    try:
        backend = detector.start()
    except Exception as exc:
        record("AI backend", FAIL, str(exc))
        return

    deadline = time.monotonic() + 20.0
    result = None
    while time.monotonic() < deadline:
        result = detector.get_latest_result()
        if result is not None:
            break
        time.sleep(0.25)

    if result is None:
        record("AI inference", FAIL, f"backend {backend} produced no result in 20s")
    else:
        record(
            "AI inference",
            PASS,
            f"backend {backend}, {result.inference_ms:.0f}ms/frame, {len(result.detections)} detections",
        )
    detector.stop()


def check_thermal(settings: Settings) -> None:
    print("\n[3/5] Thermal camera")
    if not settings.thermal_enabled:
        record("thermal", SKIP, "THERMAL_ENABLED=false")
        return

    try:
        from thermal import ThermalCamera
    except Exception as exc:
        record("thermal import", FAIL, str(exc))
        return

    try:
        import numpy as np

        cam = ThermalCamera(
            mode=settings.thermal_mode,
            i2c_bus=settings.thermal_i2c_bus,
            device_path=settings.thermal_device_path,
            hotspot_threshold_c=settings.thermal_hotspot_threshold_c,
        )
        cam.start()

        if settings.thermal_mode == "simulate":
            test = np.random.randint(0, 255, (120, 160, 3), dtype=np.uint8)
            cam.overlay_on_rgb(test)
            record("thermal", PASS, "simulated overlay OK")
        else:
            deadline = time.monotonic() + 5.0
            frame = None
            while time.monotonic() < deadline:
                frame = cam.get_thermal_frame()
                if frame is not None:
                    break
                time.sleep(0.2)
            if frame is None:
                record("thermal", FAIL, f"{settings.thermal_mode} produced no frame in 5s")
            else:
                record("thermal", PASS, f"{settings.thermal_mode} frame {frame.shape[1]}x{frame.shape[0]}")
        cam.stop()
    except Exception as exc:
        record("thermal", FAIL, str(exc))


def check_flight_controller(settings: Settings) -> None:
    print("\n[4/5] Flight controller connection")
    if not settings.fc_enabled and not settings.fc_sitl_mode:
        record("flight controller", SKIP, "FC_ENABLED=false")
        return

    try:
        from flight_controller import FlightController
    except Exception as exc:
        record("FC import", FAIL, str(exc))
        return

    connection = settings.fc_connection
    if settings.fc_sitl_mode and not connection.startswith("sim:"):
        connection = "sim:" + connection

    fc = FlightController(connection_string=connection, baud=settings.fc_baud)
    if not fc.connect():
        record("flight controller", FAIL, f"no heartbeat on {connection}")
        return

    fc.start_telemetry_loop()
    time.sleep(2.0)
    state = fc.get_state()
    record(
        "flight controller",
        PASS,
        f"{connection}: mode={state.mode}, gps_fix={state.gps_fix}, sats={state.gps_sats}, "
        f"batt={state.battery_pct:.0f}%",
    )
    fc.disconnect()


async def _ping_server(server_url: str) -> str:
    import websockets

    async with websockets.connect(server_url, open_timeout=5, close_timeout=2) as ws:
        await ws.send(json.dumps({"type": "register", "role": "drone"}))
        await ws.send(json.dumps({"type": "ping"}))
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic())
            except asyncio.TimeoutError:
                break
            msg = json.loads(raw)
            if msg.get("type") == "pong":
                return "pong received"
        return "connected (no pong — backend may be an older build)"


def check_server(server_url: str) -> None:
    print("\n[5/5] WebSocket server reachability")
    try:
        detail = asyncio.run(_ping_server(server_url))
        record("backend server", PASS, f"{server_url}: {detail}")
    except Exception as exc:
        record("backend server", FAIL, f"{server_url}: {exc}")


def main() -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s [%(name)s] %(message)s")

    parser = argparse.ArgumentParser(description="SAR Drone system diagnostic tool")
    parser.add_argument("--server-url", help="Backend WebSocket URL override")
    args = parser.parse_args()

    settings = Settings.from_env()
    server_url = args.server_url or settings.server_url

    print("SAR Drone system diagnostics")
    print(f"  drone_id: {settings.drone_id}")
    print(f"  server:   {server_url}")

    camera = check_camera(settings)
    check_ai(settings, camera)
    check_thermal(settings)
    check_flight_controller(settings)
    check_server(server_url)

    if camera is not None:
        camera.stop()

    print("\n=== Summary ===")
    failed = 0
    for name, status, _ in results:
        print(f"  {status}: {name}")
        if status == FAIL:
            failed += 1

    if failed:
        print(f"\n{failed} check(s) FAILED.")
        return 1
    print("\nAll enabled checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
