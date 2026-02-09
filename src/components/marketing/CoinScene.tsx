'use client';

import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';

function Coin() {
  const meshRef = useRef<Mesh>(null);

  useFrame((_state, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.5;
    }
  });

  return (
    <group ref={meshRef}>
      {/* Main coin body */}
      <mesh castShadow>
        <cylinderGeometry args={[2, 2, 0.3, 64]} />
        <meshStandardMaterial
          color="#f0b90b"
          metalness={0.8}
          roughness={0.2}
        />
      </mesh>
      {/* Front face rim */}
      <mesh position={[0, 0.151, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.2, 0.08, 16, 64]} />
        <meshStandardMaterial
          color="#d4a00a"
          metalness={0.9}
          roughness={0.15}
        />
      </mesh>
      {/* Front face lightning bolt (Zap icon) */}
      <mesh position={[0, 0.16, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 0.02, 6]} />
        <meshStandardMaterial
          color="#1e2329"
          metalness={0.5}
          roughness={0.4}
        />
      </mesh>
      {/* Back face rim */}
      <mesh position={[0, -0.151, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.2, 0.08, 16, 64]} />
        <meshStandardMaterial
          color="#d4a00a"
          metalness={0.9}
          roughness={0.15}
        />
      </mesh>
    </group>
  );
}

export default function CoinScene() {
  return (
    <Canvas
      camera={{ position: [0, 1, 5], fov: 45 }}
      style={{ width: '100%', height: '100%' }}
    >
      <ambientLight intensity={0.5} />
      <spotLight
        position={[5, 5, 5]}
        angle={0.3}
        penumbra={0.5}
        intensity={1.5}
        castShadow
      />
      <spotLight
        position={[-5, 3, -5]}
        angle={0.3}
        penumbra={0.5}
        intensity={0.8}
      />
      <pointLight position={[0, 5, 0]} intensity={0.6} />
      <pointLight position={[0, -5, 0]} intensity={0.3} />
      <Coin />
    </Canvas>
  );
}
