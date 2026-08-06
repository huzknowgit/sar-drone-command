export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

export function distance2D(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function angleToTarget(from, to) {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export function normalizeAngle(angle) {
  let next = angle;
  while (next > Math.PI) next -= Math.PI * 2;
  while (next < -Math.PI) next += Math.PI * 2;
  return next;
}

export function lerpAngle(current, target, t) {
  return current + normalizeAngle(target - current) * clamp(t, 0, 1);
}

export function moveToward(current, target, maxStep) {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const dz = target.z - current.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (distance <= maxStep || distance < 0.0001) {
    return { ...target };
  }

  const scale = maxStep / distance;
  return {
    x: current.x + dx * scale,
    y: current.y + dy * scale,
    z: current.z + dz * scale,
  };
}
