const EARTH_METERS_PER_DEGREE_LAT = 111_320;
const SWEEP_SPACING_METERS = 220;

function isFiniteCoord(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon);
}

function clampLat(lat) {
  return Math.max(-85, Math.min(85, lat));
}

function clampLon(lon) {
  return Math.max(-180, Math.min(180, lon));
}

export function normalizePoint(point) {
  return {
    lat: +clampLat(Number(point.lat)).toFixed(6),
    lon: +clampLon(Number(point.lon)).toFixed(6),
  };
}

export function polygonCentroid(points) {
  if (!points.length) return null;

  let lat = 0;
  let lon = 0;
  for (const point of points) {
    lat += point.lat;
    lon += point.lon;
  }

  return normalizePoint({ lat: lat / points.length, lon: lon / points.length });
}

function makeProjection(points) {
  const center = polygonCentroid(points) || { lat: 0, lon: 0 };
  const lonScale = EARTH_METERS_PER_DEGREE_LAT * Math.cos((center.lat * Math.PI) / 180);

  return {
    toXY(point) {
      return {
        x: (point.lon - center.lon) * lonScale,
        y: (point.lat - center.lat) * EARTH_METERS_PER_DEGREE_LAT,
      };
    },
    toLatLon(point) {
      return normalizePoint({
        lat: center.lat + point.y / EARTH_METERS_PER_DEGREE_LAT,
        lon: center.lon + point.x / lonScale,
      });
    },
  };
}

function rotate(point, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function unrotate(point, angle) {
  return rotate(point, -angle);
}

function bounds(points) {
  return points.reduce(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
}

function horizontalIntersections(polygon, y) {
  const xs = [];

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);

    if (a.y === b.y || y < minY || y >= maxY) continue;

    const ratio = (y - a.y) / (b.y - a.y);
    xs.push(a.x + ratio * (b.x - a.x));
  }

  return xs.sort((a, b) => a - b);
}

function generateSweepForAngle(projectedPolygon, angle, spacingMeters) {
  const rotatedPolygon = projectedPolygon.map((point) => rotate(point, angle));
  const box = bounds(rotatedPolygon);
  const route = [];
  let laneCount = 0;
  let leftToRight = true;

  const startY = box.minY + spacingMeters / 2;
  for (let y = startY; y <= box.maxY; y += spacingMeters) {
    const xs = horizontalIntersections(rotatedPolygon, y);

    for (let i = 0; i < xs.length - 1; i += 2) {
      const start = { x: xs[i], y };
      const end = { x: xs[i + 1], y };
      if (Math.abs(end.x - start.x) < spacingMeters * 0.25) continue;

      if (leftToRight) {
        route.push(unrotate(start, angle), unrotate(end, angle));
      } else {
        route.push(unrotate(end, angle), unrotate(start, angle));
      }

      leftToRight = !leftToRight;
      laneCount += 1;
    }
  }

  return {
    route,
    laneCount,
    span: box.maxY - box.minY,
  };
}

function routeDistance(points) {
  let distance = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    distance += Math.sqrt(dx * dx + dy * dy);
  }
  return distance;
}

function polygonArea(projectedPolygon) {
  let twiceArea = 0;
  for (let i = 0; i < projectedPolygon.length; i += 1) {
    const a = projectedPolygon[i];
    const b = projectedPolygon[(i + 1) % projectedPolygon.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twiceArea) / 2;
}

export function generateSearchPlan({ base, searchArea, droneCount = 1 }) {
  const cleanArea = (searchArea || []).filter(isFiniteCoord).map(normalizePoint);
  const cleanBase = isFiniteCoord(base) ? normalizePoint(base) : polygonCentroid(cleanArea);

  if (!cleanBase || cleanArea.length < 3) {
    return null;
  }

  const projection = makeProjection(cleanArea);
  const projectedPolygon = cleanArea.map((point) => projection.toXY(point));
  const areaMeters = polygonArea(projectedPolygon);
  const spacingMeters = SWEEP_SPACING_METERS;

  let best = null;
  for (let degrees = 0; degrees < 180; degrees += 15) {
    const candidate = generateSweepForAngle(projectedPolygon, (degrees * Math.PI) / 180, spacingMeters);
    if (candidate.route.length < 2) continue;

    const distance = routeDistance(candidate.route);
    const score = candidate.laneCount * 10_000 + distance;

    if (!best || score < best.score) {
      best = { ...candidate, degrees, distance, score };
    }
  }

  if (!best) {
    const center = polygonCentroid(cleanArea);
    best = {
      route: projectedPolygon,
      laneCount: cleanArea.length,
      degrees: 0,
      distance: routeDistance(projectedPolygon),
    };
    if (center) {
      best.route = [projection.toXY(center), ...best.route, projection.toXY(center)];
    }
  }

  const sweepPath = best.route.map((point) => projection.toLatLon(point));

  return {
    id: `mission_${Date.now()}`,
    base: { ...cleanBase, name: "MISSION CONTROL BASE" },
    searchArea: cleanArea,
    sweepPath,
    spacingMeters,
    laneCount: best.laneCount,
    routeDistanceMeters: Math.round(best.distance),
    areaSqKm: +(areaMeters / 1_000_000).toFixed(2),
    sweepBearingDeg: Math.round(best.degrees),
    assignedDroneCount: Math.max(1, droneCount),
    updatedAt: Date.now(),
  };
}
