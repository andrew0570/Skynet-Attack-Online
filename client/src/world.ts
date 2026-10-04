import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ARENA_RADIUS, ARMS, ATTACKS, heightAt, smoothstep, type AttackId, type BossState, type Vec3 } from '@sao/sim';

const SKY = 0x1a0b08;

export function createWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 70, 290);
  // Metallic armor needs something to reflect, or it renders near-black.
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  scene.add(new THREE.HemisphereLight(0xc08a70, 0x2a1810, 1.1));
  const sun = new THREE.DirectionalLight(0xffc9a0, 2.2);
  sun.position.set(60, 80, 25);
  scene.add(sun);

  scene.add(createTerrain());
}

function createTerrain(): THREE.Mesh {
  const size = (ARENA_RADIUS + 70) * 2;
  const geo = new THREE.PlaneGeometry(size, size, 260, 260);
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
    c.copy(floor).lerp(rim, smoothstep(ARENA_RADIUS - 6, ARENA_RADIUS + 12, r));
    // Scorched ring around the pillar where Skynet hovers.
    c.lerp(scorch, (1 - smoothstep(4, 18, r)) * 0.7);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, envMapIntensity: 0 })
  );
}

export interface SkynetVisual {
  group: THREE.Group;
  /** Flash the core white (call on hit). */
  flash(): void;
  /** `pos` is the interpolated sim position; `boss` drives charge/stun/sweep visuals. */
  animate(t: number, dt: number, pos: Vec3, boss: BossState): void;
}

/** Skynet: a glowing red core with an orbiting blade ring, driven by the fight sim. */
export function createSkynet(): SkynetVisual {
  const group = new THREE.Group();
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 7, flatShading: true });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 0), coreMat);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.9, roughness: 0.3, emissive: 0xff2200, emissiveIntensity: 0 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.12, 8, 48), ringMat);
  const light = new THREE.PointLight(0xff3311, 120, 60);
  group.add(core, ring, light);
  group.scale.setScalar(2);

  let flash = 0;
  let ringSpin = 0;
  const red = new THREE.Color(0xff2200);
  const white = new THREE.Color(0xffffff);
  return {
    group,
    flash() {
      flash = 0.12;
    },
    animate(t, dt, pos, boss) {
      flash = Math.max(0, flash - dt);
      const attack = boss.arm >= 0 && ARMS[boss.arm].kind === 'attack' ? (ARMS[boss.arm] as { attack: AttackId }).attack : null;
      const stunned = boss.phase === 'recover' && attack === 'dive';
      const perched = boss.phase === 'idle' || ((boss.phase === 'telegraph' || boss.phase === 'recover') && attack !== 'dive');

      // Core brightness: charges during telegraphs, sputters while stunned.
      let intensity = 5;
      if (boss.phase === 'telegraph') intensity = 8 + 5 * (1 - boss.timer / ATTACKS[attack!].telegraph) + Math.sin(t * 40) * 1.2;
      if (stunned) intensity = 1.5 + (Math.sin(t * 23) > 0.6 ? 4 : 0);
      coreMat.emissive.copy(flash > 0 ? white : red);
      coreMat.emissiveIntensity = flash > 0 ? 12 : intensity;
      light.intensity = 60 + intensity * 8;

      // Blade ring spins up for the sweep and glows.
      const sweeping = attack === 'sweep' && (boss.phase === 'telegraph' || boss.phase === 'active');
      ringSpin += dt * (sweeping ? 18 : stunned ? 0.5 : 2);
      ringMat.emissiveIntensity = sweeping ? 4 : 0;
      ring.rotation.set(Math.PI / 2 + (stunned ? 0.8 : Math.sin(t) * 0.3), 0, ringSpin);
      ring.scale.setScalar(attack === 'sweep' && boss.phase === 'active' ? 1.35 : 1);

      core.rotation.set(t * 0.7, t * 1.1, 0);
      group.position.set(pos.x, pos.y + (perched ? Math.sin(t * 1.5) * 0.6 : 0), pos.z);
    },
  };
}
