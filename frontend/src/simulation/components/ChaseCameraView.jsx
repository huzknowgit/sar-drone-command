import React, { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Sky } from "@react-three/drei";
import * as THREE from "three";
import ForestEnvironment from "./ForestEnvironment";
import { useSimulationStore } from "../useSimulationStore";
import "./ChaseCameraView.css";

const CHASE_BACK = 7.5;
const CHASE_UP = 2.6;

/**
 * Follows the aircraft from behind and slightly above.
 *
 * Camera placement is derived from the velocity vector rather than the stored
 * heading, so it stays correct regardless of the yaw convention used elsewhere,
 * and falls back to a fixed bearing while the drone is stationary.
 */
function ChaseRig() {
  const desired = useRef(new THREE.Vector3(0, 12, 20));
  const focus = useRef(new THREE.Vector3());

  useFrame(({ camera }, delta) => {
    const drone = useSimulationStore.getState().drones[0];
    if (!drone) return;

    const { position: p, velocity: v } = drone;
    const speed = Math.hypot(v.x, v.z);
    const dx = speed > 0.02 ? v.x / speed : 0;
    const dz = speed > 0.02 ? v.z / speed : 1;

    desired.current.set(p.x - dx * CHASE_BACK, p.y + CHASE_UP, p.z - dz * CHASE_BACK);
    focus.current.lerp(new THREE.Vector3(p.x + dx * 3, p.y - 0.4, p.z + dz * 3), 1 - Math.pow(0.002, delta));

    // Frame-rate independent smoothing, so the follow feels the same whether
    // the tab is running at 60 fps or struggling.
    camera.position.lerp(desired.current, 1 - Math.pow(0.0015, delta));
    camera.lookAt(focus.current);
  });

  return null;
}

/** Minimal airframe. DroneEntity is not reused here — it renders Html labels, which would leak DOM into this canvas. */
function Aircraft() {
  const group = useRef();
  const rotors = useRef([]);

  useFrame((_state, delta) => {
    const drone = useSimulationStore.getState().drones[0];
    if (!drone || !group.current) return;

    group.current.position.set(drone.position.x, drone.position.y, drone.position.z);
    const speed = Math.hypot(drone.velocity.x, drone.velocity.z);
    if (speed > 0.02) {
      group.current.rotation.y = Math.atan2(drone.velocity.x, drone.velocity.z);
      group.current.rotation.x = -0.09; // slight nose-down in forward flight
    }
    for (const rotor of rotors.current) {
      if (rotor) rotor.rotation.y += delta * 42;
    }
  });

  const arms = [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]];

  return (
    <group ref={group}>
      <mesh castShadow>
        <boxGeometry args={[0.75, 0.2, 1.1]} />
        <meshStandardMaterial color="#14202c" roughness={0.55} metalness={0.35} />
      </mesh>
      {arms.map(([x, z], index) => (
        <group key={`${x}-${z}`} position={[x, 0.06, z]}>
          <mesh>
            <cylinderGeometry args={[0.05, 0.05, 0.16, 6]} />
            <meshStandardMaterial color="#0d161f" roughness={0.7} />
          </mesh>
          <mesh ref={(el) => { rotors.current[index] = el; }} position={[0, 0.12, 0]}>
            <cylinderGeometry args={[0.44, 0.44, 0.012, 16]} />
            <meshStandardMaterial color="#8fd8ea" transparent opacity={0.26} />
          </mesh>
        </group>
      ))}
      {/* Nadir sensor pod — the camera whose imagery the detector actually reads. */}
      <mesh position={[0, -0.17, 0.12]}>
        <sphereGeometry args={[0.13, 12, 12]} />
        <meshStandardMaterial color="#05070a" roughness={0.3} metalness={0.6} />
      </mesh>
    </group>
  );
}

/**
 * Rendered chase view of the aircraft over the search area.
 *
 * This is a 3D render for operator situational awareness — it is NOT what the
 * detector sees. The model reads the real aerial photography shown in the
 * nadir feed; a game-engine render is far outside its training distribution and
 * is never fed to it. The on-screen label says so explicitly.
 */
export default function ChaseCameraView() {
  const detectionMode = useSimulationStore((state) => state.detectionMode);
  const drone = useSimulationStore((state) => state.drones[0]);

  return (
    <div className="chase-view">
      <Canvas
        style={{ width: "100%", height: "100%", display: "block" }}
        dpr={[1, 1.4]}
        camera={{ position: [0, 12, 20], fov: 58, near: 0.1, far: 520 }}
        gl={{ antialias: true, powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping }}
      >
        <Sky sunPosition={[64, 14, -48]} turbidity={7} rayleigh={2.4} mieCoefficient={0.006} />
        <fog attach="fog" args={["#93a9b0", 90, 300]} />
        <ambientLight intensity={0.55} />
        <hemisphereLight args={["#bcd6e4", "#1d2a16", 0.7]} />
        <directionalLight position={[64, 38, -48]} intensity={1.4} color="#ffe6c2" />

        <Suspense fallback={null}>
          <ForestEnvironment />
        </Suspense>
        <Aircraft />
        <ChaseRig />
      </Canvas>

      <div className="chase-hud">
        <span className="chase-tag">CHASE CAM — RENDERED VIEW</span>
        <span className="chase-note">not detector input</span>
      </div>

      <div className="chase-telemetry">
        {drone && (
          <>
            <span>{drone.drone_id.toUpperCase()}</span>
            <span>{drone.speedMeters.toFixed(1)} m/s</span>
            <span>{String(drone.status || "").toUpperCase()}</span>
            <span className={detectionMode === "real_ai" ? "live" : "dim"}>
              {detectionMode === "real_ai" ? "AI LIVE" : "AI OFFLINE"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
