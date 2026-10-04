import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import {
  aimRay,
  ARMS,
  BOSS,
  SKILL_ORDER,
  SKILLS,
  createFight,
  generateArena,
  heightAt,
  heuristicBrain,
  lerp,
  NO_INPUT,
  raycast,
  SIM_DT,
  STAMINA,
  VITALS,
  stepFight,
  type PlayerInput,
  type Vec3,
} from '@sao/sim';
import {
  ARCHETYPES,
  armLabel,
  describeStyle,
  explainDecision,
  learnedBrain,
  predict,
  resolveDecisions,
  styleFeatures,
  toSubmission,
  type Brain,
  type FightEvent,
  type FightSubmission,
  type Policy,
} from '@sao/sim';
import { createArenaMeshes } from './arenaMesh';
import { connectBrain } from './net';
import { ThirdPersonCamera } from './camera';
import { createCombatFx } from './combatFx';
import { createHero, setHeroColor } from './hero';
import { Input } from './input';
import { createSkynet, createWorld } from './world';

// Debug view options for screenshots: ?front (camera faces the hero), ?yaw=<radians>, ?close,
// ?shot (hide overlay), ?overview (high fixed camera over the arena), ?at=x,z (spawn point),
// ?glide (force the glide pose, to inspect the wings), ?peace (Skynet never attacks),
// ?pitch=<radians>, ?t=<seconds> (fast-forward the fight), ?notrain (fight the shared brain
// without submitting fights to train it).
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
createWorld(scene, renderer);
const arena = generateArena();
const arenaMeshes = createArenaMeshes(arena);
scene.add(arenaMeshes.group);
const skynet = createSkynet();
scene.add(skynet.group, skynet.deathFx);
const fx = createCombatFx(scene);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 700);
const thirdPerson = new ThirdPersonCamera(camera);
if (params.has('front')) thirdPerson.yaw = Math.PI;
if (params.has('yaw')) thirdPerson.yaw = Number(params.get('yaw'));
if (params.has('pitch')) thirdPerson.pitch = Number(params.get('pitch'));
if (params.has('close')) {
  thirdPerson.distance = 3.2;
  thirdPerson.pitch = 0.15;
}

// Bloom picks up HDR colors (> 1.0): visor, armor seams, laser blade, Skynet's core.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.35, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const hero = createHero();
scene.add(hero.group, hero.worldFx);

// Blob shadow: shows where you'll land during jumps and aimed dashes.
const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.55, 24).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
);
scene.add(shadow);

const input = new Input(renderer.domElement);
const el = (id: string) => document.getElementById(id)!;
const ui = {
  hud: el('hud'),
  bossHud: el('boss-hud'),
  bossHp: el('boss-hp'),
  bossEnergy: el('boss-energy'),
  bossState: el('boss-state'),
  armor: el('player-armor'),
  armorText: el('armor-text'),
  health: el('player-health'),
  healthText: el('health-text'),
  stamina: el('player-stamina'),
  staminaText: el('stamina-text'),
  staminaRow: el('stamina-row'),
  reticle: el('reticle'),
  brainStatus: el('brain-status'),
  resultNote: el('result-note'),
  playerName: el('player-name'),
  skillSlot: [0, 1, 2].map(i => el(`skill-${i}`)),
  skillCd: [0, 1, 2].map(i => el(`skill-cd-${i}`)),
  skillTime: [0, 1, 2].map(i => el(`skill-time-${i}`)),
  vignette: el('vignette'),
  result: el('result'),
  resultTitle: el('result-title'),
  callout: el('callout'),
  calloutName: el('callout-name'),
  calloutWhy: el('callout-why'),
  calloutHint: el('callout-hint'),
  read: el('read'),
  readStyle: el('read-style'),
  readTraits: el('read-traits'),
  readHabits: el('read-habits'),
  readMove: el('read-move'),
  readWhy: el('read-why'),
  learned: el('learned'),
  learnedSub: el('learned-sub'),
  learnedRows: el('learned-rows'),
};

// ---- Showing the learning: style read, decision reasons, counter-move callouts ----
const HABITS = ['Range', 'Cover', 'Airborne', 'Pillar', 'On the move', 'Melee', 'Skills', 'Dashing'];
const habitBars = HABITS.map(name => {
  const label = document.createElement('div');
  label.className = 'h';
  label.textContent = name;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  bar.appendChild(fill);
  ui.readHabits.append(label, bar);
  return fill;
});

