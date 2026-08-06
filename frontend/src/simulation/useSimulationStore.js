import { create } from "zustand";
import {
  AI_INFERENCE_INTERVAL_MS,
  CAMERA_RANGE_METERS,
  CAMERA_FOV_DEG,
  DEFAULT_SIM_BASE,
  DETECTION_RANGE,
  DRONE_COUNT,
  DRONE_TRAIL_MAX_POINTS,
  DRONE_TRAIL_MIN_WORLD_DELTA,
  PATROL_ROUTES,
  SWEEP_ALTITUDE_METERS,
  SWEEP_LANE_SPACING_METERS,
  SWEEP_SPEED_MS,
  TERRAIN_MANIFEST_URL,
  WORLD_LIMIT,
} from "./simulationConfig";
import {
  createMissionProjection,
  headingRadToDegrees,
  latLonToWorld,
  normalizeBase,
  worldToLatLon,
  worldUnitsToMeters,
} from "./geo";
import {
  angleToTarget,
  clamp,
  distance2D,
  lerp,
  lerpAngle,
  moveToward,
} from "./visionMath";
import { connect as connectAi, isLive as aiIsLive, requestDetection } from "./aiInferenceClient";

/**
 * Two detections landing within this distance of each other are the same person
 * seen twice, not two contacts. Inference runs ~1.4x a second, so without this
 * a single casualty would file a fresh alert every frame the drone is overhead.
 */
const CONTACT_MERGE_METERS = 15;
/**
 * The service reports everything from 0.25 up. Everything it reports is logged,
 * but the aircraft only abandons its search pattern for a contact this strong —
 * a drone that breaks off to circle every marginal hit reads as broken.
 */
const CONTACT_CIRCLE_CONFIDENCE = 0.5;
/** How long after its last sighting a contact still draws a live detection ray. */
const CONTACT_ACTIVE_MS = 2600;
/** A contact further away than this is not something this aircraft can circle. */
const CONTACT_LOCK_RANGE_METERS = 160;
const CONSOLE_MAX_LINES = 80;
/** Re-log an unchanged inference result at most this often, so the console shows a live pulse without flooding. */
const AI_LOG_HEARTBEAT_MS = 5000;

/** Throttle/in-flight bookkeeping for inference calls, keyed by target id. */
const aiRequestState = new Map();
/** Dedupes the connect handshake across React StrictMode's double effect invocation. */
let aiConnectPromise = null;
/** Same for the terrain fetch — a state guard alone races, since both calls run before either resolves. */
let terrainPromise = null;
let consoleSeq = 0;

function consoleLine(source, text) {
  consoleSeq += 1;
  return {
    id: consoleSeq,
    time: new Date().toTimeString().slice(0, 8),
    source,
    text,
  };
}

function appendConsole(existing, lines) {
  if (!lines.length) return existing;
  const next = [...existing, ...lines];
  return next.length > CONSOLE_MAX_LINES ? next.slice(-CONSOLE_MAX_LINES) : next;
}

function clonePoint(point) {
  return { x: point.x, y: point.y, z: point.z };
}

function routeForIndex(index) {
  return PATROL_ROUTES[index % PATROL_ROUTES.length].map(clonePoint);
}

function createDrone(index) {
  const route = routeForIndex(index);
  const start = { x: (index - 2) * 2.8, y: 0.8, z: index % 2 === 0 ? -2.2 : 2.2 };
  const next = route[(index + 1) % route.length];
  const heading = angleToTarget(start, next);

  return {
    id: `drone_${index + 1}`,
    drone_id: `drone_${index + 1}`,
    position: clonePoint(start),
    velocity: { x: 0, y: 0, z: 0 },
    route,
    assignedRoute: null,
    routeIndex: 0,
    heading,
    cameraYaw: heading,
    cameraRange: DETECTION_RANGE,
    cameraFovDeg: CAMERA_FOV_DEG,
    scanPhase: index * 0.9,
    orbitPhase: index * 1.37,
    status: "idle",
    trackingState: "standby",
    targetId: null,
    confidence: 0,
    battery: clamp(96 - index * 3.8, 58, 99),
    speedMeters: 0,
    lastDetectionAt: 0,
    lastTelemetryAt: 0,
    /** Latest real inference over the frame beneath this aircraft. */
    currentTileId: null,
    scanImageId: null,
    scanDetections: [],
    scanConfidence: 0,
    scanInferenceMs: 0,
    scanBackend: null,
    scanAt: 0,
  };
}

/**
 * Where a detection box actually sits on the ground.
 *
 * Three coordinate systems stand between a model output and a place the
 * aircraft can fly to, and all three have to be undone in order:
 *
 *   1. the box is normalized to the 1024px CROP the detector was handed,
 *   2. the crop is a clamped window into the 4000x3000 source FRAME,
 *   3. the frame is painted into one mosaic CELL, drawn oversized by the
 *      feather margin so neighbouring tiles can cross-fade.
 *
 * Skipping step 3 puts every contact off by up to ~16 m — the amount the
 * oversized draw stretches the imagery past its cell. Verified against the
 * manifest's own worldX/worldZ for annotated persons.
 */
