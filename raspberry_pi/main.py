"""
main.py — Raspberry Pi SAR drone node entrypoint.

Startup sequence:
1. Load settings (env vars / .env / CLI flags)
2. Start camera stream (video_server.py)
3. Connect flight controller (flight_controller.py) — skipped if disabled
4. Start thermal camera (thermal.py) — skipped if disabled
5. Start AI detector (ai_detector.py) — skipped if disabled
6. Start telemetry client (telemetry_client.py)
7. Run forever; graceful shutdown on SIGINT/SIGTERM.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import threading
from typing import Optional

from config import Settings
from telemetry_client import TelemetryClient
from video_server import CameraStream, run_video_server

log = logging.getLogger("pi_node")


def parse_camera_source(value: str):
    value = value.strip()
    return int(value) if value.isdigit() else value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Raspberry Pi SAR drone node")
    parser.add_argument("--server-url", help="Backend WebSocket URL, e.g. ws://192.168.1.10:8080")
    parser.add_argument("--drone-id", help="Drone ID to publish, e.g. drone_1")
    parser.add_argument("--pi-ip", help="Pi LAN IP used in video_url")
    parser.add_argument("--camera-source", help="USB camera index, /dev/video path, or stream URL")
    parser.add_argument("--camera-backend", help="OpenCV backend: auto, v4l2, dshow, msmf, gstreamer, or any")
    parser.add_argument("--camera-fourcc", help="Camera pixel format/FourCC, e.g. MJPG or YUYV")
    parser.add_argument("--fake-video", action="store_true", help="Serve generated test frames instead of camera frames")
    parser.add_argument("--no-ai", action="store_true", help="Disable AI detection (fake alerts only)")
    parser.add_argument("--ai-backend", choices=["auto", "yolo", "mobilenet", "hog"], help="AI backend override")
    parser.add_argument("--fc-enabled", action="store_true", help="Enable flight controller connection")
    parser.add_argument("--fc-connection", help="MAVLink connection string, e.g. /dev/ttyAMA0 or udp:127.0.0.1:14550")
    parser.add_argument("--fc-sitl", action="store_true", help="Use software flight simulation instead of real MAVLink")
    parser.add_argument("--thermal", action="store_true", help="Enable thermal camera module")
    parser.add_argument("--thermal-mode", choices=["amg8833", "lepton", "simulate"], help="Thermal mode override")
    return parser.parse_args()


def build_flight_controller(settings: Settings, args: argparse.Namespace, base_lat: float, base_lon: float):
    """Connect the flight controller; returns None if disabled or unreachable."""
    fc_enabled = args.fc_enabled or settings.fc_enabled
    fc_sitl = args.fc_sitl or settings.fc_sitl_mode
    if not fc_enabled and not fc_sitl:
        log.info("Flight controller disabled (FC_ENABLED=false); using simulated movement.")
        return None

    try:
        from flight_controller import FlightController
    except ImportError:
        log.warning("pymavlink not installed; flight controller unavailable. Using simulated movement.")
        return None

    connection = args.fc_connection or settings.fc_connection
    if fc_sitl and not connection.startswith("sim:"):
        connection = "sim:" + connection

    fc = FlightController(
        connection_string=connection,
        baud=settings.fc_baud,
        sim_base_lat=base_lat,
        sim_base_lon=base_lon,
    )
    if not fc.connect():
        log.error("Flight controller connection failed; falling back to simulated movement.")
        return None

    fc.start_telemetry_loop()
    return fc


def build_thermal_camera(settings: Settings, args: argparse.Namespace):
    """Start the thermal module; returns None if disabled or unavailable."""
    if not (args.thermal or settings.thermal_enabled):
        return None

    try:
        from thermal import ThermalCamera
    except ImportError:
        log.warning("Thermal module unavailable; continuing without thermal.")
        return None

    mode = args.thermal_mode or settings.thermal_mode
    try:
        thermal = ThermalCamera(
            mode=mode,
            i2c_bus=settings.thermal_i2c_bus,
            device_path=settings.thermal_device_path,
            hotspot_threshold_c=settings.thermal_hotspot_threshold_c,
        )
        thermal.start()
        log.info("Thermal camera started in %s mode.", mode)
        return thermal
    except Exception:
        log.exception("Thermal camera failed to start; continuing without thermal.")
        return None


def build_ai_detector(settings: Settings, args: argparse.Namespace, camera: CameraStream, thermal):
    """Start the AI detector; returns None if disabled or no backend available."""
    if args.no_ai or not settings.ai_enabled:
        log.info("AI detection disabled; falling back to simulated alerts.")
        return None

    try:
        from ai_detector import AIDetector
    except ImportError:
        log.warning("AI detector unavailable (OpenCV missing?); falling back to simulated alerts.")
        return None

    detector = AIDetector(
        camera_stream=camera,
        confidence_threshold=settings.ai_confidence,
        inference_interval_s=settings.ai_inference_interval_s,
        inference_size=settings.ai_inference_size,
        tiling=settings.ai_tiling,
        tile_size=settings.ai_tile_size,
        tile_overlap=settings.ai_tile_overlap,
        annotate_frame=settings.ai_annotate_frame,
        model_path=settings.ai_model_path or None,
        jpeg_quality=settings.jpeg_quality,
        backend=args.ai_backend or settings.ai_backend,
        thermal_camera=thermal,
    )
    try:
        backend = detector.start()
        log.info("AI detection active (backend: %s).", backend)
        return detector
    except Exception:
        log.exception("AI detector failed to start; falling back to simulated alerts.")
        return None


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    args = parse_args()
    settings = Settings.from_env()

    server_url = args.server_url or settings.server_url
    drone_id = args.drone_id or settings.drone_id
    pi_ip = args.pi_ip or settings.pi_ip
    fake_video = args.fake_video or settings.fake_video
    camera_source = parse_camera_source(args.camera_source) if args.camera_source else settings.camera_source
    camera_backend = (args.camera_backend or settings.camera_backend).strip().lower()
    camera_fourcc = (args.camera_fourcc or settings.camera_fourcc).strip().upper()
    video_url = f"http://{pi_ip}:{settings.video_port}/stream"

    # 1-2. Camera stream + MJPEG server
    camera = CameraStream(
        source=camera_source,
        backend=camera_backend,
        fourcc=camera_fourcc,
        width=settings.video_width,
        height=settings.video_height,
        fps=settings.video_fps,
        jpeg_quality=settings.jpeg_quality,
        fake_video=fake_video,
    )

    video_thread = threading.Thread(
        target=run_video_server,
        kwargs={"camera": camera, "host": settings.video_host, "port": settings.video_port},
        name="mjpeg-video-server",
        daemon=True,
    )
    video_thread.start()

    log.info("Video stream: %s", video_url)
    log.info("Telemetry target: %s", server_url)

    # 3. Flight controller
    fc = build_flight_controller(settings, args, settings.base_lat, settings.base_lon)

    # 4. Thermal camera
    thermal = build_thermal_camera(settings, args)

    # 5. AI detector
    detector = build_ai_detector(settings, args, camera, thermal)

    # 6. Telemetry client
    client = TelemetryClient(
        server_url=server_url,
        drone_id=drone_id,
        video_url=video_url,
        base_lat=settings.base_lat,
        base_lon=settings.base_lon,
        telemetry_interval_s=settings.telemetry_interval_s,
        alert_min_s=settings.alert_min_s,
        alert_max_s=settings.alert_max_s,
        flight_controller=fc,
        ai_detector=detector,
        alert_confidence_threshold=settings.ai_confidence,
        detection_frame_interval_s=settings.detection_frame_interval_s,
    )

    def shutdown() -> None:
        log.info("Shutting down.")
        if detector is not None:
            detector.stop()
        if thermal is not None:
            thermal.stop()
        if fc is not None:
            fc.disconnect()
        camera.stop()

    async def run() -> None:
        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop_event.set)
            except NotImplementedError:
                # Windows / non-main-thread: fall back to KeyboardInterrupt.
                pass

        telemetry_task = asyncio.create_task(client.run_forever())
        stop_task = asyncio.create_task(stop_event.wait())
        done, pending = await asyncio.wait(
            {telemetry_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    finally:
        shutdown()


if __name__ == "__main__":
    main()
