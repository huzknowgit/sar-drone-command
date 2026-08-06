import React, { useLayoutEffect, useMemo, useRef } from "react";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import {
  FOREST_RING_INNER_MARGIN,
  FOREST_RING_TREES,
  WORLD_LIMIT,
} from "../simulationConfig";
import { useSimulationStore } from "../useSimulationStore";

/**
 * Deterministic RNG — the forest must lay out identically on every reload so a
 * demo looks the same each time it is run.
 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * The searched ground: one colour-matched mosaic of real aerial wilderness
 * frames (datasets/build_terrain_mosaic.py). Deliberately unlit — it is
 * photography that already contains its own sun, shadows and canopy, so
 * shading it again would double the lighting.
 */
function PhotoTerrain({ span }) {
  const texture = useTexture("/terrain/heridal_mosaic.jpg");

  useLayoutEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }, [texture]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
      <planeGeometry args={[span, span, 1, 1]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/**
 * Forest ring framing the search area. Trees are placed strictly *outside* the
 * photographed ground: the imagery is already a top-down view of a canopy, and
 * standing geometry on top of it would render the same trees twice.
 */
function ForestRing({ innerRadius }) {
  const trunkRef = useRef();
  const canopyRef = useRef();

  const instances = useMemo(() => {
    const random = makeRandom(20260731);
    const outerRadius = WORLD_LIMIT * 1.28;
    const placements = [];

    for (let i = 0; i < FOREST_RING_TREES; i += 1) {
      const angle = random() * Math.PI * 2;
      // sqrt keeps density even across the annulus instead of bunching inward
      const t = Math.sqrt(random());
      const radius = innerRadius + t * (outerRadius - innerRadius);
      const height = 5.5 + random() * 7.5;

      placements.push({
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        height,
        spread: 1.5 + random() * 1.5,
        lean: (random() - 0.5) * 0.12,
        tint: 0.72 + random() * 0.28,
      });
    }
    return placements;
  }, [innerRadius]);

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    instances.forEach((tree, index) => {
      dummy.position.set(tree.x, tree.height * 0.22, tree.z);
      dummy.rotation.set(tree.lean, 0, tree.lean * 0.6);
      dummy.scale.set(0.34, tree.height * 0.45, 0.34);
      dummy.updateMatrix();
      trunkRef.current.setMatrixAt(index, dummy.matrix);

      dummy.position.set(tree.x, tree.height * 0.62, tree.z);
      dummy.rotation.set(tree.lean, index, tree.lean * 0.6);
      dummy.scale.set(tree.spread, tree.height * 0.78, tree.spread);
      dummy.updateMatrix();
      canopyRef.current.setMatrixAt(index, dummy.matrix);

      color.setRGB(0.06 * tree.tint, 0.15 * tree.tint, 0.09 * tree.tint);
      canopyRef.current.setColorAt(index, color);
    });

    trunkRef.current.instanceMatrix.needsUpdate = true;
    canopyRef.current.instanceMatrix.needsUpdate = true;
    if (canopyRef.current.instanceColor) canopyRef.current.instanceColor.needsUpdate = true;
  }, [instances]);

  return (
    <group>
      <instancedMesh ref={trunkRef} args={[null, null, instances.length]} castShadow>
        <cylinderGeometry args={[0.55, 0.9, 2, 5]} />
        <meshStandardMaterial color="#241d16" roughness={0.95} />
      </instancedMesh>
      <instancedMesh ref={canopyRef} args={[null, null, instances.length]} castShadow>
        <coneGeometry args={[1, 1, 7]} />
        <meshStandardMaterial roughness={0.92} flatShading />
      </instancedMesh>
    </group>
  );
}

/** Ground beyond the photography, so the world doesn't end at the mosaic edge. */
function SurroundingGround() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, 0]} receiveShadow>
      <circleGeometry args={[WORLD_LIMIT * 1.6, 64]} />
      <meshStandardMaterial color="#14200f" roughness={1} />
    </mesh>
  );
}

/** Low-lying mist stacked in soft layers — sells depth and softens the mosaic edge. */
function MistLayers({ innerRadius }) {
  return (
    <group>
      {[2.6, 5.4, 9.2].map((height, index) => (
        <mesh key={height} rotation={[-Math.PI / 2, 0, 0]} position={[0, height, 0]}>
          <ringGeometry args={[innerRadius * 0.82, WORLD_LIMIT * 1.5, 64]} />
          <meshBasicMaterial
            color="#9fb8c4"
            transparent
            opacity={0.055 - index * 0.012}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

export default function ForestEnvironment() {
  const terrain = useSimulationStore((state) => state.terrain);
  const span = terrain?.spanUnits || 60;
  const innerRadius = (span * Math.SQRT2) / 2 + FOREST_RING_INNER_MARGIN;

  return (
    <group>
      <SurroundingGround />
      <PhotoTerrain span={span} />
      <ForestRing innerRadius={innerRadius} />
      <MistLayers innerRadius={innerRadius} />

      {/* Search-area boundary — the only tactical graphic drawn over the imagery. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
        <ringGeometry args={[span / 2 - 0.16, span / 2, 4, 1, Math.PI / 4]} />
        <meshBasicMaterial color="#7fe3a0" transparent opacity={0.34} />
      </mesh>
    </group>
  );
}
