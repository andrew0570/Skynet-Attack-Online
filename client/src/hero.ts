import * as THREE from 'three';
import { clamp, PLAYER, type PlayerState } from '@sao/sim';

// Procedural armored space hero. Origin at the feet, facing +Z (its right hand is on -X).
// Purely cosmetic: all gameplay (hitboxes, timings) lives in sim/.

const ARMOR = new THREE.MeshStandardMaterial({ color: 0x3b4452, metalness: 0.75, roughness: 0.35, flatShading: true });
const ARMOR_LIGHT = new THREE.MeshStandardMaterial({ color: 0x8a96a8, metalness: 0.7, roughness: 0.5, flatShading: true });
const SUIT = new THREE.MeshStandardMaterial({ color: 0x12161c, metalness: 0.2, roughness: 0.8 });

const CYAN = new THREE.Color(0x00e5ff);
/** HDR glow: colors above 1.0 are what the bloom pass picks up. */
const glow = (intensity: number) => new THREE.MeshBasicMaterial({ color: CYAN.clone().multiplyScalar(intensity) });
const SEAM = glow(1.6);
const VISOR = glow(2.6);
const CORE = glow(3);
const BLADE_CORE = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.75, 1, 1).multiplyScalar(2.2) });
const BLADE_SHEATH = new THREE.MeshBasicMaterial({
  color: CYAN.clone().multiplyScalar(1.2),
  transparent: true,
  opacity: 0.3,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const FLAME = new THREE.MeshBasicMaterial({
  color: new THREE.Color(0.4, 0.9, 1).multiplyScalar(4),
  transparent: true,
  opacity: 0.8,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const GLOWS: [THREE.MeshBasicMaterial, THREE.Color][] = [SEAM, VISOR, CORE].map(m => [m, m.color.clone()]);
/** Wing edge glow: dim when folded, powers up as the wings deploy. */
const WING_GLOW = glow(0.6);
const WING_GLOW_FOLDED = 0.6;
const WING_GLOW_OPEN = 3.2;

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function joint(x: number, y: number, z: number, ...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.add(...children);
  return g;
}

function createSword(): THREE.Group {
  // Built along +Z so it points forward out of a hanging hand.
  const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.22, 8), ARMOR_LIGHT);
  hilt.rotation.x = Math.PI / 2;
  const guard = box(0.14, 0.035, 0.05, ARMOR, 0, 0, 0.12);
  const emitter = box(0.05, 0.05, 0.03, SEAM, 0, 0, 0.15);
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.05, 8), BLADE_CORE);
  blade.rotation.x = Math.PI / 2;
  blade.position.z = 0.15 + 0.525;
  const sheath = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 10), BLADE_SHEATH);
  sheath.rotation.x = Math.PI / 2;
  sheath.position.z = blade.position.z;
  const sword = joint(0, -0.05, 0.02, hilt, guard, emitter, blade, sheath);
  // Low ready stance: blade forward-down and slightly out to the hero's right.
  sword.rotation.set(1.45, -0.35, 0);
  return sword;
}

interface Arm {
  shoulder: THREE.Group;
  elbow: THREE.Group;
}

function createArm(side: 1 | -1): Arm & { hand: THREE.Group } {
  const hand = joint(0, -0.29, 0, box(0.09, 0.1, 0.09, SUIT, 0, -0.04, 0));
  const elbow = joint(
    0, -0.3, 0,
    box(0.12, 0.28, 0.12, ARMOR, 0, -0.14, 0),
    box(0.13, 0.025, 0.13, SEAM, 0, -0.07, 0),
    hand
  );
  const shoulder = joint(
    side * 0.32, 0.46, 0,
    box(0.2, 0.12, 0.24, ARMOR_LIGHT, side * 0.04, 0.04, 0),
    box(0.11, 0.3, 0.11, SUIT, 0, -0.15, 0),
    box(0.125, 0.16, 0.125, ARMOR, 0, -0.12, 0),
    elbow
  );
  return { shoulder, elbow, hand };
}

interface Wing {
  root: THREE.Group;
  blades: { pivot: THREE.Group; openAngle: number }[];
  side: 1 | -1;
}

