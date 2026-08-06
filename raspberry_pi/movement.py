from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Iterable


METERS_PER_DEGREE_LAT = 111_111.0
BASE_ARRIVAL_RADIUS_M = 8.0
WAYPOINT_RADIUS_M = 9.0


@dataclass
class DroneState:
    lat: float
    lon: float
    battery: float
    status: str
    speed: float
    altitude: float
    heading: float


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _shortest_turn_degrees(current: float, target: float) -> float:
    return (target - current + 540.0) % 360.0 - 180.0


def _meters_to_lat_lon(base_lat: float, north_m: float, east_m: float) -> tuple[float, float]:
    lat_delta = north_m / METERS_PER_DEGREE_LAT
    lon_scale = METERS_PER_DEGREE_LAT * max(0.2, math.cos(math.radians(base_lat)))
    lon_delta = east_m / lon_scale
    return lat_delta, lon_delta


def _lat_lon_to_meters(base_lat: float, base_lon: float, lat: float, lon: float) -> tuple[float, float]:
    north_m = (lat - base_lat) * METERS_PER_DEGREE_LAT
    lon_scale = METERS_PER_DEGREE_LAT * max(0.2, math.cos(math.radians(base_lat)))
    east_m = (lon - base_lon) * lon_scale
    return north_m, east_m


def _bearing_from_offsets(north_m: float, east_m: float) -> float:
    return (math.degrees(math.atan2(east_m, north_m)) + 360.0) % 360.0


def _sanitize_point(point: dict | None) -> dict | None:
    try:
        lat = float(point["lat"])
        lon = float(point["lon"])
    except (KeyError, TypeError, ValueError):
        return None

    if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 85.0 or abs(lon) > 180.0:
        return None

    return {"lat": lat, "lon": lon}


def _sanitize_points(points: Iterable[dict] | None) -> list[dict]:
    if not points:
        return []
    return [point for point in (_sanitize_point(item) for item in points) if point]


def _distance_meters(base_lat: float, base_lon: float, a: dict, b: dict) -> float:
    a_north, a_east = _lat_lon_to_meters(base_lat, base_lon, a["lat"], a["lon"])
    b_north, b_east = _lat_lon_to_meters(base_lat, base_lon, b["lat"], b["lon"])
    return math.hypot(b_north - a_north, b_east - a_east)


def _point_in_polygon(point: dict, polygon: list[dict]) -> bool:
    if len(polygon) < 3:
        return True

    inside = False
    x = point["lon"]
    y = point["lat"]
    j = len(polygon) - 1

    for i, current in enumerate(polygon):
        previous = polygon[j]
        yi = current["lat"]
        yj = previous["lat"]
        xi = current["lon"]
        xj = previous["lon"]

        if (yi > y) != (yj > y):
            intersect_x = ((xj - xi) * (y - yi)) / ((yj - yi) or 1e-12) + xi
            if x <= intersect_x:
                inside = not inside
        j = i

    return inside


def _polygon_centroid(points: list[dict]) -> dict | None:
    if not points:
        return None
    return {
        "lat": sum(point["lat"] for point in points) / len(points),
        "lon": sum(point["lon"] for point in points) / len(points),
    }


def _nearest_boundary_point(point: dict, polygon: list[dict]) -> dict:
    best = polygon[0]
    best_distance = float("inf")

    for index, start in enumerate(polygon):
        end = polygon[(index + 1) % len(polygon)]
        ax = start["lon"]
        ay = start["lat"]
        bx = end["lon"]
        by = end["lat"]
        dx = bx - ax
        dy = by - ay
        length_sq = dx * dx + dy * dy
        if length_sq == 0:
            candidate = start
        else:
            t = clamp(((point["lon"] - ax) * dx + (point["lat"] - ay) * dy) / length_sq, 0.0, 1.0)
            candidate = {"lat": ay + dy * t, "lon": ax + dx * t}

        distance = (candidate["lat"] - point["lat"]) ** 2 + (candidate["lon"] - point["lon"]) ** 2
        if distance < best_distance:
            best = candidate
            best_distance = distance

    return best


