# Raspberry Pi Drone Node

Python drone-side node for the SAR dashboard. It runs on the Raspberry Pi, streams camera video as MJPEG over HTTP, connects to the existing Node.js WebSocket backend, publishes telemetry once per second, follows deployed area-planner missions, and emits `human_detected` alerts every 20-40 seconds while searching.

## Files

- `main.py` - starts the MJPEG video server and WebSocket telemetry client together.
- `video_server.py` - Flask + OpenCV MJPEG endpoint at `/stream`.
- `telemetry_client.py` - WebSocket registration, telemetry loop, reconnect logic, alerts.
- `movement.py` - smooth mission-aware GPS simulation with planned-area bounds.
- `config.py` - environment-based configuration and Pi IP detection.
- `requirements.txt` - Python dependencies.

## Install on Raspberry Pi

```bash
cd ~/sar-drone-system/raspberry_pi
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

If OpenCV install is slow or fails on the Pi, use Debian packages for camera support:

```bash
sudo apt update
sudo apt install -y python3-opencv
pip install Flask websockets
```

## Find the Pi IP

On the Pi:

```bash
hostname -I
```

Use the first Wi-Fi/LAN address, for example `192.168.1.42`. The stream will be:

```text
http://192.168.1.42:8080/stream
```

## Run

Replace the backend IP with the computer running `backend/server.js`.

```bash
source .venv/bin/activate
python main.py --server-url ws://192.168.1.10:8080 --drone-id drone_1 --pi-ip 192.168.1.42
```

For a USB camera, use the OpenCV camera index or the Linux device path:

```bash
python main.py --server-url ws://192.168.1.10:8080 --camera-source 0 --camera-backend v4l2
python main.py --server-url ws://192.168.1.10:8080 --camera-source /dev/video0 --camera-backend v4l2
```

For a Logitech Brio on Raspberry Pi 3, prefer MJPEG at a modest resolution:

```bash
VIDEO_WIDTH=640 VIDEO_HEIGHT=360 VIDEO_FPS=10 JPEG_QUALITY=65 CAMERA_FOURCC=MJPG \
python main.py --server-url ws://192.168.1.10:8080 --camera-source /dev/video0 --camera-backend v4l2
```

You can also configure it with environment variables:

```bash
SERVER_URL=ws://192.168.1.10:8080 \
DRONE_ID=drone_1 \
PI_IP=192.168.1.42 \
python main.py
```

For a dry run without a camera:

```bash
python main.py --server-url ws://192.168.1.10:8080 --fake-video
```

## WebSocket Payloads

Telemetry, sent every second:

```json
{
  "type": "telemetry_update",
  "drone_id": "drone_1",
  "lat": 43.700999,
  "lon": -79.412111,
  "battery": 95.8,
  "status": "searching",
  "video_url": "http://192.168.1.42:8080/stream",
  "speed": 7.4,
  "altitude": 61.2,
  "heading": 144
}
```

Detection alert, sent every 20-40 seconds:

```json
{
  "type": "alert_event",
  "drone_id": "drone_1",
  "alert": "human_detected",
  "lat": 43.700999,
  "lon": -79.412111,
  "confidence": 0.92,
  "timestamp": 1700000000000
}
```

The timestamp is Unix epoch milliseconds to match JavaScript dashboard `Date` handling.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVER_URL` | `ws://192.168.1.50:8080` | Existing WebSocket backend URL |
| `DRONE_ID` | `drone_1` | Drone ID shown in dashboard |
| `PI_IP` | auto-detected | IP embedded in `video_url` |
| `VIDEO_PORT` | `8080` | MJPEG HTTP port |
| `VIDEO_WIDTH` | `640` | Stream width |
| `VIDEO_HEIGHT` | `360` | Stream height |
| `VIDEO_FPS` | `15` | Target camera FPS |
| `JPEG_QUALITY` | `70` | JPEG encode quality, 20-95 |
| `CAMERA_SOURCE` | `0` | OpenCV camera index or stream URL |
| `CAMERA_BACKEND` | `auto` | OpenCV backend: `auto`, `v4l2`, `dshow`, `msmf`, `gstreamer`, or `any` |
| `CAMERA_FOURCC` | `MJPG` | USB camera pixel format; recommended for Logitech Brio |
| `FAKE_VIDEO` | `false` | Generate test frames instead of using camera |
| `BASE_LAT` | `43.7005` | Movement base latitude |
| `BASE_LON` | `-79.4130` | Movement base longitude |
| `ALERT_MIN_S` | `20` | Minimum alert interval |
| `ALERT_MAX_S` | `40` | Maximum alert interval |

## Performance Tips

- Start with `640x360`, `15 FPS`, `JPEG_QUALITY=70`. That is usually responsive on local Wi-Fi.
- If latency climbs, reduce to `VIDEO_WIDTH=480 VIDEO_HEIGHT=270 VIDEO_FPS=10 JPEG_QUALITY=60`.
- Keep the Pi and dashboard machine on the same Wi-Fi band or wired LAN when possible.
- OpenCV keeps only a small capture buffer, and the MJPEG endpoint always serves the newest encoded frame.
- USB cameras normally appear as `/dev/video0`, `/dev/video1`, etc. Use `CAMERA_BACKEND=v4l2` on Raspberry Pi OS when OpenCV needs an explicit backend.
- If your Pi camera uses the modern libcamera stack and `CAMERA_SOURCE=0` does not open, test with `libcamera-hello` first, or expose a libcamera/v4l2 source that OpenCV can read.

## Area Planner Missions

When the dashboard deploys a search area, the backend forwards a `mission_plan_update` to every simulator/Pi node. This node accepts the mission, follows the generated sweep path, clamps simulated telemetry back inside the search polygon if it drifts outside, and only emits simulated alerts while inside the planned area. Recall commands switch the node to return-to-base behavior.

## Notes

This node sends `video_url` exactly as part of telemetry. The checked-in backend version must preserve and broadcast that field for the frontend to receive it; no backend or frontend files are changed here.
