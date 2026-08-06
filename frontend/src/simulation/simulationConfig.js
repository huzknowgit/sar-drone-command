export const SIM_METERS_PER_UNIT = 8;
/**
 * One aircraft. A single drone reads as a mission with a beginning and an end;
 * a stack of five orbiting the same subject reads as noise, and multi-drone
 * coordination is Phase 4 work that doesn't exist in hardware yet.
 */
export const DRONE_COUNT = 1;
export const CAMERA_RANGE_METERS = 700;
export const DETECTION_RANGE = 74;
export const CAMERA_FOV_DEG = 72;
export const DRONE_WIDTH_METERS = 1.83;
export const DRONE_LENGTH_METERS = 1.22;
export const ALERT_COOLDOWN_MS = 12000;
export const TELEMETRY_INTERVAL_MS = 800;
/** Max samples per drone for geo trail (oldest dropped). */
export const DRONE_TRAIL_MAX_POINTS = 8000;
/** Minimum horizontal world movement before appending another trail vertex (reduces duplicate points when nearly still). */
export const DRONE_TRAIL_MIN_WORLD_DELTA = 0.018;

/** Local inference service running the real aerial-tuned weights (raspberry_pi/sim_inference_server.py). */
export const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || "http://localhost:8090";
/** Matches the drone's real onboard inference cadence, so lock-on latency in the sim is honest. */
export const AI_INFERENCE_INTERVAL_MS = 700;

/**
 * Baked terrain built by datasets/build_terrain_mosaic.py — a colour-matched
 * mosaic of real aerial wilderness frames. The ground the drone searches is
 * genuine drone-altitude photography at a uniform scale, so the detector can
 * work anywhere in the search area rather than only over special patches.
 */
export const TERRAIN_MANIFEST_URL = "/terrain/mosaic_manifest.json";

/**
 * World half-extent. The mosaic spans 60 units (480 m) centred on the origin;
 * the surplus is the forest ring and horizon that frame it.
 */
export const WORLD_LIMIT = 96;

/** Sweep altitude in metres AGL — high enough to cover ground, low enough that people remain resolvable. */
export const SWEEP_ALTITUDE_METERS = 60;
/** Lawnmower lane spacing in metres; tighter than camera footprint so coverage overlaps. */
export const SWEEP_LANE_SPACING_METERS = 55;
/** Cruise speed in m/s during the search pattern. */
export const SWEEP_SPEED_MS = 14;

/** Forest ring drawn outside the photographed search area (never on top of it — the imagery already contains canopy). */
export const FOREST_RING_TREES = 420;
export const FOREST_RING_INNER_MARGIN = 4;

/**
 * Dalmatian karst inland of Split, Croatia — the landscape aerial was flown
 * over, and the terrain the detector is trained for. This is a representative
 * point in that region, not the dataset's exact survey coordinates, which are
 * not published; treat it as "this kind of ground", not a precise fix.
 *
 * The previous default was downtown Toronto, which put a wilderness search over
 * a street grid and contradicted the wilderness-tuned weights.
 */
export const DEFAULT_SIM_BASE = {
  lat: 43.5525,
  lon: 16.6215,
  name: "SAR COMMAND BASE",
};

/** Fallback patrol used only before a mission sweep is generated over the mosaic. */
export const PATROL_ROUTES = [
  [
    { x: -24, y: 8.5, z: -24 },
    { x: 24, y: 9.2, z: -24 },
    { x: 24, y: 10.5, z: 24 },
    { x: -24, y: 9.6, z: 24 },
  ],
];
