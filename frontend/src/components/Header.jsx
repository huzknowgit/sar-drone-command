import React, { useEffect, useState } from "react";
import "./Header.css";

export default function Header({ connectionStatus, lastUpdate, droneCount, alertCount }) {
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(`${now.toUTCString().slice(17, 25)} UTC`);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  const statusLabel = {
    connected: "LINK ACTIVE",
    disconnected: "LINK LOST",
    connecting: "ACQUIRING",
  }[connectionStatus] || "UNKNOWN";

  const updateLabel = lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "--";

  return (
    <header className="app-header">
      <div className="header-brand">
        <span className="header-logo">SAR</span>
        <div className="header-title-block">
          <span className="header-title">SAR DRONE COMMAND</span>
          <span className="header-subtitle">Search &amp; Rescue - Aerial Intelligence Platform</span>
        </div>
      </div>

      <div className="header-status">
        <div className="status-item">
          <span className="status-label">DRONES</span>
          <span className="status-value cyan">{droneCount}</span>
        </div>
        <div className="status-divider" />
        <div className="status-item">
          <span className="status-label">ALERTS</span>
          <span className={`status-value ${alertCount > 0 ? "red" : "dim"}`}>{alertCount}</span>
        </div>
        <div className="status-divider" />
        <div className="status-item">
          <span className="status-label">LAST UPDATE</span>
          <span className="status-value mono">{updateLabel}</span>
        </div>
        <div className="status-divider" />
        <div className="status-item">
          <span className="status-label">SERVER</span>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div className={`dot ${connectionStatus}`} />
            <span className={`status-value ${connectionStatus === "connected" ? "green" : "red"}`}>
              {statusLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="header-clock">
        <span className="clock-label">MISSION TIME</span>
        <span className="clock-value mono">{clock}</span>
      </div>
    </header>
  );
}
