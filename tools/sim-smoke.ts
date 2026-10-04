// Headless sanity check for sim/: runs the player controller without a browser.
// Usage: npm run sim:smoke
import {
  ARENA_WALK_RADIUS,
  createPlayer,
  EMPTY_ARENA,
  generateArena,
  heightAt,
  makeBox,
  moverSolid,
  mulberry32,
  NO_INPUT,
  raycast,
  SIM_DT,
  solidTop,
  stepPlayer,
  towerFromBase,
  towerSlices,
  type Arena,
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
  climbing: boolean;
}

function sim(
  ticks: number,
  input: (tick: number, p: PlayerState) => Partial<PlayerInput>,
  opts: { start?: { x: number; z: number }; arena?: Arena; setup?: (p: PlayerState) => void } = {}
) {
  const arena = opts.arena ?? EMPTY_ARENA;
  const start = opts.start ?? { x: 0, z: 30 };
  const p = createPlayer(start.x, start.z);
  opts.setup?.(p);
  const frames: Frame[] = [];
  for (let i = 0; i < ticks; i++) {
    stepPlayer(p, { ...NO_INPUT, ...input(i, p) }, SIM_DT, arena, i * SIM_DT);
    frames.push({
      x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
      aboveGround: p.pos.y - heightAt(p.pos.x, p.pos.z), onGround: p.onGround, dashing: p.dashTimer > 0, climbing: p.climbing,
    });
  }
  return { p, frames };
}

const maxOf = (frames: Frame[], f: (fr: Frame) => number) => Math.max(...frames.map(f));
const hspeed = (fr: Frame) => Math.hypot(fr.vx, fr.vz);
const firstLanding = (frames: Frame[], after = 1) => frames.findIndex((fr, i) => i >= after && fr.onGround);

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail]);

// ---------- Open-ground movement ----------
const idle = sim(120, () => ({}));
check('idle stays grounded', idle.p.onGround && Math.abs(idle.p.pos.z - 30) < 0.01);
const run = sim(60, () => ({ moveZ: -1 }));
check('run speed ~10', Math.abs(maxOf(run.frames, hspeed) - 10) < 0.5, maxOf(run.frames, hspeed).toFixed(1));
const sprint = sim(60, () => ({ moveZ: -1, sprint: true }));
check('sprint speed ~16', Math.abs(maxOf(sprint.frames, hspeed) - 16) < 0.5);

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

const committed = sim(120, t => ({ moveZ: t < 3 ? -1 : 1, jump: t === 0 }));
const cLand = firstLanding(committed.frames, 2);
const airborne = committed.frames.slice(1, cLand);
check('jump direction is locked in the air', airborne.every(f => Math.abs(f.vz - airborne[0].vz) < 1e-9 && f.vz < -10), `vz=${airborne[0].vz.toFixed(1)}`);

const redirect = sim(60, t => ({ moveZ: t < 15 ? -1 : 0, moveX: t >= 15 ? 1 : 0, jump: t === 0 || t === 15 }));
check('double jump redirects', redirect.frames[16].vx > 9 && Math.abs(redirect.frames[16].vz) < 1e-9);

const dash = sim(15, t => ({ moveZ: -1, dash: t === 0 }));
check('dash covers > 10 m', 30 - dash.p.pos.z > 10, (30 - dash.p.pos.z).toFixed(1));
const upDash = sim(90, t => ({ dash: t === 0, aimZ: -1, aimPitch: 0.8 }));
check('up-dash gains > 6 m', maxOf(upDash.frames, f => f.aboveGround) > 6, maxOf(upDash.frames, f => f.aboveGround).toFixed(1));
const groundDown = sim(15, t => ({ dash: t === 0, aimZ: -1, aimPitch: -1 }));
check('ground dash cannot aim into floor', groundDown.frames.every(f => f.onGround) && 30 - groundDown.p.pos.z > 10);
const downDash = sim(120, t => ({ jump: t === 0, dash: t === 20, aimZ: -1, aimPitch: -1 }));
const dLand = firstLanding(downDash.frames, 21);
check('down-dash slams and ends on landing', dLand > 0 && dLand < 30 && !downDash.frames[dLand].dashing, `landed tick ${dLand}`);
const limit = sim(80, t => ({ jump: t === 0 || t === 20, dash: t === 3 || t === 45, aimZ: -1, aimPitch: 0.3 }));
check('one air-dash per airtime', !limit.frames[46].onGround && !limit.frames[46].dashing);