function detectionToWorld(terrain, cell, scan, bbox) {
  if (!terrain || !cell || !Array.isArray(bbox) || bbox.length < 4) return null;

  const [left, top, width, height] = bbox;
  const cropPx = scan.crop_px || 1024;
  const halfX = cropPx / 2 / terrain.sourceWidth;
  const halfY = cropPx / 2 / terrain.sourceHeight;

  // The service clamps the crop window inside the frame; match it exactly, or
  // boxes near a frame edge resolve to ground the camera was never over.
  const centreX = clamp(scan.cx ?? 0.5, halfX, 1 - halfX);
  const centreY = clamp(scan.cy ?? 0.5, halfY, 1 - halfY);

  const frameX = (centreX - halfX) + (left + width / 2) * (2 * halfX);
  const frameY = (centreY - halfY) + (top + height / 2) * (2 * halfY);

  const drawnSpan = terrain.tileUnits * (terrain.tilePx + 2 * terrain.featherPx) / terrain.tilePx;
  const halfTile = terrain.tileUnits / 2;

  return {
    x: terrain.originX + cell.col * terrain.tileUnits + halfTile + (frameX - 0.5) * drawnSpan,
    y: 0,
    z: terrain.originZ + cell.row * terrain.tileUnits + halfTile + (frameY - 0.5) * drawnSpan,
  };
}

function metersToWorldUnits(meters, projection = null) {
  return meters / worldUnitsToMeters(1, projection);
}

function missionAltitude(index, projection = null) {
  return metersToWorldUnits(52 + index * 6, projection);
}

function missionCameraRange(projection = null) {
  return clamp(metersToWorldUnits(CAMERA_RANGE_METERS, projection), 30, 92);
}

function steerDrone(drone, destination, dt, speedMetersPerSecond, projection = null) {
  const previous = drone.position;
  const speedUnits = metersToWorldUnits(speedMetersPerSecond, projection);
  const position = moveToward(previous, destination, speedUnits * dt);
  const yaw = distance2D(previous, destination) > 0.05
    ? lerpAngle(drone.heading, angleToTarget(previous, destination), dt * 2.8)
    : drone.heading;

  return {
    ...drone,
    position,
    heading: yaw,
    velocity: {
      x: (position.x - previous.x) / Math.max(dt, 0.001),
      y: (position.y - previous.y) / Math.max(dt, 0.001),
      z: (position.z - previous.z) / Math.max(dt, 0.001),
    },
    speedMeters: worldUnitsToMeters(distance2D(previous, position), projection) / Math.max(dt, 0.001),
  };
}

function clampWorld(point) {
  return {
    x: clamp(point.x, -WORLD_LIMIT, WORLD_LIMIT),
    y: Number.isFinite(point.y) ? point.y : 0,
    z: clamp(point.z, -WORLD_LIMIT, WORLD_LIMIT),
  };
}

function splitSweepRouteByDrone(path, count) {
  const lanes = [];
  for (let index = 0; index < path.length - 1; index += 2) {
    lanes.push([path[index], path[index + 1]]);
  }

  if (lanes.length < count) {
    return Array.from({ length: count }, () => path);
  }

  const lanesPerDrone = Math.ceil(lanes.length / count);
  return Array.from({ length: count }, (_, index) => {
    const chunk = lanes.slice(index * lanesPerDrone, (index + 1) * lanesPerDrone).flat();
    return chunk.length >= 2 ? chunk : path;
  });
}

function missionRoutes(missionPlan, base, projection, droneCount) {
  const geoPath = Array.isArray(missionPlan?.sweepPath) ? missionPlan.sweepPath : [];
  const splitRoutes = splitSweepRouteByDrone(geoPath, droneCount);

  return splitRoutes.map((route, droneIndex) => {
    const path = route
      .map((point) => latLonToWorld(point, base, projection))
      .filter(Boolean)
      .filter((point, index, points) => index === 0 || distance2D(point, points[index - 1]) > 1.8);

    if (path.length < 2) return null;

    return path.map((point) => {
      return {
        x: point.x,
        y: missionAltitude(droneIndex, projection),
        z: point.z,
      };
    });
  });
}

/**
 * Which mosaic tile sits under a world position — i.e. which real aerial frame
 * the drone's camera is actually over. This is what makes the feed and the
 * detector agree: both read the frame this returns.
 */
export function locateOnTerrain(terrain, x, z) {
  if (!terrain) return null;

  const { originX, originZ, tileUnits, grid } = terrain;
  const gx = (x - originX) / tileUnits;
  const gz = (z - originZ) / tileUnits;
  const col = Math.floor(gx);
  const row = Math.floor(gz);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null;

  const tile = terrain.tiles[row * grid.cols + col];
  if (!tile) return null;

  // Where inside the frame the aircraft sits, 0-1. This aims the camera crop:
  // the detector reads the patch under the drone, not the whole 4000x3000 frame.
  return { tile, fx: gx - col, fy: gz - row };
}

