#!/usr/bin/env bash
# SAR Drone Pi Node — Setup Script
# Run: bash install.sh
# Tested on: Raspberry Pi OS Bookworm 64-bit, Pi 4B/5
set -euo pipefail

INSTALL_DIR=/opt/sar-drone
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== SAR Drone Pi Node setup ==="

# 1. System packages
echo "--- Installing system packages..."
sudo apt-get update
sudo apt-get install -y python3-pip python3-venv git libopencv-dev python3-opencv

# 2. Virtualenv
echo "--- Creating virtualenv at ${INSTALL_DIR}/venv..."
sudo mkdir -p "${INSTALL_DIR}"
sudo chown "$(id -u):$(id -g)" "${INSTALL_DIR}"
python3 -m venv "${INSTALL_DIR}/venv"

# 3. Python dependencies
echo "--- Installing Python dependencies (this can take a while on a Pi)..."
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/venv/bin/pip" install -r "${SCRIPT_DIR}/requirements.txt"

echo ""
echo "Optional dependencies (install manually if you have the hardware):"
echo "  AMG8833 thermal sensor:  ${INSTALL_DIR}/venv/bin/pip install smbus2"
echo "  Adafruit AMG88xx lib:    ${INSTALL_DIR}/venv/bin/pip install Adafruit-AMG88xx"
echo ""

# 4-6. Enable Pi interfaces (skipped gracefully off-Pi)
if command -v raspi-config >/dev/null 2>&1; then
  echo "--- Enabling camera interface..."
  sudo raspi-config nonint do_camera 0 || echo "    (camera option not available on this OS build; CSI cameras work out of the box on Bookworm)"

  echo "--- Enabling I2C (for AMG8833 thermal sensor)..."
  sudo raspi-config nonint do_i2c 0

  echo "--- Enabling serial hardware, disabling serial console (for MAVLink on UART)..."
  sudo raspi-config nonint do_serial_hw 1 || true
  sudo raspi-config nonint do_serial_cons 1 || true
else
  echo "--- raspi-config not found; skipping interface setup (not a Raspberry Pi?)."
fi

# 7. Copy node files
echo "--- Copying node files to ${INSTALL_DIR}..."
cp "${SCRIPT_DIR}"/*.py "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/requirements.txt" "${INSTALL_DIR}/"
mkdir -p "${INSTALL_DIR}/models"
if [ -d "${SCRIPT_DIR}/models" ]; then
  cp -r "${SCRIPT_DIR}/models/." "${INSTALL_DIR}/models/"
fi
if [ ! -f "${INSTALL_DIR}/.env" ]; then
  cp "${SCRIPT_DIR}/.env.example" "${INSTALL_DIR}/.env"
  echo "    Created ${INSTALL_DIR}/.env from .env.example — EDIT IT before first flight."
fi

# 8. Systemd service
echo "--- Installing systemd service..."
sudo cp "${SCRIPT_DIR}/sar-drone.service" /etc/systemd/system/sar-drone.service
sudo systemctl daemon-reload
sudo systemctl enable sar-drone.service

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Edit ${INSTALL_DIR}/.env (SERVER_URL, DRONE_ID, camera + FC options)"
echo "  2. Test components:   ${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/test_system.py"
echo "  3. Start the node:    sudo systemctl start sar-drone"
echo "  4. Follow the logs:   journalctl -u sar-drone -f"
echo ""
echo "NOTE: a reboot is required for serial/I2C interface changes to take effect."
