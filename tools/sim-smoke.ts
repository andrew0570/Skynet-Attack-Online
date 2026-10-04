// Headless sanity check for sim/: runs the player controller without a browser.
// Usage: npm run sim:smoke
import {
  ARENA_WALK_RADIUS,
  createPlayer,
  heightAt,
  NO_INPUT,
  SIM_DT,
  stepPlayer,
  type PlayerInput,
  type PlayerState,
} from '@sao/sim';

interface Frame {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  aboveGround: number;
  onGround: boolean;
  dashing: boolean;
}

function sim(ticks: number, input: (tick: number, p: PlayerState) => Partial<PlayerInput>, start = { x: 0, z: 30 }) {
  const p = createPlayer(start.x, start.z);
  const frames: Frame[] = [];
  for (let i = 0; i < ticks; i++) {
    stepPlayer(p, { ...NO_INPUT, ...input(i, p) }, SIM_DT);
    frames.push({
      x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
      aboveGround: p.pos.y - heightAt(p.pos.x, p.pos.z), onGround: p.onGround, dashing: p.dashTimer > 0,
    });
  }
  return { p, frames };
}

const maxOf = (frames: Frame[], f: (fr: Frame) => number) => Math.max(...frames.map(f));
const hspeed = (fr: Frame) => Math.hypot(fr.vx, fr.vz);
const firstLanding = (frames: Frame[], after = 1) => frames.findIndex((fr, i) => i >= after && fr.onGround);

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail]);

// Ground movement
const idle = sim(120, () => ({}));
check('idle stays grounded', idle.p.onGround && Math.abs(idle.p.pos.z - 30) < 0.01);
const run = sim(60, () => ({ moveZ: -1 }));
check('run speed ~10', Math.abs(maxOf(run.frames, hspeed) - 10) < 0.5, maxOf(run.frames, hspeed).toFixed(1));
const sprint = sim(60, () => ({ moveZ: -1, sprint: true }));
check('sprint speed ~16', Math.abs(maxOf(sprint.frames, hspeed) - 16) < 0.5);

// Jumps: higher, farther, committed
const jump = sim(120, t => ({ jump: t === 0 }));
const jumpHeight = maxOf(jump.frames, f => f.aboveGround);
check('jump height > 3.5 m', jumpHeight > 3.5 && jump.p.onGround, jumpHeight.toFixed(2));
const dbl = sim(150, t => ({ jump: t === 0 || t === 30 }));
check('double jump goes higher', maxOf(dbl.frames, f => f.aboveGround) > jumpHeight + 1, maxOf(dbl.frames, f => f.aboveGround).toFixed(2));

const takeoffTick = 30;
const longJump = sim(150, t => ({ moveZ: -1, sprint: true, jump: t === takeoffTick }));
const land = firstLanding(longJump.frames, takeoffTick + 2);
const jumpDist = Math.abs(longJump.frames[land].z - longJump.frames[takeoffTick].z);
check('sprint jump distance > 15 m', jumpDist > 15, jumpDist.toFixed(1));

// Jump forward, then hold the opposite direction mid-air: velocity must not change.
const committed = sim(120, t => ({ moveZ: t < 3 ? -1 : 1, jump: t === 0 }));
const cLand = firstLanding(committed.frames, 2);
const airborne = committed.frames.slice(1, cLand);
check('jump direction is locked in the air', airborne.every(f => Math.abs(f.vz - airborne[0].vz) < 1e-9 && f.vz < -10), `vz=${airborne[0].vz.toFixed(1)}`);

const redirect = sim(60, t => ({ moveZ: t < 15 ? -1 : 0, moveX: t >= 15 ? 1 : 0, jump: t === 0 || t === 15 }));
check('double jump redirects', redirect.frames[16].vx > 9 && Math.abs(redirect.frames[16].vz) < 1e-9);

// Dashes: farther, 3D, limited in the air
const dash = sim(15, t => ({ moveZ: -1, dash: t === 0 }));
const dashDist = 30 - dash.p.pos.z;
check('dash covers > 10 m', dashDist > 10, dashDist.toFixed(1));

const upDash = sim(90, t => ({ dash: t === 0, aimZ: -1, aimPitch: 0.8 }));
const upHeight = maxOf(upDash.frames, f => f.aboveGround);
check('up-dash gains > 6 m', upHeight > 6, upHeight.toFixed(1));

const groundDown = sim(15, t => ({ dash: t === 0, aimZ: -1, aimPitch: -1 }));
check('ground dash cannot aim into floor', groundDown.frames.every(f => f.onGround) && 30 - groundDown.p.pos.z > 10);

const downDash = sim(120, t => ({ jump: t === 0, dash: t === 20, aimZ: -1, aimPitch: -1 }));
const dLand = firstLanding(downDash.frames, 21);
check('down-dash slams and ends on landing', dLand > 0 && dLand < 30 && !downDash.frames[dLand].dashing, `landed tick ${dLand}`);

// Jump, air-dash, double jump, try a second air-dash after cooldown: it must be refused.
const limit = sim(80, t => ({ jump: t === 0 || t === 20, dash: t === 3 || t === 45, aimZ: -1, aimPitch: 0.3 }));
check('one air-dash per airtime', !limit.frames[46].onGround && !limit.frames[46].dashing);

// Boundary
const wall = sim(600, () => ({ moveZ: 1, sprint: true }));
check('rim boundary holds', Math.hypot(wall.p.pos.x, wall.p.pos.z) <= ARENA_WALK_RADIUS + 1e-6);

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
