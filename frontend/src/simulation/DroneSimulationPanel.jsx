import React, { useEffect, useMemo, useRef, useState } from "react";
import MapView from "../components/MapView";
import DroneScene from "./components/DroneScene";
import TacticalOverlay from "./components/TacticalOverlay";
import OnboardComputerConsole from "./components/OnboardComputerConsole";
import { useSimulationTelemetry } from "./hooks/useSimulationTelemetry";
import { useSimulationStore } from "./useSimulationStore";
import { headingRadToDegrees, worldToLatLon, worldUnitsToMeters } from "./geo";
import "./DroneSimulationPanel.css";

function SimulationMapView({ drones, ...props }) {
  const simDrones = useSimulationStore((state) => state.drones);
  const simBase = useSimulationStore((state) => state.base);
  const missionProjection = useSimulationStore((state) => state.missionProjection);
  const dronePathHistory = useSimulationStore((state) => state.dronePathHistory);

  const mergedDrones = useMemo(() => {
    const byId = new Map((drones || []).map((drone) => [drone.drone_id, drone]));

    for (const drone of simDrones) {
      const geo = worldToLatLon(drone.position, simBase, missionProjection);
      byId.set(drone.drone_id, {
        ...(byId.get(drone.drone_id) || {}),
        drone_id: drone.drone_id,
        lat: geo.lat,
        lon: geo.lon,
        battery: +drone.battery.toFixed(1),
        status: drone.status,
        speed: +drone.speedMeters.toFixed(2),
        altitude: Math.max(0, Math.round(worldUnitsToMeters(drone.position.y, missionProjection))),
        heading: +headingRadToDegrees(drone.heading).toFixed(1),
        simulated: true,
      });
    }

    return Array.from(byId.values());
  }, [drones, missionProjection, simBase, simDrones]);

  return <MapView drones={mergedDrones} droneTrails={dronePathHistory} {...props} />;
}

export default function DroneSimulationPanel({
  drones,
  alerts,
  base,
  missionPlan,
  planPreview,
  draftBase,
  draftSearchArea,
  locationFocus,
  plannerMode,
  selectedDroneId,
  onSelectDrone,
  onMapDraftPoint,
  highlightedAlert,
}) {
  const [view, setView] = useState("simulation");
  const lastTickRef = useRef(null);
  const elapsedRef = useRef(0);
  useSimulationTelemetry({ base, missionPlan });

  useEffect(() => {
    // Terrain first: subjects are placed from its ground-truth annotations, so
    // they must exist before the detector starts asking about them.
    useSimulationStore.getState().loadTerrain().then(() => {
      useSimulationStore.getState().connectAiService();
    });
  }, []);

  useEffect(() => {
    if (selectedDroneId) {
      useSimulationStore.getState().setSelectedDroneId(selectedDroneId);
    }
  }, [selectedDroneId]);

  useEffect(() => {
    let rafId = 0;

    const tick = (now) => {
      if (lastTickRef.current == null) {
        lastTickRef.current = now;
      }

      const dt = Math.min(0.08, Math.max(0.001, (now - lastTickRef.current) / 1000));
      lastTickRef.current = now;
      elapsedRef.current += dt;

      useSimulationStore.getState().advanceSimulation(dt, elapsedRef.current);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      lastTickRef.current = null;
    };
  }, []);

  const mapProps = {
    drones,
    alerts,
    base,
    missionPlan,
    planPreview,
    draftBase,
    draftSearchArea,
    locationFocus,
    plannerMode,
    selectedDroneId,
    onSelectDrone,
    onMapDraftPoint,
    highlightedAlert,
  };

  return (
    <section className="simulation-console">
      <div className="simulation-console-header">
        <div className="simulation-title">
          <span className="simulation-title-main">AUTONOMOUS SURVEILLANCE SIM</span>
          <span className="simulation-title-sub mono">3D VISION TRACKING / TELEMETRY SYNTHESIS</span>
        </div>
        <div className="simulation-tabs">
          <button
            type="button"
            className={view === "split" ? "active" : ""}
            onClick={() => setView("split")}
          >
            3D + MAP
          </button>
          <button
            type="button"
            className={view === "simulation" ? "active" : ""}
            onClick={() => setView("simulation")}
          >
            3D SIM
          </button>
          <button
            type="button"
            className={view === "map" ? "active" : ""}
            onClick={() => setView("map")}
          >
            GEOMAP
          </button>
        </div>
      </div>

      <div className={`simulation-stage${view === "split" ? " simulation-stage-split" : ""}`}>
        {view === "simulation" && (
          <>
            <DroneScene onSelectDrone={onSelectDrone} />
            <TacticalOverlay alertCount={alerts.length} />
            <OnboardComputerConsole />
          </>
        )}
        {view === "map" && (
          <>
            <SimulationMapView {...mapProps} />
            <OnboardComputerConsole />
          </>
        )}
        {view === "split" && (
          <>
            <div className="simulation-split-pane simulation-split-3d">
              <DroneScene onSelectDrone={onSelectDrone} />
              <TacticalOverlay alertCount={alerts.length} />
                <OnboardComputerConsole />
            </div>
            <div className="simulation-split-pane simulation-split-map">
              <SimulationMapView {...mapProps} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
