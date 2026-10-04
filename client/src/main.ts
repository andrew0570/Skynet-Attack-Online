import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import {
  ARMS,
  BOSS,
  createFight,
  generateArena,
  heightAt,
  heuristicBrain,
  lerp,
  NO_INPUT,
  PLAYER,
  PLAYER_HP,
  raycast,
  SIM_DT,
  stepFight,
  type PlayerInput,
  type Vec3,
} from '@sao/sim';
import { createArenaMeshes } from './arenaMesh';
import { ThirdPersonCamera } from './camera';
import { createCombatFx } from './combatFx';
import { createHero } from './hero';
import { Input } from './input';
import { createSkynet, createWorld } from './world';

// Debug view options for screenshots: ?front (camera faces the hero), ?yaw=<radians>, ?close,
// ?shot (hide overlay), ?overview (high fixed camera over the arena), ?at=x,z (spawn point),
// ?glide (force the glide pose, to inspect the wings), ?peace (Skynet never attacks),
// ?pitch=<radians>, ?t=<seconds> (fast-forward the fight).
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
scene.add(skynet.group);
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
scene.add(hero.group);

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
  dash: el('dash-fill'),
  bossHp: el('boss-hp'),
  bossEnergy: el('boss-energy'),
  bossState: el('boss-state'),
  playerHp: el('player-hp'),
  vignette: el('vignette'),
  result: el('result'),
  resultTitle: el('result-title'),
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

const [spawnX, spawnZ] = params.get('at')?.split(',').map(Number) ?? [arena.spawn.x, arena.spawn.z];
const brain = params.has('peace') ? () => 0 /* always "wait" */ : heuristicBrain;
let fightSeed = 1;

function newFight() {
  const f = createFight(arena, fightSeed++);
  f.player.pos = { x: spawnX, y: heightAt(spawnX, spawnZ), z: spawnZ };
  return f;
}
let fight = newFight();
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
  };
}

const BOSS_STATE_LABEL: Record<string, string> = { telegraph: 'CHARGING', recover: '', return: 'RETURNING' };

let accumulator = 0;
let last = performance.now();
let elapsed = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const frameDt = Math.min((now - last) / 1000, 0.1);
  last = now;
  elapsed += frameDt;

  if (input.wasPressed('KeyR')) {
    fight = newFight();
    fx.reset();
    Object.assign(prevPos, fight.player.pos);
    Object.assign(prevBoss, fight.boss.pos);
    accumulator = 0;
  }

  const { dx, dy } = input.takeMouseDelta();
  thirdPerson.rotate(dx, dy);

  accumulator += frameDt;
  while (accumulator >= SIM_DT) {
    Object.assign(prevPos, fight.player.pos);
    Object.assign(prevBoss, fight.boss.pos);
    const events = stepFight(fight, arena, readInput(), SIM_DT, brain);
    fx.handle(events, fight);
    for (const e of events) {
      if (e.type === 'playerHit') hurtFlash = 1;
      if (e.type === 'bossHit') skynet.flash();
    }
    input.clearPressed();
    accumulator -= SIM_DT;
  }

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
  skynet.animate(elapsed, frameDt, bossPos, fight.boss);
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
  ui.hud.classList.toggle('hidden', input.locked || params.has('shot'));
  ui.dash.style.width = `${(1 - player.dashCooldown / PLAYER.dashCooldown) * 100}%`;
  ui.bossHp.style.width = `${(b.hp / BOSS.maxHp) * 100}%`;
  ui.bossEnergy.style.width = `${(b.energy / BOSS.maxEnergy) * 100}%`;
  const arm = b.arm >= 0 ? ARMS[b.arm] : null;
  const stunned = b.phase === 'recover' && arm?.kind === 'attack' && arm.attack === 'dive';
  ui.bossState.textContent = stunned ? 'STUNNED — STRIKE NOW' : (BOSS_STATE_LABEL[b.phase] ?? '');
  ui.playerHp.style.width = `${(fight.playerHp / PLAYER_HP) * 100}%`;
  hurtFlash = Math.max(0, hurtFlash - frameDt * 2.5);
  ui.vignette.style.opacity = String(hurtFlash);
  ui.result.classList.toggle('hidden', fight.outcome === 'active');
  ui.result.className = fight.outcome === 'active' ? 'hidden' : fight.outcome;
  ui.resultTitle.textContent = fight.outcome === 'won' ? 'SKYNET DEFEATED' : fight.outcome === 'lost' ? 'TERMINATED' : '';

  composer.render();
});
