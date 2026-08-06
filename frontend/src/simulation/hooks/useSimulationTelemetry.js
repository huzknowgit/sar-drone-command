import { useEffect, useRef } from "react";
import { TELEMETRY_INTERVAL_MS } from "../simulationConfig";
import { useSimulationStore } from "../useSimulationStore";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8080";
const RECONNECT_DELAY_MS = 3000;

function isOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

export function useSimulationTelemetry({ base, missionPlan }) {
  const socketRef = useRef(null);
  const reconnectRef = useRef(null);
  const telemetryRef = useRef(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (base) useSimulationStore.getState().setBase(base);
  }, [base]);

  useEffect(() => {
    if (missionPlan) useSimulationStore.getState().setMissionPlan(missionPlan);
  }, [missionPlan]);

  useEffect(() => {
    mountedRef.current = true;

    const connect = () => {
      if (!mountedRef.current) return;
      if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) return;

      useSimulationStore.getState().setSimulatorConnection("connecting");
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        useSimulationStore.getState().setSimulatorConnection("connected");
        socket.send(JSON.stringify({ type: "register", role: "simulator" }));
      };

      socket.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "recall_drone") {
          useSimulationStore.getState().recallDrone(msg.drone_id);
        }

        if (msg.type === "mission_plan_update" && msg.missionPlan) {
          useSimulationStore.getState().setMissionPlan(msg.missionPlan);
        }
      };

      socket.onclose = () => {
        socketRef.current = null;
        useSimulationStore.getState().setSimulatorConnection("disconnected");
        clearTimeout(reconnectRef.current);
        reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => {
        useSimulationStore.getState().setSimulatorConnection("disconnected");
      };
    };

    const sendTelemetry = () => {
      const socket = socketRef.current;
      if (!isOpen(socket)) return;

      const state = useSimulationStore.getState();
      for (const packet of state.getTelemetryPackets()) {
        socket.send(JSON.stringify(packet));
      }

      for (const alert of state.drainPendingAlerts()) {
        socket.send(JSON.stringify(alert));
      }
    };

    connect();
    telemetryRef.current = setInterval(sendTelemetry, TELEMETRY_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectRef.current);
      clearInterval(telemetryRef.current);
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.close();
      }
    };
  }, []);
}