/** Callouts for the moves that exist to counter a play style, and for repositioning. */
const CALLOUTS: Record<string, { name: string; hint: string; move?: boolean }> = {
  reflect: { name: 'REFLECT SHIELD', hint: 'Beams and blades bounce back — hold your fire' },
  feint: { name: 'FEINT', hint: 'A fake wind-up to bait your dodge' },
  drones: { name: 'HUNTER DRONES', hint: 'They phase through walls — cut them down' },
  laser: { name: 'SWEEPING LASER', hint: 'Change range or jump — strafing will not escape it' },
  hunt: { name: 'HUNTING', hint: 'Skynet left its perch to close in', move: true },
  flank: { name: 'FLANKING', hint: 'Skynet is moving for a clear shot', move: true },
  rise: { name: 'ASCENDING', hint: 'Skynet climbs for a better angle', move: true },
  retreat: { name: 'RETREATING', hint: 'Skynet returns to its perch', move: true },
  enraged: { name: 'PHASE 2 — SKYNET ENRAGED', hint: 'Faster energy, chained attacks, shorter cooldowns' },
  evaded: { name: 'EVADED', hint: 'Skynet saw it coming and sidestepped', move: true },
};
let calloutTimer = 0;
/** Why Skynet made its latest decision (from the frozen policy it is fighting with). */
let lastWhy = '';

function showCallout(key: string): void {
  const c = CALLOUTS[key];
  if (!c) return;
  ui.calloutName.textContent = c.name;
  ui.calloutWhy.textContent = lastWhy;
  ui.calloutHint.textContent = c.hint;
  ui.callout.className = c.move ? 'move' : '';
  calloutTimer = c.move ? 1.4 : 2.2;
}

function handleCallouts(events: FightEvent[]): void {
  for (const e of events) {
    // A Feint's wind-up is disguised as a volley, so it's only called out when it springs.
    if (e.type === 'telegraph' && e.attack !== 'volley') showCallout(e.attack);
    if (e.type === 'fire' && e.attack === 'feint') showCallout('feint');
    if (e.type === 'move') showCallout(e.move);
    if (e.type === 'enraged') {
      lastWhy = 'Skynet dropped below half HP';
      showCallout('enraged');
    }
    // A sidestep never interrupts a bigger callout that's still showing.
    if (e.type === 'evaded' && calloutTimer <= 0.3) {
      lastWhy = '';
      showCallout('evaded');
    }
  }
}

/** Explain each new (non-wait) decision in the read panel. */
let explained = 0;
function explainNewDecisions(): void {
  while (explained < fight.decisions.length) {
    const d = fight.decisions[explained++];
    const arm = ARMS[d.arm];
    if (arm.kind === 'wait') continue;
    ui.readMove.textContent = armLabel(arm);
    if (!fightPolicy) {
      lastWhy = '';
      ui.readWhy.textContent = 'Local AI (offline) — not learning';
      continue;
    }
    const reasons = explainDecision(fightPolicy, d.context, d.arm).map(r => r.text);
    lastWhy = reasons.length ? `because ${reasons.join(' and ')}` : '';
    ui.readWhy.textContent = reasons.length ? lastWhy : fightPolicy.version === 0 ? 'Untrained — exploring at random' : 'Exploring: trying something new';
  }
}

let readTimer = 0;
function updateRead(dt: number): void {
  readTimer -= dt;
  if (readTimer > 0) return;
  readTimer = 0.2;
  const read = describeStyle(fight.style);
  ui.readStyle.textContent = fight.time < 8 ? 'READING…' : read.label.toUpperCase();
  ui.readTraits.textContent = fight.time < 8 ? '' : read.traits.join(' · ');
  styleFeatures(fight.style).forEach((v, i) => (habitBars[i].style.width = `${Math.min(1, v) * 100}%`));
}

