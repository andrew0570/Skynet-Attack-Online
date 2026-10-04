import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createPlayer, generateArena, heightAt, lerp, PLAYER, raycast, SIM_DT, stepPlayer, type PlayerInput } from '@sao/sim';
import { createArenaMeshes } from './arenaMesh';
import { ThirdPersonCamera } from './camera';
import { createHero } from './hero';
import { Input } from './input';
import { createSkynet, createWorld } from './world';

// Debug view options for screenshots: ?front (camera faces the hero), ?yaw=<radians>, ?close,
// ?shot (hide overlay), ?overview (high fixed camera over the arena), ?at=x,z (spawn point).
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
const skynet = createSkynet(arena.skynetAnchor);
scene.add(skynet.group);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 700);
const thirdPerson = new ThirdPersonCamera(camera);
if (params.has('front')) thirdPerson.yaw = Math.PI;
if (params.has('yaw')) thirdPerson.yaw = Number(params.get('yaw'));
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

const [spawnX, spawnZ] = params.get('at')?.split(',').map(Number) ?? [arena.spawn.x, arena.spawn.z];
const player = createPlayer(spawnX, spawnZ);
const hero = createHero();
scene.add(hero.group);

// Blob shadow: shows where you'll land during jumps and aimed dashes.
const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.55, 24).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
);
scene.add(shadow);

const input = new Input(renderer.domElement);
const hud = document.getElementById('hud')!;
const dashBar = document.getElementById('dash-fill')!;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

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
    glide: input.isHeld('ControlLeft') || input.isHeld('ControlRight'),
  };
}

const prevPos = { ...player.pos };
let simTime = 0;
let accumulator = 0;
let last = performance.now();
let elapsed = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const frameDt = Math.min((now - last) / 1000, 0.1);
  last = now;
  elapsed += frameDt;

  const { dx, dy } = input.takeMouseDelta();
  thirdPerson.rotate(dx, dy);

  accumulator += frameDt;
  while (accumulator >= SIM_DT) {
    Object.assign(prevPos, player.pos);
    stepPlayer(player, readInput(), SIM_DT, arena, simTime);
    simTime += SIM_DT;
    input.clearPressed();
    accumulator -= SIM_DT;
  }

  // Interpolate between the last two sim states for smooth rendering at any refresh rate.
  const alpha = accumulator / SIM_DT;
  const renderTime = simTime - SIM_DT + alpha * SIM_DT;
  arenaMeshes.update(renderTime);
  const renderPos = {
    x: lerp(prevPos.x, player.pos.x, alpha),
    y: lerp(prevPos.y, player.pos.y, alpha),
    z: lerp(prevPos.z, player.pos.z, alpha),
  };
  hero.group.position.set(renderPos.x, renderPos.y, renderPos.z);
  hero.group.rotation.y = player.yaw;
  hero.update(player, frameDt, elapsed);

  // Shadow sits on whatever is directly below: terrain, a wall top, or a platform.
  const below = raycast(arena, { x: renderPos.x, y: renderPos.y + 0.1, z: renderPos.z }, { x: renderPos.x, y: renderPos.y - 60, z: renderPos.z }, renderTime);
  const ground = Math.max(heightAt(renderPos.x, renderPos.z), renderPos.y + 0.1 - below * 60.1);
  const height = Math.max(0, renderPos.y - ground);
  shadow.position.set(renderPos.x, ground + 0.03, renderPos.z);
  shadow.scale.setScalar(1 / (1 + height * 0.08));
  (shadow.material as THREE.MeshBasicMaterial).opacity = 0.45 / (1 + height * 0.12);

  skynet.animate(elapsed);
  if (params.has('overview')) {
    camera.position.set(0, 150, 140);
    camera.lookAt(0, 0, 0);
  } else {
    thirdPerson.update(renderPos, frameDt, arena, renderTime);
  }

  hud.classList.toggle('hidden', input.locked || params.has('shot'));
  dashBar.style.width = `${(1 - player.dashCooldown / PLAYER.dashCooldown) * 100}%`;

  composer.render();
});
