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
  /** World-space death effects (sparks, fireball, shockwave, debris); add to the scene. */
  deathFx: THREE.Group;
  /** Camera shake the death sequence asks for (0..1). */
  shake: number;
  /** React to taking damage: white core flash plus a shake scaled by the damage. */
  hit(damage: number): void;
  /**
   * `pos` is the interpolated sim position; `boss` drives charge/stun/sweep visuals.
   * `floorY` is the surface under Skynet (where it crashes when destroyed).
   */
  animate(t: number, dt: number, pos: Vec3, boss: BossState, floorY: number): void;
  /** True once the death sequence has exploded and had a moment to read. */
  deathDone(): boolean;
}

/** Death sequence timing (s) and debris count. */
const DEATH = { critical: 1.6, gravity: 30, maxFall: 2.4, settle: 1.2, debris: 16, sparks: 24 };

/** Skynet: a glowing red core with an orbiting blade ring, driven by the fight sim. */
export function createSkynet(): SkynetVisual {
  const group = new THREE.Group();
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 7, flatShading: true });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 0), coreMat);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.9, roughness: 0.3, emissive: 0xff2200, emissiveIntensity: 0 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.12, 8, 48), ringMat);
  const light = new THREE.PointLight(0xff3311, 120, 60);
  // Reflect Shield: a gold lattice bubble that only shows while the shield is up.
  const shieldMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.8, 0.3).multiplyScalar(3), wireframe: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const shieldGlowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.7, 0.2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide });
  const shield = new THREE.Group();
  shield.add(new THREE.Mesh(new THREE.IcosahedronGeometry(2.4, 2), shieldMat), new THREE.Mesh(new THREE.SphereGeometry(2.3, 24, 16), shieldGlowMat));
  shield.visible = false;
  group.add(core, ring, light, shield);
  group.scale.setScalar(2);

  let flash = 0;
  let shake = 0;
  let ringSpin = 0;
  const red = new THREE.Color(0xff2200);
  const white = new THREE.Color(0xffffff);
  const enragedColor = new THREE.Color(0xff7a20);
  // Deterministic-looking jitter from layered sines (no per-frame random pops).
  const jitter = (t: number, seed: number) => Math.sin(t * 61 + seed) * 0.6 + Math.sin(t * 97 + seed * 2.3) * 0.4;

  // ---- Death sequence: critical failure → power loss and fall → crash explosion → wreck ----
  const deathFx = new THREE.Group();
  const additive = (color: THREE.Color) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const fireballMat = additive(new THREE.Color(1, 0.55, 0.2).multiplyScalar(4));
  const fireball = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), fireballMat);
  const blastCoreMat = additive(new THREE.Color(1, 0.9, 0.7).multiplyScalar(6));
  const blastCore = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), blastCoreMat);
  const waveMat = additive(new THREE.Color(1, 0.35, 0.1).multiplyScalar(4));
  const wave = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64).rotateX(-Math.PI / 2), waveMat);
  const shardGeo = new THREE.TetrahedronGeometry(0.7, 0);
  const shardMat = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.9, roughness: 0.4, emissive: 0xff3300, emissiveIntensity: 3, flatShading: true });
  const shards = Array.from({ length: DEATH.debris }, () => ({ mesh: new THREE.Mesh(shardGeo, shardMat), vel: new THREE.Vector3(), spin: new THREE.Vector3() }));
  const sparkGeo = new THREE.SphereGeometry(0.18, 6, 4);
  const sparks = Array.from({ length: DEATH.sparks }, () => ({ mesh: new THREE.Mesh(sparkGeo, additive(new THREE.Color(1, 0.8, 0.4).multiplyScalar(6))), vel: new THREE.Vector3(), life: 0 }));
  deathFx.add(fireball, blastCore, wave, ...shards.map(s => s.mesh), ...sparks.map(s => s.mesh));
  deathFx.visible = false;

  /** Seconds since death (-1 = alive), crash time (-1 = not yet), fall state. */
  let deathT = -1;
  let explodedAt = -1;
  const fallPos = new THREE.Vector3();
  let fallVy = 0;
  let nextSpark = 0;
  let sparkIdx = 0;
  const tumble = new THREE.Euler();

  function resetDeath(): void {
    deathT = -1;
    explodedAt = -1;
    deathFx.visible = false;
    core.visible = true;
    ring.visible = true;
    group.rotation.set(0, 0, 0);
    visual.shake = 0;
  }

  function explode(floorY: number): void {
    explodedAt = deathT;
    fallPos.y = floorY + 0.5;
    core.visible = false;
    fireball.position.copy(fallPos);
    blastCore.position.copy(fallPos);
    wave.position.set(fallPos.x, floorY + 0.3, fallPos.z);
    for (const s of shards) {
      s.mesh.visible = true;
      s.mesh.position.copy(fallPos);
      const a = Math.random() * Math.PI * 2;
      const up = 8 + Math.random() * 16;
      const out = 8 + Math.random() * 18;
      s.vel.set(Math.cos(a) * out, up, Math.sin(a) * out);
      s.spin.set(Math.random() * 12 - 6, Math.random() * 12 - 6, Math.random() * 12 - 6);
    }
    visual.shake = 1;
  }

  function animateDeath(t: number, dt: number, pos: Vec3, floorY: number): void {
    if (deathT < 0) {
      deathT = 0;
      fallPos.set(pos.x, pos.y, pos.z);
      fallVy = 0;
      tumble.set(0, 0, 0);
      deathFx.visible = true;
      for (const s of [...shards.map(s => s.mesh), fireball, blastCore, wave]) s.visible = false;
      for (const s of sparks) s.life = 0;
      shield.visible = false;
    }
    deathT += dt;
    const d = deathT;

    if (explodedAt < 0) {
      // 1) Critical failure: sputtering core, ring spinning out of control, escalating shudder.
      const crit = Math.min(1, d / DEATH.critical);
      const sputter = Math.sin(t * 47) * Math.sin(t * 31) > 0;
      coreMat.emissive.copy(sputter ? white : red);
      coreMat.emissiveIntensity = sputter ? 6 + 10 * crit : 0.6;
      light.intensity = sputter ? 120 + 260 * crit : 20;
      ringSpin += dt * (2 + 26 * crit);
      ringMat.emissiveIntensity = 3 * crit;
      ring.rotation.set(Math.PI / 2 + Math.sin(t * 9) * 0.7 * crit, Math.sin(t * 7) * 0.4 * crit, ringSpin);
      core.rotation.set(t * 3, t * 4.4, 0);
      visual.shake = 0.15 + 0.35 * crit;
      // Sparks spray off the hull.
      nextSpark -= dt;
      while (nextSpark <= 0) {
        nextSpark += 0.06 - 0.04 * crit;
        const s = sparks[sparkIdx++ % sparks.length];
        const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
        s.mesh.position.copy(fallPos).addScaledVector(dir, 3.2);
        s.vel.copy(dir).multiplyScalar(10 + Math.random() * 14);
        s.life = 0.35;
      }
      // 2) Power loss: it drops out of the sky, tumbling.
      if (d > DEATH.critical) {
        fallVy -= DEATH.gravity * dt;
        fallPos.y += fallVy * dt;
        tumble.x += dt * 2.6;
        tumble.z += dt * 1.7;
      }
      const s = 0.35 + 0.9 * crit;
      group.position.set(fallPos.x + jitter(t, 1) * s, fallPos.y + jitter(t, 2) * s * 0.6, fallPos.z + jitter(t, 3) * s);
      group.rotation.set(tumble.x + jitter(t, 4) * 0.2 * crit, 0, tumble.z + jitter(t, 5) * 0.2 * crit);
      // 3) Crash.
      if ((d > DEATH.critical && fallPos.y <= floorY + 1.6) || d > DEATH.critical + DEATH.maxFall) explode(floorY);
    } else {
      // 4) Explosion, then the wreck: the blade ring lies on the ground, embers fading.
      const e = d - explodedAt;
      const k = Math.min(1, e / 0.7);
      fireball.visible = e < 1.1;
      fireball.scale.setScalar(2 + 14 * (1 - (1 - k) * (1 - k)));
      fireballMat.opacity = Math.max(0, 0.9 * (1 - e / 1.1));
      blastCore.visible = e < 0.35;
      blastCore.scale.setScalar(3 + 10 * Math.min(1, e / 0.35));
      blastCoreMat.opacity = Math.max(0, 1 - e / 0.35);
      wave.visible = e < 1.2;
      wave.scale.setScalar(4 + 34 * Math.min(1, e / 1.2));
      waveMat.opacity = Math.max(0, 1 - e / 1.2);
      for (const sh of shards) {
        if (sh.mesh.position.y > floorY + 0.3 || sh.vel.y > 0) {
          sh.vel.y -= 25 * dt;
          sh.mesh.position.addScaledVector(sh.vel, dt);
          sh.mesh.rotation.x += sh.spin.x * dt;
          sh.mesh.rotation.y += sh.spin.y * dt;
          sh.mesh.rotation.z += sh.spin.z * dt;
          if (sh.mesh.position.y < floorY + 0.3 && sh.vel.y < 0) sh.mesh.position.y = floorY + 0.3;
        }
      }
      shardMat.emissiveIntensity = 3 * Math.exp(-e * 0.8);
      light.intensity = 900 * Math.exp(-e * 3) + 25 * Math.exp(-e * 0.4);
      ringMat.emissiveIntensity = 2.5 * Math.exp(-e * 0.6) * (0.75 + 0.25 * Math.sin(t * 9));
      group.position.set(fallPos.x, floorY + 0.25, fallPos.z);
      group.rotation.set(0.12, 0, 0.08);
      ring.rotation.set(Math.PI / 2, 0, ringSpin);
      visual.shake = Math.max(0, 1 - e * 1.4);
    }
    // Sparks fly and fade in both stages.
    for (const s of sparks) {
      s.life -= dt;
      s.mesh.visible = s.life > 0;
      if (s.life <= 0) continue;
      s.vel.y -= 20 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = s.life / 0.35;
    }
  }

  const visual: SkynetVisual = {
    group,
    deathFx,
    shake: 0,
    deathDone: () => explodedAt >= 0 && deathT - explodedAt > DEATH.settle,
    hit(damage) {
      flash = 0.12;
      shake = Math.min(1, shake + 0.35 + damage / 60);
    },
    animate(t, dt, pos, boss, floorY) {
      if (boss.hp <= 0) return animateDeath(t, dt, pos, floorY);
      if (deathT >= 0) resetDeath();
      flash = Math.max(0, flash - dt);
      shake = Math.max(0, shake - dt * 3);
      const attack = boss.arm >= 0 && ARMS[boss.arm].kind === 'attack' ? (ARMS[boss.arm] as { attack: AttackId }).attack : null;
      const stunned = boss.phase === 'recover' && attack === 'dive';
      const perched = boss.phase === 'idle' || boss.phase === 'moving' || ((boss.phase === 'telegraph' || boss.phase === 'recover') && attack !== 'dive');

      // Core brightness: charges during telegraphs, sputters while stunned.
      let intensity = 5;
      if (boss.phase === 'telegraph') intensity = 8 + 5 * (1 - boss.timer / ATTACKS[attack!].telegraph) + Math.sin(t * 40) * 1.2;
      if (stunned) intensity = 1.5 + (Math.sin(t * 23) > 0.6 ? 4 : 0);
      // Phase 2: the core burns white-hot orange and the light flares.
      coreMat.emissive.copy(flash > 0 ? white : boss.enraged ? enragedColor : red);
      coreMat.emissiveIntensity = flash > 0 ? 12 : intensity;
      light.intensity = (60 + intensity * 8) * (boss.enraged ? 1.6 : 1);

      // Blade ring spins up for the sweep and glows.
      const sweeping = attack === 'sweep' && (boss.phase === 'telegraph' || boss.phase === 'active');
      ringSpin += dt * (sweeping ? 18 : stunned ? 0.5 : boss.enraged ? 5 : 2);
      ringMat.emissiveIntensity = sweeping ? 4 : 0;
      ring.rotation.set(Math.PI / 2 + (stunned ? 0.8 : Math.sin(t) * 0.3), 0, ringSpin);
      ring.scale.setScalar(attack === 'sweep' && boss.phase === 'active' ? 1.35 : 1);

      core.rotation.set(t * 0.7, t * 1.1, 0);
      // Shield bubble: pops in when raised, flickers in its last moments.
      shield.visible = boss.shield > 0;
      if (shield.visible) {
        const fade = boss.shield < 0.3 ? (Math.sin(t * 60) > 0 ? 1 : 0.3) : 1;
        shieldMat.opacity = 0.75 * fade;
        shieldGlowMat.opacity = 0.18 * fade;
        shield.rotation.set(t * 0.4, t * 0.9, 0);
      }
      // Laser charge / firing: the ring locks flat and glows.
      if (attack === 'laser' && (boss.phase === 'telegraph' || boss.phase === 'active')) {
        ringMat.emissiveIntensity = boss.phase === 'active' ? 6 : 2;
        ring.rotation.set(Math.PI / 2, 0, ringSpin);
      }
      // Damage shake: jolt the whole construct and wobble its tilt.
      const s = shake * shake * 1.1;
      group.position.set(
        pos.x + jitter(t, 1) * s,
        pos.y + (perched ? Math.sin(t * 1.5) * 0.6 : 0) + jitter(t, 2) * s * 0.6,
        pos.z + jitter(t, 3) * s
      );
      group.rotation.set(jitter(t, 4) * s * 0.25, 0, jitter(t, 5) * s * 0.25);
    },
  };
  return visual;
}
