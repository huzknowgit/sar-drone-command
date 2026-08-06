import React, { useState } from "react";
import "./MissionPlanner.css";

const MODE_LABELS = {
  inspect: "Inspect",
  base: "Set Base",
  area: "Draw Area",
};

function formatCoord(point) {
  if (!point) return "Not set";
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

function Metric({ label, value }) {
  return (
    <div className="planner-metric">
      <span className="planner-metric-label">{label}</span>
      <span className="planner-metric-value mono">{value}</span>
    </div>
  );
}

export default function MissionPlanner({
  mode,
  onModeChange,
  draftBase,
  draftSearchArea,
  missionPlan,
  planPreview,
  onUndoPoint,
  onClearArea,
  onDeployPlan,
  canDeploy,
  onLocationSearch,
  locationStatus,
  collapsed,
  onToggleCollapse,
}) {
  const [locationQuery, setLocationQuery] = useState("");
  const activePlan = planPreview || missionPlan;
  const pointCount = draftSearchArea.length;
  const base = draftBase || missionPlan?.base || null;
  const isPreviewing = Boolean(planPreview);

  function handleLocationSubmit(event) {
    event.preventDefault();
    onLocationSearch(locationQuery);
  }

  return (
    <div className={`panel mission-planner ${collapsed ? "collapsed" : ""}`}>
      <div className="panel-header">
        <span className="planner-dot" />
        <span className="panel-title">MISSION PLANNER</span>
        <span className={`planner-mode-chip ${isPreviewing ? "preview" : ""}`}>
          {isPreviewing ? "PREVIEW" : "ACTIVE"}
        </span>
        <button
          type="button"
          className="panel-collapse-btn"
          title={collapsed ? "Expand mission planner" : "Collapse mission planner"}
          onClick={onToggleCollapse}
        >
          {collapsed ? "+" : "-"}
        </button>
      </div>

      {!collapsed && <div className="mission-planner-body">
        <div className="mode-segmented" aria-label="Planning mode">
          {Object.entries(MODE_LABELS).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "active" : ""}
              onClick={() => onModeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <form className="location-search" onSubmit={handleLocationSubmit}>
          <label htmlFor="mission-location">Location</label>
          <div className="location-row">
            <input
              id="mission-location"
              value={locationQuery}
              onChange={(event) => setLocationQuery(event.target.value)}
              placeholder="Place name or 43.55, 16.62"
            />
            <button type="submit">Go</button>
          </div>
          <span className="location-status">{locationStatus || "Search recenters the map. Set Base mode also places the base."}</span>
        </form>

        <div className="planner-readout">
          <div>
            <span className="readout-label">Base</span>
            <span className="readout-value mono">{formatCoord(base)}</span>
          </div>
          <div>
            <span className="readout-label">Area Points</span>
            <span className="readout-value mono">{pointCount}</span>
          </div>
        </div>

        <div className="planner-actions">
          <button type="button" className="planner-btn" onClick={onUndoPoint} disabled={pointCount === 0}>
            Undo Point
          </button>
          <button type="button" className="planner-btn" onClick={onClearArea} disabled={pointCount === 0}>
            Clear Area
          </button>
        </div>

        <div className="planner-guidance">
          {mode === "base" && "Click the map to place the mission control base."}
          {mode === "area" && "Click around the map to outline the search area. Three points are enough to preview a route."}
          {mode === "inspect" && "Select drones and alerts, or switch modes to edit the mission."}
        </div>

        <div className="planner-metrics-grid">
          <Metric label="Coverage" value={activePlan ? `${activePlan.areaSqKm} km2` : "--"} />
          <Metric label="Passes" value={activePlan ? activePlan.laneCount : "--"} />
          <Metric label="Route" value={activePlan ? `${(activePlan.routeDistanceMeters / 1000).toFixed(1)} km` : "--"} />
          <Metric label="Bearing" value={activePlan ? `${activePlan.sweepBearingDeg} deg` : "--"} />
        </div>

        <button
          type="button"
          className="deploy-btn"
          disabled={!canDeploy}
          onClick={onDeployPlan}
          title={canDeploy ? "Send this mission plan to the drone simulator" : "Set a base and draw a search area first"}
        >
          Deploy Search Pattern
        </button>
      </div>}
    </div>
  );
}
