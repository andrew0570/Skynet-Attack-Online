// Headless sanity check for sim/: runs the player controller without a browser.
// Usage: npm run sim:smoke
import {
  ARENA_WALK_RADIUS,
  ARMS,
  BOSS,
  bossCanSee,
  BOSS_REACH,
  COUNTERS,
  describeStyle,
  MOVES,
  REWARD,
  validArms,
  createFight,
  heuristicBrain,
  computeFeatures,
  createArmModel,
  createPolicy,
  FEATURE_DIM,
  FEATURE_NAMES,
  learnedBrain,
  predict,
  resolveDecisions,
  rewardOf,
  selectArm,
  toSubmission,
  trainOn,
  updateArm,
  validateSubmission,
  STAMINA,
  VITALS,
  stepFight,
  type Brain,
  type FightEvent,
  createPlayer,
  EMPTY_ARENA,
  generateArena,
  heightAt,
  makeBox,
  moverSolid,
  mulberry32,
  NO_INPUT,
  PLAYER,
  SKILLS,
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
check('sprint speed ~22', Math.abs(maxOf(sprint.frames, hspeed) - 22) < 0.5, maxOf(sprint.frames, hspeed).toFixed(1));

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

const steerAir = sim(120, t => ({ moveZ: t < 3 ? -1 : 1, jump: t === 0 }));
const sLand = firstLanding(steerAir.frames, 2);
check('air control: reverse direction mid-jump', steerAir.frames[sLand - 1].vz > 5, `vz before landing ${steerAir.frames[sLand - 1].vz.toFixed(1)}`);
const coast = sim(120, t => ({ moveZ: t < 3 ? -1 : 0, jump: t === 0 }));
const coastAir = coast.frames.slice(3, firstLanding(coast.frames, 2));
check('air momentum kept with no input', coastAir.every(f => Math.abs(f.vz - coastAir[0].vz) < 1e-9 && f.vz < -10));
const turnKeepsSpeed = sim(60, t => ({ moveZ: t < 30 ? -1 : 0, moveX: t >= 33 ? 1 : 0, sprint: true, jump: t === 30 }));
const takeoffSpeed = hspeed(turnKeepsSpeed.frames[31]);
check('air steering: 90° turn keeps full speed', Math.abs(turnKeepsSpeed.frames[59].vx - takeoffSpeed) < 0.01 && takeoffSpeed > 16,
  `${takeoffSpeed.toFixed(1)} m/s → ${hspeed(turnKeepsSpeed.frames[59]).toFixed(1)} m/s heading +x`);

// Glide (hold in the air)
const plainFall = sim(300, t => ({ jump: t === 0 || t === 30 }));
const glideFall = sim(600, t => ({ jump: t === 0 || t === 30, glide: t > 30, moveZ: -1 }));
const plainAir = firstLanding(plainFall.frames, 31);
const glideAir = firstLanding(glideFall.frames, 31);
const glideMinVy = Math.min(...glideFall.frames.slice(80, glideAir).map(f => f.vy));
check('glide: slow capped descent, much longer airtime', glideAir > plainAir * 1.8 && glideMinVy >= -3 - 1e-9, `airtime ${plainAir} → ${glideAir} ticks, min vy ${glideMinVy.toFixed(2)}`);
check('glide: travels far', 30 - glideFall.frames[glideAir].z > 40, `${(30 - glideFall.frames[glideAir].z).toFixed(1)} m`);
const glideJump = sim(120, t => ({ jump: t === 0, glide: true }));
check('glide does not stretch jumps upward', Math.abs(maxOf(glideJump.frames, f => f.aboveGround) - jumpHeight) < 0.05);
const dive = sim(200, t => ({ jump: t === 0 || t === 30, glide: t > 30, moveZ: -1, aimPitch: -0.8 }));
const diveMinVy = Math.min(...dive.frames.slice(80, firstLanding(dive.frames, 31)).map(f => f.vy));
check('glide: looking down dives faster', diveMinVy < -8 && maxOf(dive.frames, hspeed) > 22, `vy ${diveMinVy.toFixed(1)}, speed ${maxOf(dive.frames, hspeed).toFixed(1)}`);

const redirect = sim(60, t => ({ moveZ: t < 15 ? -1 : 0, moveX: t >= 15 ? 1 : 0, jump: t === 0 || t === 15 }));
check('double jump redirects', redirect.frames[16].vx > 9 && Math.abs(redirect.frames[16].vz) < 1e-9);

const dash = sim(15, t => ({ moveZ: -1, dash: t === 0 }));
check('dash covers > 10 m', 30 - dash.p.pos.z > 10, (30 - dash.p.pos.z).toFixed(1));
const upDash = sim(90, t => ({ dash: t === 0, aimZ: -1, aimPitch: 0.8 }));
check('up-dash gains > 6 m', maxOf(upDash.frames, f => f.aboveGround) > 6, maxOf(upDash.frames, f => f.aboveGround).toFixed(1));
const steepDash = sim(90, t => ({ dash: t === 0, aimZ: -1, aimPitch: 2 }));
check('near-vertical up-dash gains > 13 m', maxOf(steepDash.frames, f => f.aboveGround) > 13, maxOf(steepDash.frames, f => f.aboveGround).toFixed(1));
const groundDown = sim(15, t => ({ dash: t === 0, aimZ: -1, aimPitch: -1 }));
check('ground dash cannot aim into floor', groundDown.frames.every(f => f.onGround) && 30 - groundDown.p.pos.z > 10);
const downDash = sim(120, t => ({ jump: t === 0, dash: t === 20, aimZ: -1, aimPitch: -1 }));
const dLand = firstLanding(downDash.frames, 21);
check('down-dash slams and ends on landing', dLand > 0 && dLand < 30 && !downDash.frames[dLand].dashing, `landed tick ${dLand}`);
// Stamina: no fixed air-jump/air-dash charges — everything is paid for with stamina.
const airJumps = sim(150, t => ({ jump: t % 25 === 0 }));
check('air jumps chain until stamina runs out (15 + 4×20 = 95)', airJumps.p.airJumpCount === 4, `${airJumps.p.airJumpCount} air jumps`);
let dashesStarted = 0;
sim(140, (t, p) => {
  if (p.dashTimer > PLAYER.dashTime - SIM_DT * 1.5) dashesStarted++;
  return { dash: t % 34 === 0, aimZ: -1, aimPitch: 0.4 };
});
check('dashes chain (ground or air) until stamina runs out (4 × 25)', dashesStarted === 4, `${dashesStarted} dashes`);
const drain = sim(60 * 7, () => ({ moveZ: -1, sprint: true }), { start: { x: 0, z: 0 }, setup: p => (p.pos = { x: -60, y: heightAt(-60, -60), z: 80 }) });
check('sprint drains stamina, then falls back to run speed', drain.p.stamina === 0 && Math.abs(hspeed(drain.frames[drain.frames.length - 1]) - PLAYER.runSpeed) < 0.5,
  `stamina ${drain.p.stamina.toFixed(1)}, speed ${hspeed(drain.frames[drain.frames.length - 1]).toFixed(1)}`);
const regen = sim(60 * 4, () => ({}), { setup: p => (p.stamina = 0) });
check('stamina regenerates to full within ~4 s', regen.p.stamina === STAMINA.max, `${regen.p.stamina.toFixed(1)}`);
// Long airtime (dropped from 1500 m, mashing jump every 0.42 s): one bar of stamina, no refills.
const skyfall = sim(60 * 7, t => ({ jump: t % 25 === 0 }), { setup: p => { p.pos.y += 1500; p.onGround = false; } });
check('no stamina regen in the air: jumps end when the bar does (5 × 20)', skyfall.p.airJumpCount === 5 && !skyfall.p.onGround && skyfall.p.stamina < STAMINA.airJumpCost,
  `${skyfall.p.airJumpCount} air jumps over 7 s airborne, stamina ${skyfall.p.stamina.toFixed(1)}`);
const glideRegen = sim(60 * 4, () => ({ glide: true }), { setup: p => { p.pos.y += 200; p.onGround = false; p.stamina = 0; } });
check('no stamina regen while gliding', glideRegen.p.stamina === 0 && !glideRegen.p.onGround);
const tallVines: Arena = { ...EMPTY_ARENA, statics: [makeBox('wall', 0, 20, 5, 0.6, 0, -5, heightAt(0, 20) + 60, true)] };
const climbRegen = sim(60 * 3, () => ({ moveZ: -1 }), { arena: tallVines, start: { x: 0, z: 22 }, setup: p => (p.stamina = 0) });
check('stamina regenerates while climbing vines', climbRegen.p.climbing && climbRegen.p.stamina > 50, `${climbRegen.p.stamina.toFixed(1)} after 3 s climbing`);
const landRegen = sim(60 * 4, () => ({}), { setup: p => { p.pos.y += 3; p.onGround = false; p.stamina = 0; } });
check('stamina regenerates after landing', landRegen.p.onGround && landRegen.p.stamina > 80, `${landRegen.p.stamina.toFixed(1)}`);

const exhausted = sim(60, t => ({ jump: t === 0, dash: t === 0 }), { setup: p => (p.stamina = 5) });
check('no stamina: no jump, no dash', exhausted.frames.every(f => f.onGround && !f.dashing));

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

// ---------- Combat ----------
type Fight = ReturnType<typeof createFight>;
function runFight(seconds: number, input: (f: Fight, tick: number) => Partial<PlayerInput>, opts: { arena?: Arena; brain?: Brain; setup?: (f: Fight) => void; seed?: number } = {}) {
  const a = opts.arena ?? arena;
  const f = createFight(a, opts.seed ?? 7);
  opts.setup?.(f);
  const events: FightEvent[] = [];
  let minEnergy = Infinity;
  for (let i = 0; i < seconds * 60; i++) {
    events.push(...stepFight(f, a, { ...NO_INPUT, ...input(f, i) }, SIM_DT, opts.brain ?? heuristicBrain));
    minEnergy = Math.min(minEnergy, f.boss.energy);
  }
  return { f, events, minEnergy };
}
const armIs = (attack: string, aim = 'direct'): Brain => (_f, _a, valid) => valid.find(i => { const arm = ARMS[i]; return arm.kind === 'attack' && arm.attack === attack && arm.aim === aim; }) ?? valid[0];
const alwaysAttack: Brain = (_f, _a, valid) => valid.find(i => ARMS[i].kind === 'attack') ?? valid[0];

const idleInCorridor = runFight(30, () => ({}));
check('Skynet hits an idle player standing in a corridor', idleInCorridor.f.armor + idleInCorridor.f.health < VITALS.armor + VITALS.health, `armor ${idleInCorridor.f.armor.toFixed(0)} health ${idleInCorridor.f.health.toFixed(0)}, ${idleInCorridor.f.decisions.length} decisions`);

const firstHit = runFight(10, () => ({}), { brain: armIs('volley') });
const hit = firstHit.events.find(e => e.type === 'playerHit');
check('armor absorbs damage before health', hit?.type === 'playerHit' && hit.armor > 0 && hit.health === 0, hit?.type === 'playerHit' ? `first hit: ${hit.armor} armor, ${hit.health} health` : 'no hit');
const waitBrain: Brain = () => 0;
const recover = runFight(12, () => ({}), { brain: waitBrain, setup: f => { f.armor = 10; f.health = 60; f.armorDelay = 4; } });
check('armor regenerates, health does not', recover.f.armor === VITALS.armor && recover.f.health === 60, `armor ${recover.f.armor.toFixed(1)}, health ${recover.f.health}`);

const spam = runFight(60, () => ({}), { brain: alwaysAttack, setup: f => (f.health = 1e9) });
const attacks = spam.f.decisions.filter(d => ARMS[d.arm].kind === 'attack').length;
check('energy caps attack rate (always-attack brain, 60 s)', attacks <= 32 && spam.minEnergy >= 0, `${attacks} attacks, min energy ${spam.minEnergy.toFixed(1)}`);

const coverArena: Arena = { ...EMPTY_ARENA, skynetAnchor: { x: 0, y: 25, z: 0 }, spawn: { x: 0, z: 30 }, statics: [makeBox('wall', 0, 26, 8, 0.6, 0, -5, heightAt(0, 26) + 12)] };
const behindWall = runFight(20, () => ({}), { arena: coverArena, brain: armIs('volley') });
check('walls block Skynet\'s bolts', behindWall.f.armor === VITALS.armor && behindWall.events.some(e => e.type === 'impact'), `armor ${behindWall.f.armor}`);
const mortarOver = runFight(20, () => ({}), { arena: coverArena, brain: armIs('mortar') });
check('mortar shells arc over walls', mortarOver.f.armor < VITALS.armor, `armor ${mortarOver.f.armor.toFixed(0)} health ${mortarOver.f.health.toFixed(0)}`);

const dodging = runFight(20, f => ((f.player.invuln = 1), {}), { brain: armIs('volley') });
check('dash i-frames dodge attacks', dodging.f.armor === VITALS.armor && dodging.events.some(e => e.type === 'dodged'));

const swordSetup = (f: Fight) => {
  f.boss.cooldown = 1e9;
  f.boss.pos = { x: f.player.pos.x, y: f.player.pos.y + 1.1, z: f.player.pos.z - 4 };
};
const combo = runFight(2, (_f, t) => ({ attack: t === 0 || t === 20 || t === 40, aimZ: -1 }), { setup: swordSetup });
check('sword 3-hit combo damages Skynet (28 + 28 + 44)', combo.f.boss.hp === BOSS.maxHp - 100, `HP ${combo.f.boss.hp}`);
const whiff = runFight(1, (_f, t) => ({ attack: t === 0, aimZ: 1 }), { setup: swordSetup });
check('sword misses when facing away', whiff.f.boss.hp === BOSS.maxHp);

// Dive slam, then punish while Skynet is stunned on the ground.
let stunHit = 0;
const diveFight = runFight(8, (f, t) => {
  const b = f.boss;
  if (b.phase === 'recover' && !stunHit) {
    // Stand next to the landed boss and swing at it.
    f.player.pos = { x: b.pos.x, y: heightAt(b.pos.x, b.pos.z), z: b.pos.z + 3.5 };
    f.hurt = 1;
    stunHit = t;
    return { attack: true, aimZ: -1 };
  }
  return {};
}, { brain: armIs('dive'), setup: f => { f.player.pos = { x: 0, y: heightAt(0, 40), z: 40 }; f.boss.energy = 100; f.boss.cooldown = 0; } });
const stunDamage = diveFight.events.find(e => e.type === 'bossHit');
check('Dive Slam lands and leaves Skynet stunned (1.5x damage)', diveFight.events.some(e => e.type === 'slam') && stunDamage?.type === 'bossHit' && stunDamage.stunned && stunDamage.damage === 42,
  stunDamage?.type === 'bossHit' ? `hit for ${stunDamage.damage}` : 'no hit');

const win = runFight(1, (_f, t) => ({ attack: t === 0, aimZ: -1 }), { setup: f => { swordSetup(f); f.boss.hp = 10; } });
check('defeating Skynet wins the fight', win.f.outcome === 'won' && win.events.some(e => e.type === 'won'));
const lose = runFight(30, () => ({}), { setup: f => { f.health = 1; f.armor = 0; } });
check('running out of HP loses the fight', lose.f.outcome === 'lost' && lose.events.some(e => e.type === 'lost'));

// ---------- Skills ----------
const calm = (f: Fight) => (f.boss.cooldown = 1e9);
/** Camera 6 m behind and 3 m above the player, looking at `target`. */
const lookAt = (f: Fight, target: { x: number; y: number; z: number }) => {
  const eye = { x: f.player.pos.x, y: f.player.pos.y + 3, z: f.player.pos.z + 6 };
  const d = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
  const l = Math.hypot(d.x, d.y, d.z);
  return { eyeX: eye.x, eyeY: eye.y, eyeZ: eye.z, lookX: d.x / l, lookY: d.y / l, lookZ: d.z / l };
};
const placeAt = (z: number) => (f: Fight) => {
  calm(f);
  f.player.pos = { x: 0, y: heightAt(0, z), z };
};
const bolt = runFight(1, (f, t) => ({ ...lookAt(f, f.boss.pos), skill: t === 0 ? 1 : 0 }), { setup: placeAt(24) });
check('lightning (1) strikes Skynet on its perch when aimed at it', bolt.f.boss.hp === BOSS.maxHp - SKILLS.lightning.damage && bolt.events.some(e => e.type === 'lightning' && e.hit),
  `Skynet HP ${bolt.f.boss.hp}`);
const boltMiss = runFight(1, (f, t) => ({ ...lookAt(f, { x: 30, y: 0, z: 10 }), skill: t === 0 ? 1 : 0 }), { setup: placeAt(24) });
const missPos = boltMiss.events.find(e => e.type === 'lightning');
check('lightning aimed away misses, lands within range', boltMiss.f.boss.hp === BOSS.maxHp && missPos?.type === 'lightning' && Math.hypot(missPos.pos.x, missPos.pos.z - 24) <= SKILLS.lightning.maxRange + 1e-6);
const beam = runFight(2, (f, t) => ({ ...lookAt(f, f.boss.pos), skill: t === 0 ? 3 : 0 }), { setup: placeAt(40) });
check('sword beam (3) hits Skynet', beam.f.boss.hp === BOSS.maxHp - SKILLS.beam.damage && beam.events.some(e => e.type === 'beamImpact' && e.hitBoss), `Skynet HP ${beam.f.boss.hp}`);
const beamWall = runFight(2, (f, t) => ({ ...lookAt(f, f.boss.pos), skill: t === 0 ? 3 : 0 }), { arena: coverArena, setup: f => { calm(f); } });
check('sword beam is blocked by walls', beamWall.f.boss.hp === BOSS.maxHp && beamWall.events.some(e => e.type === 'beamImpact' && !e.hitBoss));
const spamBeam = runFight(2, (f, t) => ({ ...lookAt(f, f.boss.pos), skill: t % 20 === 0 ? 3 : 0 }), { setup: placeAt(40) });
check('skill cooldowns stop spamming (beam 2.5 s)', spamBeam.events.filter(e => e.type === 'beamFired').length === 1);
let bossZ = 0;
const rush = runFight(1.2, (f, t) => ({ eyeX: 0, eyeY: 0, eyeZ: 0, lookX: 0, lookY: 0, lookZ: -1, skill: t === 0 ? 2 : 0 }), {
  setup: f => { placeAt(40)(f); f.boss.pos = { x: 0, y: f.player.pos.y + 1.1, z: 32 }; bossZ = 32; },
});
const rushHits = rush.events.filter(e => e.type === 'bossHit').length;
check('blade rush (2) slashes through Skynet', rushHits >= 3 && rush.f.player.pos.z < bossZ - 3, `${rushHits} hits, ended at z=${rush.f.player.pos.z.toFixed(1)} (Skynet at ${bossZ})`);

// ---------- Skynet moveset 2.0: mobility + style counters ----------
/** Brain that plays `first` once (when valid), then only waits. */
const once = (match: (a: (typeof ARMS)[number]) => boolean): Brain => {
  let done = false;
  return (_f, _a, valid) => {
    const i = valid.find(k => match(ARMS[k]));
    if (done || i === undefined) return 0;
    done = true;
    return i;
  };
};
const isMove = (m: string) => (a: (typeof ARMS)[number]) => a.kind === 'move' && a.move === m;
const isAtk = (atk: string, aim?: string) => (a: (typeof ARMS)[number]) => a.kind === 'attack' && a.attack === atk && (!aim || a.aim === aim);
const ready = (f: Fight) => { f.boss.cooldown = 0; f.boss.energy = 100; };

const hunt = runFight(4, () => ({}), { brain: once(isMove('hunt')), setup: f => { ready(f); f.player.pos = { x: 0, y: heightAt(0, 60), z: 60 }; } });
const huntGap = Math.hypot(hunt.f.boss.pos.x - hunt.f.player.pos.x, hunt.f.boss.pos.z - hunt.f.player.pos.z);
check('Hunt: Skynet leaves its perch and closes to sweep range', hunt.events.some(e => e.type === 'move' && e.move === 'hunt') && huntGap < MOVES.huntRange + 0.5 && validArms(hunt.f).some(i => isAtk('sweep')(ARMS[i])),
  `${huntGap.toFixed(1)} m away, ${hunt.f.boss.pos.y.toFixed(1)} m up`);
const flank = runFight(4, () => ({}), { arena: coverArena, brain: once(isMove('flank')), setup: ready });
check('Flank: Skynet moves to regain line of sight on a hidden player', !bossCanSee(createFight(coverArena, 1), coverArena) && bossCanSee(flank.f, coverArena),
  `now at ${flank.f.boss.pos.x.toFixed(1)}, ${flank.f.boss.pos.y.toFixed(1)}, ${flank.f.boss.pos.z.toFixed(1)}`);
const back = runFight(3, () => ({}), { brain: once(isMove('retreat')), setup: f => { ready(f); f.boss.pos = { x: 30, y: 20, z: 30 }; } });
check('Retreat: Skynet flies back to its perch', Math.hypot(back.f.boss.pos.x - back.f.boss.perch.x, back.f.boss.pos.y - back.f.boss.perch.y, back.f.boss.pos.z - back.f.boss.perch.z) < 1e-6);

const reflected = runFight(3, (f, t) => ({ ...lookAt(f, f.boss.pos), skill: t === 20 ? 3 : 0 }), { brain: once(isAtk('reflect')), setup: f => { placeAt(40)(f); ready(f); } });
check('Reflect Shield bounces a sword beam back at the player', reflected.f.boss.hp === BOSS.maxHp && reflected.events.some(e => e.type === 'reflected' && e.what === 'beam') && reflected.f.armor === VITALS.armor - COUNTERS.reflectBeamDamage,
  `Skynet HP ${reflected.f.boss.hp}, player armor ${reflected.f.armor.toFixed(0)}`);
const shieldedSword = runFight(1.5, (_f, t) => ({ attack: t === 20, aimZ: -1 }), { brain: once(isAtk('reflect')), setup: f => { swordSetup(f); ready(f); } });
check('Reflect Shield punishes melee (damage + knockback)', shieldedSword.f.boss.hp === BOSS.maxHp && shieldedSword.f.armor < VITALS.armor && shieldedSword.events.some(e => e.type === 'reflected' && e.what === 'melee'));

const feint = runFight(4, () => ({}), { brain: once(isAtk('feint', 'lead')), setup: f => { placeAt(40)(f); ready(f); } });
const feintTele = feint.events.find(e => e.type === 'telegraph');
check('Feint winds up like a Bolt Volley, then fires late and fast', feintTele?.type === 'telegraph' && feintTele.attack === 'volley' && feint.events.some(e => e.type === 'fire' && e.attack === 'feint') && feint.f.armor < VITALS.armor,
  `player armor ${feint.f.armor.toFixed(0)}`);

const drones = runFight(10, () => ({}), { arena: coverArena, brain: once(isAtk('drones')), setup: ready });
check('Hunter Drones phase through walls to reach a hidden player', drones.f.armor < VITALS.armor, `armor ${drones.f.armor.toFixed(0)}`);
const cutDrone = runFight(0.5, (_f, t) => ({ attack: t === 0, aimZ: -1 }), {
  setup: f => {
    calm(f);
    const p = f.player.pos;
    f.projectiles.push({ id: 999, kind: 'drone', pos: { x: p.x, y: p.y + 1.2, z: p.z - 2 }, vel: { x: 0, y: 0, z: 0 }, ttl: 5, damage: 0, radius: 0.55, aoe: 0, gravity: 0, homing: 0, target: null, phasing: true, decision: -1 });
  },
});
check('sword swings cut down drones', cutDrone.events.some(e => e.type === 'droneDestroyed') && !cutDrone.f.projectiles.some(p => p.kind === 'drone'));

const strafe = (f: Fight) => ({ moveX: 1, sprint: true, ...lookAt(f, f.boss.pos) });
const laserOpen = runFight(3, strafe, { brain: once(isAtk('laser')), setup: f => { placeAt(40)(f); ready(f); } });
check('Sweeping Laser catches a strafing player in the open', laserOpen.f.armor === VITALS.armor - COUNTERS.laser.damage, `armor ${laserOpen.f.armor.toFixed(0)}`);
const laserCharge = runFight(3, f => ({ moveZ: -1, sprint: true, ...lookAt(f, f.boss.pos) }), { brain: once(isAtk('laser')), setup: f => { placeAt(60)(f); ready(f); } });
check('charging straight in slips under the Sweeping Laser', laserCharge.f.armor === VITALS.armor, `armor ${laserCharge.f.armor.toFixed(0)}`);
const laserCover = runFight(3, () => ({}), { arena: coverArena, brain: once(isAtk('laser')), setup: ready });
check('walls block the Sweeping Laser', laserCover.f.armor === VITALS.armor && laserCover.events.some(e => e.type === 'fire' && e.attack === 'laser'));

// No safe spot: every ranged attack reaches a player standing at the map's edge, even from the
// far side of the arena.
{
  const edge = (f: Fight) => { ready(f); f.player.pos = { x: 0, y: heightAt(0, 97), z: 97 }; };
  const farSide = (f: Fight) => { edge(f); const y = heightAt(0, -88) + 30; f.boss.pos = { x: 0, y, z: -88 }; f.boss.perch = { ...f.boss.pos }; };
  const ranged: [string, string][] = [['volley', 'direct'], ['spread', 'direct'], ['homing', 'direct'], ['mortar', 'direct'], ['feint', 'lead'], ['drones', 'direct'], ['laser', 'lead'], ['dive', 'direct']];
  const missed: string[] = [];
  for (const [atk, aim] of ranged) {
    for (const [where, setup] of [['perch', edge], ['far side', farSide]] as const) {
      const r = runFight(25, () => ({}), { brain: armIs(atk, aim), setup });
      if (r.f.armor + r.f.health >= VITALS.armor + VITALS.health) missed.push(`${atk} from ${where}`);
    }
  }
  check(`every ranged attack reaches the map edge (reach ${BOSS_REACH} m)`, missed.length === 0, missed.length ? `missed: ${missed.join(', ')}` : '8 attacks × 2 positions');
}

// Play-style profile: hiding / dashing / brawling habits are picked up within ~20-30 s.
const camper = runFight(40, () => ({}), { arena: coverArena, brain: waitBrain });
const dodger = runFight(40, (_f, t) => ({ dash: t % 100 === 0, moveX: t % 200 < 100 ? 1 : -1 }), { brain: waitBrain, setup: f => { f.player.pos = { x: 0, y: heightAt(0, 50), z: 50 }; } });
check('play-style profile reads a camper', describeStyle(camper.f.style).label === 'Camper', `${describeStyle(camper.f.style).label}: ${describeStyle(camper.f.style).traits.join(', ')}`);
check('play-style profile reads a dodger', describeStyle(dodger.f.style).label === 'Dodger', `${describeStyle(dodger.f.style).label}: ${describeStyle(dodger.f.style).traits.join(', ')}`);

// A move earns a share of the payoff of the attack it set up.
{
  let step = 0;
  const huntThenSweep: Brain = (_f, _a, valid) => {
    const want = [isMove('hunt'), isAtk('sweep')][step];
    const i = want ? valid.find(k => want(ARMS[k])) : undefined;
    if (i === undefined) return 0;
    step++;
    return i;
  };
  const hs = runFight(5, () => ({}), { brain: huntThenSweep, setup: f => { ready(f); f.player.pos = { x: 0, y: heightAt(0, 60), z: 60 }; } });
  const [mv, sw] = hs.f.decisions;
  check('a Hunt that sets up a Blade Sweep shares its reward', ARMS[mv.arm].kind === 'move' && sw.dealt > 0 && Math.abs(mv.reward - Math.min(1, rewardOf(mv) + REWARD.moveCredit * rewardOf(sw))) < 1e-9,
    `hunt ${mv.reward.toFixed(2)}, sweep ${sw.reward.toFixed(2)}`);
}

// ---------- Learning brain (M4) ----------
check('25 arms with a single 0.5 s wait', ARMS.length === 25 && ARMS.filter(a => a.kind === 'wait').length === 1 && ARMS[0].kind === 'wait' && ARMS[0].duration === 0.5);
const openFight = createFight(arena, 1);
const featsOpen = computeFeatures(openFight, arena);
check('context: 29 finite, normalized features with bias 1', featsOpen.length === FEATURE_DIM && FEATURE_DIM === 29 && featsOpen[0] === 1 && featsOpen.every(v => Number.isFinite(v) && Math.abs(v) <= 1.5),
  featsOpen.map(v => v.toFixed(2)).join(' '));
const VIS = FEATURE_NAMES.indexOf('player visible');
check('context: "player visible" sees walls', featsOpen[VIS] === 1 && computeFeatures(createFight(coverArena, 1), coverArena)[VIS] === 0);

{
  const r = mulberry32(11);
  const d = FEATURE_DIM;
  const m = createArmModel();
  for (let i = 0; i < 50; i++) updateArm(m, Array.from({ length: d }, () => r() * 2 - 1), r());
  let maxErr = 0;
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) {
    let s = 0;
    for (let k = 0; k < d; k++) s += m.A[i * d + k] * m.Ainv[k * d + j];
    maxErr = Math.max(maxErr, Math.abs(s - (i === j ? 1 : 0)));
  }
  check('LinUCB keeps an exact inverse (A·A⁻¹ = I)', maxErr < 1e-9, `max error ${maxErr.toExponential(1)}`);
}

