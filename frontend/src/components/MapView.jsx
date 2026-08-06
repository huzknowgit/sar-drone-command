import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./MapView.css";

const STATUS_COLORS = {
  tracking: "#ff3d3d",
  searching: "#00e5ff",
  returning: "#ffb300",
  charging: "#00e676",
  idle: "#607d8b",
  offline: "#37474f",
  unknown: "#546e7a",
};

// Dalmatian karst inland of Split — the terrain the detector is trained for.
// Keep in sync with DEFAULT_SIM_BASE in src/simulation/simulationConfig.js.
const MAP_CENTER = [43.5525, 16.6215];
const MAP_ZOOM = 13;

function isValidCoord(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon);
}

function latLng(point) {
  return [point.lat, point.lon];
}

function makeDroneIcon(status, isSelected, heading = 0) {
  const color = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  const size = isSelected ? 36 : 30;
  const glow = isSelected
    ? `drop-shadow(0 0 8px ${color})`
    : `drop-shadow(0 0 4px ${color})`;
  const safeHeading = Number.isFinite(heading) ? heading : 0;

  const svgBody = status === "charging"
    ? `
      <circle cx="20" cy="20" r="9" fill="${color}" opacity="0.12" stroke="${color}" stroke-width="1.5"/>
      <rect x="12" y="18" width="16" height="4" fill="${color}" opacity="0.9"/>
      <rect x="18" y="12" width="4" height="16" fill="${color}" opacity="0.9"/>`
    : `
      <g transform="rotate(${safeHeading} 20 20)">
      <circle cx="20" cy="20" r="6" fill="${color}" opacity="0.9"/>
      <path d="M20 3 L24 16 L20 13 L16 16 Z" fill="${color}" opacity="0.88"/>
      <line x1="20" y1="20" x2="5" y2="5" stroke="${color}" stroke-width="2" opacity="0.7"/>
      <line x1="20" y1="20" x2="35" y2="5" stroke="${color}" stroke-width="2" opacity="0.7"/>
      <line x1="20" y1="20" x2="5" y2="35" stroke="${color}" stroke-width="2" opacity="0.7"/>
      <line x1="20" y1="20" x2="35" y2="35" stroke="${color}" stroke-width="2" opacity="0.7"/>
      <circle cx="5" cy="5" r="5" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>
      <circle cx="35" cy="5" r="5" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>
      <circle cx="5" cy="35" r="5" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>
      <circle cx="35" cy="35" r="5" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>
      </g>
      ${isSelected ? `<circle cx="20" cy="20" r="12" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3,2" opacity="0.55"/>` : ""}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${size}" height="${size}">${svgBody}</svg>`;

  return L.divIcon({
    className: "",
    html: `<div style="filter:${glow}">${svg}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 2],
  });
}

function makeBaseIcon(isDraft = false) {
  const color = isDraft ? "#ffb300" : "#00e676";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" width="44" height="44">
      <circle cx="30" cy="30" r="28" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.55"/>
      <circle cx="30" cy="30" r="18" fill="rgba(0,0,0,0.2)" stroke="${color}" stroke-width="1.5"/>
      <text x="30" y="37" text-anchor="middle" font-size="20" font-weight="900"
            font-family="'Exo 2', sans-serif" fill="${color}" opacity="0.95">H</text>
    </svg>`;

  return L.divIcon({
    className: "",
    html: `<div class="base-marker-wrap">${svg}</div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -26],
  });
}

