import React, { useMemo } from "react";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { latLonToWorld } from "../geo";
import { useSimulationStore } from "../useSimulationStore";

function makeClosedLine(points) {
  if (points.length < 3) return [];
  return [...points, points[0]].map((point) => [point.x, 0.13, point.z]);
}

function MissionFill({ points }) {
  const geometry = useMemo(() => {
    if (points.length < 3) return null;

    const shape = new THREE.Shape(points.map((point) => new THREE.Vector2(point.x, point.z)));
    return new THREE.ShapeGeometry(shape);
  }, [points]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.08, 0]}>
      <meshBasicMaterial
        color="#00e5ff"
        transparent
        opacity={0.055}
        depthWrite={false}
        side={THREE.DoubleSide}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

export default function MissionPlanLayer() {
  const missionPlan = useSimulationStore((state) => state.missionPlan);
  const projection = useSimulationStore((state) => state.missionProjection);
  const base = useSimulationStore((state) => state.base);

  const { areaPoints, sweepPoints, basePoint } = useMemo(() => {
    const area = (missionPlan?.searchArea || [])
      .map((point) => latLonToWorld(point, base, projection))
      .filter(Boolean);
    const sweep = (missionPlan?.sweepPath || [])
      .map((point) => latLonToWorld(point, base, projection))
      .filter(Boolean);
    const launch = latLonToWorld(missionPlan?.base || base, base, projection);

    return { areaPoints: area, sweepPoints: sweep, basePoint: launch };
  }, [base, missionPlan, projection]);

  if (!missionPlan || areaPoints.length < 3) return null;

  return (
    <group>
      <MissionFill points={areaPoints} />
      <Line points={makeClosedLine(areaPoints)} color="#00e5ff" transparent opacity={0.78} lineWidth={1.35} />

      {sweepPoints.length >= 2 && (
        <Line
          points={sweepPoints.map((point) => [point.x, 0.28, point.z])}
          color="#ffb300"
          transparent
          opacity={0.76}
          lineWidth={1.15}
        />
      )}

      {sweepPoints.map((point, index) => (
        <mesh key={`${point.x}-${point.z}-${index}`} position={[point.x, 0.22, point.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.28, 16]} />
          <meshBasicMaterial color={index % 2 === 0 ? "#00e5ff" : "#ffb300"} transparent opacity={0.72} />
        </mesh>
      ))}

      {basePoint && (
        <mesh position={[basePoint.x, 0.32, basePoint.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.2, 2.55, 48]} />
          <meshBasicMaterial color="#00e676" transparent opacity={0.86} blending={THREE.AdditiveBlending} />
        </mesh>
      )}
    </group>
  );
}
