import React, { useMemo } from "react";
import { AI_SERVICE_URL } from "../simulationConfig";
import { locateOnTerrain, useSimulationStore } from "../useSimulationStore";
import { headingRadToDegrees, worldToLatLon, worldUnitsToMeters } from "../geo";
import "./CameraFeed.css";

/**
 * Nadir sensor feed.
 *
 * Not a render of the 3D scene — this is the actual aerial photograph of the
 * ground beneath the aircraft, at native resolution, and it is the exact crop
 * handed to the detector. The 3D terrain is built from the same imagery but at
 * ~12 cm/px; this feed is ~1.5 cm/px, so rendering the WebGL scene here would be
 * both blurrier and far harder for the model to work on.
 *
 * Predicted boxes and ground-truth annotations are drawn together, so misses are
 * as visible as hits.
 */
export default function CameraFeed({ compact = false }) {
  const drones = useSimulationStore((state) => state.drones);
  const terrain = useSimulationStore((state) => state.terrain);
  const base = useSimulationStore((state) => state.base);
  const projection = useSimulationStore((state) => state.missionProjection);
  const detectionMode = useSimulationStore((state) => state.detectionMode);
  const selectedDroneId = useSimulationStore((state) => state.selectedDroneId);
  const ignoreContact = useSimulationStore((state) => state.ignoreContact);

  const drone = drones.find((item) => item.drone_id === selectedDroneId) || drones[0];
  // The frame the sensor is aimed at, which is not always the one under the
  // aircraft: circling a contact, the gimbal stays on the contact. Before the
  // first simulation tick there is no aim point yet, so fall back to the ground
  // under the aircraft rather than claiming it is outside the survey area.
  const tile = drone && terrain
    ? terrain.tiles.find((item) => item.imageId === drone.currentTileId)
      || locateOnTerrain(terrain, drone.position.x, drone.position.z)?.tile
      || null
    : null;

  // Boxes are only drawn when the last inference actually ran on the frame now
  // on screen. Stale boxes over a new frame — or ground truth with no inference
  // behind it — would misrepresent the model as hitting or missing something it
  // was never asked about.
  const scanMatchesFrame = Boolean(tile) && drone?.scanImageId === tile.imageId;
  const detections = scanMatchesFrame ? drone.scanDetections || [] : [];
  const analyzed = scanMatchesFrame;
  const live = detectionMode === "real_ai";

  const cropPx = drone?.scanCropPx || 1024;
  const frameW = terrain?.sourceWidth || 4000;
  const frameH = terrain?.sourceHeight || 3000;

  // Ground truth is stored per frame; the feed shows a crop, so annotations are
  // re-expressed in crop coordinates including the service's edge clamping.
  const groundTruth = useMemo(() => {
    if (!tile || !scanMatchesFrame) return [];

    const halfX = cropPx / 2 / frameW;
    const halfY = cropPx / 2 / frameH;
    const ccx = Math.min(Math.max(drone.scanCropX ?? 0.5, halfX), 1 - halfX);
    const ccy = Math.min(Math.max(drone.scanCropY ?? 0.5, halfY), 1 - halfY);

    return tile.persons
      .map((person) => ({
        cx: (person.cx - (ccx - halfX)) / (2 * halfX),
        cy: (person.cy - (ccy - halfY)) / (2 * halfY),
        w: person.w / (2 * halfX),
        h: person.h / (2 * halfY),
      }))
      .filter((p) => p.cx > -0.05 && p.cx < 1.05 && p.cy > -0.05 && p.cy < 1.05);
  }, [tile, scanMatchesFrame, drone?.scanCropX, drone?.scanCropY, cropPx, frameW, frameH]);

  if (!drone) return null;

  const geo = worldToLatLon(drone.position, base, projection);
  const altitude = Math.max(0, Math.round(worldUnitsToMeters(drone.position.y, projection)));
  const heading = Math.round(headingRadToDegrees(drone.heading));
  const tracking = drone.status === "tracking";

  const viewX = (scanMatchesFrame ? drone.scanCropX : drone?.cropX) ?? 0.5;
  const viewY = (scanMatchesFrame ? drone.scanCropY : drone?.cropY) ?? 0.5;
  const imageUrl = tile && live
    ? `${AI_SERVICE_URL}/image/${tile.imageId}?cx=${viewX.toFixed(4)}&cy=${viewY.toFixed(4)}`
    : null;

  const state = detections.length
    ? `${detections.length} CONTACT`
    : !live ? "NO SENSOR LINK"
      : analyzed ? "CLEAR"
        : "SCANNING";

  return (
    <div className={`nadir-feed${compact ? " compact" : ""}${tracking ? " tracking" : ""}`}>
      <div className="nadir-stage">
        {imageUrl ? (
          <img className="nadir-image" src={imageUrl} alt={`nadir ${tile.imageId}`} draggable="false" />
        ) : (
          <div className="nadir-offline">
            {live ? "OUTSIDE SURVEY AREA" : "SENSOR OFFLINE — INFERENCE SERVICE DOWN"}
          </div>
        )}

        {/* Ground truth under predictions, so a prediction always draws on top. */}
        {imageUrl && groundTruth.map((person, index) => (
          <div
            key={`gt-${index}`}
            className="nadir-box truth"
            style={{
              left: `${(person.cx - person.w / 2) * 100}%`,
              top: `${(person.cy - person.h / 2) * 100}%`,
              width: `${person.w * 100}%`,
              height: `${person.h * 100}%`,
            }}
          />
        ))}

        {imageUrl && detections.map((detection, index) => {
          const [x, y, w, h] = detection.bbox_norm;
          return (
            <div
              key={`det-${index}`}
              className="nadir-box detected"
              style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
            >
              <i className="c tl" /><i className="c tr" /><i className="c bl" /><i className="c br" />
              <span className="nadir-box-label">PERSON {Math.round(detection.confidence * 100)}%</span>
            </div>
          );
        })}

        <div className="nadir-reticle">
          <span className="tick t" /><span className="tick b" />
          <span className="tick l" /><span className="tick r" />
        </div>
        <div className="nadir-vignette" />
        <div className="nadir-scan" />

        {/* On-screen display, burned in the way a real ground station overlays it. */}
        <div className="nadir-osd osd-tl">
          <span className={`rec${live ? " on" : ""}`}>●</span>
          <span>{live ? "REC" : "NO SIG"}</span>
          <span className="dim">NADIR / EO</span>
        </div>

        <div className="nadir-osd osd-tr">
          <span>{drone.drone_id.toUpperCase()}</span>
          <span className="dim">{new Date().toISOString().slice(11, 19)}Z</span>
        </div>

        <div className="nadir-osd osd-bl">
          <span>ALT {altitude}m</span>
          <span>HDG {String(heading).padStart(3, "0")}</span>
          <span>GS {drone.speedMeters.toFixed(1)}m/s</span>
        </div>

        <div className="nadir-osd osd-br">
          <span>{geo.lat.toFixed(5)}, {geo.lon.toFixed(5)}</span>
        </div>

        <div className={`nadir-status${detections.length ? " hit" : ""}`}>{state}</div>

        {tracking && (
          <div className="nadir-track-banner">
            <span>TARGET TRACK — {String(drone.targetId || "CONTACT").toUpperCase()}</span>
            <button
              type="button"
              className="nadir-wave-off"
              title="Stop circling this contact and go back on the planned route"
              onClick={() => ignoreContact(drone.targetId)}
            >
              IGNORE — RESUME ROUTE
            </button>
          </div>
        )}
      </div>

      <div className="nadir-foot">
        <span>FRAME {tile ? tile.imageId : "--"}</span>
        <span>GT {groundTruth.length}</span>
        <span className={detections.length ? "hit" : ""}>DET {analyzed ? detections.length : "--"}</span>
        <span>{analyzed && drone.scanInferenceMs ? `${drone.scanInferenceMs}ms` : "--"}</span>
        <span className="dim">{drone.scanCropPx || 1024}px</span>
      </div>
    </div>
  );
}
