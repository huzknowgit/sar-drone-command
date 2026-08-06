import React, { useEffect, useRef } from "react";
import "./AlertsPanel.css";

const ALERT_META = {
  human_detected: { icon: "H", label: "HUMAN DETECTED", color: "#ff3d3d" },
  heat_signature: { icon: "T", label: "HEAT SIGNATURE", color: "#ff8c00" },
  debris_field: { icon: "D", label: "DEBRIS FIELD", color: "#ffb300" },
  strobe_light: { icon: "S", label: "STROBE LIGHT", color: "#00e5ff" },
};

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function AlertRow({ alert, onClick, onDismiss }) {
  const meta = ALERT_META[alert.alert] || {
    icon: "?",
    label: String(alert.alert || "UNKNOWN ALERT").replace(/_/g, " ").toUpperCase(),
    color: "#607d8b",
  };
  const time = new Date(alert.timestamp || Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const confPct = Math.round(safeNumber(alert.confidence) * 100);

  return (
    <div className="alert-row" style={{ "--alert-color": meta.color }} onClick={() => onClick(alert)}>
      <div className="alert-icon">{meta.icon}</div>
      <div className="alert-body">
        <div className="alert-top">
          <span className="alert-type" style={{ color: meta.color }}>
            {meta.label}
          </span>
          <span className="alert-conf mono" style={{ color: meta.color }}>
            {confPct}%
          </span>
        </div>
        <div className="alert-bottom">
          <span className="alert-drone mono dim">{alert.drone_id || "unknown"}</span>
          <span className="alert-time mono dim">{time}</span>
        </div>
      </div>
      <div className="alert-locator">
        <span className="mono" style={{ fontSize: 8, color: "#334466" }}>
          {safeNumber(alert.lat).toFixed(3)}, {safeNumber(alert.lon).toFixed(3)}
        </span>
      </div>
      <button
        type="button"
        className="alert-dismiss"
        title="Remove event"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss(alert.id);
        }}
      >
        x
      </button>
    </div>
  );
}

export default function AlertsPanel({
  alerts,
  onHighlightAlert,
  onDismissAlert,
  onClearAlerts,
  collapsed,
  onToggleCollapse,
}) {
  const bodyRef = useRef(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [alerts.length]);

  const newestTimestamp = alerts[0]?.timestamp || 0;
  const hasNewAlert = alerts.length > 0 && Date.now() - newestTimestamp < 5000;

  return (
    <div className={`panel alerts-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="panel-header">
        <span className="alerts-dot" style={{ animation: hasNewAlert ? "pulse-red 1s infinite" : "none" }} />
        <span className="panel-title">EVENT LOG</span>
        {alerts.length > 0 && (
          <>
            <span className={`panel-badge ${hasNewAlert ? "alert" : ""}`}>
              {alerts.length}
            </span>
            <button
              type="button"
              className="panel-clear-btn"
              title="Clear event log"
              onClick={onClearAlerts}
            >
              x
            </button>
          </>
        )}
        <button
          type="button"
          className="panel-collapse-btn"
          title={collapsed ? "Expand event log" : "Collapse event log"}
          onClick={onToggleCollapse}
        >
          {collapsed ? "+" : "-"}
        </button>
      </div>

      {!collapsed && <div className="panel-body alerts-panel-body" ref={bodyRef}>
        {alerts.length === 0 ? (
          <div className="empty-state">
            <span className="mono dim">NO EVENTS DETECTED</span>
          </div>
        ) : (
          alerts.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              onClick={onHighlightAlert}
              onDismiss={onDismissAlert}
            />
          ))
        )}
      </div>}
    </div>
  );
}
