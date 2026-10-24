'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useChartTheme } from '@/lib/chart-theme';

const POINT_COUNT = 200;
const GLOBE_RADIUS = 2;
const CONNECTION_DISTANCE = 0.8;
const MAX_FLASHES = 24;
const FLASH_DURATION_MS = 900;
const DOT_STRIDE = 73;

export interface GlobeTick {
  id: number;
  dir: 1 | -1;
}

export interface GlobeSceneProps {
  ticks?: GlobeTick[];
  reducedMotion?: boolean;
}

interface ActiveFlash {
  id: number;
  dotIndex: number;
  dir: 1 | -1;
  startTime: number;
}

function fibonacciSphere(count: number, radius: number): Float32Array {
  const positions = new Float32Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radiusAtY = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;

    positions[i * 3] = Math.cos(theta) * radiusAtY * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = Math.sin(theta) * radiusAtY * radius;
  }
  return positions;
}

const FLASH_VERTEX_SHADER = `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uScale;

  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (uScale / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FLASH_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float edge = 1.0 - smoothstep(0.4, 0.5, dist);
    gl_FragColor = vec4(vColor, vAlpha * edge);
  }
`;

function GlobeDots({
  ticks = [],
  reducedMotion = false,
}: {
  ticks: GlobeTick[];
  reducedMotion: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const flashGeometryRef = useRef<THREE.BufferGeometry>(null);
  const flashMaterialRef = useRef<THREE.ShaderMaterial>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const targetRotation = useRef({ x: 0, y: 0 });
  const { size, camera } = useThree();
  const theme = useChartTheme();

  const positions = useMemo(() => fibonacciSphere(POINT_COUNT, GLOBE_RADIUS), []);

  const linePositions = useMemo(() => {
    const lines: number[] = [];
    for (let i = 0; i < POINT_COUNT; i++) {
      for (let j = i + 1; j < POINT_COUNT; j++) {
        const dx = positions[i * 3] - positions[j * 3];
        const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
        const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < CONNECTION_DISTANCE) {
          lines.push(
            positions[i * 3],
            positions[i * 3 + 1],
            positions[i * 3 + 2],
            positions[j * 3],
            positions[j * 3 + 1],
            positions[j * 3 + 2]
          );
        }
      }
    }
    return new Float32Array(lines);
  }, [positions]);

  const flashPosArray = useMemo(() => new Float32Array(MAX_FLASHES * 3), []);
  const flashColArray = useMemo(() => new Float32Array(MAX_FLASHES * 3), []);
  const flashSizeArray = useMemo(() => new Float32Array(MAX_FLASHES), []);
  const flashAlphaArray = useMemo(() => new Float32Array(MAX_FLASHES), []);

  const shaderUniforms = useMemo(
    () => ({
      uScale: { value: 300.0 },
    }),
    []
  );

  const flashesRef = useRef<ActiveFlash[]>([]);
  const seenTickIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (reducedMotion || !ticks || ticks.length === 0) return;
    const now = performance.now();
    let hasNew = false;

    for (const tick of ticks) {
      if (!seenTickIdsRef.current.has(tick.id)) {
        seenTickIdsRef.current.add(tick.id);
        // Fibonacci points are ordered pole to pole, so consecutive ids would
        // all land near the top. A stride coprime to POINT_COUNT spreads them.
        const dotIndex = (Math.abs(tick.id) * DOT_STRIDE) % POINT_COUNT;
        flashesRef.current.push({
          id: tick.id,
          dotIndex,
          dir: tick.dir,
          startTime: now,
        });
        hasNew = true;
      }
    }

    if (hasNew && flashesRef.current.length > MAX_FLASHES) {
      flashesRef.current = flashesRef.current.slice(-MAX_FLASHES);
    }

    if (seenTickIdsRef.current.size > 200) {
      seenTickIdsRef.current = new Set(ticks.map((t) => t.id));
    }
  }, [ticks, reducedMotion]);

  useFrame((_state, delta) => {
    if (reducedMotion) return;

    if (groupRef.current) {
      // Auto-rotation of 0.15 rad/s
      groupRef.current.rotation.y += delta * 0.15;

      // Mouse reactivity (subtle tilt)
      targetRotation.current.x = (mouseRef.current.y / size.height - 0.5) * 0.3;
      targetRotation.current.y += (mouseRef.current.x / size.width - 0.5) * 0.001;
      groupRef.current.rotation.x +=
        (targetRotation.current.x - groupRef.current.rotation.x) * 0.05;
    }

    const mat = flashMaterialRef.current;
    const geo = flashGeometryRef.current;
    if (!mat || !geo) return;

    const now = performance.now();
    flashesRef.current = flashesRef.current.filter(
      (f) => now - f.startTime < FLASH_DURATION_MS
    );
    const count = flashesRef.current.length;

    const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
    const scale = (size.height * 0.5) / Math.tan(THREE.MathUtils.degToRad(fov * 0.5));
    mat.uniforms.uScale.value = scale;

    if (count > 0) {
      const posAttr = geo.attributes.position as THREE.BufferAttribute;
      const colAttr = geo.attributes.aColor as THREE.BufferAttribute;
      const sizeAttr = geo.attributes.aSize as THREE.BufferAttribute;
      const alphaAttr = geo.attributes.aAlpha as THREE.BufferAttribute;

      const upColor = new THREE.Color(theme.up);
      const downColor = new THREE.Color(theme.down);

      for (let i = 0; i < count; i++) {
        const flash = flashesRef.current[i];
        const elapsed = now - flash.startTime;
        const progress = Math.min(Math.max(elapsed / FLASH_DURATION_MS, 0), 1);
        const currentSize = 0.08 + (0.16 - 0.08) * progress;
        const currentAlpha = 1.0 - progress;

        const pIdx = flash.dotIndex * 3;
        posAttr.setXYZ(i, positions[pIdx], positions[pIdx + 1], positions[pIdx + 2]);

        const color = flash.dir === 1 ? upColor : downColor;
        colAttr.setXYZ(i, color.r, color.g, color.b);

        sizeAttr.setX(i, currentSize);
        alphaAttr.setX(i, currentAlpha);
      }

      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
    }

    geo.setDrawRange(0, count);
  });

  useEffect(() => {
    if (reducedMotion) return;
    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [reducedMotion]);

  return (
    <group ref={groupRef}>
      {/* Dots on sphere surface */}
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color={theme.text}
          size={0.04}
          sizeAttenuation
          transparent
          opacity={0.55}
        />
      </points>

      {/* Connection lines */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[linePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={theme.text} transparent opacity={0.10} />
      </lineSegments>

      {/* Glow sphere */}
      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS * 1.02, 32, 32]} />
        <meshBasicMaterial
          color={theme.text}
          transparent
          opacity={0.03}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Tick flashes */}
      <points>
        <bufferGeometry ref={flashGeometryRef}>
          <bufferAttribute attach="attributes-position" args={[flashPosArray, 3]} />
          <bufferAttribute attach="attributes-aColor" args={[flashColArray, 3]} />
          <bufferAttribute attach="attributes-aSize" args={[flashSizeArray, 1]} />
          <bufferAttribute attach="attributes-aAlpha" args={[flashAlphaArray, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={flashMaterialRef}
          uniforms={shaderUniforms}
          vertexShader={FLASH_VERTEX_SHADER}
          fragmentShader={FLASH_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.NormalBlending}
        />
      </points>
    </group>
  );
}

export default function GlobeScene({
  ticks = [],
  reducedMotion = false,
}: GlobeSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isIntersecting, setIsIntersecting] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);

  useEffect(() => {
    const handleVisibility = () => {
      setIsDocumentVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) {
          setIsIntersecting(entry.isIntersecting);
        }
      },
      { threshold: 0 }
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  const frameloop =
    !isIntersecting || !isDocumentVisible
      ? 'never'
      : reducedMotion
      ? 'demand'
      : 'always';

  return (
    <div ref={containerRef} className="w-full h-full">
      <Canvas
        camera={{ position: [0, 0, 5.5], fov: 45 }}
        frameloop={frameloop}
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        dpr={[1, 1.75]}
        style={{ width: '100%', height: '100%' }}
      >
        <ambientLight intensity={0.3} />
        <pointLight position={[5, 5, 5]} intensity={0.5} />
        <GlobeDots ticks={ticks} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
}
