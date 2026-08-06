import React, { useRef } from "react";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import VisionCone from "./VisionCone";
import { headingRadToDegrees, worldUnitsToMeters } from "../geo";
import { DRONE_WIDTH_METERS } from "../simulationConfig";
import { useSimulationStore } from "../useSimulationStore";

function Rotor({ position, spinOffset = 0 }) {
  const bladeRef = useRef(null);

  useFrame((_, dt) => {
    if (bladeRef.current) bladeRef.current.rotation.y += dt * (22 + spinOffset);
  });

  return (
    <group position={position}>
      <mesh castShadow>
        <cylinderGeometry args={[0.28, 0.28, 0.16, 18]} />
        <meshStandardMaterial color="#12253a" emissive="#00e5ff" emissiveIntensity={0.18} roughness={0.48} />
      </mesh>
      <group ref={bladeRef} position={[0, 0.12, 0]}>
        <mesh>
          <boxGeometry args={[1.55, 0.035, 0.16]} />
          <meshBasicMaterial color="#9ff8ff" transparent opacity={0.34} blending={THREE.AdditiveBlending} />
        </mesh>
        <mesh rotation={[0, Math.PI / 2, 0]}>
          <boxGeometry args={[1.55, 0.035, 0.16]} />
          <meshBasicMaterial color="#9ff8ff" transparent opacity={0.24} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>
    </group>
  );
}

function DroneBody({ active }) {
  const glowColor = active ? "#ff3d3d" : "#00e5ff";

  return (
    <group>
      <mesh castShadow>
        <boxGeometry args={[1.75, 0.38, 1.15]} />
        <meshStandardMaterial
          color="#102237"
          emissive={active ? "#3a0707" : "#05283a"}
          emissiveIntensity={0.7}
          metalness={0.22}
          roughness={0.38}
        />
      </mesh>
      <mesh castShadow position={[0, 0.16, 0.42]}>
        <sphereGeometry args={[0.34, 20, 14]} />
        <meshStandardMaterial color="#07111d" emissive={glowColor} emissiveIntensity={0.65} roughness={0.28} />
      </mesh>
      <mesh position={[0, -0.08, 0.86]}>
        <boxGeometry args={[0.42, 0.16, 0.34]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.72} blending={THREE.AdditiveBlending} />
      </mesh>
      <group position={[0, -0.34, 0.38]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.24, 0.3, 0.32, 18]} />
          <meshStandardMaterial color="#050a10" emissive={glowColor} emissiveIntensity={0.38} roughness={0.34} />
        </mesh>
        <mesh position={[0, -0.02, 0.18]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.13, 0.13, 0.12, 18]} />
          <meshBasicMaterial color={glowColor} transparent opacity={0.82} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[4.25, 0.12, 0.12]} />
        <meshStandardMaterial color="#152a3f" emissive="#06293a" emissiveIntensity={0.25} />
      </mesh>
      <mesh position={[0, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <boxGeometry args={[3.25, 0.12, 0.12]} />
        <meshStandardMaterial color="#152a3f" emissive="#06293a" emissiveIntensity={0.25} />
      </mesh>
      <Rotor position={[-2.08, 0.02, -1.55]} spinOffset={0} />
      <Rotor position={[2.08, 0.02, -1.55]} spinOffset={2} />
      <Rotor position={[-2.08, 0.02, 1.55]} spinOffset={1} />
      <Rotor position={[2.08, 0.02, 1.55]} spinOffset={3} />
    </group>
  );
}

export default function DroneEntity({ drone, selected, onSelect }) {
  const projection = useSimulationStore((state) => state.missionProjection);
  const active = drone.status === "tracking";
  const color = active ? "#ff3d3d" : selected ? "#ffb300" : "#00e5ff";
  const heading = headingRadToDegrees(drone.heading);
  const metersPerUnit = worldUnitsToMeters(1, projection);
  const physicalScale = (DRONE_WIDTH_METERS / metersPerUnit) / 4.25;
  const visibleBodyScale = Math.max(physicalScale, 0.08);

  return (
    <group
      position={[drone.position.x, drone.position.y, drone.position.z]}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(drone.drone_id);
      }}
    >
      <VisionCone yaw={drone.cameraYaw} range={drone.cameraRange} fovDeg={drone.cameraFovDeg} active={active} />

      <group rotation={[0, drone.heading, 0]} scale={visibleBodyScale}>
        <DroneBody active={active} />
      </group>

      <mesh>
        <sphereGeometry args={[active ? 2.1 : 1.45, 28, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={active ? 0.16 : 0.08}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {(active || selected) && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.25, 0.025, 8, 80]} />
          <meshBasicMaterial color={color} transparent opacity={0.86} blending={THREE.AdditiveBlending} />
        </mesh>
      )}

      <Html position={[0, 1.45, 0]} center distanceFactor={18} className="sim-world-label">
        <div className={`sim-drone-label ${active ? "tracking" : ""} ${selected ? "selected" : ""}`}>
          <span>{drone.drone_id}</span>
          <span>{active ? `LOCK ${Math.round(drone.confidence * 100)}%` : `${Math.round(heading)} HDG`}</span>
        </div>
      </Html>
    </group>
  );
}
