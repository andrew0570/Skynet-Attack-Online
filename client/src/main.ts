import * as THREE from 'three';
import { createPlayer, lerp, PLAYER, SIM_DT, stepPlayer, type PlayerInput } from '@sao/sim';
import { ThirdPersonCamera } from './camera';
import { Input } from './input';
import { createPlayerMesh, createSkynet, createWorld } from './world';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
createWorld(scene);
const skynet = createSkynet();
scene.add(skynet.group);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 400);
const thirdPerson = new ThirdPersonCamera(camera);

const player = createPlayer(0, 30);
const playerMesh = createPlayerMesh();
scene.add(playerMesh.group);

const input = new Input(renderer.domElement);
const hud = document.getElementById('hud')!;
const dashBar = document.getElementById('dash-fill')!;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  };
}

const prevPos = { ...player.pos };
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
    stepPlayer(player, readInput(), SIM_DT);
    input.clearPressed();
    accumulator -= SIM_DT;
  }

  // Interpolate between the last two sim states for smooth rendering at any refresh rate.
  const alpha = accumulator / SIM_DT;
  const renderPos = {
    x: lerp(prevPos.x, player.pos.x, alpha),
    y: lerp(prevPos.y, player.pos.y, alpha),
    z: lerp(prevPos.z, player.pos.z, alpha),
  };
  playerMesh.group.position.set(renderPos.x, renderPos.y, renderPos.z);
  playerMesh.group.rotation.y = player.yaw;
  playerMesh.body.emissiveIntensity = player.invuln > 0 ? 1.4 : 0.15;
  playerMesh.group.scale.set(1, player.dashTimer > 0 ? 0.85 : 1, player.dashTimer > 0 ? 1.3 : 1);

  skynet.animate(elapsed);
  thirdPerson.update(renderPos, frameDt);

  hud.classList.toggle('hidden', input.locked);
  dashBar.style.width = `${(1 - player.dashCooldown / PLAYER.dashCooldown) * 100}%`;

  renderer.render(scene, camera);
});
