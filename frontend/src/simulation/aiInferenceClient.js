import { AI_SERVICE_URL } from "./simulationConfig";

/**
 * Client for the local inference service that runs the drone's
 * model weights. Each simulated target is backed by an annotated aerial
 * photo; detections returned here are genuine model output, not simulated.
 */

let health = null;
let detectableImages = [];
let cursor = 0;

export function isLive() {
  return health !== null && detectableImages.length > 0;
}

export function getHealth() {
  return health;
}

export async function connect() {
  try {
    const healthResponse = await fetch(`${AI_SERVICE_URL}/health`);
    if (!healthResponse.ok) throw new Error(`health ${healthResponse.status}`);
    const healthBody = await healthResponse.json();

    const manifestResponse = await fetch(`${AI_SERVICE_URL}/manifest`);
    if (!manifestResponse.ok) throw new Error(`manifest ${manifestResponse.status}`);
    const manifestBody = await manifestResponse.json();

    health = healthBody;
    detectableImages = manifestBody.detectable || [];
    return health;
  } catch {
    health = null;
    detectableImages = [];
    return null;
  }
}

/** Round-robin so repeated targets in one demo don't all reuse the same photo. */
export function nextImageId() {
  if (!detectableImages.length) return null;
  const imageId = detectableImages[cursor % detectableImages.length];
  cursor += 1;
  return imageId;
}

/**
 * Run the detector on the patch under the aircraft.
 *
 * (cx, cy) is the normalized position within the frame; the service crops a
 * fixed window there — the size the model was trained on — rather than scoring
 * the whole 4000x3000 frame, which costs ~7 s instead of ~350 ms.
 */
export async function requestDetection(imageId, cx = 0.5, cy = 0.5) {
  try {
    const response = await fetch(`${AI_SERVICE_URL}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_id: imageId, cx, cy }),
    });
    if (!response.ok) throw new Error(`detect ${response.status}`);
    return await response.json();
  } catch {
    health = null;
    return null;
  }
}
