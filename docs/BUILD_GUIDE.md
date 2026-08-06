# SAR Drone — Build & Bring-Up Guide

Step-by-step hardware assembly and software bring-up, phase by phase. Buy
parts per [PARTS_LIST.md](../PARTS_LIST.md); the roadmap and exit criteria are
in [PROJECT_PLAN.md](PROJECT_PLAN.md).

---

## Phase 1 — Bench System

### 1.1 Pi setup
1. Flash **Raspberry Pi OS Bookworm 64-bit** to the SD card (Raspberry Pi Imager;
   set hostname, user `pi`, Wi-Fi, SSH in the imager's settings).
2. Boot, SSH in, then clone this repo and run the installer:
   ```bash
   git clone <your-repo-url> sar-drone-system
   bash sar-drone-system/raspberry_pi/install.sh
   ```
3. Edit `/opt/sar-drone/.env`: set `SERVER_URL=ws://<your-PC-ip>:8080`,
   `DRONE_ID=drone_1`.

### 1.2 Camera
- **Pi Camera Module 3:** connect the CSI ribbon (contacts toward the SoC),
  no config needed on Bookworm. Set `CAMERA_SOURCE=0`.
- **USB webcam:** plug in, `ls /dev/video*`, set `CAMERA_SOURCE=/dev/video0`.
- No camera yet? `FAKE_VIDEO=true`.

### 1.3 AMG8833 thermal (I2C)

| AMG8833 pin | Pi pin |
|---|---|
| VIN | 1 (3.3 V) |
| GND | 6 (GND) |
| SDA | 3 (GPIO2/SDA) |
| SCL | 5 (GPIO3/SCL) |

```bash
sudo raspi-config nonint do_i2c 0        # done by install.sh already
i2cdetect -y 1                            # expect device at 0x69
/opt/sar-drone/venv/bin/pip install smbus2
```
Set in `.env`: `THERMAL_ENABLED=true`, `THERMAL_MODE=amg8833`.

### 1.4 Command PC
```bash
cd backend && npm install && node server.js
cd frontend-prod && npm install && npm run dev   # production dashboard
```

### 1.5 Validate
```bash
/opt/sar-drone/venv/bin/python /opt/sar-drone/test_system.py
sudo systemctl start sar-drone && journalctl -u sar-drone -f
```
Walk in front of the camera → alert appears on the dashboard with a detection
overlay on the video feed. Record inference ms and detection range — this is
your Phase 1 evidence.

---

## Phase 2 — Multirotor Testbed

### 2.1 Airframe & FC (summary — follow the ArduCopter wiki for detail)
1. Assemble the S500/F450: motors on arms (2 CW, 2 CCW in X config), ESCs,
   power distribution, XT60 lead via the PM02 power module.
2. Mount the Pixhawk on anti-vibration foam, arrow forward. Connect: GPS/compass
   (mast), RC receiver, power module, buzzer + safety switch.
3. Flash **ArduCopter** (latest stable) with Mission Planner or QGroundControl.
4. Complete mandatory calibrations: accelerometer, compass, radio, ESC,
   failsafes (RTL on RC loss and low battery). **Configure a manual-override
   flight mode switch (STABILIZE/ALT_HOLD) before anything autonomous.**

### 2.2 Pi ↔ Pixhawk wiring (TELEM2)

| Pixhawk TELEM2 (JST-GH 6-pin) | Raspberry Pi |
|---|---|
| TX  | pin 10 (GPIO15, RXD) |
| RX  | pin 8 (GPIO14, TXD) |
| GND | pin 9 (GND) |

> TX→RX, RX→TX — crossed. Do **not** connect the 5 V line between them.
> Power the Pi from its own 5 V/5 A BEC off the flight battery.

Serial console must be off, UART on (done by `install.sh`; reboot required).

Pixhawk parameters: `SERIAL2_PROTOCOL=2` (MAVLink 2), `SERIAL2_BAUD=57` (57600).

`.env` on the Pi:
```env
FC_ENABLED=true
FC_CONNECTION=/dev/ttyAMA0
FC_BAUD=57600
FC_SITL_MODE=false
```

### 2.3 First flights (in order — do not skip)
1. **Bench, props off:** `python test_system.py` → flight controller check
   PASS with real GPS fix/satellite counts on the dashboard.
2. **Manual hover** (RC only, Pi observing): verify telemetry, video, and
   detections stream to the dashboard during flight.
3. **Guided test:** dashboard *recall* → confirm RTL engages.
4. **Mission test:** draw a small search area over your field → deploy → the
   node uploads waypoints to the FC → switch to AUTO at safe altitude →
   monitor the sweep; thumb on the mode switch the whole time.
5. **Detection test:** teammate stands in the search area → alert pin within
   ~10 m of their position = Phase 2 exit criterion met.

**Legal checklist before any outdoor flight (Canada):** drone registered
(≥250 g), registration marked on airframe, pilot holds Basic RPAS certificate,
uncontrolled airspace (check with the NAV Drone app), VLOS, not over people.

---

## Phase 3 — VTOL QuadPlane

### 3.1 Conversion overview (Skywalker X8)
1. Build the X8 per manufacturer instructions; pusher motor + ESC, elevon servos.
2. Mount carbon boom pairs under each wing; 4 lift motors + ESCs (quad X layout
   relative to the CG). Keep lift props clear of the wing surface.
3. CG matters more than anything: balance to the airframe spec **with the full
   payload installed** (Pi, cameras, battery).
4. Flash **ArduPlane**, enable QuadPlane (`Q_ENABLE=1`, `Q_FRAME_CLASS=1`),
   follow the ArduPlane QuadPlane docs for motor/servo mapping.
5. Install and calibrate the **airspeed sensor** (pitot on a wing, out of prop
   wash) — required for safe transitions.
6. Tune sequence: QHOVER hovers first ("it's just a quad"), then FBWA glide
   tests, then first transition at altitude with plenty of margin.

### 3.2 Thermal payload upgrade (FLIR Lepton)
1. PureThermal 3 board + Lepton 3.5, USB to the Pi. `ls /dev/video*` — it
   appears as a second device (usually `/dev/video1`... check, CSI cams shift
   numbering).
2. `.env`: `THERMAL_MODE=lepton`, `THERMAL_DEVICE_PATH=/dev/video1`,
   `THERMAL_HOTSPOT_THRESHOLD_C=32.0`.
3. Co-mount Lepton and RGB camera looking straight down, rigidly, close
   together — the confidence-boost fusion in `ai_detector.py` assumes
   roughly-aligned fields of view.

### 3.3 Jetson upgrade (optional)
Same repo, same `.env`. On JetPack: `pip install ultralytics` uses CUDA
automatically (~15 fps YOLOv8n vs ~1–2 on Pi 4). Lower
`AI_INFERENCE_INTERVAL_S` to `0.1`. Power the Jetson from a 5 V/6 A BEC.

---

## Bring-up cheat sheet

| Symptom | First thing to check |
|---|---|
| `test_system.py` FC check fails | `SERIAL2_PROTOCOL/BAUD` params; TX/RX swapped; serial console still enabled (reboot after install.sh) |
| GPS fix 0 on dashboard | Cold start takes 1–5 min outdoors; keep GPS away from ESC/power wiring |
| Detections lag behind video | Raise `AI_INFERENCE_INTERVAL_S`; check Pi throttling (`vcgencmd get_throttled`) |
| AMG8833 missing at 0x69 | Wrong I2C address jumper (0x68), SDA/SCL swapped |
| Video stutters in flight | Wi-Fi range — lower `VIDEO_WIDTH/HEIGHT/FPS`, or move the ground station AP |
| Compass errors after payload install | Re-run compass calibration with payload powered (camera/Pi magnets & current affect it) |