/**
 * Lawnmower sweep across the photographed search area, in world space.
 *
 * The mosaic is a fixed patch of ground rather than an operator-drawn polygon,
 * so the pattern is generated directly here instead of going through the geo
 * mission planner.
 */
function forestSweepRoute(terrain) {
  const span = terrain.spanUnits;
  const half = span / 2;
  const altitude = SWEEP_ALTITUDE_METERS / terrain.metersPerUnit;
  const spacing = SWEEP_LANE_SPACING_METERS / terrain.metersPerUnit;

  // Lane count is derived from the span rather than stepping by spacing until we
  // run out: stepping leaves a gap whenever the spacing doesn't divide the area
  // evenly, and that gap is a strip of ground the drone never looks at. Rounding
  // the count up and spreading lanes across equal bands guarantees full coverage,
  // tightening the lanes slightly instead of skipping a row.
  const laneCount = Math.max(2, Math.ceil(span / spacing));
  const band = span / laneCount;
  const inset = band * 0.5;

  const route = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    const z = -half + inset + lane * band;
    const xs = lane % 2 === 0 ? [-half + inset, half - inset] : [half - inset, -half + inset];
    route.push({ x: xs[0], y: altitude, z });
    route.push({ x: xs[1], y: altitude, z });
  }

  return route;
}

function telemetryFromDrone(drone, base, projection) {
  const geo = worldToLatLon(drone.position, base, projection);
  const panelStatus = drone.status === "tracking" ? "searching" : drone.status;

  return {
    type: "telemetry_update",
    drone_id: drone.drone_id,
    lat: geo.lat,
    lon: geo.lon,
    battery: +drone.battery.toFixed(1),
    status: panelStatus,
    speed: +drone.speedMeters.toFixed(2),
    altitude: Math.max(0, Math.round(worldUnitsToMeters(drone.position.y, projection))),
    heading: +headingRadToDegrees(drone.heading).toFixed(1),
  };
}