/** Hold Tab: each archetype's best moves under the latest shared brain vs. the untrained v0. */
let learnedKey = -2;
function renderLearned(): void {
  const policy = net.snapshotPolicy();
  const youAre = describeStyle(fight.style).label;
  const key = (policy?.version ?? -1) * 100 + ARCHETYPES.findIndex(a => a.label === youAre);
  if (key === learnedKey) return;
  learnedKey = key;
  ui.learnedSub.textContent = policy ? `Shared brain v${policy.version} · trained on ${net.status.fights} fights` : 'Offline — connect to the shared brain to see what it has learned.';
  const rows: string[] = ['<div class="head">AGAINST A…</div><div class="head">AT V0</div><div class="head">NOW — TOP MOVES</div>'];
  for (const a of ARCHETYPES) {
    const ranked = policy
      ? ARMS.map((arm, i) => ({ arm, v: predict(policy.arms[i], a.context) }))
          .filter(x => x.arm.kind !== 'wait')
          .sort((x, y) => y.v - x.v)
          .slice(0, 3)
      : [];
    const now = ranked.length
      ? ranked
          .map(x => `<span>${armLabel(x.arm)}</span><div class="bar"><div class="${x.v < 0 ? 'neg' : ''}" style="width:${Math.min(100, (Math.abs(x.v) / 0.5) * 100)}%"></div></div><span class="v">${x.v >= 0 ? '+' : ''}${x.v.toFixed(2)}</span>`)
          .join('')
      : '<span>—</span><span></span><span></span>';
    rows.push(`<div class="who${a.label === youAre ? ' you' : ''}"><b>${a.label.toUpperCase()}</b><span>${a.blurb}</span></div><div class="v0">No preference — random pick</div><div class="now">${now}</div>`);
  }
  ui.learnedRows.innerHTML = rows.join('');
}

// ---- Start screen (every load): callsign, armor color, training consent ----
// The callsign and color live only in this page's memory: never sent to the server or saved.
// The consent choice is sent (the server only learns from fights of players who agreed).
const ARMOR_COLORS = [
  ['Cyan', '#00e5ff'], ['Lime', '#5dff6a'], ['Gold', '#ffd23d'], ['Orange', '#ff9a2e'],
  ['Magenta', '#ff4fd8'], ['Violet', '#b26bff'], ['Teal', '#2effc0'], ['White', '#e8f6ff'],
] as const;
const startScreen = el('start');
const startForm = el('start-form') as HTMLFormElement;
const startName = el('start-name') as HTMLInputElement;
const startGo = el('start-go') as HTMLButtonElement;
let playerName = '';
/** null until the start screen is answered (also null in test modes: never submits). */
let consentChoice: boolean | null = null;
let lastConsentSync = -Infinity;
el('start-colors').innerHTML = ARMOR_COLORS.map(([name, hex], i) =>
  `<label class="swatch" title="${name}"><input type="radio" name="color" value="${hex}" aria-label="${name}"${i === 0 ? ' checked' : ''} /><i style="--c:${hex}"></i></label>`).join('');
function applyColor(hex: string): void {
  setHeroColor(hex);
  startScreen.style.setProperty('--accent', hex);
  ui.playerName.style.setProperty('--accent', hex);
}
startForm.addEventListener('change', e => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'color') applyColor(t.value);
  if (t.name === 'consent') {
    startGo.disabled = false;
    startGo.textContent = 'Enter the arena';
  }
});
startForm.addEventListener('submit', e => {
  e.preventDefault();
  const choice = startForm.querySelector<HTMLInputElement>('input[name="consent"]:checked');
  if (!choice) return;
  consentChoice = choice.value === 'yes';
  playerName = startName.value.trim().slice(0, 16) || 'Resistance fighter';
  ui.playerName.textContent = playerName.toUpperCase();
  startScreen.classList.add('hidden');
  startGo.blur();
});
// Tests and screenshots skip the start screen.
if (params.has('autoplay') || params.has('shot')) startScreen.classList.add('hidden');
else startName.focus();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

const [spawnX, spawnZ] = params.get('at')?.split(',').map(Number) ?? [arena.spawn.x, arena.spawn.z];
// Skynet's shared brain (SpacetimeDB). Each fight freezes the weights when it starts; the fight
// is submitted for training when it ends. Offline, the local placeholder AI takes over.
const net = connectBrain(() => {});
const peace: Brain = () => 0; // ?peace: always "wait"
let brain: Brain = heuristicBrain;
/** Shared-brain version this fight is using, or -1 (local AI / peace: never submitted). */
let fightPolicyVersion = -1;
/** The frozen policy this fight is using (null: local AI / peace). */
let fightPolicy: Policy | null = null;
let fightStarted = false;
let submitted = false;
let fightSeed = 1;

