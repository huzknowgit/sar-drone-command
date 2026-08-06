import React from "react";
import { Line } from "@react-three/drei";
import { useSimulationStore } from "../useSimulationStore";

export default function DetectionRayLayer() {
  const contacts = useSimulationStore((state) => state.detectionContacts);

  return (
    <group>
      {contacts.map((contact) => (
        <Line
          key={`${contact.droneId}-${contact.targetId}`}
          points={[
            [contact.from.x, contact.from.y, contact.from.z],
            [contact.to.x, contact.to.y, contact.to.z],
          ]}
          color="#ff3d3d"
          transparent
          opacity={0.74}
          lineWidth={1.35}
        />
      ))}
    </group>
  );
}
