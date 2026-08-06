import React, { useEffect, useState } from "react";
import { useSimulationStore } from "../simulation/useSimulationStore";
import ChaseCameraView from "../simulation/components/ChaseCameraView";
import CameraFeed from "../simulation/components/CameraFeed";
import "./VideoPanel.css";

function SimulatedCameraFeed({ drone, cameraMode }) {
  const simDrone = useSimulationStore((state) => state.drones.find((item) => item.drone_id === drone.drone_id));
  const target = useSimulationStore((state) => state.contacts.find((contact) => contact.id === simDrone?.targetId));
  const isTracking = simDrone?.status === "tracking" && target;
  const heading = Number.isFinite(drone.heading) ? drone.heading : 0;

  return (
    <div className={`feed-sim-stream ${cameraMode} ${isTracking ? "tracking" : ""}`}>
      <div className="feed-sim-terrain" style={{ transform: `rotate(${heading * 0.18}deg) scale(1.15)` }} />
      <div className="feed-sim-scanline" />
      <div className="feed-sim-gimbal">GIMBAL CAM / SIM CV</div>
      {isTracking && (
        <div className="feed-sim-target">
          <span>{target.id}</span>
          <strong>{Math.round((simDrone.confidence || 0) * 100)}%</strong>
        </div>
      )}
    </div>
  );
}

function FeedSurface({ drone, cameraMode, large = false }) {
  const { drone_id, status, battery, video_url } = drone;
  const safeBattery = Number.isFinite(battery) ? battery : 0;
  const isLive = status !== "offline";
  const isSimulatedDrone = /^drone_\d+$/i.test(String(drone_id || ""));
  const hasLiveStream = isLive && cameraMode === "normal" && typeof video_url === "string" && video_url.length > 0;

  return (
    <>
      {hasLiveStream ? (
        <>
          <img className="feed-video-stream" src={video_url} alt={`${drone_id} live camera`} draggable="false" />
          <div className="feed-video-vignette" />
        </>
      ) : isLive && isSimulatedDrone ? (
        <SimulatedCameraFeed drone={drone} cameraMode={cameraMode} />
      ) : (
        <div className={`feed-static ${cameraMode}`} />
      )}
      {cameraMode === "thermal" && <div className="thermal-scan" />}

      <div className="feed-hud">
        <div className="feed-hud-top">
          <span className="feed-drone-id mono">{drone_id}</span>
          {isLive && <span className="feed-live">REC</span>}
        </div>
        <div className="feed-hud-bottom">
          <span className="mono" style={{ fontSize: large ? 12 : 9, color: safeBattery < 25 ? "#ff3d3d" : "#00e676" }}>
            BATT {safeBattery.toFixed(0)}%
          </span>
          <span className="mono" style={{ fontSize: large ? 12 : 9, color: "#6f8bad" }}>
            {String(status || "unknown").toUpperCase()} - {cameraMode.toUpperCase()}
          </span>
        </div>
      </div>

      <div className="feed-center">
        <div className={`feed-crosshair ${large ? "large" : ""}`}>
          <div className="crosshair-h" />
          <div className="crosshair-v" />
        </div>
        <span className="mono feed-placeholder">
          {hasLiveStream ? "LIVE CAMERA" : isSimulatedDrone ? "SIMULATED CAMERA" : cameraMode === "thermal" ? "THERMAL CAMERA" : "NO CAMERA LINK"}
        </span>
      </div>
    </>
  );
}

function FeedSlot({ drone, isPrimary, cameraMode, onOpen }) {
  if (!drone) {
    return (
      <div className="feed-slot empty">
        <div className="feed-no-signal">
          <span className="feed-no-signal-icon">NO</span>
          <span className="mono dim" style={{ fontSize: 9 }}>NO LINK</span>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`feed-slot ${isPrimary ? "primary" : ""}`}
      onClick={() => onOpen(drone)}
      title="Open full screen feed"
    >
      <FeedSurface drone={drone} cameraMode={cameraMode} />
    </button>
  );
}

