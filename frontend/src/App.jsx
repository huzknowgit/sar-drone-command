import React, { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWebSocket } from "./hooks/useWebSocket";
import DronePanel from "./components/DronePanel";
import AlertsPanel from "./components/AlertsPanel";
import VideoPanel from "./components/VideoPanel";
import Header from "./components/Header";
import MissionPlanner from "./components/MissionPlanner";
import DroneSimulationPanel from "./simulation/DroneSimulationPanel";
import { useSimulationStore } from "./simulation/useSimulationStore";
import { generateSearchPlan, normalizePoint } from "./utils/missionPlanning";
import "./App.css";

function parseCoordinateSearch(value) {
  const match = value
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);

  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;

  return normalizePoint({ lat, lon });
}

export default function App() {
  const {
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
  } = useWebSocket();

  const [selectedDroneId, setSelectedDroneId] = useState(null);
  const [highlightedAlert, setHighlightedAlert] = useState(null);
  const [plannerMode, setPlannerMode] = useState("inspect");
  const [draftBase, setDraftBase] = useState(null);
  const [draftSearchArea, setDraftSearchArea] = useState([]);
  const [locationFocus, setLocationFocus] = useState(null);
  const [locationStatus, setLocationStatus] = useState("");
  const [collapsedPanels, setCollapsedPanels] = useState({
    mission: false,
    units: false,
    events: false,
    video: false,
  });

  const simDroneIds = useSimulationStore(
    useShallow((state) => state.drones.map((drone) => drone.drone_id)),
  );
  // Telemetry in the same shape the backend would relay, so the panels below
  // cannot tell the difference between a simulated and a real aircraft.
  const simTelemetry = useSimulationStore(
    useShallow((state) => state.getTelemetryPackets()),
  );
  const simAlertLog = useSimulationStore((state) => state.alertLog);

  const visibleDrones = useMemo(() => {
    if (!simDroneIds.length) return drones;

    const simIdSet = new Set(simDroneIds);
    const filtered = drones.filter((drone) => simIdSet.has(drone.drone_id));
    if (filtered.length) return filtered;

    // The simulator publishes over the same WebSocket as real hardware, so with
    // the backend down its aircraft never reach these panels and Active Units
    // sits empty while the drone is visibly flying. Read the sim directly.
    return simTelemetry.length ? simTelemetry : drones;
  }, [drones, simDroneIds, simTelemetry]);

  // Same reasoning for detections: without this the event log stays at zero
  // while the onboard console is reporting contacts.
  const visibleAlerts = useMemo(
    () => (alerts.length ? alerts : simAlertLog),
    [alerts, simAlertLog],
  );

  const selectedDrone = visibleDrones.find((d) => d.drone_id === selectedDroneId) || null;
  const activeBase = draftBase || missionPlan?.base || base;

  const planPreview = useMemo(() => {
    if (!activeBase || draftSearchArea.length < 3) return null;

    return generateSearchPlan({
      base: activeBase,
      searchArea: draftSearchArea,
      droneCount: Math.max(1, visibleDrones.length),
    });
  }, [activeBase, draftSearchArea, visibleDrones.length]);

  const handleMapDraftPoint = useCallback((point) => {
    const cleanPoint = normalizePoint(point);

    if (plannerMode === "base") {
      setDraftBase({ ...cleanPoint, name: "MISSION CONTROL BASE" });
      return;
    }

    if (plannerMode === "area") {
      setDraftSearchArea((prev) => [...prev, cleanPoint].slice(0, 24));
    }
  }, [plannerMode]);

  const handleDeployPlan = useCallback(() => {
    if (!planPreview) return;

    sendMissionPlan(planPreview);
    setPlannerMode("inspect");
    setDraftBase(null);
    setDraftSearchArea([]);
  }, [planPreview, sendMissionPlan]);

  const togglePanel = useCallback((panelName) => {
    setCollapsedPanels((prev) => ({
      ...prev,
      [panelName]: !prev[panelName],
    }));
  }, []);

  const handleLocationSearch = useCallback(async (query) => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const parsed = parseCoordinateSearch(trimmed);
    if (parsed) {
      const point = { ...parsed, label: "Manual coordinate" };
      setLocationFocus(point);
      setLocationStatus("Map centered on coordinates");
      if (plannerMode === "base") {
        setDraftBase({ ...parsed, name: "MISSION CONTROL BASE" });
      }
      return;
    }

    setLocationStatus("Searching location...");
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(trimmed)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Search failed");

      const results = await response.json();
      const first = Array.isArray(results) ? results[0] : null;
      if (!first) {
        setLocationStatus("No location found");
        return;
      }

      const point = normalizePoint({ lat: Number(first.lat), lon: Number(first.lon) });
      const focused = {
        ...point,
        label: first.display_name?.split(",").slice(0, 2).join(",") || trimmed,
      };

      setLocationFocus(focused);
      setLocationStatus(`Found ${focused.label}`);
      if (plannerMode === "base") {
        setDraftBase({ ...point, name: "MISSION CONTROL BASE" });
      }
    } catch {
      setLocationStatus("Location search unavailable");
    }
  }, [plannerMode]);

  return (
    <div className="app-shell">
      <Header
        connectionStatus={connectionStatus}
        lastUpdate={lastUpdate}
        droneCount={visibleDrones.length}
        alertCount={visibleAlerts.length}
      />

      <main className="app-body">
        <section className="col-left">
          <div className="col-map">
            <DroneSimulationPanel
              drones={visibleDrones}
              alerts={visibleAlerts}
              base={base}
              missionPlan={missionPlan}
              planPreview={planPreview}
              draftBase={draftBase}
              draftSearchArea={draftSearchArea}
              locationFocus={locationFocus}
              plannerMode={plannerMode}
              selectedDroneId={selectedDroneId}
              onSelectDrone={setSelectedDroneId}
              onMapDraftPoint={handleMapDraftPoint}
              highlightedAlert={highlightedAlert}
            />
          </div>

          <VideoPanel
            drones={visibleDrones}
            selectedDrone={selectedDrone}
            collapsed={collapsedPanels.video}
            onToggleCollapse={() => togglePanel("video")}
          />
        </section>

        <aside className="col-right">
          <MissionPlanner
            mode={plannerMode}
            onModeChange={setPlannerMode}
            draftBase={draftBase}
            draftSearchArea={draftSearchArea}
            missionPlan={missionPlan}
            planPreview={planPreview}
            onUndoPoint={() => setDraftSearchArea((prev) => prev.slice(0, -1))}
            onClearArea={() => setDraftSearchArea([])}
            onDeployPlan={handleDeployPlan}
            canDeploy={Boolean(planPreview)}
            onLocationSearch={handleLocationSearch}
            locationStatus={locationStatus}
            collapsed={collapsedPanels.mission}
            onToggleCollapse={() => togglePanel("mission")}
          />

          <DronePanel
            drones={visibleDrones}
            selectedDroneId={selectedDroneId}
            onSelectDrone={setSelectedDroneId}
            onRecall={sendRecall}
            collapsed={collapsedPanels.units}
            onToggleCollapse={() => togglePanel("units")}
          />

          <AlertsPanel
            alerts={visibleAlerts}
            onHighlightAlert={setHighlightedAlert}
            onDismissAlert={dismissAlert}
            onClearAlerts={clearAlerts}
            collapsed={collapsedPanels.events}
            onToggleCollapse={() => togglePanel("events")}
          />
        </aside>
      </main>
    </div>
  );
}
