import React, { useEffect, useMemo, useRef } from "react";
import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useSimulationStore } from "../useSimulationStore";

export default function CameraController() {
  const controlsRef = useRef(null);
  const { camera } = useThree();
  const cameraMode = useSimulationStore((state) => state.cameraMode);
  const selectedDroneId = useSimulationStore((state) => state.selectedDroneId);
  const targetVector = useMemo(() => new THREE.Vector3(), []);
  const desiredVector = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    if (cameraMode !== "overview") return;
    camera.position.set(52, 42, 52);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();
  }, [camera, cameraMode]);

  useFrame(() => {
    if (cameraMode !== "follow" && cameraMode !== "alert") return;

    const state = useSimulationStore.getState();
    const selectedDrone = state.drones.find((drone) => drone.drone_id === selectedDroneId) || state.drones[0];
    if (!selectedDrone) return;

    let lookAt = selectedDrone.position;
    let desired = {
      x: selectedDrone.position.x - Math.sin(selectedDrone.heading) * 13,
      y: selectedDrone.position.y + 6.5,
      z: selectedDrone.position.z - Math.cos(selectedDrone.heading) * 13,
    };

    if (cameraMode === "alert" && state.detectionContacts.length) {
      const contact = state.detectionContacts[0];
      lookAt = contact.to;
      desired = {
        x: (contact.from.x + contact.to.x) / 2 + 10,
        y: Math.max(contact.from.y, contact.to.y) + 10,
        z: (contact.from.z + contact.to.z) / 2 + 10,
      };
    }

    desiredVector.set(desired.x, desired.y, desired.z);
    targetVector.set(lookAt.x, lookAt.y + 1.2, lookAt.z);
    camera.position.lerp(desiredVector, 0.055);
    controlsRef.current?.target.lerp(targetVector, 0.08);
    controlsRef.current?.update();
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={cameraMode === "overview"}
      enableDamping
      dampingFactor={0.08}
      maxPolarAngle={Math.PI * 0.48}
      minDistance={18}
      maxDistance={118}
    />
  );
}
