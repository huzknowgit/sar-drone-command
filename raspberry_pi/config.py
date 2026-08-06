from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv is optional
    pass


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _camera_source(value: str) -> int | str:
    value = value.strip()
    if value.isdigit():
        return int(value)
    return value


def detect_lan_ip(server_url: str | None = None) -> str:
    """Best-effort local Wi-Fi/LAN IP detection without sending user data."""
    target_host = "8.8.8.8"
    if server_url:
        parsed = urlparse(server_url)
        if parsed.hostname and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            target_host = parsed.hostname

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect((target_host, 80))
            return sock.getsockname()[0]
        except OSError:
            try:
                return socket.gethostbyname(socket.gethostname())
            except OSError:
                return "127.0.0.1"


@dataclass(frozen=True)
class Settings:
    server_url: str
    drone_id: str
    pi_ip: str
    video_host: str
    video_port: int
    video_width: int
    video_height: int
    video_fps: int
    jpeg_quality: int
    camera_source: int | str
    camera_backend: str
    camera_fourcc: str
    fake_video: bool
    base_lat: float
    base_lon: float
    telemetry_interval_s: float
    alert_min_s: int
    alert_max_s: int

    # AI Settings
    ai_enabled: bool  # default True (AI_ENABLED=false to disable)
    ai_backend: str  # "auto", "yolo", "mobilenet", "hog"
    ai_confidence: float
    ai_model_path: str  # path to custom YOLO weights, "" = default yolov8n.pt
    ai_inference_interval_s: float
    ai_inference_size: int  # YOLO input size; 320 = fast, 640 = better small-person recall
    ai_tiling: bool  # SAHI-style sliced inference; only pays off with high-res frames
    ai_tile_size: int
    ai_tile_overlap: float
    ai_annotate_frame: bool
    detection_frame_interval_s: float  # min seconds between detection_frame WS msgs

    # Thermal Settings
    thermal_enabled: bool
    thermal_mode: str  # "amg8833", "lepton", "simulate"
    thermal_i2c_bus: int  # for AMG8833
    thermal_device_path: str  # for Lepton
    thermal_hotspot_threshold_c: float

    # Flight Controller Settings
    fc_enabled: bool  # default False (FC_ENABLED=true to enable)
    fc_connection: str
    fc_baud: int
    fc_sitl_mode: bool  # if True, use software sim instead of real MAVLink

    @property
    def video_url(self) -> str:
        return f"http://{self.pi_ip}:{self.video_port}/stream"

    @classmethod
    def from_env(cls) -> "Settings":
        server_url = os.getenv("SERVER_URL", "ws://192.168.1.50:8080")
        pi_ip = os.getenv("PI_IP") or detect_lan_ip(server_url)

        return cls(
            server_url=server_url,
            drone_id=os.getenv("DRONE_ID", "drone_1"),
            pi_ip=pi_ip,
            video_host=os.getenv("VIDEO_HOST", "0.0.0.0"),
            video_port=int(os.getenv("VIDEO_PORT", "8080")),
            video_width=int(os.getenv("VIDEO_WIDTH", "640")),
            video_height=int(os.getenv("VIDEO_HEIGHT", "360")),
            video_fps=int(os.getenv("VIDEO_FPS", "15")),
            jpeg_quality=int(os.getenv("JPEG_QUALITY", "70")),
            camera_source=_camera_source(os.getenv("CAMERA_SOURCE", "0")),
            camera_backend=os.getenv("CAMERA_BACKEND", "auto").strip().lower(),
            camera_fourcc=os.getenv("CAMERA_FOURCC", "MJPG").strip().upper(),
            fake_video=_env_bool("FAKE_VIDEO", False),
            base_lat=float(os.getenv("BASE_LAT", "43.7005")),
            base_lon=float(os.getenv("BASE_LON", "-79.4130")),
            telemetry_interval_s=float(os.getenv("TELEMETRY_INTERVAL_S", "1.0")),
            alert_min_s=int(os.getenv("ALERT_MIN_S", "20")),
            alert_max_s=int(os.getenv("ALERT_MAX_S", "40")),
            ai_enabled=_env_bool("AI_ENABLED", True) and not _env_bool("FAKE_AI", False),
            ai_backend=os.getenv("AI_BACKEND", "auto").strip().lower(),
            ai_confidence=float(os.getenv("AI_CONFIDENCE", "0.45")),
            ai_model_path=os.getenv("AI_MODEL_PATH", "").strip(),
            ai_inference_interval_s=float(os.getenv("AI_INFERENCE_INTERVAL_S", "0.5")),
            ai_inference_size=int(os.getenv("AI_INFERENCE_SIZE", "320")),
            ai_tiling=_env_bool("AI_TILING", False),
            ai_tile_size=int(os.getenv("AI_TILE_SIZE", "640")),
            ai_tile_overlap=float(os.getenv("AI_TILE_OVERLAP", "0.2")),
            ai_annotate_frame=_env_bool("AI_ANNOTATE_FRAME", True),
            detection_frame_interval_s=float(os.getenv("DETECTION_FRAME_INTERVAL_S", "2.0")),
            thermal_enabled=_env_bool("THERMAL_ENABLED", False),
            thermal_mode=os.getenv("THERMAL_MODE", "simulate").strip().lower(),
            thermal_i2c_bus=int(os.getenv("THERMAL_I2C_BUS", "1")),
            thermal_device_path=os.getenv("THERMAL_DEVICE_PATH", "/dev/video1"),
            thermal_hotspot_threshold_c=float(os.getenv("THERMAL_HOTSPOT_THRESHOLD_C", "35.0")),
            fc_enabled=_env_bool("FC_ENABLED", False) or _env_bool("FLIGHT_CONTROLLER_ENABLED", False),
            fc_connection=os.getenv("FC_CONNECTION", "/dev/ttyAMA0").strip(),
            fc_baud=int(os.getenv("FC_BAUD", "57600")),
            fc_sitl_mode=_env_bool("FC_SITL_MODE", False),
        )