class SmoothRandomWalk:
    """Smooth simulated movement that can follow an active area-planner mission."""

    def __init__(
        self,
        base_lat: float,
        base_lon: float,
        radius_m: float = 700.0,
        initial_battery: float = 96.0,
    ) -> None:
        self.base_lat = base_lat
        self.base_lon = base_lon
        self.north_m = random.uniform(-60.0, 60.0)
        self.east_m = random.uniform(-60.0, 60.0)
        lat_delta, lon_delta = _meters_to_lat_lon(self.base_lat, self.north_m, self.east_m)
        self.lat = self.base_lat + lat_delta
        self.lon = self.base_lon + lon_delta
        self.heading = random.uniform(0.0, 360.0)
        self.target_heading = self.heading
        self.speed = random.uniform(5.0, 8.0)
        self.altitude = random.uniform(45.0, 70.0)
        self.battery = initial_battery
        self.radius_m = radius_m
        self._retarget_in_s = 0.0
        self.status = "searching"
        self.search_area: list[dict] = []
        self.search_route: list[dict] = []
        self.route_index = 0
        self.mission_complete = False

    def apply_mission_plan(self, plan: dict) -> bool:
        base = _sanitize_point(plan.get("base") if isinstance(plan, dict) else None)
        search_area = _sanitize_points(plan.get("searchArea") if isinstance(plan, dict) else None)
        sweep_path = _sanitize_points(plan.get("sweepPath") if isinstance(plan, dict) else None)

        if not base or len(search_area) < 3 or len(sweep_path) < 2:
            return False

        self.base_lat = base["lat"]
        self.base_lon = base["lon"]
        self.search_area = search_area
        self.search_route = sweep_path
        self.route_index = 0
        self.mission_complete = False
        if self.status not in {"charging", "offline"} and self.battery > 20.0:
            self.status = "searching"
        self._sync_offsets_from_position()
        return True

    def recall_to_base(self) -> None:
        if self.status not in {"charging", "offline"}:
            self.status = "returning"
            self.mission_complete = False

    def tick(self, dt_s: float) -> DroneState:
        if self.status == "offline":
            return self._state("offline")

        if self.status in {"charging", "idle"}:
            self.speed = 0.0
            self.altitude = 0.0
            self.lat = self.base_lat
            self.lon = self.base_lon
            self.battery = min(100.0, self.battery + 0.55 * dt_s)
            if self.status == "charging" and self.battery >= 99.0:
                self.battery = 100.0
                self.status = "idle" if self.mission_complete else "searching"
            self._sync_offsets_from_position()
            return self._state(self.status)

        self.battery = max(0.0, self.battery - (0.035 if self.status == "returning" else 0.018) * dt_s)
        if self.battery <= 0.0:
            self.status = "offline"
            self.speed = 0.0
            self.altitude = 0.0
            return self._state("offline")

        if self.battery < 20.0 and self.status == "searching":
            self.status = "returning"

        if self.status == "returning":
            self._fly_toward_base(dt_s)
        elif self.search_route:
            self._follow_route(dt_s)
        else:
            self._random_walk(dt_s)

        self._sync_offsets_from_position()
        return self._state(self.status)

    def can_emit_alert(self) -> bool:
        return self.status == "searching" and (
            not self.search_area or _point_in_polygon({"lat": self.lat, "lon": self.lon}, self.search_area)
        )

    def _random_walk(self, dt_s: float) -> None:
        self._update_target_heading(dt_s)

        turn = _shortest_turn_degrees(self.heading, self.target_heading)
        max_turn = 18.0 * dt_s
        self.heading = (self.heading + clamp(turn, -max_turn, max_turn)) % 360.0

        self.speed = clamp(self.speed + random.gauss(0.0, 0.35), 4.0, 11.5)
        self.altitude = clamp(self.altitude + random.gauss(0.0, 0.45), 35.0, 85.0)

        heading_rad = math.radians(self.heading)
        self.north_m += math.cos(heading_rad) * self.speed * dt_s
        self.east_m += math.sin(heading_rad) * self.speed * dt_s

        lat_delta, lon_delta = _meters_to_lat_lon(self.base_lat, self.north_m, self.east_m)
        self.lat = self.base_lat + lat_delta
        self.lon = self.base_lon + lon_delta
        self._enforce_search_area()

    def _follow_route(self, dt_s: float) -> None:
        target = self.search_route[min(self.route_index, len(self.search_route) - 1)]
        current = {"lat": self.lat, "lon": self.lon}
        distance_to_target = _distance_meters(self.base_lat, self.base_lon, current, target)

        if distance_to_target < WAYPOINT_RADIUS_M:
            if self.route_index >= len(self.search_route) - 1:
                self.mission_complete = True
                self.status = "returning"
                return
            self.route_index += 1
            target = self.search_route[self.route_index]

        self.speed = clamp(self.speed + random.gauss(0.0, 0.28), 5.5, 12.0)
        self.altitude = clamp(self.altitude + random.gauss(0.0, 0.35), 40.0, 85.0)
        self._move_toward(target, self.speed * dt_s)
        self._enforce_search_area()

    def _fly_toward_base(self, dt_s: float) -> None:
        base = {"lat": self.base_lat, "lon": self.base_lon}
        current = {"lat": self.lat, "lon": self.lon}
        distance_to_base = _distance_meters(self.base_lat, self.base_lon, current, base)

        if distance_to_base < BASE_ARRIVAL_RADIUS_M:
            self.lat = self.base_lat
            self.lon = self.base_lon
            self.speed = 0.0
            self.altitude = 0.0
            self.status = "charging"
            return

        self.speed = clamp(self.speed + random.gauss(0.0, 0.25), 7.0, 14.0)
        self.altitude = clamp(self.altitude - 0.4 * dt_s, 20.0, 85.0)
        self._move_toward(base, self.speed * dt_s)

    def _move_toward(self, target: dict, distance_m: float) -> None:
        current_north, current_east = _lat_lon_to_meters(self.base_lat, self.base_lon, self.lat, self.lon)
        target_north, target_east = _lat_lon_to_meters(self.base_lat, self.base_lon, target["lat"], target["lon"])
        d_north = target_north - current_north
        d_east = target_east - current_east
        distance = math.hypot(d_north, d_east)
        if distance <= 0.0:
            return

        amount = min(distance_m, distance)
        self.heading = _bearing_from_offsets(d_north, d_east)
        next_north = current_north + (d_north / distance) * amount
        next_east = current_east + (d_east / distance) * amount
        lat_delta, lon_delta = _meters_to_lat_lon(self.base_lat, next_north, next_east)
        self.lat = self.base_lat + lat_delta
        self.lon = self.base_lon + lon_delta

    def _enforce_search_area(self) -> None:
        if len(self.search_area) < 3:
            return

        current = {"lat": self.lat, "lon": self.lon}
        if _point_in_polygon(current, self.search_area):
            return

        nearest = _nearest_boundary_point(current, self.search_area)
        centroid = _polygon_centroid(self.search_area)
        if centroid:
            self.lat = nearest["lat"] + (centroid["lat"] - nearest["lat"]) * 0.015
            self.lon = nearest["lon"] + (centroid["lon"] - nearest["lon"]) * 0.015
        else:
            self.lat = nearest["lat"]
            self.lon = nearest["lon"]

        north_m, east_m = _lat_lon_to_meters(self.base_lat, self.base_lon, self.lat, self.lon)
        self.target_heading = self.heading = _bearing_from_offsets(-north_m, -east_m)

    def _sync_offsets_from_position(self) -> None:
        self.north_m, self.east_m = _lat_lon_to_meters(self.base_lat, self.base_lon, self.lat, self.lon)

    def _state(self, status: str) -> DroneState:
        return DroneState(
            lat=self.lat,
            lon=self.lon,
            battery=self.battery,
            status=status,
            speed=self.speed,
            altitude=self.altitude,
            heading=self.heading,
        )

    def _update_target_heading(self, dt_s: float) -> None:
        self._retarget_in_s -= dt_s
        distance_from_base = math.hypot(self.north_m, self.east_m)

        if distance_from_base > self.radius_m:
            self.target_heading = _bearing_from_offsets(-self.north_m, -self.east_m)
            self._retarget_in_s = 2.0
            return

        if self._retarget_in_s <= 0.0:
            self.target_heading = (self.target_heading + random.uniform(-45.0, 45.0)) % 360.0
            self._retarget_in_s = random.uniform(4.0, 9.0)
