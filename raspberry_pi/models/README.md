# AI Model Weights

The AI detector auto-selects a backend at startup:

1. **YOLOv8n** (ultralytics) — primary; weights auto-download on first run
2. **MobileNet SSD** (OpenCV DNN) — fallback; weights must be placed in this directory
3. **HOG+SVM** (OpenCV built-in) — emergency fallback; needs no files

## YOLOv8 (recommended)

```bash
pip install ultralytics
# Download weights once (also happens automatically on first detection run):
python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"
```

For better aerial (top-down) person detection, fine-tune YOLOv8n on the
VisDrone dataset and point `AI_MODEL_PATH` at the resulting weights:
https://github.com/ultralytics/ultralytics

## MobileNet SSD (fallback, no ultralytics needed)

Download both files into this `models/` directory:

```bash
wget https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/MobileNetSSD_deploy.prototxt \
     -O raspberry_pi/models/MobileNetSSD_deploy.prototxt
wget https://drive.google.com/uc?id=0B3gersZ2cHIxRm5PMWRoTkdHdHc \
     -O raspberry_pi/models/MobileNetSSD_deploy.caffemodel
```

> If the Google Drive link requires a confirmation page, download
> `MobileNetSSD_deploy.caffemodel` in a browser and copy it here manually.

## HOG+SVM

Built into OpenCV — no downloads. Slowest and least accurate; used only when
neither YOLO nor MobileNet SSD is available.
