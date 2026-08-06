"""
TelemetryClient — SAR drone node WebSocket client.

Reads state from a FlightController (real MAVLink or software sim) and
detections from an AIDetector, and reports both to the backend:

- telemetry_update: position, battery, speed, altitude, heading, status
- alert_event: real AI person detections with live GPS coordinates
- detection_frame: annotated JPEG + bounding boxes (throttled)

Handled commands from the backend:
- recall_drone       -> fc.return_to_launch()
- mission_plan_update / upload_mission -> fc.upload_mission(sweepPath)
- fly_to             -> fc.fly_to_waypoint(lat, lon, altitude_m)
- set_camera_mode    -> toggles the AI detector's thermal overlay

Both flight_controller and ai_detector are optional: with neither, the
client falls back to the original simulated random-walk behavior.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
from typing import Optional

import websockets
from websockets.exceptions import ConnectionClosed

from movement import SmoothRandomWalk


log = logging.getLogger("pi_telemetry")


class TelemetryClient:
    def __init__(
        self,
        server_url: str,
        drone_id: str,
        video_url: str,
        base_lat: float,
        base_lon: float,
        telemetry_interval_s: float = 1.0,
        alert_min_s: int = 20,
        alert_max_s: int = 40,
        flight_controller=None,  # Optional FlightController
        ai_detector=None,  # Optional AIDetector
        alert_confidence_threshold: float = 0.5,
        alert_cooldown_s: float = 10.0,
        detection_frame_interval_s: float = 2.0,
    ) -> None:
        self.server_url = server_url
        self.drone_id = drone_id
        self.video_url = video_url
        self.telemetry_interval_s = telemetry_interval_s
        self.alert_min_s = alert_min_s
        self.alert_max_s = max(alert_min_s, alert_max_s)
        self.fc = flight_controller
        self.ai_detector = ai_detector
        self.alert_confidence_threshold = alert_confidence_threshold
        self.alert_cooldown_s = alert_cooldown_s
        self.detection_frame_interval_s = max(0.5, detection_frame_interval_s)

        # Simulated movement fallback, used when no flight controller is wired.
        self.walk: Optional[SmoothRandomWalk] = None
        if self.fc is None:
            self.walk = SmoothRandomWalk(base_lat, base_lon)

        self._next_fake_alert_at = time.monotonic() + random.uniform(self.alert_min_s, self.alert_max_s)
        self._last_alert_at = 0.0
        self._last_detection_frame_at = 0.0
        self._last_ai_timestamp = 0.0

    async def run_forever(self) -> None:
        while True:
            try:
                await self._run_once()
            except (OSError, ConnectionClosed, TimeoutError) as exc:
                log.warning("WebSocket disconnected: %s. Reconnecting in 3s.", exc)
                await asyncio.sleep(3.0)
            except Exception:
                log.exception("Unexpected telemetry error. Reconnecting in 3s.")
                await asyncio.sleep(3.0)

    async def _run_once(self) -> None:
        log.info("Connecting to %s", self.server_url)
        async with websockets.connect(self.server_url, ping_interval=20, ping_timeout=20) as ws:
            log.info("Connected to backend as %s", self.drone_id)
            role = "drone" if self.fc is not None or self.ai_detector is not None else "simulator"
            await self._send(ws, {"type": "register", "role": role})

            receiver_task = asyncio.create_task(self._receive_commands(ws))
            last_tick = time.monotonic()
            try:
                while True:
                    now = time.monotonic()
                    dt_s = max(0.1, now - last_tick)
                    last_tick = now

                    await self._send(ws, self._telemetry_payload(dt_s))
                    await self._process_detections(ws, now)

                    await asyncio.sleep(self.telemetry_interval_s)
            finally:
                receiver_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await receiver_task

    # ------------------------------------------------------------ commands

    async def _receive_commands(self, ws) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            try:
                self._handle_command(msg)
            except Exception:
                log.exception("Command handling failed for message type %r.", msg.get("type"))

    def _handle_command(self, msg: dict) -> None:
        msg_type = msg.get("type")

        if msg_type == "recall_drone" and msg.get("drone_id") == self.drone_id:
            log.info("Recall command received for %s; returning to base.", self.drone_id)
            if self.fc is not None:
                self.fc.return_to_launch()
            elif self.walk is not None:
                self.walk.recall_to_base()

        elif msg_type == "mission_plan_update":
            plan = msg.get("missionPlan") or {}
            self._apply_mission_plan(plan)

        elif msg_type == "upload_mission":
            plan = msg.get("missionPlan") or {}
            waypoints = plan.get("sweepPath") or msg.get("waypoints") or []
            if self.fc is not None:
                if self.fc.upload_mission(waypoints):
                    log.info("Mission uploaded to flight controller (%d waypoints).", len(waypoints))
                else:
                    log.warning("Mission upload to flight controller failed.")
            else:
                self._apply_mission_plan(plan)

        elif msg_type == "fly_to" and msg.get("drone_id") in (None, self.drone_id):
            lat = msg.get("lat")
            lon = msg.get("lon")
            altitude_m = msg.get("altitude_m", 50.0)
            if self.fc is not None and isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                self.fc.fly_to_waypoint(float(lat), float(lon), float(altitude_m))
                log.info("fly_to command: %.6f, %.6f @ %sm", lat, lon, altitude_m)

        elif msg_type == "set_camera_mode" and msg.get("drone_id") in (None, self.drone_id):
            mode = "thermal" if msg.get("mode") == "thermal" else "normal"
            if self.ai_detector is not None:
                self.ai_detector.thermal_mode = mode
                log.info("Camera mode set to %s.", mode)

        elif msg_type == "pong":
            pass  # connection-health reply; nothing to do

    def _apply_mission_plan(self, plan: dict) -> None:
        if self.fc is not None:
            waypoints = plan.get("sweepPath") or []
            if waypoints and self.fc.upload_mission(waypoints):
                log.info("Mission plan uploaded to flight controller (%d waypoints).", len(waypoints))
            else:
                log.warning("Mission plan update was not applied to the flight controller.")
        elif self.walk is not None:
            if self.walk.apply_mission_plan(plan):
                log.info("Mission plan accepted; following planned area and sweep path.")
            else:
                log.warning("Mission plan update was invalid for this Pi node.")

    # ----------------------------------------------------------- telemetry

    def _current_state(self, dt_s: float):
        """Return (lat, lon, battery, status, speed, altitude, heading)."""
        if self.fc is not None:
            state = self.fc.get_state()
            return (
                state.lat,
                state.lon,
                state.battery_pct,
                self._status_from_flight_state(state),
                state.groundspeed_ms,
                state.altitude_m,
                state.heading_deg,
            )

        state = self.walk.tick(dt_s)
        return (state.lat, state.lon, state.battery, state.status, state.speed, state.altitude, state.heading)

    @staticmethod
    def _status_from_flight_state(state) -> str:
        if not state.connected:
            return "offline"
        if state.mode == "RTL":
            return "returning"
        if state.mode == "LAND":
            return "returning"
        if not state.armed:
            return "idle"
        if state.mode in {"AUTO", "GUIDED", "LOITER", "SIM"}:
            return "searching"
        return "searching"

    def _telemetry_payload(self, dt_s: float) -> dict:
        lat, lon, battery, status, speed, altitude, heading = self._current_state(dt_s)
        self._last_position = (lat, lon)
        return {
            "type": "telemetry_update",
            "drone_id": self.drone_id,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "battery": round(battery, 1),
            "status": status,
            "video_url": self.video_url,
            "speed": round(speed, 1),
            "altitude": round(altitude, 1),
            "heading": round(heading) % 360,
        }

    # ---------------------------------------------------------- detections

    async def _process_detections(self, ws, now: float) -> None:
        if self.ai_detector is None:
            await self._maybe_send_fake_alert(ws, now)
            return

        result = self.ai_detector.get_latest_result()
        if result is None or result.timestamp <= self._last_ai_timestamp:
            return
        self._last_ai_timestamp = result.timestamp

        confident = [d for d in result.detections if d.confidence >= self.alert_confidence_threshold]
        if not confident:
            return

        lat, lon = getattr(self, "_last_position", (0.0, 0.0))
        best = max(confident, key=lambda d: d.confidence)

        if now - self._last_alert_at >= self.alert_cooldown_s:
            self._last_alert_at = now
            log.info(
                "AI detection: %d person(s), best %.0f%% at %.6f, %.6f",
                len(confident),
                best.confidence * 100,
                lat,
                lon,
            )
            await self._send(
                ws,
                {
                    "type": "alert_event",
                    "drone_id": self.drone_id,
                    "alert": "human_detected",
                    "lat": round(lat, 6),
                    "lon": round(lon, 6),
                    "confidence": round(best.confidence, 2),
                    "timestamp": int(time.time() * 1000),
                },
            )

        # Throttle detection frames to avoid flooding the WebSocket.
        if now - self._last_detection_frame_at >= self.detection_frame_interval_s:
            jpeg_b64 = result.frame_jpeg_b64
            if jpeg_b64:
                self._last_detection_frame_at = now
                await self._send(
                    ws,
                    {
                        "type": "detection_frame",
                        "drone_id": self.drone_id,
                        "jpeg_b64": jpeg_b64,
                        "detections": [d.to_dict() for d in result.detections],
                        "backend": result.backend,
                        "inference_ms": round(result.inference_ms, 1),
                        "timestamp": int(result.timestamp * 1000),
                    },
                )

    async def _maybe_send_fake_alert(self, ws, now: float) -> None:
        """Legacy simulated alerts, used only when no AI detector is wired."""
        if self.walk is None or now < self._next_fake_alert_at or not self.walk.can_emit_alert():
            return

        lat, lon = getattr(self, "_last_position", (self.walk.lat, self.walk.lon))
        alert = {
            "type": "alert_event",
            "drone_id": self.drone_id,
            "alert": "human_detected",
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "confidence": round(random.uniform(0.80, 0.98), 2),
            "timestamp": int(time.time() * 1000),
        }
        log.info("Simulated alert at %.6f, %.6f (%.0f%%)", alert["lat"], alert["lon"], alert["confidence"] * 100)
        await self._send(ws, alert)
        self._next_fake_alert_at = now + random.uniform(self.alert_min_s, self.alert_max_s)

    async def _send(self, ws, payload: dict) -> None:
        await ws.send(json.dumps(payload, separators=(",", ":")))
