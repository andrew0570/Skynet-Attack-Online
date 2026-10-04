import * as THREE from 'three';
import { ARENA_RADIUS, heightAt, smoothstep } from '@sao/sim';

const SKY = 0x1a0b08;

export function createWorld(scene: THREE.Scene): void {
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 50, 170);

  scene.add(new THREE.HemisphereLight(0xc08a70, 0x1a0f0a, 0.9));
  const sun = new THREE.DirectionalLight(0xffc9a0, 1.6);
  sun.position.set(40, 60, 20);
  scene.add(sun);

  scene.add(createTerrain());
}

function createTerrain(): THREE.Mesh {
  const size = (ARENA_RADIUS + 60) * 2;
  const geo = new THREE.PlaneGeometry(size, size, 220, 220);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const floor = new THREE.Color(0x4a2a1e);
  const rim = new THREE.Color(0x8a6248);
  const scorch = new THREE.Color(0x2a1610);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = heightAt(x, z);
    pos.setY(i, y);
    const r = Math.hypot(x, z);
    c.copy(floor).lerp(rim, smoothstep(ARENA_RADIUS - 12, ARENA_RADIUS + 6, r));
    // Scorched ring around the center where Skynet hovers.
    c.lerp(scorch, (1 - smoothstep(4, 14, r)) * 0.7);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 })
  );
}

export function createSkynet(): { group: THREE.Group; animate: (t: number) => void } {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.6, 0),
    new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 2, flatShading: true })
  );
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(3.2, 0.12, 8, 48),
    new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.9, roughness: 0.3 })
  );
  group.add(core, ring, new THREE.PointLight(0xff3311, 40, 30));

  const baseY = heightAt(0, 0) + 6;
  group.position.set(0, baseY, 0);
  return {
    group,
    animate(t: number) {
      core.rotation.set(t * 0.7, t * 1.1, 0);
      ring.rotation.set(Math.PI / 2 + Math.sin(t) * 0.3, 0, t * 2);
      group.position.y = baseY + Math.sin(t * 1.5) * 0.4;
    },
  };
}

export function createPlayerMesh(): { group: THREE.Group; body: THREE.MeshStandardMaterial } {
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x2b3440, emissive: 0x00e5ff, emissiveIntensity: 0.15, roughness: 0.5, metalness: 0.4 });
  const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.9, 6, 12), body);
  capsule.position.y = 0.9;
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.16, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x001018, emissive: 0x00e5ff, emissiveIntensity: 2.5 })
  );
  visor.position.set(0, 1.45, 0.38);
  group.add(capsule, visor);
  return { group, body };
}