check('reward: HP-fraction formula', Math.abs(rewardOf({ dealt: 24, taken: 0, cost: 22 }) - (24 / 30 - 0.1 * 22 / 40)) < 1e-12
  && Math.abs(rewardOf({ dealt: 0, taken: 100, cost: 0 }) + 100 / 240) < 1e-12 && rewardOf({ dealt: 0, taken: 300, cost: 40 }) === -1);

{
  const f = createFight(coverArena, 7);
  let sawPending = false;
  for (let i = 0; i < 60 * 9; i++) {
    stepFight(f, coverArena, NO_INPUT, SIM_DT, armIs('mortar'));
    const d0 = f.decisions[0];
    if (d0 && d0.windowEnd <= f.time && !d0.resolved && f.projectiles.some(p => p.decision === 0)) sawPending = true;
  }
  check('rewards wait for in-flight shells before scoring', sawPending && f.decisions[0].resolved && f.decisions[0].dealt > 0, `decision 0: dealt ${f.decisions[0].dealt.toFixed(1)}, reward ${f.decisions[0].reward.toFixed(2)}`);
}

{
  // Synthetic bandit: arm 1 pays when feature 3 is on, arm 4 when it's off.
  const pol = createPolicy();
  const r = mulberry32(3);
  let correct = 0;
  for (let t = 0; t < 1500; t++) {
    const k = r() < 0.5 ? 1 : 0;
    const x = new Array(FEATURE_DIM).fill(0);
    x[0] = 1;
    x[3] = k;
    const a = selectArm(pol, x, [1, 4]);
    const reward = (a === 1 ? (k ? 0.6 : -0.4) : k ? -0.3 : 0.5) + (r() - 0.5) * 0.2;
    updateArm(pol.arms[a], x, reward);
    if (t >= 1300 && a === (k ? 1 : 4)) correct++;
  }
  check('LinUCB learns which arm suits which context', correct / 200 > 0.9, `${((correct / 200) * 100).toFixed(0)}% optimal in the last 200 rounds`);
}

