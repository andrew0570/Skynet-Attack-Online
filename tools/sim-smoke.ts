// Headless sanity check for sim/: runs the player controller without a browser.
// Usage: npm run sim:smoke
import {
  ARENA_WALK_RADIUS,
  ARMS,
  BOSS,
  createFight,
  heuristicBrain,
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
