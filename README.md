# SAR Drone Command — Search & Rescue Drone System

A real-time search-and-rescue drone command system: Raspberry Pi drone nodes
with on-device AI person detection, MAVLink flight control, live MJPEG video,
and a mission-control dashboard with area sweep planning.

See it in action: **[website/index.html](website/index.html)** (or the hosted GitHub Pages site).

## System Architecture

```
[DRONE + Pi]──────────────────────────────[COMMAND PC]
Camera → AI Detector → JPEG+Detections  →  Frontend Dashboard
MAVLink ← Flight Controller ← Commands  ←  Mission Planner
Telemetry → WebSocket Client → Server   →  Map + Alerts
```

```
sar-drone-system/
├── backend/          Node.js WebSocket server (drones ⇄ dashboards relay)
├── simulator/        Multi-drone simulator (demos, no hardware needed)
├── frontend/         DEMO dashboard with 3D Three.js simulation panel
├── frontend-prod/    PRODUCTION dashboard (no 3D, wired to real Pi drones)
├── raspberry_pi/     Python drone node (camera, AI, thermal, MAVLink)
└── website/          Static project showcase page (GitHub Pages)
```

Two frontends serve different purposes:

- **`frontend/`** — demo/presentation mode with the interactive 3D simulation panel. Use for showcasing the system.
- **`frontend-prod/`** — lean production dashboard for real missions. Renders the Leaflet map directly, no Three.js, smaller bundle, plus live AI detection overlays on the video feeds.

## Hardware Requirements

| Component | Recommendation |
|---|---|
| Compute | Raspberry Pi 4B minimum, **Pi 5 recommended** for YOLOv8 speed (or Jetson Nano, see below) |
| Camera | Pi Camera Module 3 (CSI) or any USB webcam |
| Flight controller | Pixhawk 4, Cube Orange, or any ArduPilot / PX4 FC |
| Thermal (optional) | AMG8833 (I2C, ~$40) or FLIR Lepton on a PureThermal USB board (~$200) |

**Wiring the flight controller (UART):**

```
Pi GPIO14 (UART TX) → FC TELEM RX
Pi GPIO15 (UART RX) → FC TELEM TX
Pi GND              → FC GND        (common ground is required)
```

Alternatively connect over USB (`/dev/ttyACM0`), a USB-serial adapter
(`/dev/ttyUSB0`), or a telemetry radio bridged to UDP (`udp:127.0.0.1:14550`).

## Software Setup

**Backend (command PC):**

```bash
cd backend && npm install && node server.js
```

**Frontend — demo/presentation:**

```bash
cd frontend && npm install && npm run dev
```

**Frontend — production (real missions):**

```bash
cd frontend-prod && npm install && npm run dev     # or: npm run build
```

**Simulator (no hardware needed):**

```bash
cd simulator && npm install && node simulator.js
```

**Pi node (on the drone):**

```bash
bash raspberry_pi/install.sh      # full setup: deps, venv, interfaces, systemd
# then edit /opt/sar-drone/.env and:
sudo systemctl start sar-drone
```

> The dashboard reads the backend address from `VITE_WS_URL`
> (default `ws://localhost:8080`).

## Pi Node Quick Start (no real drone, for testing)

```bash
cd raspberry_pi
cp .env.example .env
# Edit .env: set SERVER_URL to your command PC's IP
# Set FAKE_VIDEO=true if no camera, FC_SITL_MODE=true if no flight controller
pip install -r requirements.txt
python main.py
```

Run `python test_system.py` first to diagnose camera, AI backend, thermal,
flight controller, and server connectivity individually.

### AI detection backends

The Pi node picks the best available backend automatically:

1. **YOLOv8n** (`pip install ultralytics`) — best accuracy, needs a `.pt` weights file (bring your own, or use a stock COCO checkpoint) via `AI_MODEL_PATH`
2. **MobileNet SSD** (OpenCV DNN) — download weights per `raspberry_pi/models/README.md`
3. **HOG+SVM** (OpenCV built-in) — zero dependencies, emergency fallback