const BLADES = [
  { at: 0.25, length: 1.1, open: -0.15 },
  { at: 0.6, length: 0.95, open: 0.12 },
  { at: 0.95, length: 0.8, open: 0.38 },
  { at: 1.3, length: 0.6, open: 0.62 },
];
const SPAR_LENGTH = 1.45;
/** Root roll: folded, the spars rise in a V behind the shoulders; open, they sweep out level. */
const WING_ROOT_FOLDED = Math.PI / 2 - 0.35;
const WING_ROOT_OPEN = 0.22;
/** Blades folded flat along the spar. */
const BLADE_FOLDED = Math.PI / 2 - 0.08;

/**
 * Cybernetic wing in the torso's back plane (x = outward, -y = toward the hips): a metal spar
 * with four blades hanging off it, each with a glowing outer edge. `side` 1 = left (+X).
 */
function createWing(side: 1 | -1): Wing {
  const root = new THREE.Group();
  root.position.set(side * 0.13, 0.52, -0.28);
  const spar = box(SPAR_LENGTH, 0.07, 0.06, ARMOR_LIGHT, (side * SPAR_LENGTH) / 2, 0, 0);
  const sparGlow = box(SPAR_LENGTH * 0.9, 0.02, 0.02, WING_GLOW, (side * SPAR_LENGTH) / 2, 0.045, 0);
  root.add(spar, sparGlow);
  const blades = BLADES.map(b => {
    const pivot = new THREE.Group();
    pivot.position.x = side * b.at;
    // Blade hangs along -Y from the spar; outer edge glows.
    pivot.add(
      box(0.13, b.length, 0.025, ARMOR, 0, -b.length / 2, 0),
      box(0.025, b.length * 0.95, 0.03, WING_GLOW, side * 0.065, -b.length / 2, 0),
      box(0.13, 0.025, 0.03, WING_GLOW, 0, -b.length, 0)
    );
    root.add(pivot);
    return { pivot, openAngle: b.open };
  });
  return { root, blades, side };
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
}

function createLeg(side: 1 | -1): Leg {
  const knee = joint(
    0, -0.42, 0,
    box(0.14, 0.1, 0.06, ARMOR_LIGHT, 0, 0, 0.09),
    box(0.14, 0.38, 0.15, ARMOR, 0, -0.2, 0),
    box(0.02, 0.24, 0.02, SEAM, 0, -0.2, 0.08),
    box(0.15, 0.08, 0.27, ARMOR, 0, -0.43, 0.04)
  );
  const hip = joint(
    side * 0.11, -0.06, 0,
    box(0.15, 0.42, 0.16, SUIT, 0, -0.21, 0),
    box(0.16, 0.24, 0.07, ARMOR, 0, -0.18, 0.07),
    knee
  );
  return { hip, knee };
}

/** Target joint angles. Positive X rotation swings a limb backward / tilts the body forward. */
interface Pose {
  bodyY: number;
  bodyPitch: number;
  torsoPitch: number;
  hip: [number, number];
  knee: [number, number];
  shoulderX: [number, number];
  shoulderZ: [number, number];
  elbow: [number, number];
  thrust: number;
}

const FLIP_TIME = 0.42;
const LAND_TIME = 0.16;

export interface Hero {
  group: THREE.Group;
  update(p: PlayerState, dt: number, time: number): void;
}

