import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useSimulationStore } from "../useSimulationStore";

/**
 * Ground marker for a person the detector has found.
 *
 * Deliberately not a human figure: the people here are real, photographed in
 * the terrain imagery, so a 3D body standing on top would render the same person
 * twice — the same reason the forest ring stops at the edge of the photography.
 * A pulsing ring marks the position without pretending to be the person.
 */
function ContactMarker({ position, confidence, ignored }) {
  const ring = useRef();
  const inner = useRef();

  // A waved-off contact stays on the map, dimmed and still: it was a real find
  // and the operator should be able to see everything the sortie turned up,
  // but it must not keep pulsing for attention it has already been given.
  const color = ignored ? "#5c7a99" : "#ff3d3d";

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pulse = ignored ? 1 : 1 + Math.sin(t * 3.2) * 0.16;
    if (ring.current) {
      ring.current.scale.setScalar(pulse);
      ring.current.material.opacity = ignored ? 0.32 : 0.55 + Math.sin(t * 3.2) * 0.2;
    }
    if (inner.current) inner.current.rotation.z = ignored ? 0 : t * 0.7;
  });

  return (
    <group position={[position.x, 0.12, position.z]}>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.5, 1.85, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.7} depthWrite={false} />
      </mesh>
      <mesh ref={inner} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.75, 0.92, 4]} />
        <meshBasicMaterial color={ignored ? "#5c7a99" : "#ffb300"} transparent opacity={0.85} depthWrite={false} />
      </mesh>
      {/* Vertical beam so a contact is findable from the wide tactical camera. */}
      <mesh position={[0, 5, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 10, 6]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={(ignored ? 0.06 : 0.16) + confidence * (ignored ? 0.06 : 0.22)}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

/**
 * Every marker on the ground is a place the model put a box on a person.
 *
 * There is nothing else to draw: people the detector has not found are not
 * marked, because the operator should see what the search actually produced
 * rather than a God-view of where everyone is hiding.
 */
export default function ContactLayer() {
  const contacts = useSimulationStore((state) => state.contacts);

  return (
    <group>
      {contacts.map((contact) => (
        <ContactMarker
          key={contact.id}
          position={contact.position}
          confidence={contact.confidence || 0}
          ignored={contact.ignored}
        />
      ))}
    </group>
  );
}
