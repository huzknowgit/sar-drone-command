/**
 * Legacy synthetic-telemetry harness — NOT part of the AI demo.
 *
 * This process invents five aircraft and rolls dice for "detections". It exists
 * to exercise the backend relay without a browser or a Pi. The AI simulator
 * (frontend/src/simulation) is the real one: it flies over held-out aerial
 * imagery and only reports a contact the deployed model actually produced.
 *
 * Running both at once puts fabricated alerts in the same event log as real
 * model output, which is exactly what the dashboard must never do, so the
 * random alert generator is off unless explicitly asked for.
 */
const WebSocket = require("ws");

const SERVER_URL = process.env.SERVER_URL || "ws://localhost:8080";
/** Set SIM_SYNTHETIC_ALERTS=1 to re-enable the dice-roll alerts for relay testing. */
const SYNTHETIC_ALERTS = process.env.SIM_SYNTHETIC_ALERTS === "1";
const TELEMETRY_INTERVAL_MS = 1000;
const BASE_ARRIVAL_THRESHOLD = 0.0008;
const WAYPOINT_THRESHOLD = 0.00055;

const DEFAULT_BASE = { lat: 43.7005, lon: -79.4130, name: "SAR COMMAND BASE" };

const DRONE_CONFIGS = [
  { id: "ALPHA-1", lat: 43.720, lon: -79.380, heading: 45, searchZone: { lat: 43.740, lon: -79.360 } },
  { id: "BRAVO-2", lat: 43.695, lon: -79.420, heading: 120, searchZone: { lat: 43.710, lon: -79.400 } },
  { id: "CHARLIE-3", lat: 43.745, lon: -79.450, heading: 200, searchZone: { lat: 43.730, lon: -79.430 } },
  { id: "DELTA-4", lat: 43.670, lon: -79.390, heading: 300, searchZone: { lat: 43.690, lon: -79.370 } },
  { id: "ECHO-5", lat: 43.760, lon: -79.410, heading: 270, searchZone: { lat: 43.750, lon: -79.440 } },
];

let ws;
let reconnectTimer = null;
let simInterval = null;
let missionBase = { ...DEFAULT_BASE };
let activeMission = null;

const drones = DRONE_CONFIGS.map(createDrone);

function createDrone(cfg) {
  return {
    id: cfg.id,
    lat: cfg.lat,
    lon: cfg.lon,
    altitude: rand(40, 80),
    speed: rand(8, 14),
    heading: cfg.heading,
    battery: rand(75, 100),
    status: "searching",
    searchZone: { ...cfg.searchZone },
    searchRoute: [],
    routeIndex: 0,
    missionComplete: false,
    alertCooldown: 0,
    recalled: false,
  };
}

function tickAllDrones() {
  for (const drone of drones) tickDrone(drone);
}

function tickDrone(drone) {
  if (drone.status === "idle") {
    drone.lat = missionBase.lat;
    drone.lon = missionBase.lon;
    drone.speed = 0;
    drone.altitude = 0;
    drone.battery = Math.min(100, drone.battery + 0.4);
    return;
  }

  if (drone.status === "charging") {
    drone.speed = 0;
    drone.altitude = 0;
    drone.battery = Math.min(100, drone.battery + 0.6);

    if (drone.battery >= 99) {
      drone.battery = 100;
      drone.recalled = false;
      if (drone.missionComplete) {
        drone.status = "idle";
        console.log(`[SIM] ${drone.id} is charged and standing by at mission base.`);
        return;
      }
      prepareRouteForDrone(drone, drones.indexOf(drone));
      drone.status = "searching";
      drone.speed = rand(8, 12);
      drone.altitude = rand(40, 70);
      console.log(`[SIM] ${drone.id} fully charged. Redeploying.`);
    }
    return;
  }

  const drainRate = drone.status === "returning" ? 0.035 : 0.018;
  drone.battery = Math.max(0, drone.battery - drainRate);

  if (drone.battery <= 0) {
    drone.status = "offline";
    drone.speed = 0;
    drone.altitude = 0;
    return;
  }

  if (drone.battery < 20 && drone.status === "searching") {
    drone.status = "returning";
    drone.recalled = false;
    console.log(`[SIM] ${drone.id} battery critical (${drone.battery.toFixed(0)}%). Returning to base.`);
  }

  if (drone.status === "returning") {
    flyTowardBase(drone);
  } else if (drone.status === "searching") {
    if (drone.searchRoute.length >= 2) {
      followAssignedRoute(drone);
    } else {
      biasedSearchWalk(drone);
    }
    enforceSearchArea(drone);
  }

  if (drone.alertCooldown > 0) drone.alertCooldown -= 1;
}