For high-resolution camera frames (`VIDEO_WIDTH` ≥ ~1280), `AI_TILING=true`
enables SAHI-style sliced inference — the detector runs on overlapping
`AI_TILE_SIZE` crops plus one full-frame pass and merges the results, which
markedly improves recall on small/distant subjects at the cost of one
inference per tile.

## Jetson Nano Notes

- Install JetPack 4.6+ and `pip install ultralytics` — CUDA is used automatically.
- Connection strings and `.env` options are identical to the Pi.
- Power from the barrel jack (5V 4A) — USB power is not enough under GPU load.

## Mission Flow

1. Operator opens the dashboard and uses the **Mission Planner** to place a base and draw a search area polygon on the map.
2. **Deploy** generates a lawnmower sweep path and broadcasts the mission plan; the Pi node uploads the waypoints to the flight controller (`AUTO`/`GUIDED` mission).
3. Drones fly the sweep while streaming telemetry (GPS, battery, speed, altitude, heading) and live MJPEG video to the dashboard.
4. The on-device AI detector runs continuously. On a person detection it sends an **alert** with live GPS coordinates plus a **detection frame** (annotated JPEG + bounding boxes) that overlays on the video feed.
5. The optional thermal module (AMG8833 / FLIR Lepton / simulated) flags heat signatures and boosts confidence of overlapping detections; the dashboard's **Thermal** toggle switches the Pi's overlay remotely.
6. **Recall** commands an RTL (return-to-launch); low battery does the same automatically in simulation.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard shows "disconnected" | Backend not running or wrong `VITE_WS_URL`; check `node server.js` output and firewall on port 8080 |
| No video in dashboard | Pi's video port (default 8080 on the Pi) blocked, or `PI_IP` auto-detect picked the wrong interface — set `PI_IP` in `.env` |
| Camera won't open | Try `CAMERA_SOURCE=/dev/video0`, check `ls /dev/video*`, enable the camera in `raspi-config`, or set `FAKE_VIDEO=true` to bypass |
| No heartbeat from FC | Wrong port/baud (`FC_CONNECTION`, `FC_BAUD`), TX/RX swapped, or serial console still enabled — rerun `install.sh` and reboot |
| YOLO too slow on Pi 4 | Increase `AI_INFERENCE_INTERVAL_S` (e.g. `1.0`), or install MobileNet SSD weights and set `AI_BACKEND=mobilenet` |
| `ultralytics` install fails | Use `pip install ultralytics --no-deps` plus manual torch install, or fall back to `AI_BACKEND=mobilenet` / `hog` |
| AMG8833 not found | Enable I2C (`raspi-config`), check wiring with `i2cdetect -y 1` (address 0x69), `pip install smbus2` |
| Alerts flood the dashboard | Raise `AI_CONFIDENCE` (e.g. `0.6`) and/or `DETECTION_FRAME_INTERVAL_S` |
| Drone marker disappears | Telemetry stopped >15s (server prunes stale drones); check the Pi node logs: `journalctl -u sar-drone -f` |

## Message Protocol (WebSocket)

Clients register with `{"type": "register", "role": "drone" | "simulator" | "dashboard"}`.

| Type | Direction | Purpose |
|---|---|---|
| `telemetry_update` | drone → server → dashboards | Position, battery, status, video URL |
| `alert_event` | drone → server → dashboards | AI person detection with GPS + confidence |
| `detection_frame` | drone → server → dashboards | Annotated JPEG (base64) + bounding boxes |
| `mission_plan_update` | dashboard → server → drones | Search area + sweep path waypoints |
| `recall_drone` | dashboard → server → drones | Return to launch |
| `set_camera_mode` | dashboard → server → drones | Toggle thermal overlay |
| `fly_to` | dashboard → server → drones | Direct waypoint command |
| `ping` / `pong` | any ⇄ server | Connection health check |
| `snapshot` | server → dashboard | Full state on connect (incl. last detection frames) |
