import * as THREE from 'three';
import { ARENA_RADIUS } from '@sao/sim';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.Fog(0x05070a, 40, 140);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 12, 30);
camera.lookAt(0, 4, 0);

scene.add(new THREE.HemisphereLight(0x8899aa, 0x110805, 0.6));
const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
sun.position.set(20, 40, 10);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(ARENA_RADIUS, 64),
  new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Placeholder Skynet core: glowing icosahedron with an orbiting blade ring.
const skynet = new THREE.Group();
skynet.position.y = 5;
const core = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.6, 0),
  new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 2, flatShading: true })
);
const ring = new THREE.Mesh(
  new THREE.TorusGeometry(3.2, 0.12, 8, 48),
  new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.9, roughness: 0.3 })
);
skynet.add(core, ring);
skynet.add(new THREE.PointLight(0xff3311, 30, 25));
scene.add(skynet);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  core.rotation.set(t * 0.7, t * 1.1, 0);
  ring.rotation.set(Math.PI / 2 + Math.sin(t) * 0.3, 0, t * 2);
  skynet.position.y = 5 + Math.sin(t * 1.5) * 0.4;
  renderer.render(scene, camera);
});