function flyTowardBase(drone) {
  const dLat = missionBase.lat - drone.lat;
  const dLon = missionBase.lon - drone.lon;
  const dist = Math.sqrt(dLat * dLat + dLon * dLon);

  if (dist < BASE_ARRIVAL_THRESHOLD) {
    drone.lat = missionBase.lat;
    drone.lon = missionBase.lon;
    drone.altitude = 0;
    drone.speed = 0;
    drone.status = "charging";
    console.log(
      `[SIM] ${drone.id} landed at mission base. ${drone.missionComplete ? "Mission complete; charging for standby." : "Charging."}`
    );
    return;
  }

  moveToward(drone, missionBase, 0.0015);
  drone.speed = clamp(drone.speed + gaussRand() * 0.2, 10, 16);
  drone.altitude = clamp(drone.altitude - 0.5, 20, 80);
}

function followAssignedRoute(drone) {
  const target = drone.searchRoute[drone.routeIndex] || drone.searchRoute[0];
  const dist = distanceDeg(drone, target);

  if (dist < WAYPOINT_THRESHOLD) {
    if (drone.routeIndex >= drone.searchRoute.length - 1) {
      drone.missionComplete = true;
      drone.status = "returning";
      drone.searchRoute = [];
      drone.routeIndex = 0;
      console.log(`[SIM] ${drone.id} completed its assigned search area. Returning to mission base.`);
      return;
    }

    drone.routeIndex += 1;
  }

  const nextTarget = drone.searchRoute[drone.routeIndex] || target;
  moveToward(drone, nextTarget, 0.0011);
  drone.speed = clamp(drone.speed + gaussRand() * 0.25, 7, 14);
  drone.altitude = clamp(drone.altitude + gaussRand() * 0.4, 42, 82);
}

function biasedSearchWalk(drone) {
  const bias = 0.7;
  const dLat = (drone.searchZone.lat - drone.lat) * 0.012 * bias + gaussRand() * 0.0005 * (1 - bias);
  const dLon = (drone.searchZone.lon - drone.lon) * 0.012 * bias + gaussRand() * 0.0005 * (1 - bias);
  drone.lat += dLat;
  drone.lon += dLon;
  drone.heading = bearingTo(drone, { lat: drone.lat + dLat, lon: drone.lon + dLon });
  drone.searchZone.lat += gaussRand() * 0.00015;
  drone.searchZone.lon += gaussRand() * 0.00015;
  drone.speed = clamp(drone.speed + gaussRand() * 0.3, 6, 14);
  drone.altitude = clamp(drone.altitude + gaussRand() * 0.5, 40, 85);
}

function moveToward(drone, target, step) {
  const dLat = target.lat - drone.lat;
  const dLon = target.lon - drone.lon;
  const dist = Math.sqrt(dLat * dLat + dLon * dLon);
  if (dist <= 0) return;

  const amount = Math.min(step, dist);
  drone.lat += (dLat / dist) * amount;
  drone.lon += (dLon / dist) * amount;
  drone.heading = bearingTo(drone, target);
}

