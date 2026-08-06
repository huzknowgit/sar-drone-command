const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;
// Dalmatian karst near Split — must match DEFAULT_SIM_BASE in
// frontend/src/simulation/simulationConfig.js. The dashboard adopts whatever
// base this snapshot carries, so a stale value here silently drags the whole
// mission (and every alert coordinate) off the imagery the detector is flying.
const DEFAULT_BASE = { lat: 43.5525, lon: 16.6215, name: "SAR COMMAND BASE" };
const MAX_ALERT_HISTORY = 50;
const STALE_THRESHOLD_MS = 15_000;

const droneStore = {};
const alertHistory = [];
const detectionFrames = new Map();
const simulators = new Set();
const dashboards = new Set();

let missionPlan = null;

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  console.log(`[SERVER] SAR Backend listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[SERVER] New connection from ${clientIp}`);

  ws.isRegistered = false;
  ws.role = "unknown";

  ws.on("message", (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      console.warn("[SERVER] Received malformed JSON. Ignoring.");
      return;
    }

    if (!ws.isRegistered) {
      handleRegistration(ws, msg);
      return;
    }

    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", timestamp: Date.now() });
      return;
    }

    if (ws.role === "simulator" || ws.role === "drone") {
      handleSimulatorMessage(msg);
    } else if (ws.role === "dashboard") {
      handleDashboardMessage(msg);
    }
  });

  ws.on("close", () => {
    simulators.delete(ws);
    dashboards.delete(ws);
    console.log(`[SERVER] Client disconnected. Simulators: ${simulators.size}, Dashboards: ${dashboards.size}`);
  });

  ws.on("error", (err) => {
    console.error(`[SERVER] WebSocket error: ${err.message}`);
  });
});

function handleRegistration(ws, msg) {
  if (msg.type !== "register") {
    console.warn("[SERVER] Client sent data before registering. Ignoring.");
    return;
  }

  if (msg.role !== "simulator" && msg.role !== "drone" && msg.role !== "dashboard") {
    console.warn(`[SERVER] Invalid role requested: ${msg.role}`);
    ws.close(4000, "Invalid role");
    return;
  }

  ws.role = msg.role;
  ws.isRegistered = true;

  // "drone" (real Pi node) and "simulator" clients are treated identically.
  if (ws.role === "simulator" || ws.role === "drone") {
    simulators.add(ws);
    console.log(`[SERVER] ${ws.role} registered. Total drone/simulator clients: ${simulators.size}`);
    if (missionPlan) sendMissionPlan(ws);
    return;
  }

  dashboards.add(ws);
  console.log(`[SERVER] Dashboard registered. Total dashboards: ${dashboards.size}`);
  sendSnapshot(ws);
}

function handleSimulatorMessage(msg) {
  switch (msg.type) {
    case "telemetry_update":
      handleTelemetry(msg);
      break;
    case "alert_event":
      handleAlert(msg);
      break;
    case "detection_frame":
      handleDetectionFrame(msg);
      break;
    default:
      console.warn(`[SERVER] Unknown simulator message type: ${msg.type}`);
  }
}

function handleDashboardMessage(msg) {
  switch (msg.type) {
    case "recall_drone":
      handleRecallDrone(msg);
      break;
    case "mission_plan_update":
      handleMissionPlanUpdate(msg.missionPlan);
      break;
    case "set_camera_mode":
      handleSetCameraMode(msg);
      break;
    case "fly_to":
      handleFlyTo(msg);
      break;
    default:
      console.warn(`[SERVER] Unknown dashboard message type: ${msg.type}`);
  }
}

function handleDetectionFrame(msg) {
  const droneId = String(msg.drone_id || "").trim();
  if (!droneId) return;

  detectionFrames.set(droneId, msg);
  broadcastToDashboards(msg);
}

function handleSetCameraMode(msg) {
  if (!msg.drone_id) return;
  const mode = msg.mode === "thermal" ? "thermal" : "normal";
  console.log(`[SERVER] Camera mode for ${msg.drone_id}: ${mode}`);

  broadcastToSimulators({
    type: "set_camera_mode",
    drone_id: msg.drone_id,
    mode,
  });
}

function handleFlyTo(msg) {
  const lat = Number(msg.lat);
  const lon = Number(msg.lon);
  if (!msg.drone_id || !isValidCoordinate(lat, lon)) return;

  broadcastToSimulators({
    type: "fly_to",
    drone_id: msg.drone_id,
    lat,
    lon,
    altitude_m: safePositiveNumber(msg.altitude_m, 50),
  });
}

function handleRecallDrone(msg) {
  if (!msg.drone_id) return;
  console.log(`[SERVER] Operator recall: ${msg.drone_id}`);

  broadcastToSimulators({
    type: "recall_drone",
    drone_id: msg.drone_id,
  });
}

function handleMissionPlanUpdate(candidatePlan) {
  const cleanPlan = sanitizeMissionPlan(candidatePlan);
  if (!cleanPlan) {
    console.warn("[SERVER] Rejected invalid mission plan.");
    return;
  }

  missionPlan = cleanPlan;
  console.log(
    `[SERVER] Mission plan updated: ${missionPlan.searchArea.length} area points, ${missionPlan.sweepPath.length} route waypoints`
  );

  const payload = {
    type: "mission_plan_update",
    missionPlan,
    base: missionPlan.base,
    timestamp: Date.now(),
  };

  broadcastToDashboards(payload);
  broadcastToSimulators(payload);
}