function makeAlertIcon() {
  return L.divIcon({
    className: "",
    html: `
      <div class="alert-marker">
        <div class="alert-pulse"></div>
        <div class="alert-core">!</div>
      </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function makeVertexIcon(index) {
  return L.divIcon({
    className: "",
    html: `<div class="area-vertex">${index + 1}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function dronePopup(drone, color) {
  const battery = Number.isFinite(drone.battery) ? drone.battery : 0;
  const lat = Number.isFinite(drone.lat) ? drone.lat : 0;
  const lon = Number.isFinite(drone.lon) ? drone.lon : 0;
  const altitude = Number.isFinite(drone.altitude) ? drone.altitude : 0;
  const speed = Number.isFinite(drone.speed) ? drone.speed : 0;
  const heading = Number.isFinite(drone.heading) ? drone.heading : 0;

  return `
    <div style="min-width:190px;font-family:'Share Tech Mono',monospace;font-size:12px;line-height:1.9">
      <div style="color:${color};font-size:14px;font-weight:bold;margin-bottom:4px">${drone.drone_id}</div>
      <div>STATUS <span style="color:${color}">${String(drone.status || "unknown").toUpperCase()}</span></div>
      <div>BATT <span style="color:${battery < 25 ? "#ff3d3d" : battery < 50 ? "#ffb300" : "#00e676"}">${battery.toFixed(1)}%</span></div>
      <div>LAT ${lat.toFixed(5)}</div>
      <div>LON ${lon.toFixed(5)}</div>
      <div>ALT ${altitude.toFixed(0)} m</div>
      <div>SPD ${speed.toFixed(1)} m/s</div>
      <div>HDG ${heading.toFixed(0)} deg</div>
    </div>`;
}

const TRAIL_COLORS = ["#00e5ff", "#ffb300", "#00e676", "#ab47bc", "#7c4dff", "#26c6da"];

function trailColorForDroneId(droneId, dronesList) {
  const idx = (dronesList || []).findIndex((d) => d.drone_id === droneId);
  return TRAIL_COLORS[(idx >= 0 ? idx : 0) % TRAIL_COLORS.length];
}

export default function MapView({
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
  droneTrails,
}) {
  const mapRef = useRef(null);
  const leafletRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const droneLayerRef = useRef({});
  const alertLayerRef = useRef({});
  const baseMarkerRef = useRef(null);
  const missionLayerRef = useRef(null);
  const draftLayerRef = useRef(null);
  const locationMarkerRef = useRef(null);
  const selectedDroneRef = useRef(null);
  const missionFitRef = useRef(null);
  const trailLayerRef = useRef({});
  const trailPaintThrottleRef = useRef(0);

  const visibleMission = planPreview || missionPlan;
  const currentBase = visibleMission?.base || base;

  const overlayLabel = useMemo(() => {
    if (plannerMode === "base") return "CLICK MAP TO PLACE MISSION CONTROL BASE";
    if (plannerMode === "area") return "CLICK MAP TO OUTLINE SEARCH AREA";
    if (visibleMission?.sweepPath?.length) return "AUTONOMOUS SEARCH PATTERN READY";
    return "SECTOR MAP - DALMATIAN KARST AOR";
  }, [plannerMode, visibleMission]);

  useEffect(() => {
    selectedDroneRef.current = selectedDroneId;
  }, [selectedDroneId]);

  useEffect(() => {
    if (leafletRef.current) return;

    const map = L.map(mapRef.current, {
      center: MAP_CENTER,
      zoom: MAP_ZOOM,
      zoomControl: true,
      attributionControl: true,
    });

    // Satellite imagery, not street tiles: a wilderness search rendered over a
    // road map undercuts the whole premise, and terrain is what an operator
    // actually needs to read here. Esri tile URLs are {z}/{y}/{x}, not {z}/{x}/{y}.
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        maxZoom: 19,
      },
    ).addTo(map);

    missionLayerRef.current = L.layerGroup().addTo(map);
    draftLayerRef.current = L.layerGroup().addTo(map);
    leafletRef.current = map;
    setMapReady(true);

    return () => {
      map.remove();
      leafletRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = leafletRef.current;
    const el = mapRef.current;
    if (!mapReady || !map || !el || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [mapReady]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!mapReady || !map) return undefined;

    const container = map.getContainer();
    container.classList.toggle("map-clickable", plannerMode === "base" || plannerMode === "area");

    const handleClick = (event) => {
      if (plannerMode !== "base" && plannerMode !== "area") return;
      onMapDraftPoint({ lat: event.latlng.lat, lon: event.latlng.lng });
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
      container.classList.remove("map-clickable");
    };
  }, [plannerMode, onMapDraftPoint, mapReady]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!mapReady || !map || !isValidCoord(currentBase)) return;

    const popup = `
      <div style="font-family:'Share Tech Mono',monospace;font-size:12px;line-height:1.8">
        <div style="color:#00e676;font-size:13px;font-weight:bold">${currentBase.name || "MISSION CONTROL BASE"}</div>
        <div style="color:#607d8b">SAR Operations Center</div>
        <div>${currentBase.lat.toFixed(5)}, ${currentBase.lon.toFixed(5)}</div>
      </div>`;

    if (baseMarkerRef.current) {
      baseMarkerRef.current.setLatLng(latLng(currentBase));
      baseMarkerRef.current.getPopup()?.setContent(popup);
      baseMarkerRef.current.getTooltip()?.setContent(currentBase.name || "Mission Control Base");
    } else {
      baseMarkerRef.current = L.marker(latLng(currentBase), {
        icon: makeBaseIcon(false),
        zIndexOffset: 150,
      })
        .addTo(map)
        .bindPopup(popup, { maxWidth: 220 })
        .bindTooltip(currentBase.name || "Mission Control Base", {
          permanent: true,
          direction: "right",
          className: "base-tooltip",
          offset: [18, 0],
        });
    }
  }, [currentBase, mapReady]);

  useEffect(() => {
    const layer = missionLayerRef.current;
    if (!mapReady || !layer) return;

    layer.clearLayers();
    if (!visibleMission) return;

    const area = (visibleMission.searchArea || []).filter(isValidCoord);
    const path = (visibleMission.sweepPath || []).filter(isValidCoord);

    if (area.length >= 3) {
      L.polygon(area.map(latLng), {
        color: planPreview ? "#ffb300" : "#00e676",
        weight: 2,
        dashArray: planPreview ? "6,6" : undefined,
        fillColor: planPreview ? "#ffb300" : "#00e676",
        fillOpacity: 0.08,
      }).addTo(layer);
    }

    if (path.length >= 2) {
      L.polyline(path.map(latLng), {
        color: "#00e5ff",
        weight: 2,
        opacity: 0.82,
      }).addTo(layer);

      L.circleMarker(latLng(path[0]), {
        radius: 4,
        color: "#00e5ff",
        fillColor: "#00e5ff",
        fillOpacity: 0.9,
      }).addTo(layer);
    }

    const fitId = visibleMission?.id || `${area.length}-${path.length}-${currentBase?.lat}-${currentBase?.lon}`;
    const fitPoints = [...area, ...path, currentBase].filter(isValidCoord);
    const map = leafletRef.current;
    if (map && fitPoints.length >= 2 && missionFitRef.current !== fitId) {
      missionFitRef.current = fitId;
      map.fitBounds(L.latLngBounds(fitPoints.map(latLng)), {
        padding: [42, 42],
        maxZoom: 15,
        animate: true,
      });
    }
  }, [visibleMission, planPreview, currentBase, mapReady]);

  useEffect(() => {
    const layer = draftLayerRef.current;
    if (!mapReady || !layer) return;

    layer.clearLayers();

    if (isValidCoord(draftBase)) {
      L.marker(latLng(draftBase), {
        icon: makeBaseIcon(true),
        zIndexOffset: 100,
      })
        .addTo(layer)
        .bindTooltip("Draft Mission Control Base", {
          permanent: true,
          direction: "right",
          className: "base-tooltip draft",
          offset: [18, 0],
        });
    }

    const area = (draftSearchArea || []).filter(isValidCoord);
    if (area.length >= 2) {
      L.polyline(area.map(latLng), {
        color: "#ffb300",
        weight: 2,
        dashArray: "4,5",
      }).addTo(layer);
    }

    area.forEach((point, index) => {
      L.marker(latLng(point), { icon: makeVertexIcon(index), zIndexOffset: 200 }).addTo(layer);
    });
  }, [draftBase, draftSearchArea, mapReady]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!mapReady || !map || !isValidCoord(draftBase)) return;
    map.panTo(latLng(draftBase), { animate: true, duration: 0.35 });
  }, [draftBase, mapReady]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!mapReady || !map || !isValidCoord(locationFocus)) return;

    const label = locationFocus.label || "Location";
    if (locationMarkerRef.current) {
      locationMarkerRef.current.setLatLng(latLng(locationFocus));
      locationMarkerRef.current.getTooltip()?.setContent(label);
    } else {
      locationMarkerRef.current = L.circleMarker(latLng(locationFocus), {
        radius: 8,
        color: "#ffb300",
        weight: 2,
        fillColor: "#ffb300",
        fillOpacity: 0.18,
      })
        .addTo(map)
        .bindTooltip(label, {
          permanent: false,
          direction: "top",
          className: "location-tooltip",
        });
    }

    map.setView(latLng(locationFocus), Math.max(map.getZoom(), 14), { animate: true });
  }, [locationFocus, mapReady]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!mapReady || !map) return;

    const trails = droneTrails || {};
    const seenTrailIds = new Set();
    const now = performance.now();
    const throttleMs = 100;
    const skipHeavyTrailPaint = now - trailPaintThrottleRef.current < throttleMs;

    for (const [droneId, points] of Object.entries(trails)) {
      if (!Array.isArray(points) || points.length < 2) continue;
      const latlngs = points.filter(isValidCoord).map(latLng);
      if (latlngs.length < 2) continue;

      seenTrailIds.add(droneId);
      const color = trailColorForDroneId(droneId, drones);
      const existing = trailLayerRef.current[droneId];

      if (existing) {
        if (!skipHeavyTrailPaint) {
          existing.setLatLngs(latlngs);
          existing.setStyle({ color, opacity: 0.52, weight: 2 });
          existing.bringToBack();
        }
      } else {
        const line = L.polyline(latlngs, {
          color,
          weight: 2,
          opacity: 0.52,
          lineJoin: "round",
          lineCap: "round",
        }).addTo(map);
        line.bringToBack();
        trailLayerRef.current[droneId] = line;
      }
    }

    for (const [id, line] of Object.entries(trailLayerRef.current)) {
      if (!seenTrailIds.has(id)) {
        line.remove();
        delete trailLayerRef.current[id];
      }
    }

    if (!skipHeavyTrailPaint) {
      trailPaintThrottleRef.current = now;
    }
  }, [droneTrails, drones, mapReady]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!mapReady || !map) return;

    const seenIds = new Set();

    for (const drone of drones) {
      if (!drone?.drone_id || !isValidCoord(drone)) continue;

      const status = drone.status || "unknown";
      const isSelected = drone.drone_id === selectedDroneId;
      const color = STATUS_COLORS[status] || STATUS_COLORS.unknown;
      const icon = makeDroneIcon(status, isSelected, drone.heading);
      const popupHtml = dronePopup(drone, color);
      const existing = droneLayerRef.current[drone.drone_id];
      seenIds.add(drone.drone_id);

      if (existing) {
        existing.marker.setLatLng(latLng(drone));
        existing.marker.setIcon(icon);
        existing.marker.getPopup()?.setContent(popupHtml);
        existing.marker.getTooltip()?.setContent(drone.drone_id);

        if (status === "returning" && isValidCoord(currentBase)) {
          const points = [latLng(drone), latLng(currentBase)];
          if (existing.polyline) {
            existing.polyline.setLatLngs(points);
          } else {
            existing.polyline = L.polyline(points, {
              color,
              weight: 1.5,
              dashArray: "6,6",
              opacity: 0.65,
            }).addTo(map);
          }
        } else if (existing.polyline) {
          existing.polyline.remove();
          existing.polyline = null;
        }
      } else {
        const marker = L.marker(latLng(drone), { icon })
          .addTo(map)
          .bindPopup(popupHtml, { maxWidth: 230 })
          .bindTooltip(drone.drone_id, {
            permanent: true,
            direction: "top",
            className: "drone-map-tooltip",
            offset: [0, -16],
          })
          .on("click", () => onSelectDrone(drone.drone_id))
          .on("popupclose", () => {
            if (selectedDroneRef.current === drone.drone_id) {
              onSelectDrone(null);
            }
          });

        droneLayerRef.current[drone.drone_id] = { marker, polyline: null };
      }

      if (isSelected) {
        droneLayerRef.current[drone.drone_id]?.marker.openPopup();
      }
    }

    for (const [id, layer] of Object.entries(droneLayerRef.current)) {
      if (!seenIds.has(id)) {
        layer.marker.remove();
        layer.polyline?.remove();
        delete droneLayerRef.current[id];
      }
    }
  }, [drones, selectedDroneId, onSelectDrone, currentBase, mapReady]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!mapReady || !map || !selectedDroneId) return;

    const drone = drones.find((item) => item.drone_id === selectedDroneId && isValidCoord(item));
    if (drone) map.panTo(latLng(drone), { animate: true, duration: 0.5 });
  }, [selectedDroneId, drones, mapReady]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!mapReady || !map) return;

    const visibleAlerts = (alerts || []).filter(isValidCoord).slice(0, 10);
    const seenIds = new Set();

    for (const alert of visibleAlerts) {
      if (!alert.id) continue;
      seenIds.add(alert.id);

      if (alertLayerRef.current[alert.id]) continue;

      const label = String(alert.alert || "alert").replace(/_/g, " ").toUpperCase();
      const confidence = Number.isFinite(alert.confidence) ? alert.confidence : 0;
      const popupHtml = `
        <div style="font-family:'Share Tech Mono',monospace;font-size:11px;line-height:1.7">
          <div style="color:#ff3d3d;font-weight:bold">${label}</div>
          <div>Drone: ${alert.drone_id || "unknown"}</div>
          <div>Conf: ${(confidence * 100).toFixed(0)}%</div>
          <div>${new Date(alert.timestamp || Date.now()).toLocaleTimeString()}</div>
        </div>`;

      alertLayerRef.current[alert.id] = L.marker(latLng(alert), { icon: makeAlertIcon() })
        .addTo(map)
        .bindPopup(popupHtml);
    }

    for (const [id, marker] of Object.entries(alertLayerRef.current)) {
      if (!seenIds.has(id)) {
        marker.remove();
        delete alertLayerRef.current[id];
      }
    }

    if (highlightedAlert && isValidCoord(highlightedAlert)) {
      map.panTo(latLng(highlightedAlert), { animate: true });
      alertLayerRef.current[highlightedAlert.id]?.openPopup();
    }
  }, [alerts, highlightedAlert, mapReady]);

  return (
    <div className="mapview-root">
      <div ref={mapRef} className="mapview-leaflet" />
      <div className="mapview-overlay-label">{overlayLabel}</div>
    </div>
  );
}