function buildTelemetry(drone) {
  return {
    type: "telemetry_update",
    drone_id: drone.id,
    lat: +drone.lat.toFixed(6),
    lon: +drone.lon.toFixed(6),
    battery: +drone.battery.toFixed(1),
    status: drone.status,
    speed: +drone.speed.toFixed(1),
    altitude: +drone.altitude.toFixed(1),
    heading: +drone.heading.toFixed(0),
  };
}

function maybeAlert(drone) {
  if (!SYNTHETIC_ALERTS) return null;
  if (drone.status !== "searching") return null;
  if (activeMission?.searchArea?.length >= 3 && !pointInPolygon(drone, activeMission.searchArea)) return null;
  if (drone.alertCooldown > 0) return null;
  if (Math.random() > 0.003) return null;

  const alertTypes = ["human_detected", "heat_signature", "debris_field", "strobe_light"];
  const alertType = alertTypes[Math.floor(Math.random() * alertTypes.length)];
  drone.alertCooldown = 120;

  return {
    type: "alert_event",
    drone_id: drone.id,
    alert: alertType,
    lat: +drone.lat.toFixed(6),
    lon: +drone.lon.toFixed(6),
    confidence: +(0.72 + Math.random() * 0.26).toFixed(2),
    timestamp: Date.now(),
  };
}

function handleRecall(msg) {
  const drone = drones.find((d) => d.id === msg.drone_id);
  if (!drone) {
    console.warn(`[SIM] Recall received for unknown drone: ${msg.drone_id}`);
    return;
  }

  if (drone.status === "charging" || drone.status === "returning") {
    console.log(`[SIM] ${drone.id} is already returning or charging. Recall ignored.`);
    return;
  }

  drone.status = "returning";
  drone.recalled = true;
  drone.missionComplete = false;
  console.log(`[SIM] Operator recall: ${drone.id} returning to base.`);
}

function applyMissionPlan(plan) {
  const cleanBase = sanitizePoint(plan?.base);
  const cleanPath = Array.isArray(plan?.sweepPath) ? plan.sweepPath.map(sanitizePoint).filter(Boolean) : [];
  const cleanArea = Array.isArray(plan?.searchArea) ? plan.searchArea.map(sanitizePoint).filter(Boolean) : [];

  if (!cleanBase || cleanPath.length < 2 || cleanArea.length < 3) {
    console.warn("[SIM] Ignoring invalid mission plan.");
    return;
  }

  missionBase = { ...cleanBase, name: plan.base?.name || "MISSION CONTROL BASE" };
  activeMission = {
    ...plan,
    base: missionBase,
    searchArea: cleanArea,
    sweepPath: cleanPath,
  };

  drones.forEach((drone, index) => {
    prepareRouteForDrone(drone, index);
    if (drone.status !== "charging" && drone.status !== "offline" && drone.battery > 20) {
      drone.status = "searching";
      drone.recalled = false;
      drone.missionComplete = false;
    }
  });

  console.log(`[SIM] Applied mission plan with ${cleanPath.length} route waypoints.`);
}

function prepareRouteForDrone(drone, index) {
  if (!activeMission?.sweepPath?.length) return;

  const routes = splitRouteByDrone(activeMission.sweepPath, drones.length);
  drone.searchRoute = routes[index] || activeMission.sweepPath;
  drone.routeIndex = 0;
  drone.missionComplete = false;
  drone.searchZone = polygonCentroid(activeMission.searchArea) || drone.searchZone;
}