function handleTelemetry(msg) {
  const droneId = String(msg.drone_id || "").trim();
  const lat = Number(msg.lat);
  const lon = Number(msg.lon);
  const battery = Number(msg.battery);
  const speed = Number(msg.speed);
  const altitude = Number(msg.altitude);
  const heading = Number(msg.heading);
  const videoUrl = sanitizeVideoUrl(msg.video_url);

  if (!droneId || !isValidCoordinate(lat, lon)) {
    console.warn("[SERVER] Ignoring invalid telemetry packet.");
    return;
  }

  const existingDrone = droneStore[droneId] || {};
  droneStore[droneId] = {
    drone_id: droneId,
    lat,
    lon,
    battery: clamp(Number.isFinite(battery) ? battery : 0, 0, 100),
    status: sanitizeStatus(msg.status),
    speed: Number.isFinite(speed) ? Math.max(0, speed) : 0,
    altitude: Number.isFinite(altitude) ? Math.max(0, altitude) : 0,
    heading: Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : 0,
    video_url: videoUrl || existingDrone.video_url || null,
    last_updated: Date.now(),
  };

  broadcastToDashboards({
    type: "drone_state_update",
    drones: Object.values(droneStore),
    timestamp: Date.now(),
  });
}

function handleAlert(msg) {
  const lat = Number(msg.lat);
  const lon = Number(msg.lon);
  if (!isValidCoordinate(lat, lon)) return;

  const confidence = clamp(Number(msg.confidence) || 0, 0, 1);
  const alert = {
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    drone_id: String(msg.drone_id || "unknown"),
    alert: String(msg.alert || "unknown_alert"),
    lat,
    lon,
    confidence,
    timestamp: Number(msg.timestamp) || Date.now(),
  };

  console.log(
    `[SERVER] Alert from ${alert.drone_id}: ${alert.alert} (${(alert.confidence * 100).toFixed(0)}%)`
  );

  alertHistory.unshift(alert);
  if (alertHistory.length > MAX_ALERT_HISTORY) alertHistory.pop();

  broadcastToDashboards({
    type: "alert_event",
    alert,
    timestamp: Date.now(),
  });
}

function sendSnapshot(ws) {
  safeSend(ws, {
    type: "snapshot",
    drones: Object.values(droneStore),
    alerts: alertHistory,
    base: missionPlan?.base || DEFAULT_BASE,
    missionPlan,
    detectionFrames: Object.fromEntries(detectionFrames),
    timestamp: Date.now(),
  });
}

function sendMissionPlan(ws) {
  safeSend(ws, {
    type: "mission_plan_update",
    missionPlan,
    base: missionPlan.base,
    timestamp: Date.now(),
  });
}

function broadcastToDashboards(payload) {
  for (const ws of dashboards) safeSend(ws, payload);
}

function broadcastToSimulators(payload) {
  for (const ws of simulators) safeSend(ws, payload);
}

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;

  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.warn(`[SERVER] Failed to send payload: ${err.message}`);
  }
}

function sanitizeMissionPlan(plan) {
  if (!plan || typeof plan !== "object") return null;

  const base = sanitizePoint(plan.base);
  const searchArea = Array.isArray(plan.searchArea)
    ? plan.searchArea.map(sanitizePoint).filter(Boolean).slice(0, 50)
    : [];
  const sweepPath = Array.isArray(plan.sweepPath)
    ? plan.sweepPath.map(sanitizePoint).filter(Boolean).slice(0, 500)
    : [];

  if (!base || searchArea.length < 3 || sweepPath.length < 2) return null;

  return {
    id: String(plan.id || `mission_${Date.now()}`),
    base: {
      ...base,
      name: String(plan.base?.name || "MISSION CONTROL BASE"),
    },
    searchArea,
    sweepPath,
    spacingMeters: safePositiveNumber(plan.spacingMeters, 220),
    laneCount: Math.max(1, Math.round(safePositiveNumber(plan.laneCount, 1))),
    routeDistanceMeters: Math.round(safePositiveNumber(plan.routeDistanceMeters, 0)),
    areaSqKm: safePositiveNumber(plan.areaSqKm, 0),
    sweepBearingDeg: Math.round(safePositiveNumber(plan.sweepBearingDeg, 0)) % 180,
    assignedDroneCount: Math.max(1, Math.round(safePositiveNumber(plan.assignedDroneCount, 1))),
    updatedAt: Date.now(),
  };
}

function sanitizePoint(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!isValidCoordinate(lat, lon)) return null;

  return {
    lat: +lat.toFixed(6),
    lon: +lon.toFixed(6),
  };
}

function sanitizeStatus(status) {
  const allowed = new Set(["searching", "returning", "charging", "idle", "offline", "unknown"]);
  return allowed.has(status) ? status : "unknown";
}

function sanitizeVideoUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isValidCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
}

function safePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const [id, drone] of Object.entries(droneStore)) {
    if (now - drone.last_updated > STALE_THRESHOLD_MS) {
      console.log(`[SERVER] Removing stale drone: ${id}`);
      delete droneStore[id];
      detectionFrames.delete(id);
      changed = true;
    }
  }

  if (changed) {
    broadcastToDashboards({
      type: "drone_state_update",
      drones: Object.values(droneStore),
      timestamp: Date.now(),
    });
  }
}, 5_000);

process.on("SIGINT", () => {
  console.log("\n[SERVER] Shutting down gracefully...");
  wss.close(() => process.exit(0));
});