export const useSimulationStore = create((set, get) => ({
  base: DEFAULT_SIM_BASE,
  missionPlan: null,
  missionProjection: null,
  drones: Array.from({ length: DRONE_COUNT }, (_, index) => createDrone(index)),
  /**
   * Everything the detector has found, in world coordinates.
   *
   * There is no pre-placed cast of subjects to be discovered — a contact exists
   * only because the model put a box on a person in the imagery, so the map
   * shows the search's actual findings, misses and false positives included.
   */
  contacts: [],
  nextContactId: 1,
  detectionContacts: [],
  pendingAlerts: [],
  selectedDroneId: "drone_1",
  cameraMode: "overview",
  trackingEnabled: true,
  simulatorConnection: "disconnected",
  lastCommand: "AUTONOMOUS SEARCH",
  /** { [drone_id]: Array<{ lat, lon }> } — full flown path in geo coordinates (simulated). */
  dronePathHistory: {},
  /** "connecting" | "real_ai" | "sensor_offline" */
  detectionMode: "connecting",
  aiHealth: null,
  /** Onboard-computer console ring buffer. */
  consoleLines: [],
  /** Baked aerial mosaic layout (frontend/public/terrain/mosaic_manifest.json). */
  terrain: null,
  /**
   * Detections kept locally, newest first.
   *
   * `pendingAlerts` is drained by the telemetry hook and pushed to the backend;
   * with no backend running those events would vanish and the event log would
   * sit empty while the drone was visibly finding people. This is the record the
   * UI reads when the WebSocket has nothing.
   */
  alertLog: [],

  setBase: (base) => set((state) => {
    const cleanBase = normalizeBase(base);
    if (state.missionPlan) return { base: cleanBase };
    return { base: cleanBase, missionProjection: null };
  }),
  setSimulatorConnection: (simulatorConnection) => set({ simulatorConnection }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setSelectedDroneId: (selectedDroneId) => set({ selectedDroneId }),
  toggleTracking: () => set((state) => ({ trackingEnabled: !state.trackingEnabled })),

  pushConsoleLine: (source, text) => set((state) => ({
    consoleLines: appendConsole(state.consoleLines, [consoleLine(source, text)]),
  })),

  /**
   * Load the baked terrain and put the aircraft on its sweep.
   *
   * Nothing is placed for it to find. The annotated person count is reported
   * only so the console can state the search area honestly; who gets found is
   * decided by the detector during the flight.
   */
  loadTerrain: async () => {
    if (terrainPromise) return terrainPromise;
    terrainPromise = (async () => {
    let terrain = null;
    try {
      const response = await fetch(TERRAIN_MANIFEST_URL);
      if (response.ok) terrain = await response.json();
    } catch {
      terrain = null;
    }

    if (!terrain) {
      set((state) => ({
        consoleLines: appendConsole(state.consoleLines, [
          consoleLine("SYS", "terrain manifest missing — run datasets/build_terrain_mosaic.py"),
        ]),
      }));
      return null;
    }

    const route = forestSweepRoute(terrain);
    const totalPersons = terrain.tiles.reduce((sum, tile) => sum + tile.persons.length, 0);

    set((state) => ({
      terrain,
      drones: state.drones.map((drone) => ({
        ...drone,
        route,
        assignedRoute: route,
        routeIndex: 0,
        position: { x: route[0].x, y: route[0].y, z: route[0].z },
        status: "searching",
        trackingState: "searching",
        missionComplete: false,
        cameraRange: DETECTION_RANGE,
      })),
      lastCommand: "AREA SWEEP ACTIVE",
      consoleLines: appendConsole(state.consoleLines, [
        consoleLine("SYS", `terrain: ${terrain.grid.cols}x${terrain.grid.rows} aerial frames, ${terrain.spanMeters}m square`),
        consoleLine("SYS", `search area ground truth: ${totalPersons} annotated persons`),
        consoleLine("NAV", `sweep pattern: ${route.length} waypoints @ ${SWEEP_ALTITUDE_METERS}m AGL, ${SWEEP_LANE_SPACING_METERS}m lanes`),
        consoleLine("NAV", "GUIDED mode — autonomous area search"),
      ]),
    }));

    return terrain;
    })();

    return terrainPromise;
  },

  connectAiService: async () => {
    if (aiConnectPromise) return aiConnectPromise;

    aiConnectPromise = connectAi();
    const health = await aiConnectPromise;

    set((state) => {
      if (!health) {
        return {
          detectionMode: "sensor_offline",
          aiHealth: null,
          consoleLines: appendConsole(state.consoleLines, [
            consoleLine("LINK", `inference service unreachable at :8090`),
            consoleLine("SYS", "sensor offline — no contacts will be reported"),
          ]),
        };
      }

      return {
        detectionMode: "real_ai",
        aiHealth: health,
        consoleLines: appendConsole(state.consoleLines, [
          consoleLine("SYS", `detector backend: ${health.backend}`),
          consoleLine("SYS", `weights: ${health.model}`),
          consoleLine("SYS", `imagery: ${health.images} frames @ ${health.crop_px}px crops, ${health.persons} annotated persons`),
          consoleLine("SYS", `source: ${health.source || "aerial"}`),
          consoleLine("LINK", `inference service online (conf >= ${health.confidence_threshold})`),
        ]),
      };
    });
  },

  reportAiDisconnected: () => set((state) => (
    state.detectionMode === "sensor_offline" ? {} : {
      detectionMode: "sensor_offline",
      aiHealth: null,
      consoleLines: appendConsole(state.consoleLines, [
        consoleLine("LINK", "inference service lost"),
        consoleLine("SYS", "sensor offline — no contacts will be reported"),
      ]),
    }
  )),

  /**
   * Result of one inference pass over the frame beneath a drone.
   *
   * This is where a detection becomes a thing that exists in the world: every
   * box the model returns is projected onto the ground and either merged into a
   * contact already standing there or filed as a new one. A new contact is what
   * raises the alert the ground station sees, so the event log and the onboard
   * computer are reporting the same events — there is no second, separate idea
   * of what was found.
   */
  applyAiScan: (droneId, result, cell) => set((state) => {
    const boxes = result.detections || [];
    const top = boxes.reduce((best, det) => Math.max(best, det.confidence), 0);
    const now = Date.now();

    const mergeUnits = metersToWorldUnits(CONTACT_MERGE_METERS, state.missionProjection);
    const contacts = state.contacts.slice();
    const newAlerts = [];
    const contactLines = [];
    let nextContactId = state.nextContactId;
    let sightings = 0;

    for (const box of boxes) {
      const position = detectionToWorld(state.terrain, cell, result, box.bbox_norm);
      if (!position) continue;

      sightings += 1;
      const index = contacts.findIndex((contact) => distance2D(contact.position, position) <= mergeUnits);

      if (index >= 0) {
        // Same person, seen again. Keep the strongest look the model has had of
        // them and let the position settle toward the newest fix.
        const existing = contacts[index];
        contacts[index] = {
          ...existing,
          position: {
            x: lerp(existing.position.x, position.x, 0.25),
            y: 0,
            z: lerp(existing.position.z, position.z, 0.25),
          },
          confidence: Math.max(existing.confidence, box.confidence),
          lastConfidence: box.confidence,
          lastSeenAt: now,
          lastSeenBy: droneId,
          sightings: existing.sightings + 1,
          imageId: result.image_id,
        };
        continue;
      }

      const contact = {
        id: `contact_${nextContactId}`,
        position,
        confidence: box.confidence,
        lastConfidence: box.confidence,
        firstSeenAt: now,
        lastSeenAt: now,
        lastSeenBy: droneId,
        sightings: 1,
        imageId: result.image_id,
        ignored: false,
      };
      nextContactId += 1;
      contacts.push(contact);

      const geo = worldToLatLon(position, state.base, state.missionProjection);
      contactLines.push(consoleLine(
        "NET",
        `alert_event -> ground station: ${contact.id} ${geo.lat.toFixed(5)},${geo.lon.toFixed(5)} conf=${box.confidence.toFixed(2)}`,
      ));
      newAlerts.push({
        // The backend mints ids when it relays; with no backend the panel still
        // needs a stable key, so one is minted here.
        id: `sim_${contact.id}_${now}`,
        type: "alert_event",
        drone_id: droneId,
        alert: "human_detected",
        target_id: contact.id,
        confidence: +box.confidence.toFixed(2),
        lat: geo.lat,
        lon: geo.lon,
        position: { x: +position.x.toFixed(2), z: +position.z.toFixed(2) },
        timestamp: now,
      });
    }

    // Inference runs every frame; log each change, then only a periodic
    // heartbeat once results stop moving, so the console stays readable.
    const entry = aiRequestState.get(droneId);
    const signature = `${result.image_id}:${boxes.length}:${top.toFixed(2)}`;
    const shouldLog = !entry
      || entry.loggedSignature !== signature
      || now - (entry.loggedAt || 0) > AI_LOG_HEARTBEAT_MS;

    if (entry && shouldLog) {
      entry.loggedSignature = signature;
      entry.loggedAt = now;
    }

    const lines = shouldLog ? [consoleLine(
      "AI",
      boxes.length
        ? `frame ${result.image_id}: ${boxes.length} person @ ${(top * 100).toFixed(0)}% conf (${result.inference_ms}ms, ${result.backend})`
        : `frame ${result.image_id}: no person (${result.inference_ms}ms, ${result.backend})`,
    )] : [];

    return {
      consoleLines: appendConsole(state.consoleLines, [...lines, ...contactLines]),
      contacts,
      nextContactId,
      pendingAlerts: newAlerts.length ? [...state.pendingAlerts, ...newAlerts] : state.pendingAlerts,
      // Newest first, capped — the panel shows recent contacts, not the sortie's
      // full history, and this is display state rather than a record of record.
      alertLog: newAlerts.length
        ? [...newAlerts.slice().reverse(), ...state.alertLog].slice(0, 60)
        : state.alertLog,
      drones: state.drones.map((item) => (
        item.drone_id === droneId
          ? {
            ...item,
            scanImageId: result.image_id,
            scanDetections: boxes,
            scanConfidence: top,
            scanInferenceMs: result.inference_ms,
            scanBackend: result.backend,
            scanAt: now,
            scanSightings: sightings,
            // The crop these boxes belong to — the feed must render the same
            // window, or the boxes would sit over the wrong patch of ground.
            scanCropX: result.cx,
            scanCropY: result.cy,
            scanCropPx: result.crop_px,
          }
          : item
      )),
    };
  }),

  setMissionPlan: (missionPlan) => set((state) => {
    const cleanBase = normalizeBase(missionPlan?.base || state.base);
    const missionProjection = createMissionProjection(missionPlan, cleanBase);
    const drones = state.drones.slice(0, DRONE_COUNT);

    // With baked terrain loaded the search area is a fixed patch of real
    // photography, not an operator-drawn polygon, so an incoming geo plan is
    // kept for the map but must not retask the drone off the imagery.
    if (state.terrain) {
      return { missionPlan, base: cleanBase, missionProjection, drones };
    }

    const routes = missionProjection
      ? missionRoutes(missionPlan, cleanBase, missionProjection, drones.length)
      : null;

    if (!routes || routes.some((route) => !route)) {
      return {
        missionPlan,
        base: cleanBase,
        missionProjection,
        lastCommand: missionPlan ? "MISSION PLAN RECEIVED" : state.lastCommand,
        drones,
        dronePathHistory: {},
      };
    }

    const baseWorld = latLonToWorld(cleanBase, cleanBase, missionProjection) || { x: 0, y: 0, z: 0 };

    const reassigned = drones.map((drone, index) => ({
      ...drone,
      route: routes[index],
      assignedRoute: routes[index],
      routeIndex: 0,
      status: drone.status === "charging" ? "charging" : "searching",
      trackingState: "searching",
      targetId: null,
      missionComplete: false,
      cameraRange: missionCameraRange(missionProjection),
      cameraFovDeg: CAMERA_FOV_DEG,
      position: {
        x: baseWorld.x + (index - 2) * 2.8,
        y: Math.max(0.9, missionAltitude(index, missionProjection) * 0.22),
        z: baseWorld.z + (index % 2 === 0 ? -2.2 : 2.2),
      },
      velocity: { x: 0, y: 0, z: 0 },
    }));

    const dronePathHistory = {};
    for (const drone of reassigned) {
      const geo = worldToLatLon(drone.position, cleanBase, missionProjection);
      dronePathHistory[drone.drone_id] = [{ lat: geo.lat, lon: geo.lon }];
    }

    return {
      missionPlan,
      base: cleanBase,
      missionProjection,
      lastCommand: "MISSION SWEEP ASSIGNED",
      drones: reassigned,
      dronePathHistory,
    };
  }),

  /**
   * Operator waves a contact off: drop the orbit and go back on the planned
   * route. The aircraft holds its orbit indefinitely until this is clicked —
   * deciding a contact has been dealt with is the operator's call, not a
   * timeout's. The alert stays in the event log; the detection was real and
   * gets triaged, not erased.
   */
  ignoreContact: (contactId) => set((state) => {
    const id = contactId || state.drones.find((drone) => drone.targetId)?.targetId;
    const contact = state.contacts.find((item) => item.id === id);
    if (!contact || contact.ignored) return {};

    return {
      contacts: state.contacts.map((item) => (
        item.id === id ? { ...item, ignored: true, ignoredAt: Date.now() } : item
      )),
      lastCommand: `WAVE OFF ${id.toUpperCase()}`,
      consoleLines: appendConsole(state.consoleLines, [
        consoleLine("CMD", `operator: ${id} waved off — resuming planned route`),
      ]),
      drones: state.drones.map((drone) => (
        drone.targetId === id
          ? {
            ...drone,
            status: drone.status === "tracking" ? "searching" : drone.status,
            trackingState: "searching",
            targetId: null,
            confidence: 0,
          }
          : drone
      )),
    };
  }),

  /** Re-arm every waved-off contact, so the aircraft can circle them again. */
  clearIgnoredContacts: () => set((state) => {
    const count = state.contacts.filter((contact) => contact.ignored).length;
    if (!count) return {};

    return {
      contacts: state.contacts.map((contact) => (
        contact.ignored ? { ...contact, ignored: false, ignoredAt: 0 } : contact
      )),
      consoleLines: appendConsole(state.consoleLines, [
        consoleLine("CMD", `operator: ignore list cleared — ${count} contact(s) re-armed`),
      ]),
    };
  }),

  recallDrone: (droneId) => set((state) => ({
    lastCommand: `RECALL ${String(droneId || "").toUpperCase()}`,
    drones: state.drones.map((drone) => {
      const baseWorld = latLonToWorld(state.base, state.base, state.missionProjection) || { x: 0, z: 0 };
      return drone.drone_id === droneId
        ? {
          ...drone,
          status: "returning",
          trackingState: "returning",
          targetId: null,
          route: [{ x: baseWorld.x, y: 1.2, z: baseWorld.z }],
          routeIndex: 0,
        }
        : drone;
    }),
  })),

  drainPendingAlerts: () => {
    const pendingAlerts = get().pendingAlerts;
    if (pendingAlerts.length) set({ pendingAlerts: [] });
    return pendingAlerts;
  },

  getTelemetryPackets: () => {
    const state = get();
    return state.drones.map((drone) => telemetryFromDrone(drone, state.base, state.missionProjection));
  },

  advanceSimulation: (rawDt, elapsed) => {
    const inferenceRequests = [];
    set((state) => advanceState(state, rawDt, elapsed, inferenceRequests));
    for (const request of inferenceRequests) dispatchInference(request);
  },
}));

function advanceState(state, rawDt, elapsed, inferenceRequests) {
    const dt = clamp(rawDt || 0.016, 0.001, 0.08);
    const now = Date.now();
    const detectionContacts = [];
    const newConsoleLines = [];
    const realAi = state.detectionMode === "real_ai";
    const projection = state.missionProjection;
    const baseWorld = latLonToWorld(state.base, state.base, projection) || { x: 0, y: 0, z: 0 };

    const updatedDrones = state.drones.map((drone, index) => {
      let next = {
        ...drone,
        position: clonePoint(drone.position),
        velocity: clonePoint(drone.velocity),
      };
      const lockedContact = state.contacts.find((contact) => contact.id === next.targetId);

      if (next.status === "idle") {
        const idleTarget = {
          x: baseWorld.x + (index - 2) * 2.8,
          y: 0.8,
          z: baseWorld.z + (index % 2 === 0 ? -2.2 : 2.2),
        };
        next = {
          ...next,
          position: moveToward(next.position, idleTarget, metersToWorldUnits(8, projection) * dt),
          velocity: { x: 0, y: 0, z: 0 },
          speedMeters: 0,
          battery: clamp(next.battery + dt * 2.2, 0, 100),
        };
        next.cameraYaw = lerpAngle(next.cameraYaw, next.heading + Math.sin(elapsed + next.scanPhase) * 0.45, dt * 1.2);
        return next;
      }

      if (next.status === "charging") {
        const battery = clamp(next.battery + dt * 6.5, 0, 100);
        if (battery > 96) {
          if (next.missionComplete) {
            return {
              ...next,
              battery,
              status: "idle",
              trackingState: "standby",
              targetId: null,
              speedMeters: 0,
            };
          }

          const route = next.assignedRoute || routeForIndex(index);
          next = {
            ...next,
            battery,
            status: "searching",
            trackingState: "searching",
            route,
            routeIndex: 0,
            position: { x: baseWorld.x, y: missionAltitude(index, projection), z: baseWorld.z },
          };
        } else {
          next = {
            ...next,
            battery,
            position: { x: baseWorld.x, y: 1.2, z: baseWorld.z },
            velocity: { x: 0, y: 0, z: 0 },
            speedMeters: 0,
          };
        }
        return next;
      }

      if (next.status === "returning") {
        const destination = { x: baseWorld.x, y: 1.2, z: baseWorld.z };
        next = steerDrone(next, destination, dt, 13.5, projection);
        next.cameraYaw = lerpAngle(next.cameraYaw, next.heading, dt * 2.2);
        next.battery = clamp(next.battery - dt * 0.9, 0, 100);

        if (distance2D(next.position, destination) < 1.4 && next.position.y < 1.8) {
          next = {
            ...next,
            status: "charging",
            trackingState: "charging",
            targetId: null,
            speedMeters: 0,
            velocity: { x: 0, y: 0, z: 0 },
          };
        }

        return next;
      }

      // Contacts are created by the detector in applyAiScan, not here. All this
      // has to decide is whether one of them is worth breaking off the search
      // pattern for — and once it commits, it holds the orbit until the
      // operator waves it off. Nothing times out on its own: an unattended
      // find is exactly the thing a search aircraft must not quietly abandon.
      const lockRange = metersToWorldUnits(CONTACT_LOCK_RANGE_METERS, projection);
      let lockTarget = state.trackingEnabled && lockedContact && !lockedContact.ignored
        ? lockedContact
        : null;

      if (state.trackingEnabled && !lockTarget) {
        let nearest = null;
        let nearestDistance = Infinity;
        for (const contact of state.contacts) {
          if (contact.ignored || contact.confidence < CONTACT_CIRCLE_CONFIDENCE) continue;

          const distance = distance2D(next.position, contact.position);
          if (distance > lockRange || distance >= nearestDistance) continue;

          nearest = contact;
          nearestDistance = distance;
        }
        lockTarget = nearest;
      }

      if (lockTarget) {
        if (next.targetId !== lockTarget.id) next.lastDetectionAt = now;
        next.status = "tracking";
        next.trackingState = "target_lock";
        next.targetId = lockTarget.id;
        next.confidence = lockTarget.confidence;
      } else {
        if (next.status === "tracking") next.status = "searching";
        next.trackingState = "searching";
        next.targetId = null;
        next.confidence = Math.max(0, next.confidence - dt * 0.5);
      }

      if (lockTarget) {
        next.cameraYaw = lerpAngle(next.cameraYaw, angleToTarget(next.position, lockTarget.position), dt * 4.4);
      } else {
        const scanYaw = next.heading + Math.sin(elapsed * 0.95 + next.scanPhase) * 0.95;
        next.cameraYaw = lerpAngle(next.cameraYaw, scanYaw, dt * 1.8);
      }

      // Where the sensor is pointed. Searching, it looks straight down at the
      // ground the aircraft is passing over. Circling a contact, it stays on
      // the contact — the orbit is ~72 m wide but a 1024px crop only spans
      // ~15 m of ground, so a nadir-locked camera would swing the person out of
      // frame on every lap. A real gimbal holds the subject; so does this, and
      // it means inference keeps re-confirming the contact while it orbits.
      const sensorPoint = lockTarget ? lockTarget.position : next.position;
      const located = locateOnTerrain(state.terrain, sensorPoint.x, sensorPoint.z);
      const tile = located?.tile || null;
      next.currentTileId = tile ? tile.imageId : null;
      next.cropX = located ? located.fx : 0.5;
      next.cropY = located ? located.fy : 0.5;

      // Inference runs continuously, not only when something is known to be
      // there. Most results come back negative, and that steady stream of "no
      // person" is what a real sortie actually looks like.
      if (realAi && next.currentTileId) {
        inferenceRequests.push({
          droneId: next.drone_id,
          imageId: next.currentTileId,
          cx: next.cropX,
          cy: next.cropY,
          cell: { col: tile.col, row: tile.row },
        });
      }

      // Draw a sight line to anything the model has reported recently, whether
      // or not the aircraft is circling it.
      for (const contact of state.contacts) {
        if (contact.ignored || now - contact.lastSeenAt > CONTACT_ACTIVE_MS) continue;
        if (contact.lastSeenBy !== next.drone_id) continue;

        detectionContacts.push({
          droneId: next.drone_id,
          targetId: contact.id,
          confidence: contact.confidence,
          distance: distance2D(next.position, contact.position),
          from: { x: next.position.x, y: next.position.y - 0.25, z: next.position.z },
          to: { x: contact.position.x, y: 1.15, z: contact.position.z },
        });
      }

      if (lockTarget) {
        next.orbitPhase += dt * (0.42 + index * 0.01);
        const orbitRadius = clamp(metersToWorldUnits(72 + (index % 4) * 18, projection), 4.5, 13.5);
        const destination = {
          x: lockTarget.position.x + Math.cos(next.orbitPhase) * orbitRadius,
          y: 8.5 + (index % 4) * 0.85,
          z: lockTarget.position.z + Math.sin(next.orbitPhase) * orbitRadius,
        };

        next = steerDrone(next, clampWorld(destination), dt, 11.5, projection);
        const targetYaw = angleToTarget(next.position, lockTarget.position);
        next.heading = lerpAngle(next.heading, targetYaw, dt * 3.4);
        next.cameraYaw = lerpAngle(next.cameraYaw, targetYaw, dt * 5.2);
        next.battery = clamp(next.battery - dt * 0.045, 0, 100);
      } else {
        const route = next.route?.length ? next.route : routeForIndex(index);
        const waypoint = route[Math.min(next.routeIndex, route.length - 1)];
        if (distance2D(next.position, waypoint) < 1.6) {
          if (next.routeIndex >= route.length - 1 && next.assignedRoute) {
            next.status = "returning";
            next.trackingState = "returning";
            next.targetId = null;
            next.missionComplete = true;
            next.route = [{ x: baseWorld.x, y: 1.2, z: baseWorld.z }];
            next.routeIndex = 0;
            return next;
          }

          next.routeIndex = next.assignedRoute
            ? Math.min(next.routeIndex + 1, route.length - 1)
            : (next.routeIndex + 1) % route.length;
        }

        const destination = route[Math.min(next.routeIndex, route.length - 1)];
        next = steerDrone(next, destination, dt, SWEEP_SPEED_MS, projection);
        next.position.y = lerp(next.position.y, destination.y, dt * 1.4);
        next.battery = clamp(next.battery - dt * 0.03, 0, 100);
      }

      if (next.battery < 12 && next.status !== "returning") {
        next.status = "returning";
        next.trackingState = "returning";
        next.targetId = null;
        next.route = [{ x: baseWorld.x, y: 1.2, z: baseWorld.z }];
        next.routeIndex = 0;
      }

      return next;
    });

    // Log flight-mode changes the way the onboard controller reports them.
    for (let index = 0; index < updatedDrones.length; index += 1) {
      const before = state.drones[index];
      const after = updatedDrones[index];
      if (!before || before.status === after.status) continue;

      const text = {
        tracking: `${after.drone_id} GUIDED: target lock ${after.targetId} — orbit hold`,
        searching: `${after.drone_id} GUIDED: resuming sweep waypoints`,
        returning: `${after.drone_id} RTL: returning to launch`,
        charging: `${after.drone_id} LANDED: on pad, charging`,
        idle: `${after.drone_id} DISARMED: standby`,
      }[after.status];

      if (text) newConsoleLines.push(consoleLine("FC", text));
    }

    const dronePathHistory = { ...state.dronePathHistory };
    for (const drone of updatedDrones) {
      const geo = worldToLatLon(drone.position, state.base, projection);
      if (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) continue;

      const prevPath = dronePathHistory[drone.drone_id] || [];
      const last = prevPath[prevPath.length - 1];
      if (last) {
        const lastWorld = latLonToWorld({ lat: last.lat, lon: last.lon }, state.base, projection);
        if (lastWorld && distance2D(lastWorld, drone.position) < DRONE_TRAIL_MIN_WORLD_DELTA) {
          continue;
        }
      }

      const path = [...prevPath, { lat: geo.lat, lon: geo.lon }];
      dronePathHistory[drone.drone_id] = path.length > DRONE_TRAIL_MAX_POINTS
        ? path.slice(-DRONE_TRAIL_MAX_POINTS)
        : path;
    }

    return {
      drones: updatedDrones,
      detectionContacts,
      dronePathHistory,
      consoleLines: appendConsole(state.consoleLines, newConsoleLines),
    };
}

function dispatchInference({ droneId, imageId, cx, cy, cell }) {
  const entry = aiRequestState.get(droneId) || { lastRequestAt: 0, inFlight: false };
  const now = Date.now();
  if (entry.inFlight || now - entry.lastRequestAt < AI_INFERENCE_INTERVAL_MS) return;

  entry.inFlight = true;
  entry.lastRequestAt = now;
  aiRequestState.set(droneId, entry);

  requestDetection(imageId, cx, cy).then((result) => {
    entry.inFlight = false;
    const store = useSimulationStore.getState();
    if (result) {
      // The cell is captured at request time, not read back from live state:
      // the aircraft has moved on by the time inference returns, and these
      // boxes belong to the ground it was over when the frame was taken.
      store.applyAiScan(droneId, result, cell);
    } else if (!aiIsLive()) {
      store.reportAiDisconnected();
    }
  });
}