function splitRouteByDrone(path, count) {
  if (!Array.isArray(path) || path.length < 2) return [];

  const lanes = [];
  for (let i = 0; i < path.length - 1; i += 2) {
    lanes.push([path[i], path[i + 1]]);
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

function nearestWaypointIndex(drone, route) {
  let bestIndex = 0;
  let bestDistance = Infinity;

  route.forEach((point, index) => {
    const dist = distanceDeg(drone, point);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function enforceSearchArea(drone) {
  const area = activeMission?.searchArea || [];
  if (area.length < 3 || pointInPolygon(drone, area)) return;

  const nearest = nearestBoundaryPoint(drone, area);
  const center = polygonCentroid(area);

  if (center) {
    drone.lat = nearest.lat + (center.lat - nearest.lat) * 0.015;
    drone.lon = nearest.lon + (center.lon - nearest.lon) * 0.015;
  } else {
    drone.lat = nearest.lat;
    drone.lon = nearest.lon;
  }

  drone.heading = bearingTo(drone, center || missionBase);
}

function pointInPolygon(point, polygon) {
  let inside = false;
  let j = polygon.length - 1;

  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const previous = polygon[j];
    const crosses = current.lat > point.lat !== previous.lat > point.lat;

    if (crosses) {
      const intersectLon =
        ((previous.lon - current.lon) * (point.lat - current.lat)) / ((previous.lat - current.lat) || 1e-12) +
        current.lon;
      if (point.lon <= intersectLon) inside = !inside;
    }

    j = i;
  }

  return inside;
}

function nearestBoundaryPoint(point, polygon) {
  let best = polygon[0];
  let bestDistance = Infinity;

  for (let i = 0; i < polygon.length; i += 1) {
    const start = polygon[i];
    const end = polygon[(i + 1) % polygon.length];
    const dLon = end.lon - start.lon;
    const dLat = end.lat - start.lat;
    const lengthSq = dLon * dLon + dLat * dLat;
    const t = lengthSq
      ? clamp(((point.lon - start.lon) * dLon + (point.lat - start.lat) * dLat) / lengthSq, 0, 1)
      : 0;
    const candidate = {
      lat: start.lat + dLat * t,
      lon: start.lon + dLon * t,
    };
    const distance = distanceDeg(point, candidate);

    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function polygonCentroid(points) {
  if (!Array.isArray(points) || !points.length) return null;

  return points.reduce(
    (acc, point) => ({
      lat: acc.lat + point.lat / points.length,
      lon: acc.lon + point.lon / points.length,
    }),
    { lat: 0, lon: 0 }
  );
}

function connect() {
  console.log(`[SIM] Connecting to server at ${SERVER_URL}...`);
  ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    console.log("[SIM] Connected to backend server.");
    console.log(
      SYNTHETIC_ALERTS
        ? "[SIM] Synthetic alerts ENABLED — fake detections will reach the dashboard."
        : "[SIM] Synthetic alerts off. Telemetry only; detections come from the AI simulator."
    );
    send({ type: "register", role: "simulator" });
    startSimulation();
  });

  ws.on("message", (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    if (msg.type === "recall_drone") {
      handleRecall(msg);
    } else if (msg.type === "mission_plan_update") {
      applyMissionPlan(msg.missionPlan);
    }
  });

  ws.on("close", () => {
    console.log("[SIM] Disconnected. Reconnecting in 3s...");
    stopSimulation();
    reconnectTimer = setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    console.error(`[SIM] WebSocket error: ${err.message}`);
  });
}

function startSimulation() {
  if (simInterval) clearInterval(simInterval);

  simInterval = setInterval(() => {
    tickAllDrones();

    for (const drone of drones) {
      if (drone.status === "offline") continue;

      send(buildTelemetry(drone));

      const alert = maybeAlert(drone);
      if (alert) {
        console.log(`[SIM] ${drone.id}: ${alert.alert} (${(alert.confidence * 100).toFixed(0)}%)`);
        send(alert);
      }
    }
  }, TELEMETRY_INTERVAL_MS);
}

function stopSimulation() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sanitizePoint(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    return null;
  }

  return { lat, lon };
}

function distanceDeg(a, b) {
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function gaussRand() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function bearingTo(a, b) {
  const dLon = b.lon - a.lon;
  const dLat = b.lat - a.lat;
  return (Math.atan2(dLon, dLat) * (180 / Math.PI) + 360) % 360;
}

connect();

process.on("SIGINT", () => {
  console.log("\n[SIM] Shutting down simulator...");
  stopSimulation();
  if (ws) ws.close();
  process.exit(0);
});