{
  const f = createFight(arena, 3);
  for (let i = 0; i < 60 * 30; i++) stepFight(f, arena, NO_INPUT, SIM_DT, heuristicBrain);
  resolveDecisions(f, true);
  const good = toSubmission(f, 0, 'abandoned');
  check('valid fight passes validation', validateSubmission(good) === null, `${good.arms.length} decisions`);
  check('tampered reward rejected', validateSubmission({ ...good, rewards: good.rewards.map((v, i) => (i === 0 ? 2 : v)) }) === 'reward out of range');
  check('unknown arm rejected', validateSubmission({ ...good, arms: good.arms.map((v, i) => (i === 0 ? 99 : v)) }) === 'unknown arm');
  // 3x the decisions crammed into 5 s: well past the 2.5 decisions/s limit, whatever the sample size.
  const crammed = { ...good, duration: 5, arms: [...good.arms, ...good.arms, ...good.arms], contexts: [...good.contexts, ...good.contexts, ...good.contexts], rewards: [...good.rewards, ...good.rewards, ...good.rewards] };
  check('too many decisions for the fight length rejected', validateSubmission(crammed) === 'too many decisions for the fight length', `${crammed.arms.length} decisions in 5 s`);
  check('out-of-range feature rejected', validateSubmission({ ...good, contexts: good.contexts.map((v, i) => (i === 1 ? 9 : v)) }) === 'feature out of range');
}

