import React, { useMemo } from "react";
import { useSimulationStore } from "../useSimulationStore";
import { headingRadToDegrees, worldUnitsToMeters } from "../geo";

function Dot({ status }) {
  return <span className={`sim-dot ${status}`} />;
}

function Stat({ label, value, tone = "" }) {
  return (
    <div className="sim-stat">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

export default function TacticalOverlay({ alertCount = 0 }) {
  const drones = useSimulationStore((state) => state.drones);
  const contacts = useSimulationStore((state) => state.contacts);
  const sightLines = useSimulationStore((state) => state.detectionContacts);
  const selectedDroneId = useSimulationStore((state) => state.selectedDroneId);
  const cameraMode = useSimulationStore((state) => state.cameraMode);
  const projection = useSimulationStore((state) => state.missionProjection);
  const trackingEnabled = useSimulationStore((state) => state.trackingEnabled);
  const simulatorConnection = useSimulationStore((state) => state.simulatorConnection);
  const lastCommand = useSimulationStore((state) => state.lastCommand);
  const setCameraMode = useSimulationStore((state) => state.setCameraMode);
  const toggleTracking = useSimulationStore((state) => state.toggleTracking);
  const ignoreContact = useSimulationStore((state) => state.ignoreContact);
  const clearIgnoredContacts = useSimulationStore((state) => state.clearIgnoredContacts);

  const selectedDrone = useMemo(
    () => drones.find((drone) => drone.drone_id === selectedDroneId) || drones[0],
    [drones, selectedDroneId],
  );
  const lockedCount = drones.filter((drone) => drone.status === "tracking").length;
  const lockedTargetId = drones.find((drone) => drone.targetId)?.targetId || null;
  const lockedContact = contacts.find((contact) => contact.id === lockedTargetId) || null;
  const ignoredCount = contacts.filter((contact) => contact.ignored).length;
  const openCount = contacts.length - ignoredCount;

  return (
    <div className="tactical-overlay">
      <div className="sim-topbar">
        <div className="sim-status-strip">
          <span className="sim-kicker">VIRTUAL ISR SIM</span>
          <span className="sim-divider" />
          <span><Dot status={simulatorConnection} /> SIM LINK {simulatorConnection.toUpperCase()}</span>
          <span>COMMAND {lastCommand}</span>
        </div>

        <div className="sim-action-row">
          {["overview", "follow", "alert"].map((mode) => (
            <button
              key={mode}
              type="button"
              className={cameraMode === mode ? "active" : ""}
              onClick={() => setCameraMode(mode)}
            >
              {mode.toUpperCase()}
            </button>
          ))}
          <button type="button" className={trackingEnabled ? "active" : ""} onClick={toggleTracking}>
            TRACK {trackingEnabled ? "AUTO" : "HOLD"}
          </button>
          <button
            type="button"
            className={lockedTargetId ? "wave-off" : ""}
            disabled={!lockedTargetId}
            title="Stop circling this contact and go back on the planned route"
            onClick={() => ignoreContact(lockedTargetId)}
          >
            IGNORE — RESUME ROUTE
          </button>
        </div>
      </div>

      <div className="sim-left-readout">
        <div className="readout-title">MISSION STATE</div>
        <div className="sim-stat-grid">
          <Stat label="DRONES" value={drones.length} tone="cyan" />
          <Stat label="FOUND" value={contacts.length} tone={contacts.length ? "red" : "dim"} />
          <Stat label="LOCKS" value={lockedCount} tone={lockedCount ? "red" : "dim"} />
          <Stat label="OPEN" value={openCount} tone={openCount ? "amber" : "dim"} />
        </div>
        <div className="sim-alert-line">
          <span>EVENT LOG</span>
          <strong className={alertCount ? "red" : "dim"}>{alertCount}</strong>
        </div>
        {ignoredCount > 0 && (
          <div className="sim-alert-line">
            <span>IGNORED</span>
            <strong className="amber">{ignoredCount}</strong>
            <button type="button" className="sim-inline-btn" onClick={clearIgnoredContacts}>
              RE-ARM
            </button>
          </div>
        )}
      </div>

      <div className="sim-right-readout">
        <div className="readout-title">SELECTED UNIT</div>
        {selectedDrone ? (
          <>
            <div className="selected-unit">
              <span className={selectedDrone.status === "tracking" ? "red" : "cyan"}>
                {selectedDrone.drone_id}
              </span>
              <strong>{String(selectedDrone.status || "unknown").toUpperCase()}</strong>
            </div>
            <div className="sim-stat-grid compact">
              <Stat label="BATT" value={`${selectedDrone.battery.toFixed(0)}%`} tone={selectedDrone.battery < 25 ? "red" : "green"} />
              <Stat label="SPD" value={`${selectedDrone.speedMeters.toFixed(1)} m/s`} />
              <Stat label="ALT" value={`${Math.round(worldUnitsToMeters(selectedDrone.position.y, projection))} m`} />
              <Stat label="HDG" value={`${Math.round(headingRadToDegrees(selectedDrone.heading))}`} />
              <Stat label="CAM" value={`${Math.round(headingRadToDegrees(selectedDrone.cameraYaw))}`} />
              <Stat label="CONF" value={`${Math.round(selectedDrone.confidence * 100)}%`} tone={selectedDrone.confidence ? "red" : "dim"} />
            </div>
          </>
        ) : (
          <span className="mono dim">NO UNIT</span>
        )}

        <div className="readout-title secondary">CONTACT</div>
        {lockedContact ? (
          <>
            <div className="target-chip">
              <span className="red">{lockedContact.id}</span>
              <strong>{Math.round(lockedContact.confidence * 100)}% ORBITING</strong>
            </div>
            <button
              type="button"
              className="sim-inline-btn block"
              onClick={() => ignoreContact(lockedContact.id)}
            >
              IGNORE — RESUME ROUTE
            </button>
          </>
        ) : (
          <span className="mono dim">NO ACTIVE CONTACT</span>
        )}
      </div>

      <div className="sim-contact-tape">
        {sightLines.length === 0 ? (
          <span className="mono dim">VISION SCAN CLEAR</span>
        ) : (
          sightLines.slice(0, 4).map((sight) => (
            <div className="contact-pill" key={`${sight.droneId}-${sight.targetId}`}>
              <span>{sight.droneId}</span>
              <strong>{sight.targetId}</strong>
              <em>{Math.round(sight.confidence * 100)}%</em>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