const rim = sim(900, () => ({ moveZ: 1, sprint: true }));
check('arena boundary holds', Math.hypot(rim.p.pos.x, rim.p.pos.z) <= ARENA_WALK_RADIUS + 1e-6);

// ---------- Solids ----------
const wallTop = heightAt(0, 20) + 6;
const wallArena: Arena = { ...EMPTY_ARENA, statics: [makeBox('wall', 0, 20, 5, 0.6, 0, -5, wallTop)] };
const blocked = sim(120, () => ({ moveZ: -1, sprint: true }), { arena: wallArena });
check('wall blocks movement', Math.abs(blocked.p.pos.z - 21.0) < 0.05, blocked.p.pos.z.toFixed(2));

const landOn = sim(90, () => ({}), { arena: wallArena, start: { x: 0, z: 20 }, setup: p => (p.pos.y = wallTop + 3) });
check('falls onto and stands on a wall top', landOn.p.onGround && Math.abs(landOn.p.pos.y - wallTop) < 1e-6);

const vineArena: Arena = { ...EMPTY_ARENA, statics: [makeBox('wall', 0, 20, 5, 0.6, 0, -5, wallTop, true)] };
const climb = sim(240, (_, p) => (p.onGround && p.pos.y > wallTop - 0.1 ? {} : { moveZ: -1 }), { arena: vineArena, start: { x: 0, z: 22 } });
const climbTick = climb.frames.findIndex(f => f.climbing);
check('vines: climb up and mantle onto the top', climbTick >= 0 && climb.p.onGround && Math.abs(climb.p.pos.y - wallTop) < 1e-6, `top reached: ${climb.p.pos.y.toFixed(2)}`);

const wallJump = sim(40, t => ({ moveZ: t < 20 ? -1 : 0, jump: t === 20 }), { arena: vineArena, start: { x: 0, z: 22 } });
check('vines: wall jump kicks away', wallJump.frames[19].climbing && wallJump.frames[21].vz > 5 && wallJump.frames[21].vy > 10);

const noVines = sim(120, () => ({ moveZ: -1 }), { arena: wallArena, start: { x: 0, z: 22 } });
check('plain walls are not climbable', noVines.frames.every(f => !f.climbing && f.aboveGround < 0.01));

const g30 = heightAt(0, 30);
// Phase -π/2: shift starts at 0 and reaches full displacement at t = period / 2.
const sliderArena: Arena = {
  ...EMPTY_ARENA,
  movers: [{ base: makeBox('shifter', 0, 30, 2, 2, 0, g30 - 1, g30 + 0.4), amp: { x: 6, y: 0, z: 0 }, period: 4, phase: -Math.PI / 2 }],
};
const ride = sim(120, () => ({}), { arena: sliderArena, setup: p => (p.pos.y = g30 + 0.4) });
const sliderX = moverSolid(sliderArena.movers[0], 120 * SIM_DT).x;
check('sliding wall carries a player standing on it', Math.abs(ride.p.pos.x - sliderX) < 0.2 && ride.p.onGround && sliderX > 5.9, `player ${ride.p.pos.x.toFixed(2)} vs wall ${sliderX.toFixed(2)}`);

const pushArena: Arena = {
  ...EMPTY_ARENA,
  movers: [{ base: makeBox('shifter', -4, 30, 0.5, 3, 0, g30 - 1, g30 + 5), amp: { x: 8, y: 0, z: 0 }, period: 4, phase: -Math.PI / 2 }],
};
const shove = sim(120, () => ({}), { arena: pushArena });
check('sliding wall shoves a player aside', shove.p.pos.x > 4.8, `x=${shove.p.pos.x.toFixed(2)}`);

const riseArena: Arena = {
  ...EMPTY_ARENA,
  movers: [{ base: makeBox('shifter', 0, 30, 2, 2, 0, g30 - 6, g30 - 0.5), amp: { x: 0, y: 5, z: 0 }, period: 4, phase: -Math.PI / 2 }],
};
const rise = sim(120, () => ({}), { arena: riseArena });
check('rising wall lifts a player out of the ground', rise.p.onGround && rise.p.pos.y > g30 + 4.3, `y=${(rise.p.pos.y - g30).toFixed(2)} above ground`);

const slabArena: Arena = { ...EMPTY_ARENA, statics: [makeBox('slab', 0, 30, 5, 5, 0, g30 + 3, g30 + 3.6)] };
const bonk = sim(90, t => ({ jump: t === 0 }), { arena: slabArena });
check('ceiling stops a jump', maxOf(bonk.frames, f => f.y - g30) <= 3 - 1.8 + 1e-6 && bonk.p.onGround, `peak ${maxOf(bonk.frames, f => f.y - g30).toFixed(2)}`);

