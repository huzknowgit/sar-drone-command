import { DEFAULT_SIM_BASE, SIM_METERS_PER_UNIT, WORLD_LIMIT } from "./simulationConfig";
import { clamp } from "./visionMath";

const EARTH_METERS_PER_DEGREE_LAT = 111_320;
const MISSION_WORLD_SPAN = WORLD_LIMIT * 1.94;

function lonScaleForLat(lat) {
  return Math.max(1, EARTH_METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
}

export function normalizeBase(base) {
  const lat = Number(base?.lat);
  const lon = Number(base?.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return DEFAULT_SIM_BASE;
  }

  return {
    lat,
    lon,
    name: base?.name || DEFAULT_SIM_BASE.name,
  };
}

function isValidPoint(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon);
}

function centroid(points) {
  if (!points.length) return null;

  return points.reduce(
    (acc, point) => ({
      lat: acc.lat + point.lat / points.length,
      lon: acc.lon + point.lon / points.length,
    }),
    { lat: 0, lon: 0 },
  );
}

function toMeters(point, center) {
  return {
    x: (point.lon - center.lon) * lonScaleForLat(center.lat),
    z: (point.lat - center.lat) * EARTH_METERS_PER_DEGREE_LAT,
  };
}

function fromMeters(point, center) {
  return {
    lat: +(center.lat + point.z / EARTH_METERS_PER_DEGREE_LAT).toFixed(6),
    lon: +(center.lon + point.x / lonScaleForLat(center.lat)).toFixed(6),
  };
}

function meterBounds(points) {
  return points.reduce(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minZ: Math.min(acc.minZ, point.z),
      maxZ: Math.max(acc.maxZ, point.z),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
  );
}

export function createMissionProjection(missionPlan, fallbackBase) {
  const base = normalizeBase(missionPlan?.base || fallbackBase);
  const searchArea = Array.isArray(missionPlan?.searchArea) ? missionPlan.searchArea.filter(isValidPoint) : [];
  const sweepPath = Array.isArray(missionPlan?.sweepPath) ? missionPlan.sweepPath.filter(isValidPoint) : [];
  const anchorPoints = searchArea.length >= 3 ? searchArea : sweepPath;
  const center = centroid(anchorPoints) || base;
  const meterPoints = [...searchArea, ...sweepPath, base].filter(isValidPoint).map((point) => toMeters(point, center));

  if (meterPoints.length < 2) return null;

  const bounds = meterBounds(meterPoints);
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanZ = Math.max(1, bounds.maxZ - bounds.minZ);
  const maxSpan = Math.max(spanX, spanZ, 420);
  const metersPerUnit = Math.max(2.8, maxSpan / MISSION_WORLD_SPAN);

  return {
    center,
    metersPerUnit,
    bounds,
    worldBounds: {
      minX: bounds.minX / metersPerUnit,
      maxX: bounds.maxX / metersPerUnit,
      minZ: bounds.minZ / metersPerUnit,
      maxZ: bounds.maxZ / metersPerUnit,
    },
  };
}

export function worldUnitsToMeters(units, projection) {
  return units * (projection?.metersPerUnit || SIM_METERS_PER_UNIT);
}

export function worldToLatLon(position, base, projection = null) {
  if (projection) {
    return fromMeters(
      {
        x: Number(position?.x || 0) * projection.metersPerUnit,
        z: Number(position?.z || 0) * projection.metersPerUnit,
      },
      projection.center,
    );
  }

  const cleanBase = normalizeBase(base);
  const metersX = Number(position?.x || 0) * SIM_METERS_PER_UNIT;
  const metersZ = Number(position?.z || 0) * SIM_METERS_PER_UNIT;

  return {
    lat: +(cleanBase.lat + metersZ / EARTH_METERS_PER_DEGREE_LAT).toFixed(6),
    lon: +(cleanBase.lon + metersX / lonScaleForLat(cleanBase.lat)).toFixed(6),
  };
}

export function latLonToWorld(point, base, projection = null) {
  if (!isValidPoint(point)) return null;

  if (projection) {
    const meters = toMeters(point, projection.center);
    return {
      x: clamp(meters.x / projection.metersPerUnit, -WORLD_LIMIT, WORLD_LIMIT),
      y: 9,
      z: clamp(meters.z / projection.metersPerUnit, -WORLD_LIMIT, WORLD_LIMIT),
    };
  }

  const cleanBase = normalizeBase(base);
  const lat = Number(point.lat);
  const lon = Number(point.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    x: clamp(((lon - cleanBase.lon) * lonScaleForLat(cleanBase.lat)) / SIM_METERS_PER_UNIT, -WORLD_LIMIT, WORLD_LIMIT),
    y: 9,
    z: clamp(((lat - cleanBase.lat) * EARTH_METERS_PER_DEGREE_LAT) / SIM_METERS_PER_UNIT, -WORLD_LIMIT, WORLD_LIMIT),
  };
}

export function headingRadToDegrees(headingRad) {
  return ((headingRad * 180) / Math.PI + 360) % 360;
}