function newFight() {
  const f = createFight(arena, fightSeed++);
  f.player.pos = { x: spawnX, y: heightAt(spawnX, spawnZ), z: spawnZ };
  fightStarted = false;
  submitted = false;
  explained = 0;
  lastWhy = '';
  calloutTimer = 0;
  ui.readMove.textContent = '—';
  ui.readWhy.textContent = '';
  return f;
}

/** Freeze the brain at the fight's first tick (by then the connection is usually up). */
function startFight(): void {
  fightStarted = true;
  const policy = params.has('peace') ? null : net.snapshotPolicy();
  brain = params.has('peace') ? peace : policy ? learnedBrain(policy) : heuristicBrain;
  fightPolicyVersion = policy ? policy.version : -1;
  fightPolicy = policy;
}

/** Send a finished (or abandoned) fight to train the shared brain. */
function submitFight(outcome: FightSubmission['outcome']): void {
  // ?notrain: play against the shared brain without teaching it (for testing a model version).
  if (submitted || fightPolicyVersion < 0 || net.status.consented !== true || params.has('notrain')) return;
  if (outcome === 'abandoned' && fight.time < 10) return;
  submitted = true;
  resolveDecisions(fight, true);
  net.submit(toSubmission(fight, fightPolicyVersion, outcome));
}

let fight = newFight();
if (params.has('t')) startFight();
// ?t=<seconds>: fast-forward the fight (idle player) before rendering, for screenshots.
for (let i = 0; i < Number(params.get('t') ?? 0) * 60; i++) stepFight(fight, arena, NO_INPUT, SIM_DT, brain);
const prevPos: Vec3 = { ...fight.player.pos };
const prevBoss: Vec3 = { ...fight.boss.pos };
let hurtFlash = 0;

function readInput(): PlayerInput {
  const forward = (input.isHeld('KeyW') ? 1 : 0) - (input.isHeld('KeyS') ? 1 : 0);
  const right = (input.isHeld('KeyD') ? 1 : 0) - (input.isHeld('KeyA') ? 1 : 0);
  const dir = thirdPerson.moveDir(forward, right);
  const aim = thirdPerson.aim();
  return {
    moveX: dir.x,
    moveZ: dir.z,
    sprint: input.isHeld('ShiftLeft') || input.isHeld('ShiftRight'),
    jump: input.wasPressed('Space'),
    dash: input.wasPressed('KeyQ') || input.wasPressed('Mouse2'),
    aimX: aim.x,
    aimZ: aim.z,
    aimPitch: aim.pitch,
    glide: input.isHeld('CapsLock'),
    attack: input.wasPressed('Mouse0'),
    skill: input.wasPressed('Digit1') ? 1 : input.wasPressed('Digit2') ? 2 : input.wasPressed('Digit3') ? 3 : 0,
    // The reticle ray: from the camera through the center of the screen.
    eyeX: camera.position.x,
    eyeY: camera.position.y,
    eyeZ: camera.position.z,
    lookX: lookDir.x,
    lookY: lookDir.y,
    lookZ: lookDir.z,
  };
}
const lookDir = new THREE.Vector3(0, 0, -1);

// Debug handle for automated browser tests (tools/browser-test.ts).
(window as unknown as { __sao: unknown }).__sao = {
  get fight() {
    return fight;
  },
  get fightPolicyVersion() {
    return fightPolicyVersion;
  },
  get submitted() {
    return submitted;
  },
  net,
};

const BOSS_STATE_LABEL: Record<string, string> = { telegraph: 'CHARGING', recover: '', return: 'RETURNING' };