const ramp = towerFromBase(0, 30, -Math.PI / 2, (58 * Math.PI) / 180, 8, 6, 2.5, 2.5, false, 'ramp');
const rampArena: Arena = { ...EMPTY_ARENA, statics: towerSlices(ramp, 0.4) };
const walkUp = sim(150, () => ({ moveZ: -1 }), { arena: rampArena, start: { x: 0, z: 38 } });
check('walk up a fallen-tower ramp', maxOf(walkUp.frames, f => f.aboveGround) > 5.5, `peak ${maxOf(walkUp.frames, f => f.aboveGround).toFixed(2)} m`);

const losBlocked = raycast(wallArena, { x: 0, y: 1, z: 30 }, { x: 0, y: 1, z: 10 }, 0);
const losOver = raycast(wallArena, { x: 0, y: wallTop + 2, z: 30 }, { x: 0, y: wallTop + 2, z: 10 }, 0);
check('line of sight blocked by wall, clear over it', Math.abs(losBlocked - 0.47) < 0.01 && losOver === 1, `t=${losBlocked.toFixed(3)}`);

// ---------- Generated arena ----------
const arena = generateArena();
const count = (k: string) => arena.statics.filter(s => s.kind === k).length;
check('arena generates walls, slabs, towers, shifting walls', count('wall') > 100 && count('slab') > 40 && arena.towers.length === 8 && arena.movers.length > 20,
  `${count('wall')} walls, ${count('slab')} slabs, ${count('parapet')} parapets, ${arena.towers.length} towers, ${arena.movers.length} shifting walls, ${arena.statics.filter(s => s.climbable).length} climbable`);
const spawnIdle = sim(120, () => ({}), { arena, start: arena.spawn });
check('spawn is clear', Math.hypot(spawnIdle.p.pos.x - arena.spawn.x, spawnIdle.p.pos.z - arena.spawn.z) < 1e-6 && spawnIdle.p.onGround);

// Cover analysis: how exposed is ground level to Skynet's perch?
const eye = arena.skynetAnchor;
const exposed = (x: number, z: number, t = 0) => raycast(arena, eye, { x, y: heightAt(x, z) + 1.2, z }, t) === 1;
let corridorClear = 0;
let corridorTotal = 0;
for (let r = 26; r <= 96; r += 5) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const off of [-4, 0, 4]) {
  corridorTotal++;
  if (exposed(dx * r + dz * off, dz * r + dx * off)) corridorClear++;
}
let fortExposed = 0;
let fortTotal = 0;
const rng = mulberry32(5);
while (fortTotal < 400) {
  const a = rng() * Math.PI * 2;
  const r = 30 + rng() * 64;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  if (Math.abs(x) < 9 || Math.abs(z) < 9) continue;
  fortTotal++;
  if (exposed(x, z)) fortExposed++;
}
check('corridors are open lines of attack (> 90% visible to Skynet)', corridorClear / corridorTotal > 0.9, `${((100 * corridorClear) / corridorTotal).toFixed(0)}% visible`);
check('fortresses give cover (< 35% of ground visible to Skynet)', fortExposed / fortTotal < 0.35, `${((100 * fortExposed) / fortTotal).toFixed(0)}% visible`);

const quadRamp = arena.towers.find(t => t.style === 'ramp' && t.center.x > 0 && t.center.z > 0)!;
const rampUp = sim(400, (_, p) => (p.onGround && p.pos.y > 6.5 ? {} : { moveX: Math.SQRT1_2, moveZ: Math.SQRT1_2 }), { arena, start: { x: 7, z: 7 } });
check('glade ramp leads onto level 1', rampUp.p.onGround && rampUp.p.pos.y > 6.5, `y=${rampUp.p.pos.y.toFixed(2)} (ramp at ${quadRamp.center.x.toFixed(1)}, ${quadRamp.center.z.toFixed(1)})`);

const pillarTop = solidTop(arena.pillar!);
const pillarClimb = sim(360, (_, p) => (p.onGround && p.pos.y > pillarTop - 0.1 ? {} : { moveZ: -1 }), { arena, start: { x: 0, z: 4.5 } });
check('climb the central pillar to the top', pillarClimb.p.onGround && Math.abs(pillarClimb.p.pos.y - pillarTop) < 1e-6, `y=${pillarClimb.p.pos.y.toFixed(1)} top=${pillarTop.toFixed(1)}`);

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