export function createHero(): Hero {
  const left = createArm(1);
  const right = createArm(-1);
  right.hand.add(createSword());
  const legs = [createLeg(1), createLeg(-1)];
  const arms = [left, right];

  const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), ARMOR);
  helmet.position.y = 0.12;
  helmet.scale.set(1, 1.1, 1.08);
  const head = joint(
    0, 0.54, 0,
    helmet,
    box(0.24, 0.05, 0.06, VISOR, 0, 0.13, 0.155),
    box(0.03, 0.08, 0.24, ARMOR_LIGHT, 0, 0.3, -0.02)
  );

  // Flame base sits at the nozzle (y = 0) and the tip points down, so scaling Y lengthens it.
  const flameGeo = new THREE.ConeGeometry(0.06, 0.45, 8).rotateX(Math.PI).translate(0, -0.225, 0);
  const flames = [-1, 1].map(s => {
    const flame = new THREE.Mesh(flameGeo, FLAME);
    flame.position.set(s * 0.1, 0, -0.25);
    return flame;
  });
  const thrusters = [-1, 1].map(s => {
    const n = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.12, 8), ARMOR_LIGHT);
    n.position.set(s * 0.1, 0.2, -0.25);
    return n;
  });
  const flameGroup = joint(0, 0.14, 0, ...flames);

  const coreGem = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.03, 6), CORE);
  coreGem.rotation.x = Math.PI / 2;
  coreGem.position.set(0, 0.38, 0.16);

  const wings = [createWing(1), createWing(-1)];

  const torso = joint(
    0, 0.08, 0,
    ...wings.map(w => w.root),
    box(0.3, 0.2, 0.2, SUIT, 0, 0.12, 0),
    box(0.5, 0.32, 0.28, ARMOR, 0, 0.36, 0.01),
    coreGem,
    box(0.02, 0.22, 0.02, SEAM, 0.15, 0.34, 0.155),
    box(0.02, 0.22, 0.02, SEAM, -0.15, 0.34, 0.155),
    box(0.36, 0.34, 0.14, ARMOR, 0, 0.36, -0.2),
    ...thrusters,
    flameGroup,
    head,
    left.shoulder,
    right.shoulder
  );

  const body = joint(
    0, 0.95, 0,
    box(0.34, 0.18, 0.22, SUIT),
    box(0.36, 0.03, 0.24, SEAM, 0, 0.07, 0),
    torso,
    ...legs.map(l => l.hip)
  );
  const group = new THREE.Group();
  group.add(body);

  const cur: Pose = {
    bodyY: 0, bodyPitch: 0, torsoPitch: 0,
    hip: [0, 0], knee: [0, 0], shoulderX: [0, 0], shoulderZ: [0, 0], elbow: [0, 0], thrust: 0,
  };
  let phase = 0;
  let wingOpen = 0;
  let flipT = 0;
  let landT = 0;
  let prevAirJumps = PLAYER.airJumps;
  let prevOnGround = true;

  function targetPose(p: PlayerState, time: number): Pose {
    const hs = Math.hypot(p.vel.x, p.vel.z);
    // Sword arm (index 1) rests in a low ready stance unless overridden.
    const pose: Pose = {
      bodyY: 0, bodyPitch: 0, torsoPitch: 0.03,
      hip: [0, 0], knee: [0.05, 0.05],
      shoulderX: [0.05, -0.35], shoulderZ: [0.12, -0.12], elbow: [-0.25, -0.75], thrust: 0.1,
    };

    if (p.dashTimer > 0) {
      // Superhero lean along the dash vector; limbs trail behind.
      pose.bodyPitch = clamp(1.15 - p.dashDir.y * 1.1, -0.1, 2.1);
      pose.hip = [0.35, 0.15];
      pose.knee = [0.6, 0.3];
      pose.shoulderX = [1.0, 1.3];
      pose.shoulderZ = [0.25, -0.25];
      pose.elbow = [-0.2, 0];
      pose.thrust = 1.6;
    } else if (p.gliding) {
      // Wingsuit glide: body prone, arms spread wide, legs trailing, thrusters idling.
      pose.bodyPitch = 1.25;
      pose.torsoPitch = 0;
      pose.hip = [0.25, 0.25];
      pose.knee = [0.15, 0.15];
      pose.shoulderX = [-0.1, -0.1];
      pose.shoulderZ = [1.35, -1.35];
      pose.elbow = [0, 0];
      pose.thrust = 0.6;
    } else if (!p.onGround) {
      const rising = clamp(p.vel.y / PLAYER.jumpSpeed, -1, 1);
      if (rising > 0) {
        pose.hip = [-0.8 * rising, -0.45 * rising];
        pose.knee = [1.3 * rising, 0.7 * rising];
      } else {
        pose.hip = [-0.25, 0.15];
        pose.knee = [0.45, 0.25];
      }
      pose.torsoPitch = 0.12;
      pose.shoulderZ = [0.55, -0.4];
      pose.shoulderX = [-0.2, -0.5];
      pose.thrust = 0.35 + Math.max(0, rising) * 0.6;
    } else if (hs > 0.5) {
      const amp = clamp(hs / PLAYER.sprintSpeed, 0, 1);
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      const stride = 0.45 + 0.45 * amp;
      const kneeBend = 0.35 + 1.0 * amp;
      pose.hip = [-s * stride, s * stride];
      pose.knee = [0.1 + kneeBend * Math.max(0, c), 0.1 + kneeBend * Math.max(0, -c)];
      pose.shoulderX = [s * 0.75 * amp, -0.35 - s * 0.3 * amp];
      pose.elbow = [-0.5 - 0.5 * amp, -0.8];
      pose.torsoPitch = 0.08 + 0.28 * amp;
      pose.bodyY = -0.05 * amp * Math.abs(s);
      pose.thrust = 0.1 + 0.3 * amp;
    } else {
      // Idle breathing.
      pose.bodyY = Math.sin(time * 2.2) * 0.01;
      pose.torsoPitch = 0.03 + Math.sin(time * 2.2) * 0.015;
    }

    if (landT > 0) {
      const k = landT / LAND_TIME;
      pose.bodyY -= 0.14 * k;
      pose.hip = [pose.hip[0] - 0.4 * k, pose.hip[1] - 0.4 * k];
      pose.knee = [pose.knee[0] + 0.8 * k, pose.knee[1] + 0.8 * k];
    }
    return pose;
  }

  const blendPair = (a: [number, number], b: [number, number], k: number) => {
    a[0] += (b[0] - a[0]) * k;
    a[1] += (b[1] - a[1]) * k;
  };

  return {
    group,
    update(p, dt, time) {
      const hs = Math.hypot(p.vel.x, p.vel.z);
      phase += (dt * hs * Math.PI * 2) / (2.2 + hs * 0.15);
      if (p.airJumpsLeft < prevAirJumps) flipT = FLIP_TIME;
      if (p.onGround && !prevOnGround) landT = LAND_TIME;
      prevAirJumps = p.airJumpsLeft;
      prevOnGround = p.onGround;
      flipT = Math.max(0, flipT - dt);
      landT = Math.max(0, landT - dt);

      const target = targetPose(p, time);
      const k = 1 - Math.exp(-dt * 18);
      cur.bodyY += (target.bodyY - cur.bodyY) * k;
      cur.bodyPitch += (target.bodyPitch - cur.bodyPitch) * k;
      cur.torsoPitch += (target.torsoPitch - cur.torsoPitch) * k;
      cur.thrust += (target.thrust - cur.thrust) * (1 - Math.exp(-dt * 30));
      blendPair(cur.hip, target.hip, k);
      blendPair(cur.knee, target.knee, k);
      blendPair(cur.shoulderX, target.shoulderX, k);
      blendPair(cur.shoulderZ, target.shoulderZ, k);
      blendPair(cur.elbow, target.elbow, k);

      // Double-jump front flip, eased, layered on top of the blended pose.
      const f = flipT > 0 ? 1 - flipT / FLIP_TIME : 0;
      const flip = f * f * (3 - 2 * f) * Math.PI * 2;

      body.position.y = 0.95 + cur.bodyY;
      body.rotation.x = cur.bodyPitch + flip;
      torso.rotation.x = cur.torsoPitch;
      for (let i = 0; i < 2; i++) {
        legs[i].hip.rotation.x = cur.hip[i];
        legs[i].knee.rotation.x = cur.knee[i];
        arms[i].shoulder.rotation.x = cur.shoulderX[i];
        arms[i].shoulder.rotation.z = cur.shoulderZ[i];
        arms[i].elbow.rotation.x = cur.elbow[i];
      }

      // Wings: unfold fast when a glide starts, fold a bit slower after.
      const wingTarget = p.gliding ? 1 : 0;
      wingOpen += (wingTarget - wingOpen) * (1 - Math.exp(-dt * (wingTarget ? 12 : 7)));
      const e = wingOpen * wingOpen * (3 - 2 * wingOpen);
      const flutter = Math.sin(time * 3.1) * 0.05 * e;
      for (const w of wings) {
        w.root.rotation.z = w.side * (WING_ROOT_FOLDED + (WING_ROOT_OPEN - WING_ROOT_FOLDED) * e + flutter);
        // Folded wings tuck slightly against the backpack.
        w.root.rotation.y = w.side * 0.25 * (1 - e);
        w.blades.forEach((b, i) => {
          b.pivot.rotation.z = w.side * (BLADE_FOLDED + (b.openAngle - BLADE_FOLDED) * e + flutter * (i + 1) * 0.4);
        });
      }
      WING_GLOW.color.copy(CYAN).multiplyScalar(WING_GLOW_FOLDED + (WING_GLOW_OPEN - WING_GLOW_FOLDED) * e);

      const flicker = 0.85 + 0.15 * Math.sin(time * 60);
      flameGroup.scale.set(1, Math.max(0.05, cur.thrust * flicker), 1);
      flameGroup.visible = cur.thrust > 0.08;

      // Armor seams flare while dash invulnerability is active.
      const boost = p.invuln > 0 ? 2.2 : 1;
      for (const [mat, base] of GLOWS) mat.color.copy(base).multiplyScalar(boost);
    },
  };
}
