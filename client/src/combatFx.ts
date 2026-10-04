import * as THREE from 'three';
import { ARMS, ATTACKS, heightAt, SKILLS, type FightEvent, type FightState, type ProjectileKind, type Vec3 } from '@sao/sim';

// Skynet's attacks read as red/orange; the player's sword and dodges as cyan.
const hdr = (r: number, g: number, b: number, k: number) => new THREE.Color(r, g, b).multiplyScalar(k);
const additive = (color: THREE.Color, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

const PROJECTILE_LOOK: Record<ProjectileKind, { geo: THREE.BufferGeometry; mat: THREE.Material }> = {
  bolt: { geo: new THREE.SphereGeometry(0.35, 10, 8), mat: new THREE.MeshBasicMaterial({ color: hdr(1, 0.25, 0.05, 6) }) },
  orb: { geo: new THREE.IcosahedronGeometry(0.6, 1), mat: new THREE.MeshBasicMaterial({ color: hdr(1, 0.1, 0.45, 5) }) },
  shell: { geo: new THREE.SphereGeometry(0.5, 10, 8), mat: new THREE.MeshBasicMaterial({ color: hdr(1, 0.5, 0.1, 5) }) },
};

/** Sword beam: a long cyan lance oriented along its velocity (+Z). */
const BEAM_GEO = new THREE.CylinderGeometry(0.16, 0.16, 3.2, 8).rotateX(Math.PI / 2);
const BEAM_MAT = new THREE.MeshBasicMaterial({ color: hdr(0.4, 1, 1, 6) });

interface Effect {
  obj: THREE.Object3D;
  life: number;
  maxLife: number;
  tick: (k: number, obj: THREE.Object3D) => void;
}

export interface CombatFx {
  handle(events: FightEvent[], fight: FightState): void;
  update(fight: FightState, dt: number, time: number): void;
  reset(): void;
  /** Camera shake amount (decays); read by the camera each frame. */
  shake: number;
}

export function createCombatFx(scene: THREE.Scene): CombatFx {
  const root = new THREE.Group();
  scene.add(root);
  const projectiles = new Map<number, THREE.Mesh>();
  let effects: Effect[] = [];
  const ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
  const discGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
  const sphereGeo = new THREE.SphereGeometry(1, 16, 12);

  // Aim line shown while Skynet winds up a ranged attack (shows the player where it's aiming).
  const aimLineMat = new THREE.LineBasicMaterial({ color: hdr(1, 0.15, 0.05, 4), transparent: true, opacity: 0.8 });
  const aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), aimLineMat);
  aimLine.visible = false;
  root.add(aimLine);
  let aimTarget: Vec3 | null = null;

  const fx = {
    shake: 0,
    handle,
    update,
    reset() {
      for (const m of projectiles.values()) root.remove(m);
      projectiles.clear();
      for (const e of effects) root.remove(e.obj);
      effects = [];
      aimLine.visible = false;
      aimTarget = null;
    },
  };

  function add(obj: THREE.Object3D, life: number, tick: Effect['tick']): void {
    root.add(obj);
    effects.push({ obj, life, maxLife: life, tick });
  }

  /** Pulsing ground ring that marks where something will land. */
  function groundMarker(at: Vec3, radius: number, life: number): void {
    const mat = additive(hdr(1, 0.1, 0.03, 3), 0.8);
    const g = new THREE.Group();
    const ring = new THREE.Mesh(ringGeo, mat);
    const fill = new THREE.Mesh(discGeo, additive(hdr(1, 0.1, 0.03, 1), 0.15));
    g.add(ring, fill);
    g.position.set(at.x, heightAt(at.x, at.z) + 0.08, at.z);
    g.scale.setScalar(radius);
    add(g, life, k => {
      // Inner fill grows to the edge as the impact approaches.
      fill.scale.setScalar(Math.min(1, 1 - k));
      mat.opacity = 0.5 + 0.4 * Math.sin((1 - k) * 30);
    });
  }

  /** Expanding flash sphere. */
  function burst(at: Vec3, radius: number, color: THREE.Color, life = 0.3): void {
    const mat = additive(color, 0.9);
    const m = new THREE.Mesh(sphereGeo, mat);
    m.position.set(at.x, at.y, at.z);
    add(m, life, (k, o) => {
      o.scale.setScalar(radius * (0.3 + 0.7 * (1 - k)));
      mat.opacity = 0.9 * k;
    });
  }

  /** Expanding flat shockwave ring. */
  function shockwave(at: Vec3, radius: number, color: THREE.Color, life = 0.4): void {
    const mat = additive(color, 1);
    const m = new THREE.Mesh(ringGeo, mat);
    m.position.set(at.x, at.y + 0.2, at.z);
    add(m, life, (k, o) => {
      o.scale.setScalar(radius * (1 - k * k));
      mat.opacity = k;
    });
  }

  function handle(events: FightEvent[], fight: FightState): void {
    for (const e of events) {
      switch (e.type) {
        case 'telegraph':
          if (e.attack === 'dive') groundMarker(e.markers[0], 7, ATTACKS.dive.telegraph + ATTACKS.dive.active);
          else if (e.attack === 'mortar' && e.markers.length) for (const m of e.markers) groundMarker(m, 4.5, 2.6);
          else if (e.attack === 'volley' || e.attack === 'spread' || e.attack === 'homing') {
            aimTarget = e.aim;
            aimLine.visible = true;
          }
          break;
        case 'fire':
          aimLine.visible = false;
          aimTarget = null;
          break;
        case 'impact': {
          const big = e.kind === 'shell';
          burst(e.pos, big ? e.radius : 1.2, big ? hdr(1, 0.45, 0.1, 3) : hdr(1, 0.25, 0.05, 3), big ? 0.45 : 0.2);
          if (big) {
            shockwave({ ...e.pos, y: heightAt(e.pos.x, e.pos.z) }, e.radius, hdr(1, 0.4, 0.1, 3));
            fx.shake = Math.max(fx.shake, 0.25);
          }
          break;
        }
        case 'slam':
          shockwave(e.pos, e.radius, hdr(1, 0.15, 0.05, 4), 0.55);
          burst({ ...e.pos, y: e.pos.y + 1 }, 4, hdr(1, 0.2, 0.05, 3), 0.4);
          fx.shake = Math.max(fx.shake, 0.7);
          break;
        case 'sweep':
          shockwave(e.pos, e.radius, hdr(1, 0.2, 0.05, 4), 0.35);
          break;
        case 'playerHit':
          fx.shake = Math.max(fx.shake, 0.35);
          break;
        case 'dodged':
          burst({ ...e.pos, y: e.pos.y + 1 }, 1.4, hdr(0, 0.9, 1, 2), 0.25);
          break;
        case 'bossHit':
          burst(fight.boss.pos, 2.2, e.stunned ? hdr(0.6, 1, 1, 3) : hdr(0, 0.9, 1, 2.5), 0.18);
          break;
        case 'lightningCast':
          lightningGlyph(e.pos);
          break;
        case 'lightning':
          lightningBolt(e.pos);
          fx.shake = Math.max(fx.shake, 0.45);
          break;
        case 'beamFired':
          burst(e.from, 0.8, hdr(0.4, 1, 1, 4), 0.15);
          break;
        case 'beamImpact':
          burst(e.pos, e.hitBoss ? 2 : 1.2, hdr(0.3, 1, 1, e.hitBoss ? 4 : 2.5), 0.25);
          break;
        case 'rush':
          fx.shake = Math.max(fx.shake, 0.2);
          break;
      }
    }
  }

  /** Cyan target glyph on the ground while a lightning strike charges. */
  function lightningGlyph(at: Vec3): void {
    const mat = additive(hdr(0.3, 0.9, 1, 3), 0.9);
    const g = new THREE.Group();
    const outer = new THREE.Mesh(ringGeo, mat);
    const inner = new THREE.Mesh(ringGeo, mat);
    inner.scale.setScalar(0.55);
    g.add(outer, inner);
    g.position.set(at.x, at.y + 0.1, at.z);
    g.scale.setScalar(SKILLS.lightning.radius);
    add(g, SKILLS.lightning.castTime, k => {
      inner.scale.setScalar(0.55 + 0.45 * (1 - k));
      g.rotation.y += 0.15;
      mat.opacity = 0.5 + 0.5 * Math.sin((1 - k) * 40);
    });
  }

  /** Jagged lightning column from the sky down to the strike point. */
  function lightningBolt(at: Vec3): void {
    const path = new THREE.CurvePath<THREE.Vector3>();
    const top = at.y + 70;
    let prev = new THREE.Vector3(at.x + (Math.random() - 0.5) * 6, top, at.z + (Math.random() - 0.5) * 6);
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const spread = i === steps ? 0 : 2.2 * (1 - k * 0.6);
      const next = new THREE.Vector3(
        at.x + (Math.random() - 0.5) * spread,
        top + (at.y - top) * k,
        at.z + (Math.random() - 0.5) * spread
      );
      path.add(new THREE.LineCurve3(prev, next));
      prev = next;
    }
    const core = new THREE.Mesh(new THREE.TubeGeometry(path, steps * 2, 0.22, 5, false), new THREE.MeshBasicMaterial({ color: hdr(0.8, 0.95, 1, 8), transparent: true }));
    const glowMat = additive(hdr(0.3, 0.8, 1, 2), 0.45);
    const glow = new THREE.Mesh(new THREE.TubeGeometry(path, steps * 2, 0.9, 6, false), glowMat);
    const g = new THREE.Group();
    g.add(core, glow);
    add(g, 0.3, k => {
      // Flicker, then fade.
      const on = k > 0.5 ? (Math.random() > 0.3 ? 1 : 0.2) : k * 2;
      (core.material as THREE.MeshBasicMaterial).opacity = on;
      glowMat.opacity = 0.45 * on;
    });
    shockwave(at, SKILLS.lightning.radius * 1.6, hdr(0.3, 0.9, 1, 4), 0.45);
    burst({ ...at, y: at.y + 1 }, 3, hdr(0.5, 0.95, 1, 4), 0.3);
  }

  function update(fight: FightState, dt: number, time: number): void {
    fx.shake = Math.max(0, fx.shake - dt * 2.5);

    // Projectiles: one mesh per live projectile, oriented along its velocity.
    const live = new Set<number>();
    for (const p of fight.projectiles) {
      live.add(p.id);
      let mesh = projectiles.get(p.id);
      if (!mesh) {
        const look = PROJECTILE_LOOK[p.kind];
        mesh = new THREE.Mesh(look.geo, look.mat);
        projectiles.set(p.id, mesh);
        root.add(mesh);
      }
      mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
      if (p.kind === 'bolt') {
        mesh.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z);
        mesh.scale.set(1, 1, 3.2);
      } else if (p.kind === 'orb') {
        mesh.scale.setScalar(1 + 0.25 * Math.sin(time * 14 + p.id));
        mesh.rotation.set(time * 3, time * 2, 0);
      }
    }
    // The player's sword beams share the map (ids are unique across both lists).
    for (const s of fight.shots) {
      live.add(s.id);
      let mesh = projectiles.get(s.id);
      if (!mesh) {
        mesh = new THREE.Mesh(BEAM_GEO, BEAM_MAT);
        projectiles.set(s.id, mesh);
        root.add(mesh);
      }
      mesh.position.set(s.pos.x, s.pos.y, s.pos.z);
      mesh.lookAt(s.pos.x + s.vel.x, s.pos.y + s.vel.y, s.pos.z + s.vel.z);
    }
    for (const [id, mesh] of projectiles) {
      if (!live.has(id)) {
        root.remove(mesh);
        projectiles.delete(id);
      }
    }

    // Aim line follows Skynet while it winds up.
    const b = fight.boss;
    const arm = b.arm >= 0 ? ARMS[b.arm] : null;
    if (aimLine.visible && aimTarget && b.phase === 'telegraph' && arm?.kind === 'attack') {
      const pos = aimLine.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, b.pos.x, b.pos.y, b.pos.z);
      pos.setXYZ(1, aimTarget.x, aimTarget.y, aimTarget.z);
      pos.needsUpdate = true;
      aimLine.geometry.computeBoundingSphere();
      aimLineMat.opacity = 0.4 + 0.5 * Math.abs(Math.sin(time * 20));
    } else {
      aimLine.visible = false;
    }

    effects = effects.filter(e => {
      e.life -= dt;
      if (e.life <= 0) {
        root.remove(e.obj);
        return false;
      }
      e.tick(e.life / e.maxLife, e.obj);
      return true;
    });
  }

  return fx;
}
