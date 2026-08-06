import React, { useMemo } from "react";
import { Line } from "@react-three/drei";
import * as THREE from "three";

export default function VisionCone({ yaw, range, fovDeg, active }) {
  const halfAngle = (fovDeg * Math.PI) / 360;
  const color = active ? "#ff3d3d" : "#00e5ff";
  const opacity = active ? 0.25 : 0.12;

  const { wedgeGeometry, left, right, arc } = useMemo(() => {
    const width = Math.tan(halfAngle) * range;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([
        0, -0.28, 0,
        -width, -2.2, range,
        width, -2.2, range,
      ], 3),
    );
    geometry.computeVertexNormals();

    const arcPoints = [];
    for (let i = 0; i <= 28; i += 1) {
      const t = -halfAngle + (i / 28) * halfAngle * 2;
      arcPoints.push([Math.sin(t) * range, -2.2, Math.cos(t) * range]);
    }

    return {
      wedgeGeometry: geometry,
      left: [-width, -2.2, range],
      right: [width, -2.2, range],
      arc: arcPoints,
    };
  }, [halfAngle, range]);

  return (
    <group rotation={[0, yaw, 0]}>
      <mesh geometry={wedgeGeometry}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <Line points={[[0, -0.28, 0], left]} color={color} transparent opacity={active ? 0.82 : 0.42} lineWidth={1} />
      <Line points={[[0, -0.28, 0], right]} color={color} transparent opacity={active ? 0.82 : 0.42} lineWidth={1} />
      <Line points={arc} color={color} transparent opacity={active ? 0.72 : 0.34} lineWidth={1} />
      <Line
        points={[[0, -0.2, 0], [0, -1.8, range * 0.92]]}
        color={active ? "#ffb300" : "#8ff5ff"}
        transparent
        opacity={active ? 0.95 : 0.38}
        lineWidth={1.5}
      />
    </group>
  );
}