{
  // End-to-end: a fresh Skynet trains (validate → train, like the server) against a player who
  // hides behind a wall. Bolts/orbs hit the wall; mortars arc over it and dives land behind it.
  // It should learn to attack over the wall.
  const pol = createPolicy();
  const isMortar = (a: number) => ARMS[a].kind === 'attack' && ['mortar', 'dive', 'drones'].includes((ARMS[a] as { attack: string }).attack);
  const isBlocked = (a: number) => ARMS[a].kind === 'attack' && ['volley', 'spread', 'homing', 'feint', 'laser'].includes((ARMS[a] as { attack: string }).attack);
  const usage: number[] = [];
  for (let fight = 0; fight < 15; fight++) {
    const f = createFight(coverArena, 100 + fight);
    f.health = 1e9;
    const brain = learnedBrain(pol);
    for (let i = 0; i < 60 * 40; i++) stepFight(f, coverArena, NO_INPUT, SIM_DT, brain);
    resolveDecisions(f, true);
    const sub = toSubmission(f, pol.version, 'abandoned');
    if (validateSubmission(sub) === null) trainOn(pol, sub);
    const attacks = sub.arms.filter(a => ARMS[a].kind === 'attack');
    usage.push(attacks.filter(isMortar).length / Math.max(1, attacks.length));
  }
  const hidden = computeFeatures(createFight(coverArena, 1), coverArena);
  const attackArms = ARMS.map((_, i) => i).filter(i => ARMS[i].kind === 'attack');
  const best = attackArms.reduce((a, b) => (predict(pol.arms[b], hidden) > predict(pol.arms[a], hidden) ? b : a));
  const early = (usage[0] + usage[1] + usage[2]) / 3;
  const late = (usage[12] + usage[13] + usage[14]) / 3;
  const bestBlocked = Math.max(...attackArms.filter(isBlocked).map(a => predict(pol.arms[a], hidden)));
  const label = (a: number) => (ARMS[a].kind === 'attack' ? `${(ARMS[a] as { attack: string }).attack}/${(ARMS[a] as { aim: string }).aim}` : 'wait');
  check('trained Skynet learns to attack over walls vs a hidden player', isMortar(best) && late > early && predict(pol.arms[best], hidden) > bestBlocked + 0.3 && pol.version === 15,
    `best ${label(best)} (predicted ${predict(pol.arms[best], hidden).toFixed(2)}) vs best bolt attack ${bestBlocked.toFixed(2)}; over-wall share of attacks ${(early * 100).toFixed(0)}% → ${(late * 100).toFixed(0)}%`);
}

const runA = runFight(20, (_f, t) => ({ moveX: Math.sin(t / 40), moveZ: -1, dash: t % 50 === 0, aimZ: -1 }));
const runB = runFight(20, (_f, t) => ({ moveX: Math.sin(t / 40), moveZ: -1, dash: t % 50 === 0, aimZ: -1 }));
check('fights are deterministic', runA.f.health === runB.f.health && runA.f.armor === runB.f.armor && runA.f.decisions.length === runB.f.decisions.length && runA.f.player.pos.x === runB.f.player.pos.x,
  `health ${runA.f.health.toFixed(1)}, ${runA.f.decisions.length} decisions`);

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
