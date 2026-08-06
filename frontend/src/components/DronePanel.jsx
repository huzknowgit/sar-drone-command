import React, { useState } from "react";
import "./DronePanel.css";

const STATUS_META = {
  tracking: { label: "TRACKING", color: "#ff3d3d" },
  searching: { label: "SEARCHING", color: "#00e5ff" },
  returning: { label: "RETURNING", color: "#ffb300" },
  charging: { label: "CHARGING", color: "#00e676" },
  idle: { label: "IDLE", color: "#607d8b" },
  offline: { label: "OFFLINE", color: "#37474f" },
  unknown: { label: "UNKNOWN", color: "#546e7a" },
};

function numberOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function BatteryBar({ pct, status }) {
  const safePct = Math.max(0, Math.min(100, numberOr(pct)));
  const isCharging = status === "charging";
  const color = isCharging
    ? "#00e676"
    : safePct > 50 ? "#00e676"
    : safePct > 25 ? "#ffb300"
    : "#ff3d3d";

  return (
    <div className="battery-wrap">
      <div
        className={`battery-fill ${isCharging ? "charging-anim" : ""}`}
        style={{ width: `${Math.max(2, safePct)}%`, background: color }}
      />
      <span className="battery-label mono" style={{ color }}>
        {isCharging ? `CHG ${safePct.toFixed(0)}%` : `${safePct.toFixed(0)}%`}
      </span>
    </div>
  );
}

function RecallButton({ drone, onRecall, justRecalled }) {
  const { status } = drone;
  const disabled = status === "returning" || status === "charging" || status === "offline";

  let label = "RECALL";
  let title = "Recall drone to base for charging";
  if (status === "returning") { label = "INBOUND"; title = "Drone is already returning to base"; }
  if (status === "charging") { label = "CHARGING"; title = "Drone is charging at base"; }
  if (status === "offline") { label = "OFFLINE"; title = "Drone is offline"; }
  if (justRecalled) label = "RECALLED";

  return (
    <button
      className={`recall-btn ${disabled ? "disabled" : ""} ${justRecalled ? "confirmed" : ""}`}
      disabled={disabled}
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onRecall(drone.drone_id);
      }}
    >
      {label}
    </button>
  );
}

function DroneCard({ drone, isSelected, onSelect, onRecall }) {
  const {
    drone_id,
    lat,
    lon,
    battery,
    status = "unknown",
    speed,
    altitude,
    heading,
    last_updated,
  } = drone;
  const meta = STATUS_META[status] || STATUS_META.unknown;
  const [justRecalled, setJustRecalled] = useState(false);

  function handleRecall(id) {
    onRecall(id);
    setJustRecalled(true);
    setTimeout(() => setJustRecalled(false), 3000);
  }

  const age = Number.isFinite(last_updated) ? `${Math.max(0, Math.round((Date.now() - last_updated) / 1000))}s` : "--";

  return (
    <div className={`drone-card ${isSelected ? "selected" : ""} status-${status}`} onClick={onSelect}>
      <div className="drone-card-top">
        <div className="drone-id mono" style={{ color: meta.color }}>
          {drone_id}
        </div>
        <span className="drone-status" style={{ color: meta.color, borderColor: meta.color }}>
          {meta.label}
        </span>
      </div>

      <BatteryBar pct={battery} status={status} />

      <div className="drone-stats">
        <div className="stat">
          <span className="stat-label">LAT</span>
          <span className="stat-val mono">{numberOr(lat).toFixed(4)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">LON</span>
          <span className="stat-val mono">{numberOr(lon).toFixed(4)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">ALT</span>
          <span className="stat-val mono">{status === "charging" ? "0 m" : `${numberOr(altitude).toFixed(0)} m`}</span>
        </div>
        <div className="stat">
          <span className="stat-label">SPD</span>
          <span className="stat-val mono">{status === "charging" ? "0.0" : numberOr(speed).toFixed(1)} m/s</span>
        </div>
        <div className="stat">
          <span className="stat-label">HDG</span>
          <span className="stat-val mono">{status === "charging" ? "--" : `${numberOr(heading).toFixed(0)} deg`}</span>
        </div>
        <div className="stat">
          <span className="stat-label">AGO</span>
          <span className="stat-val mono dim">{age}</span>
        </div>
      </div>

      <RecallButton drone={drone} onRecall={handleRecall} justRecalled={justRecalled} />
    </div>
  );
}

export default function DronePanel({ drones, selectedDroneId, onSelectDrone, onRecall, collapsed, onToggleCollapse }) {
  const sorted = [...drones].sort((a, b) => String(a.drone_id).localeCompare(String(b.drone_id)));
  const searching = drones.filter((d) => d.status === "searching").length;
  const returning = drones.filter((d) => d.status === "returning").length;
  const charging = drones.filter((d) => d.status === "charging").length;

  return (
    <div className={`panel drone-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="panel-header">
        <span className="panel-dot" />
        <span className="panel-title">ACTIVE UNITS</span>
        <div className="panel-status-counts">
          {searching > 0 && <span className="count-chip cyan">{searching} SRCH</span>}
          {returning > 0 && <span className="count-chip amber">{returning} RTB</span>}
          {charging > 0 && <span className="count-chip green">{charging} CHG</span>}
        </div>
        <span className="panel-badge">{drones.length} ACTIVE</span>
        <button
          type="button"
          className="panel-collapse-btn"
          title={collapsed ? "Expand active units" : "Collapse active units"}
          onClick={onToggleCollapse}
        >
          {collapsed ? "+" : "-"}
        </button>
      </div>

      {!collapsed && <div className="panel-body drone-panel-body">
        {sorted.length === 0 ? (
          <div className="empty-state">
            <span className="mono dim">AWAITING DRONE LINK...</span>
          </div>
        ) : (
          sorted.map((drone) => (
            <DroneCard
              key={drone.drone_id}
              drone={drone}
              isSelected={drone.drone_id === selectedDroneId}
              onSelect={() => onSelectDrone(drone.drone_id === selectedDroneId ? null : drone.drone_id)}
              onRecall={onRecall}
            />
          ))
        )}
      </div>}
    </div>
  );
}