let accumulator = 0;
let last = performance.now();
let elapsed = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const frameDt = Math.min((now - last) / 1000, 0.1);
  last = now;
  elapsed += frameDt;

  if (input.consumePressed('KeyR')) {
    if (fight.outcome === 'active') submitFight('abandoned');
    fight = newFight();
    fx.reset();
    Object.assign(prevPos, fight.player.pos);
    Object.assign(prevBoss, fight.boss.pos);
  }

  const { dx, dy } = input.takeMouseDelta();
  thirdPerson.rotate(dx, dy);

  camera.getWorldDirection(lookDir);
  // The fight only runs while you're playing (mouse captured); Esc pauses it.
  // ?autoplay / ?shot keep it running for automated tests and screenshots.
  const running = input.locked || params.has('autoplay') || params.has('shot');
  accumulator = running ? accumulator + frameDt : 0;
  while (accumulator >= SIM_DT) {
    // Freeze the brain at the first tick; if that happened before the shared brain connected,
    // upgrade as long as Skynet hasn't made a decision yet (~2 s into every fight).
    const upgrade = fightStarted && fightPolicyVersion < 0 && fight.decisions.length === 0 && !params.has('peace') && net.status.connected;
    if (!fightStarted || upgrade) startFight();
    Object.assign(prevPos, fight.player.pos);
    Object.assign(prevBoss, fight.boss.pos);
    const events = stepFight(fight, arena, readInput(), SIM_DT, brain);
    fx.handle(events, fight);
    explainNewDecisions();
    handleCallouts(events);
    for (const e of events) {
      if (e.type === 'playerHit') hurtFlash = 1;
      if (e.type === 'bossHit') skynet.hit(e.damage);
    }
    input.clearPressed();
    accumulator -= SIM_DT;
  }
  if (fight.outcome !== 'active') submitFight(fight.outcome);

  // Interpolate between the last two sim states for smooth rendering at any refresh rate.
  const alpha = accumulator / SIM_DT;
  const renderTime = fight.time - SIM_DT + alpha * SIM_DT;
  arenaMeshes.update(renderTime);
  const player = fight.player;
  const renderPos = { x: lerp(prevPos.x, player.pos.x, alpha), y: lerp(prevPos.y, player.pos.y, alpha), z: lerp(prevPos.z, player.pos.z, alpha) };
  const bossPos = { x: lerp(prevBoss.x, fight.boss.pos.x, alpha), y: lerp(prevBoss.y, fight.boss.pos.y, alpha), z: lerp(prevBoss.z, fight.boss.pos.z, alpha) };

  hero.group.position.set(renderPos.x, renderPos.y, renderPos.z);
  hero.group.rotation.y = player.yaw;
  hero.update(params.has('glide') ? { ...player, gliding: true } : player, frameDt, elapsed);
  // The surface under Skynet (pillar top, wall, or terrain): where it crashes when destroyed.
  const bossDrop = raycast(arena, bossPos, { x: bossPos.x, y: bossPos.y - 120, z: bossPos.z }, renderTime);
  const bossFloor = Math.max(heightAt(bossPos.x, bossPos.z), bossPos.y - bossDrop * 120);
  skynet.animate(elapsed, frameDt, bossPos, fight.boss, bossFloor);
  fx.shake = Math.max(fx.shake, skynet.shake);
  fx.update(fight, frameDt, elapsed);

  // Shadow sits on whatever is directly below: terrain, a wall top, or a slab.
  const below = raycast(arena, { x: renderPos.x, y: renderPos.y + 0.1, z: renderPos.z }, { x: renderPos.x, y: renderPos.y - 60, z: renderPos.z }, renderTime);
  const ground = Math.max(heightAt(renderPos.x, renderPos.z), renderPos.y + 0.1 - below * 60.1);
  const height = Math.max(0, renderPos.y - ground);
  shadow.position.set(renderPos.x, ground + 0.03, renderPos.z);
  shadow.scale.setScalar(1 / (1 + height * 0.08));
  (shadow.material as THREE.MeshBasicMaterial).opacity = 0.45 / (1 + height * 0.12);

  if (params.has('overview')) {
    camera.position.set(0, 150, 140);
    camera.lookAt(0, 0, 0);
  } else {
    thirdPerson.update(renderPos, frameDt, arena, renderTime);
    if (fx.shake > 0) {
      const s = fx.shake * 0.35;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
    }
  }

  // HUD
  const b = fight.boss;
  const startOpen = !startScreen.classList.contains('hidden');
  ui.hud.classList.toggle('hidden', input.locked || params.has('shot') || startOpen);
  ui.bossHp.style.width = `${(b.hp / BOSS.maxHp) * 100}%`;
  ui.bossEnergy.style.width = `${(b.energy / BOSS.maxEnergy) * 100}%`;
  ui.bossHud.classList.toggle('enraged', b.enraged);
  const arm = b.arm >= 0 ? ARMS[b.arm] : null;
  const stunned = b.phase === 'recover' && arm?.kind === 'attack' && arm.attack === 'dive';
  ui.bossState.textContent = stunned ? 'STUNNED — STRIKE NOW' : (BOSS_STATE_LABEL[b.phase] ?? '');
  ui.armor.style.width = `${(fight.armor / VITALS.armor) * 100}%`;
  ui.armorText.textContent = `${Math.ceil(fight.armor)}`;
  ui.health.style.width = `${(fight.health / VITALS.health) * 100}%`;
  ui.healthText.textContent = `${Math.ceil(fight.health)}`;
  ui.stamina.style.width = `${(player.stamina / STAMINA.max) * 100}%`;
  ui.staminaText.textContent = `${Math.floor(player.stamina)}`;
  ui.staminaRow.classList.toggle('low', player.stamina < STAMINA.dashCost);

  // Skill bar cooldowns.
  SKILL_ORDER.forEach((id, i) => {
    const cd = fight.skillCd[i];
    const total = SKILLS[id].cooldown;
    ui.skillCd[i].style.height = `${(cd / total) * 100}%`;
    ui.skillTime[i].textContent = cd > 0 ? cd.toFixed(cd < 1 ? 1 : 0) : '';
    ui.skillSlot[i].classList.toggle('ready', cd <= 0);
  });

  // Reticle turns red when it's on Skynet.
  camera.getWorldDirection(lookDir);
  ui.reticle.classList.toggle('on-target', aimRay(fight, arena, camera.position, lookDir).hitBoss);
  hurtFlash = Math.max(0, hurtFlash - frameDt * 2.5);
  ui.vignette.style.opacity = String(hurtFlash);
  // On a win, hold the result screen until Skynet's death sequence has played out.
  const showResult = fight.outcome === 'lost' || (fight.outcome === 'won' && skynet.deathDone());
  ui.result.className = showResult ? fight.outcome : 'hidden';
  ui.resultTitle.textContent = fight.outcome === 'won' ? 'SKYNET DEFEATED' : fight.outcome === 'lost' ? 'TERMINATED' : '';
  const who = playerName ? (fight.outcome === 'won' ? `Well fought, ${playerName}. ` : `${playerName} has fallen. `) : '';
  ui.resultNote.textContent = who + (submitted ? 'Skynet is learning from this fight.' : '');
  calloutTimer = Math.max(0, calloutTimer - frameDt);
  ui.callout.classList.toggle('hidden', calloutTimer <= 0 || params.has('shot'));
  updateRead(frameDt);
  ui.read.classList.toggle('hidden', params.has('shot') || startOpen);
  // Hold Tab (or ?learned for screenshots): what the shared brain has learned.
  const showLearned = input.isHeld('Tab') || params.has('learned');
  if (showLearned) renderLearned();
  ui.learned.classList.toggle('hidden', !showLearned);

  // Brain status under Skynet's name.
  const s = net.status;
  if (!s.connected) ui.brainStatus.textContent = 'LOCAL AI · OFFLINE';
  else {
    const using = fightStarted && fightPolicyVersion >= 0 ? fightPolicyVersion : s.version;
    const newer = fightStarted && fightPolicyVersion >= 0 && s.version > fightPolicyVersion ? ` · v${s.version} next fight` : '';
    const notLearning = params.has('notrain') ? ' · test mode, not learning' : s.consented === false ? ' · not learning from you' : '';
    ui.brainStatus.textContent = `NEURAL CORE v${using} · trained on ${s.fights} fights${newer}${notLearning}`;
  }

  // Keep the server's consent record in line with the start-screen choice (also after a
  // reconnect or a server reset). Retried at most every 2 s until the server reflects it.
  if (s.connected && consentChoice !== null && s.consented !== consentChoice && elapsed - lastConsentSync > 2) {
    lastConsentSync = elapsed;
    net.setConsent(consentChoice);
  }

  composer.render();
});
