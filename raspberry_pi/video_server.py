from __future__ import annotations

import logging
import math
import sys
import threading
import time
from typing import Iterator, Optional

try:
    import cv2
except Exception:  # pragma: no cover - optional dependency
    cv2 = None
import numpy as np
from flask import Flask, Response, jsonify


log = logging.getLogger("pi_video")


class CameraStream:
    def __init__(
        self,
        source: int | str = 0,
        backend: str = "auto",
        fourcc: str = "MJPG",
        width: int = 640,
        height: int = 360,
        fps: int = 15,
        jpeg_quality: int = 70,
        fake_video: bool = False,
    ) -> None:
        self.source = source
        self.backend = backend
        self.fourcc = fourcc.strip().upper()
        self.width = width
        self.height = height
        self.fps = max(1, fps)
        self.jpeg_quality = max(20, min(95, jpeg_quality))
        # If OpenCV is not available, force fake video mode.
        self.fake_video = fake_video or (cv2 is None)
        self._capture: Optional["cv2.VideoCapture"] = None
        self._latest_jpeg: bytes | None = None
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self.last_frame_at = 0.0
        self._read_failures = 0
        self._last_reopen_attempt = 0.0

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._capture_loop, name="camera-capture", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        if self._capture:
            self._capture.release()

    def get_jpeg(self) -> bytes | None:
        with self._lock:
            return self._latest_jpeg

    def _capture_loop(self) -> None:
        if not self.fake_video:
            self._open_camera()

        frame_period = 1.0 / self.fps
        while not self._stop_event.is_set():
            started_at = time.monotonic()
            frame = self._read_frame()

            if frame is not None:
                jpeg = self._encode_frame(frame)
                if jpeg:
                    with self._lock:
                        self._latest_jpeg = jpeg
                        self.last_frame_at = time.time()

            elapsed = time.monotonic() - started_at
            time.sleep(max(0.001, frame_period - elapsed))

    def _open_camera(self) -> None:
        if cv2 is None:
            # OpenCV not available; fall back to fake video.
            log.warning("OpenCV not available; serving generated frames.")
            self.fake_video = True
            return

        if self._capture:
            self._capture.release()
            self._capture = None

        backend_id = self._opencv_backend()
        if backend_id == cv2.CAP_ANY:
            self._capture = cv2.VideoCapture(self.source)
        else:
            self._capture = cv2.VideoCapture(self.source, backend_id)

        if not self._capture.isOpened():
            log.warning(
                "Camera source %r did not open with backend %s; serving generated frames.",
                self.source,
                self.backend,
            )
            self.fake_video = True
            return

        log.info("Opened camera source %r with backend %s.", self.source, self.backend)
        if self.fourcc:
            self._capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*self.fourcc[:4]))
        self._capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self._capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self._capture.set(cv2.CAP_PROP_FPS, self.fps)
        self._capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    def _opencv_backend(self) -> int:
        if cv2 is None:
            return 0

        source_is_device = isinstance(self.source, int) or str(self.source).startswith("/dev/video")
        backend = (self.backend or "auto").lower()
        backend_map = {
            "any": cv2.CAP_ANY,
            "v4l2": getattr(cv2, "CAP_V4L2", cv2.CAP_ANY),
            "dshow": getattr(cv2, "CAP_DSHOW", cv2.CAP_ANY),
            "msmf": getattr(cv2, "CAP_MSMF", cv2.CAP_ANY),
            "gstreamer": getattr(cv2, "CAP_GSTREAMER", cv2.CAP_ANY),
        }

        if backend in backend_map:
            return backend_map[backend]

        if not source_is_device:
            return cv2.CAP_ANY
        if sys.platform.startswith("linux"):
            return getattr(cv2, "CAP_V4L2", cv2.CAP_ANY)
        if sys.platform.startswith("win"):
            return getattr(cv2, "CAP_DSHOW", cv2.CAP_ANY)
        return cv2.CAP_ANY

    def _read_frame(self):
        if self.fake_video:
            return self._fake_frame()

        if not self._capture:
            return None

        ok, frame = self._capture.read()
        if not ok:
            self._read_failures += 1
            log.warning("Camera read failed (%s consecutive); retrying.", self._read_failures)
            if self._read_failures >= 5:
                self._reopen_camera()
            else:
                time.sleep(0.2)
            return None

        self._read_failures = 0
        return frame

    def _reopen_camera(self) -> None:
        now = time.monotonic()
        if now - self._last_reopen_attempt < 2.0:
            time.sleep(0.2)
            return

        self._last_reopen_attempt = now
        log.warning("Reopening camera source %r.", self.source)
        self._open_camera()
        self._read_failures = 0

    def _encode_frame(self, frame) -> bytes | None:
        if frame.shape[1] != self.width or frame.shape[0] != self.height:
            if cv2 is not None:
                frame = cv2.resize(frame, (self.width, self.height), interpolation=cv2.INTER_AREA)
            else:
                # simple numpy resize via PIL if available
                try:
                    from PIL import Image

                    img = Image.fromarray(frame)
                    img = img.resize((self.width, self.height), Image.LANCZOS)
                    frame = np.array(img)
                except Exception:
                    pass

        if cv2 is not None:
            ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality])
            if not ok:
                return None
            return encoded.tobytes()

        # Fall back to PIL for JPEG encoding when OpenCV is not present
        try:
            from PIL import Image
            import io

            img = Image.fromarray(frame)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=self.jpeg_quality)
            return buf.getvalue()
        except Exception:
            return None

    def _fake_frame(self):
        frame = np.zeros((self.height, self.width, 3), dtype=np.uint8)
        t = time.time()
        pulse = int((math.sin(t * 2.0) * 0.5 + 0.5) * 90)
        frame[:, :] = (20 + pulse // 4, 35 + pulse // 3, 45 + pulse)
        # Draw text if OpenCV is available; otherwise skip text drawing.
        if cv2 is not None:
            cv2.putText(
                frame,
                "SAR PI CAMERA TEST",
                (24, 42),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (230, 250, 255),
                2,
                cv2.LINE_AA,
            )
            cv2.putText(
                frame,
                time.strftime("%Y-%m-%d %H:%M:%S"),
                (24, self.height - 28),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (180, 230, 255),
                1,
                cv2.LINE_AA,
            )
        return frame


def create_app(camera: CameraStream) -> Flask:
    app = Flask(__name__)

    @app.get("/")
    def index():
        return jsonify(
            {
                "service": "sar-drone-pi-video",
                "stream": "/stream",
                "last_frame_at": camera.last_frame_at,
            }
        )

    @app.get("/health")
    def health():
        return jsonify({"ok": camera.get_jpeg() is not None, "last_frame_at": camera.last_frame_at})

    @app.get("/stream")
    def stream():
        return Response(
            _mjpeg_frames(camera),
            mimetype="multipart/x-mixed-replace; boundary=frame",
            headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
        )

    return app


def _mjpeg_frames(camera: CameraStream) -> Iterator[bytes]:
    while True:
        jpeg = camera.get_jpeg()
        if jpeg is None:
            time.sleep(0.05)
            continue

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            + f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii")
            + jpeg
            + b"\r\n"
        )
        time.sleep(0.001)


def run_video_server(camera: CameraStream, host: str, port: int) -> None:
    camera.start()
    app = create_app(camera)
    app.run(host=host, port=port, threaded=True, use_reloader=False)
