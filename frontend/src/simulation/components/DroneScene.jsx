import React, { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { Preload, Sky } from "@react-three/drei";
import * as THREE from "three";
import ForestEnvironment from "./ForestEnvironment";
import DroneLayer from "./DroneLayer";
import ContactLayer from "./ContactLayer";
import DetectionRayLayer from "./DetectionRayLayer";
import CameraController from "./CameraController";
import MissionPlanLayer from "./MissionPlanLayer";

export default function DroneScene({ onSelectDrone }) {
  return (
    <Canvas
      style={{ width: "100%", height: "100%", display: "block" }}
      shadows
      dpr={[1, 1.65]}
      camera={{ position: [58, 46, 58], fov: 48, near: 0.1, far: 520 }}
      gl={{ antialias: true, powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping }}
      onCreated={({ camera }) => {
        camera.lookAt(0, 0, 0);
      }}
    >
      {/* Low sun: long shadows off the forest ring and a warm horizon, which is
          what makes an overhead scene read as a real time of day. */}
      <Sky sunPosition={[64, 14, -48]} turbidity={7} rayleigh={2.4} mieCoefficient={0.006} />
      <fog attach="fog" args={["#93a9b0", 130, 340]} />

      <ambientLight intensity={0.5} />
      <hemisphereLight args={["#bcd6e4", "#1d2a16", 0.7]} />
      <directionalLight
        castShadow
        position={[64, 38, -48]}
        intensity={1.5}
        color="#ffe6c2"
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-110}
        shadow-camera-right={110}
        shadow-camera-top={110}
        shadow-camera-bottom={-110}
        shadow-camera-far={320}
      />

      <Suspense fallback={null}>
        <ForestEnvironment />
      </Suspense>

      <MissionPlanLayer />
      <ContactLayer />
      <DroneLayer onSelectDrone={onSelectDrone} />
      <DetectionRayLayer />
      <CameraController />
      <Preload all />
    </Canvas>
  );
}
