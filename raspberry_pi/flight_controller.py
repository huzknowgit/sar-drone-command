"""
flight_controller.py — MAVLink interface for real drone control.

Compatible with:
  - ArduPilot (ArduCopter recommended for VTOL SAR use)
  - PX4

Connection options:
  - Serial: /dev/ttyAMA0 (Pi UART), /dev/ttyUSB0 (USB-to-serial), /dev/ttyACM0 (USB)
  - UDP: udp:127.0.0.1:14550 (for SITL testing or telemetry radio bridge)
  - TCP: tcp:127.0.0.1:5760
  - "sim:" prefix (or SITL_MODE=true env var): software simulation using
    SmoothRandomWalk from movement.py — runs without any hardware.

The flight controller reads real GPS, battery, attitude, speed from MAVLink
and exposes them to the telemetry client. It also accepts high-level commands:
  - fly_to_waypoint(lat, lon, altitude_m)
  - upload_mission(waypoints)
  - return_to_launch()
  - set_mode(mode_name)
  - land()
  - arm() / disarm()
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field, replace
from typing import List, Optional

from movement import SmoothRandomWalk

try:
    from pymavlink import mavutil
except ImportError:  # pragma: no cover - optional dependency
    mavutil = None

log = logging.getLogger("flight_controller")

HEARTBEAT_TIMEOUT_S = 5.0
CONNECT_TIMEOUT_S = 10.0
ACK_TIMEOUT_S = 3.0


@dataclass
class FlightState:
    lat: float = 0.0
    lon: float = 0.0
    altitude_m: float = 0.0
    heading_deg: float = 0.0
    groundspeed_ms: float = 0.0
    battery_pct: float = 0.0
    battery_voltage: float = 0.0
    armed: bool = False
    mode: str = "UNKNOWN"
    gps_fix: int = 0  # 0=no fix, 2=2D, 3=3D
    gps_sats: int = 0
    connected: bool = False
    last_heartbeat: float = 0.0


def _env_true(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "on"}


class FlightController:
    def __init__(
        self,
        connection_string: str = "/dev/ttyAMA0",
        baud: int = 57600,
        source_system: int = 255,
        sim_base_lat: float = 43.7005,
        sim_base_lon: float = -79.4130,
    ) -> None:
        self.connection_string = connection_string
        self.baud = baud
        self.source_system = source_system

        self.sim_mode = connection_string.startswith("sim:") or _env_true("SITL_MODE") or _env_true("FC_SITL_MODE")
        self._sim_walk: Optional[SmoothRandomWalk] = None
        self._sim_base = (sim_base_lat, sim_base_lon)
        self._sim_last_tick = 0.0

        self._conn = None
        self._state = FlightState()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._command_lock = threading.Lock()  # serialize command/ack exchanges

    # ------------------------------------------------------------------ API

    def connect(self) -> bool:
        """Blocking connect with 10s timeout. Returns True on success."""
        if self.sim_mode:
            self._sim_walk = SmoothRandomWalk(self._sim_base[0], self._sim_base[1])
            self._sim_last_tick = time.monotonic()
            with self._lock:
                self._state = FlightState(
                    lat=self._sim_walk.lat,
                    lon=self._sim_walk.lon,
                    battery_pct=self._sim_walk.battery,
                    armed=True,
                    mode="SIM",
                    gps_fix=3,
                    gps_sats=12,
                    connected=True,
                    last_heartbeat=time.time(),
                )
            log.info("Flight controller in SIMULATED mode (no MAVLink hardware).")
            return True

        if mavutil is None:
            log.error("pymavlink is not installed; cannot connect to a real flight controller.")
            return False

        try:
            log.info("Connecting to flight controller at %s (baud %d)...", self.connection_string, self.baud)
            self._conn = mavutil.mavlink_connection(
                self.connection_string,
                baud=self.baud,
                source_system=self.source_system,
            )
            heartbeat = self._conn.wait_heartbeat(timeout=CONNECT_TIMEOUT_S)
            if heartbeat is None:
                log.error("No heartbeat from flight controller within %.0fs.", CONNECT_TIMEOUT_S)
                self._conn.close()
                self._conn = None
                return False
        except Exception:
            log.exception("Flight controller connection failed.")
            self._conn = None
            return False

        with self._lock:
            self._state.connected = True
            self._state.last_heartbeat = time.time()

        log.info(
            "Flight controller connected (system %d, component %d).",
            self._conn.target_system,
            self._conn.target_component,
        )
        # Ask for a sane stream of telemetry messages.
        self._request_data_streams()
        return True

    def start_telemetry_loop(self) -> None:
        """Start background thread that keeps FlightState current."""
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._telemetry_loop, name="fc-telemetry", daemon=True)
        self._thread.start()

    def get_state(self) -> FlightState:
        """Thread-safe snapshot of current flight state."""
        with self._lock:
            return replace(self._state)

    def fly_to_waypoint(self, lat: float, lon: float, altitude_m: float) -> bool:
        """
        Command drone to fly to a GPS waypoint.
        Switches to GUIDED mode if not already in it.
        Returns True if command accepted.
        """
        if self.sim_mode:
            if self._sim_walk:
                self._sim_walk.apply_mission_plan(
                    {
                        "base": {"lat": self._sim_walk.base_lat, "lon": self._sim_walk.base_lon},
                        "searchArea": [
                            {"lat": lat + 0.002, "lon": lon - 0.002},
                            {"lat": lat + 0.002, "lon": lon + 0.002},
                            {"lat": lat - 0.002, "lon": lon + 0.002},
                            {"lat": lat - 0.002, "lon": lon - 0.002},
                        ],
                        "sweepPath": [{"lat": lat, "lon": lon}, {"lat": lat, "lon": lon}],
                    }
                )
            log.info("[SIM] fly_to_waypoint %.6f, %.6f @ %.0fm", lat, lon, altitude_m)
            return True

        if self._conn is None:
            return False

        if self.get_state().mode != "GUIDED" and not self.set_mode("GUIDED"):
            return False

        with self._command_lock:
            try:
                self._conn.mav.set_position_target_global_int_send(
                    0,  # time_boot_ms
                    self._conn.target_system,
                    self._conn.target_component,
                    mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                    0b0000111111111000,  # only position enabled
                    int(lat * 1e7),
                    int(lon * 1e7),
                    float(altitude_m),
                    0, 0, 0,  # velocity
                    0, 0, 0,  # acceleration
                    0, 0,  # yaw, yaw rate
                )
            except Exception:
                log.exception("fly_to_waypoint failed.")
                return False

        log.info("Waypoint command sent: %.6f, %.6f @ %.0fm", lat, lon, altitude_m)
        return True

    def upload_mission(self, waypoints: List[dict]) -> bool:
        """
        Upload a full mission (list of {lat, lon, alt} dicts) to the FC.
        Clears existing mission first. Returns True on success.
        Use this for the sweep path from the mission planner.
        """
        clean: List[dict] = []
        for wp in waypoints or []:
            try:
                clean.append(
                    {
                        "lat": float(wp["lat"]),
                        "lon": float(wp["lon"]),
                        "alt": float(wp.get("alt", wp.get("altitude_m", 50.0))),
                    }
                )
            except (KeyError, TypeError, ValueError):
                continue

        if not clean:
            log.warning("upload_mission called with no valid waypoints.")
            return False

        if self.sim_mode:
            if self._sim_walk:
                self._sim_walk.search_route = [{"lat": wp["lat"], "lon": wp["lon"]} for wp in clean]
                self._sim_walk.route_index = 0
                self._sim_walk.mission_complete = False
            log.info("[SIM] Mission uploaded: %d waypoints.", len(clean))
            return True

        if self._conn is None:
            return False

        with self._command_lock:
            try:
                return self._upload_mission_mavlink(clean)
            except Exception:
                log.exception("Mission upload failed.")
                return False

    def _upload_mission_mavlink(self, waypoints: List[dict]) -> bool:
        target = (self._conn.target_system, self._conn.target_component)

        # Clear any existing mission.
        self._conn.mav.mission_clear_all_send(*target)
        ack = self._conn.recv_match(type="MISSION_ACK", blocking=True, timeout=ACK_TIMEOUT_S)
        if ack is None:
            log.warning("No MISSION_ACK after mission_clear_all; continuing anyway.")

        # MISSION_COUNT -> respond to each MISSION_REQUEST(_INT) with MISSION_ITEM_INT.
        count = len(waypoints)
        self._conn.mav.mission_count_send(*target, count)

        sent = 0
        deadline = time.monotonic() + max(10.0, count * ACK_TIMEOUT_S)
        while sent < count and time.monotonic() < deadline:
            request = self._conn.recv_match(
                type=["MISSION_REQUEST", "MISSION_REQUEST_INT"],
                blocking=True,
                timeout=ACK_TIMEOUT_S,
            )
            if request is None:
                log.error("Timed out waiting for MISSION_REQUEST (sent %d/%d).", sent, count)
                return False

            seq = request.seq
            wp = waypoints[min(seq, count - 1)]
            self._conn.mav.mission_item_int_send(
                *target,
                seq,
                mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT,
                mavutil.mavlink.MAV_CMD_NAV_WAYPOINT,
                1 if seq == 0 else 0,  # current
                1,  # autocontinue
                0, 0, 0, 0,  # params 1-4 (hold time, accept radius, pass radius, yaw)
                int(wp["lat"] * 1e7),
                int(wp["lon"] * 1e7),
                float(wp["alt"]),
            )
            sent = max(sent, seq + 1)

        ack = self._conn.recv_match(type="MISSION_ACK", blocking=True, timeout=ACK_TIMEOUT_S)
        if ack is None or ack.type != mavutil.mavlink.MAV_MISSION_ACCEPTED:
            log.error("Mission upload not accepted (ack=%s).", getattr(ack, "type", None))
            return False

        log.info("Mission uploaded: %d waypoints.", count)
        return True

    def return_to_launch(self) -> bool:
        """Command RTL mode. Returns True if accepted."""
        if self.sim_mode:
            if self._sim_walk:
                self._sim_walk.recall_to_base()
            log.info("[SIM] Return to launch.")
            return True
        return self.set_mode("RTL")

    def set_search_mode(self) -> bool:
        """Start the uploaded mission (AUTO), falling back to LOITER."""
        if self.sim_mode:
            return True
        return self.set_mode("AUTO") or self.set_mode("LOITER")

    def set_mode(self, mode_name: str) -> bool:
        """Set flight mode by name (e.g. 'AUTO', 'GUIDED', 'RTL', 'LOITER')."""
        if self.sim_mode:
            with self._lock:
                self._state.mode = mode_name.upper()
            return True

        if self._conn is None:
            return False

        mode_name = mode_name.upper()
        mode_map = self._conn.mode_mapping() or {}
        if mode_name not in mode_map:
            log.error("Unknown flight mode %r. Available: %s", mode_name, sorted(mode_map))
            return False

        with self._command_lock:
            try:
                self._conn.set_mode(mode_map[mode_name])
            except Exception:
                log.exception("set_mode(%s) failed.", mode_name)
                return False

        log.info("Flight mode set to %s.", mode_name)
        return True

    def arm(self) -> bool:
        return self._arm_disarm(True)

    def disarm(self) -> bool:
        return self._arm_disarm(False)

    def _arm_disarm(self, arm: bool) -> bool:
        action = "arm" if arm else "disarm"
        if self.sim_mode:
            with self._lock:
                self._state.armed = arm
            log.info("[SIM] %s.", action)
            return True

        if self._conn is None:
            return False

        with self._command_lock:
            try:
                self._conn.mav.command_long_send(
                    self._conn.target_system,
                    self._conn.target_component,
                    mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
                    0,
                    1.0 if arm else 0.0,
                    0, 0, 0, 0, 0, 0,
                )
                ack = self._conn.recv_match(type="COMMAND_ACK", blocking=True, timeout=ACK_TIMEOUT_S)
            except Exception:
                log.exception("%s command failed.", action)
                return False

        accepted = ack is not None and ack.result == mavutil.mavlink.MAV_RESULT_ACCEPTED
        log.info("%s %s.", action.capitalize(), "accepted" if accepted else "rejected")
        return accepted

    def land(self) -> bool:
        """Command the drone to land in place."""
        if self.sim_mode:
            if self._sim_walk:
                self._sim_walk.recall_to_base()
            return True
        return self.set_mode("LAND")

    def disconnect(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None
        with self._lock:
            self._state.connected = False

    # -------------------------------------------------------- telemetry loop

    def _telemetry_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                if self.sim_mode:
                    self._tick_sim()
                    self._stop_event.wait(0.5)
                else:
                    self._pump_mavlink()
            except Exception:
                log.exception("Telemetry loop iteration failed; continuing.")
                self._stop_event.wait(1.0)

    def _tick_sim(self) -> None:
        if self._sim_walk is None:
            return

        now = time.monotonic()
        dt = max(0.1, now - self._sim_last_tick)
        self._sim_last_tick = now
        state = self._sim_walk.tick(dt)

        with self._lock:
            self._state.lat = state.lat
            self._state.lon = state.lon
            self._state.altitude_m = state.altitude
            self._state.heading_deg = state.heading
            self._state.groundspeed_ms = state.speed
            self._state.battery_pct = state.battery
            self._state.battery_voltage = 14.0 + (state.battery / 100.0) * 2.8
            self._state.mode = "SIM"
            self._state.connected = True
            self._state.last_heartbeat = time.time()

    def _pump_mavlink(self) -> None:
        msg = self._conn.recv_match(blocking=True, timeout=1.0) if self._conn else None

        now = time.time()
        with self._lock:
            heartbeat_age = now - self._state.last_heartbeat

        if msg is None:
            if heartbeat_age > HEARTBEAT_TIMEOUT_S:
                self._handle_link_loss()
            return

        msg_type = msg.get_type()
        with self._lock:
            if msg_type == "HEARTBEAT":
                if msg.get_srcSystem() == getattr(self._conn, "target_system", None):
                    self._state.last_heartbeat = now
                    self._state.connected = True
                    self._state.armed = bool(
                        msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED
                    )
                    mode_map = {v: k for k, v in (self._conn.mode_mapping() or {}).items()}
                    self._state.mode = mode_map.get(msg.custom_mode, self._state.mode)
            elif msg_type == "GLOBAL_POSITION_INT":
                self._state.lat = msg.lat / 1e7
                self._state.lon = msg.lon / 1e7
                self._state.altitude_m = msg.relative_alt / 1000.0
                self._state.heading_deg = msg.hdg / 100.0 if msg.hdg != 65535 else self._state.heading_deg
            elif msg_type == "VFR_HUD":
                self._state.groundspeed_ms = float(msg.groundspeed)
            elif msg_type == "SYS_STATUS":
                if msg.battery_remaining >= 0:
                    self._state.battery_pct = float(msg.battery_remaining)
                if msg.voltage_battery not in (0, 0xFFFF):
                    self._state.battery_voltage = msg.voltage_battery / 1000.0
            elif msg_type == "GPS_RAW_INT":
                self._state.gps_fix = int(msg.fix_type)
                self._state.gps_sats = int(msg.satellites_visible)

    def _handle_link_loss(self) -> None:
        with self._lock:
            if not self._state.connected:
                pass
            self._state.connected = False

        log.warning("No heartbeat for %.0fs; attempting reconnect.", HEARTBEAT_TIMEOUT_S)
        try:
            if self._conn is not None:
                self._conn.close()
        except Exception:
            pass
        self._conn = None

        while not self._stop_event.is_set():
            if self.connect():
                return
            log.info("Reconnect failed; retrying in 3s.")
            self._stop_event.wait(3.0)

    def _request_data_streams(self) -> None:
        """Ask the FC to stream position/status messages at a useful rate."""
        try:
            self._conn.mav.request_data_stream_send(
                self._conn.target_system,
                self._conn.target_component,
                mavutil.mavlink.MAV_DATA_STREAM_ALL,
                4,  # Hz
                1,  # start
            )
        except Exception:
            log.exception("Failed to request data streams (non-fatal).")


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

    parser = argparse.ArgumentParser(description="Flight controller smoke test.")
    parser.add_argument("--connection", default="sim:", help="Connection string (default: software sim)")
    parser.add_argument("--baud", type=int, default=57600)
    args = parser.parse_args()

    fc = FlightController(connection_string=args.connection, baud=args.baud)
    if not fc.connect():
        raise SystemExit("Flight controller connection failed.")

    fc.start_telemetry_loop()
    try:
        while True:
            time.sleep(1.0)
            s = fc.get_state()
            print(
                f"lat={s.lat:.6f} lon={s.lon:.6f} alt={s.altitude_m:.1f}m "
                f"hdg={s.heading_deg:.0f} spd={s.groundspeed_ms:.1f}m/s "
                f"batt={s.battery_pct:.0f}% mode={s.mode} armed={s.armed} "
                f"gps={s.gps_fix}/{s.gps_sats} connected={s.connected}"
            )
    except KeyboardInterrupt:
        fc.disconnect()