export default function VideoPanel({ drones, selectedDrone, collapsed, onToggleCollapse }) {
  const [cameraMode, setCameraMode] = useState("normal");
  const [expandedDrone, setExpandedDrone] = useState(null);
  const simDrones = useSimulationStore((state) => state.drones);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setExpandedDrone(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const sorted = [...drones].sort((a, b) => {
    if (selectedDrone) {
      if (a.drone_id === selectedDrone.drone_id) return -1;
      if (b.drone_id === selectedDrone.drone_id) return 1;
    }
    return String(a.drone_id).localeCompare(String(b.drone_id));
  });

  const slots = Array.from({ length: 5 }, (_, index) => sorted[index] || null);

  // Show the rendered chase view whenever no real aircraft is streaming. The
  // `drones` prop comes from the backend WebSocket and is empty when only the
  // simulator is running, so the simulator's own drones are the signal here.
  const hasRealStream = drones.some(
    (drone) => typeof drone.video_url === "string" && drone.video_url.length > 0,
  );
  const simulatedOnly = simDrones.length > 0 && !hasRealStream;
  const liveExpandedDrone = expandedDrone
    ? drones.find((drone) => drone.drone_id === expandedDrone.drone_id) || expandedDrone
    : null;

  return (
    <div className={`video-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="video-panel-label">
        <span>VIDEO FEEDS</span>
        <span className="mono dim" style={{ fontSize: 9, marginLeft: 8 }}>
          {drones.length} ACTIVE
        </span>
        {!collapsed && <div className="camera-toggle">
          <button
            type="button"
            className={cameraMode === "normal" ? "active" : ""}
            onClick={() => setCameraMode("normal")}
          >
            Normal
          </button>
          <button
            type="button"
            className={cameraMode === "thermal" ? "active" : ""}
            onClick={() => setCameraMode("thermal")}
          >
            Thermal
          </button>
        </div>}
        <button
          type="button"
          className="panel-collapse-btn video-collapse-btn"
          title={collapsed ? "Expand video feeds" : "Collapse video feeds"}
          onClick={onToggleCollapse}
        >
          {collapsed ? "+" : "-"}
        </button>
      </div>

      {!collapsed && <div className={`video-grid${simulatedOnly ? " chase-mode" : ""}`}>
        {/* Two cameras, two jobs. NADIR is the sensor feed — real aerial
            photography of the ground below, and the exact pixels the detector
            reads. CHASE is a rendered 3D view for situational awareness only.
            Real hardware feeds still use the slot grid below. */}
        {simulatedOnly ? (
          <>
            <div className="feed-tile">
              <div className="feed-tile-label">
                NADIR CAM <span className="dim">/ SENSOR — AI INPUT</span>
              </div>
              <CameraFeed compact />
            </div>
            <div className="feed-tile">
              <div className="feed-tile-label">
                CHASE CAM <span className="dim">/ RENDERED — NOT AI INPUT</span>
              </div>
              <ChaseCameraView />
            </div>
          </>
        ) : slots.map((drone, index) => (
          <FeedSlot
            key={drone ? drone.drone_id : `empty-${index}`}
            drone={drone}
            cameraMode={cameraMode}
            onOpen={setExpandedDrone}
            isPrimary={Boolean(drone && selectedDrone && drone.drone_id === selectedDrone.drone_id)}
          />
        ))}
      </div>}

      {liveExpandedDrone && (
        <div className="feed-modal" role="dialog" aria-modal="true" onClick={() => setExpandedDrone(null)}>
          <div className="feed-modal-frame" onClick={(event) => event.stopPropagation()}>
            <div className="feed-modal-toolbar">
              <span className="mono">{liveExpandedDrone.drone_id}</span>
              <div className="camera-toggle modal-toggle">
                <button
                  type="button"
                  className={cameraMode === "normal" ? "active" : ""}
                  onClick={() => setCameraMode("normal")}
                >
                  Normal
                </button>
                <button
                  type="button"
                  className={cameraMode === "thermal" ? "active" : ""}
                  onClick={() => setCameraMode("thermal")}
                >
                  Thermal
                </button>
              </div>
              <button type="button" className="feed-modal-close" onClick={() => setExpandedDrone(null)}>
                x
              </button>
            </div>
            <div className="feed-fullscreen-surface">
              <FeedSurface drone={liveExpandedDrone} cameraMode={cameraMode} large />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
