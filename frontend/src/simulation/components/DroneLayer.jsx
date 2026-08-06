import React from "react";
import DroneEntity from "./DroneEntity";
import { useSimulationStore } from "../useSimulationStore";

export default function DroneLayer({ onSelectDrone }) {
  const drones = useSimulationStore((state) => state.drones);
  const selectedDroneId = useSimulationStore((state) => state.selectedDroneId);
  const setSelectedDroneId = useSimulationStore((state) => state.setSelectedDroneId);

  const handleSelect = (droneId) => {
    setSelectedDroneId(droneId);
    onSelectDrone?.(droneId);
  };

  return (
    <group>
      {drones.map((drone) => (
        <DroneEntity
          key={drone.drone_id}
          drone={drone}
          selected={drone.drone_id === selectedDroneId}
          onSelect={handleSelect}
        />
      ))}
    </group>
  );
}
