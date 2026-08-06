import { useCallback, useEffect, useRef, useState } from "react";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8080";
const RECONNECT_DELAY = 3000;
// Dalmatian karst near Split — must match DEFAULT_SIM_BASE in
// src/simulation/simulationConfig.js, or the map and the 3D world disagree
// about where the mission is until the backend sends a real base.
const DEFAULT_BASE = { lat: 43.5525, lon: 16.6215, name: "SAR COMMAND BASE" };

function isOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function cleanArray(value) {
  return Array.isArray(value) ? value : [];
}

export function useWebSocket() {
  const [drones, setDrones] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [base, setBase] = useState(DEFAULT_BASE);
  const [missionPlan, setMissionPlan] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [lastUpdate, setLastUpdate] = useState(null);

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const mountedRef = useRef(true);

  const send = useCallback((payload) => {
    const ws = wsRef.current;
    if (!isOpen(ws)) return false;

    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

    setConnectionStatus("connecting");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnectionStatus("connected");
      ws.send(JSON.stringify({ type: "register", role: "dashboard" }));
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;

      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn("[WS] Ignoring malformed message.");
        return;
      }

      setLastUpdate(Date.now());

      switch (msg.type) {
        case "snapshot": {
          setDrones(cleanArray(msg.drones));
          setAlerts(cleanArray(msg.alerts));
          if (msg.base) setBase(msg.base);
          if (msg.missionPlan) {
            setMissionPlan(msg.missionPlan);
            if (msg.missionPlan.base) setBase(msg.missionPlan.base);
          }
          break;
        }

        case "drone_state_update":
          setDrones(cleanArray(msg.drones));
          break;

        case "alert_event":
          if (msg.alert) {
            setAlerts((prev) => [msg.alert, ...prev].slice(0, 50));
          }
          break;

        case "mission_plan_update":
          if (msg.missionPlan) {
            setMissionPlan(msg.missionPlan);
            if (msg.missionPlan.base) setBase(msg.missionPlan.base);
          }
          break;

        default:
          console.debug("[WS] Unknown message type:", msg.type);
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      wsRef.current = null;
      setConnectionStatus("disconnected");
      clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = (err) => {
      console.error("[WS] Error:", err);
    };
  }, []);

  const sendRecall = useCallback((drone_id) => {
    if (!drone_id) return false;
    return send({ type: "recall_drone", drone_id });
  }, [send]);

  const sendMissionPlan = useCallback((plan) => {
    if (!plan) return false;
    return send({ type: "mission_plan_update", missionPlan: plan });
  }, [send]);

  const dismissAlert = useCallback((alertId) => {
    setAlerts((prev) => prev.filter((alert) => alert.id !== alertId));
  }, []);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return {
    drones,
    alerts,
    base,
    missionPlan,
    connectionStatus,
    lastUpdate,
    sendRecall,
    sendMissionPlan,
    dismissAlert,
    clearAlerts,
  };
}
