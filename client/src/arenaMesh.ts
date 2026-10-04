import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA_RADIUS, heightAt, moverSolid, smoothstep, solidTop, towerAxis, type Arena, type Solid, type Tower } from '@sao/sim';
import { concreteTexture, facadeTexture, vineTextures } from './textures';

// Visual language: cyan = player, red = Skynet, amber = shifting walls, teal-green glow = climbable vines.
const AMBER = new THREE.Color(1, 0.55, 0.12).multiplyScalar(3);
const SKYNET_RED = new THREE.Color(1, 0.12, 0.04).multiplyScalar(4);

/** Solid-local frame → world: Three's rotation.y = -solid.rot (see Solid.rot). */
function placeMatrix(s: Solid, localY: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationY(-s.rot).setPosition(s.x, localY, s.z);
}

/** World-space UVs so texture density is the same on every wall. */
function worldUVs(geo: THREE.BufferGeometry, metersPerTile: number): void {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);
    if (Math.abs(ny) > 0.5) uv.setXY(i, x / metersPerTile, z / metersPerTile);
    else uv.setXY(i, (x * -nz + z * nx) / metersPerTile, y / metersPerTile);
  }
}

/** Scale a BoxGeometry's per-face UVs to its real dimensions (faces: ±x, ±y, ±z). */
function boxUVs(geo: THREE.BufferGeometry, w: number, h: number, d: number, metersPerTile: number): void {
  const uv = geo.attributes.uv;
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = f * 4; i < f * 4 + 4; i++) uv.setXY(i, (uv.getX(i) * dims[f][0]) / metersPerTile, (uv.getY(i) * dims[f][1]) / metersPerTile);
  }
}

/** Scorch walls near the ground, plus a small per-wall tint so the maze isn't uniform. */
function scorchColors(geo: THREE.BufferGeometry, tint: number): void {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) - heightAt(pos.getX(i), pos.getZ(i));
    const k = (0.3 + 0.7 * smoothstep(-0.3, 2.8, h)) * tint;
    colors[i * 3] = k;
    colors[i * 3 + 1] = k * 0.96;
    colors[i * 3 + 2] = k * 0.92;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function wallGeometry(s: Solid, tint: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(s.hx * 2, s.height, s.hz * 2);
  geo.applyMatrix4(placeMatrix(s, s.y + s.height / 2));
  worldUVs(geo, 4);
  scorchColors(geo, tint);
  return geo;
}

/** Vine sheets on both long faces of a climbable wall, from its base (or the ground) to the top. */
function wallVines(s: Solid, rand: () => number): THREE.BufferGeometry[] {
  const bottom = Math.max(heightAt(s.x, s.z), s.y);
  const h = solidTop(s) - bottom + 0.3;
  const w = s.hx * 2 * (0.75 + rand() * 0.2);
  return [1, -1].map(side => {
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.attributes.uv;
    const ou = rand();
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 3) + ou, uv.getY(i) * (h / 3));
    if (side < 0) geo.rotateY(Math.PI);
    geo.translate(0, 0, side * (s.hz + 0.04));
    geo.applyMatrix4(placeMatrix(s, bottom + h / 2 - 0.3));
    return geo;
  });
}

/** World matrix of a tilted tower box: local X along the (tilted) lean direction, Y along the axis. */
function towerMatrix(t: Tower): THREE.Matrix4 {
  const a = towerAxis(t);
  const s = Math.sin(t.tilt);
  const c = Math.cos(t.tilt);
  const xb = new THREE.Vector3(c * Math.cos(t.heading), -s, c * Math.sin(t.heading));
  const yb = new THREE.Vector3(a.x, a.y, a.z);
  const zb = new THREE.Vector3().crossVectors(xb, yb);
  return new THREE.Matrix4().makeBasis(xb, yb, zb).setPosition(t.center.x, t.center.y, t.center.z);
}

function createTower(t: Tower, facade: THREE.Material, plain: THREE.Material, vineMat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const w = t.halfWidth * 2;
  const h = t.halfLength * 2;
  const d = t.halfDepth * 2;
  const geo = new THREE.BoxGeometry(w, h, d);
  boxUVs(geo, w, h, d, t.style === 'tower' ? 8 : 4);
  const body = new THREE.Mesh(geo, t.style === 'tower' ? facade : plain);
  body.applyMatrix4(towerMatrix(t));
  group.add(body);
  if (t.climbable) {
    // Vines overgrow the up-facing side (the natural climbing face); the facade shows elsewhere.
    const vg = new THREE.PlaneGeometry(d, h);
    const uv = vg.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * d) / 3, (uv.getY(i) * h) / 3);
    vg.rotateY(-Math.PI / 2);
    vg.translate(-t.halfWidth - 0.06, 0, 0);
    const vines = new THREE.Mesh(vg, vineMat);
    vines.applyMatrix4(towerMatrix(t));
    group.add(vines);
  }
  return group;
}

function createPillar(pillar: Solid, anchor: THREE.Vector3, concrete: THREE.Material, vineMat: THREE.Material): { group: THREE.Group; tether: THREE.MeshBasicMaterial } {
  const group = new THREE.Group();
  const ground = heightAt(pillar.x, pillar.z);
  const top = solidTop(pillar);

  const geo = new THREE.CylinderGeometry(pillar.r, pillar.r, pillar.height, 14, 4);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ((Math.PI * 2 * pillar.r) / 4), uv.getY(i) * (pillar.height / 4));
  geo.translate(pillar.x, pillar.y + pillar.height / 2, pillar.z);
  scorchColors(geo, 0.9);
  group.add(new THREE.Mesh(geo, concrete));

  const vh = top - ground;
  const vines = new THREE.CylinderGeometry(pillar.r + 0.06, pillar.r + 0.06, vh, 28, 1, true);
  const vuv = vines.attributes.uv;
  for (let i = 0; i < vuv.count; i++) vuv.setXY(i, vuv.getX(i) * ((Math.PI * 2 * pillar.r) / 3), vuv.getY(i) * (vh / 3));
  vines.translate(pillar.x, ground + vh / 2, pillar.z);
  group.add(new THREE.Mesh(vines, vineMat));

  // Crown: dark metal ring with spikes and a glowing red conduit.
  const metal = new THREE.MeshStandardMaterial({ color: 0x22252b, metalness: 0.8, roughness: 0.4, flatShading: true });
  const crown = new THREE.Mesh(new THREE.TorusGeometry(pillar.r + 0.2, 0.35, 6, 24), metal);
  crown.rotation.x = Math.PI / 2;
  crown.position.set(pillar.x, top, pillar.z);
  const conduit = new THREE.Mesh(new THREE.TorusGeometry(pillar.r - 0.3, 0.08, 6, 32), new THREE.MeshBasicMaterial({ color: SKYNET_RED }));
  conduit.rotation.x = Math.PI / 2;
  conduit.position.set(pillar.x, top + 0.05, pillar.z);
  group.add(crown, conduit);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.25, 2.2, 5), metal);
    spike.position.set(pillar.x + Math.cos(a) * (pillar.r + 0.2), top + 0.9, pillar.z + Math.sin(a) * (pillar.r + 0.2));
    spike.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
    group.add(spike);
  }

  // Energy tether from the crown to Skynet.
  const length = anchor.y - top;
  const tetherMat = new THREE.MeshBasicMaterial({ color: SKYNET_RED.clone(), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
  const tether = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, length, 8, 1, true), tetherMat);
  tether.position.set(anchor.x, top + length / 2, anchor.z);
  group.add(tether);
  return { group, tether: tetherMat };
}

/** A shifting wall: concrete slab with amber seams so players learn that it moves. */
function createShifterMesh(s: Solid, concrete: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const w = s.hx * 2;
  const h = s.height;
  const d = s.hz * 2;
  const geo = new THREE.BoxGeometry(w, h, d);
  boxUVs(geo, w, h, d, 4);
  const slab = new THREE.Mesh(geo, concrete);
  slab.position.y = h / 2;
  group.add(slab);
  const seam = new THREE.MeshBasicMaterial({ color: AMBER });
  const t = 0.07;
  for (const side of [1, -1]) {
    for (const y of [h - 0.35, h * 0.55]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, t, t), seam);
      strip.position.set(0, y, side * (d / 2 + 0.01));
      group.add(strip);
    }
    for (const x of [-w * 0.3, w * 0.3]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(t, h * 0.5, t), seam);
      strip.position.set(x, h * 0.75, side * (d / 2 + 0.01));
      group.add(strip);
    }
  }
  return group;
}

export function createArenaMeshes(arena: Arena): { group: THREE.Group; update(t: number): void } {
  const group = new THREE.Group();
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  const concreteMap = concreteTexture();
  const concrete = new THREE.MeshStandardMaterial({ map: concreteMap, vertexColors: true, roughness: 0.95, envMapIntensity: 0.2 });
  const concretePlain = new THREE.MeshStandardMaterial({ map: concreteMap, roughness: 0.95, envMapIntensity: 0.2, color: 0xb0a89e });
  const facade = new THREE.MeshStandardMaterial({ map: facadeTexture(), roughness: 0.95, envMapIntensity: 0.2, color: 0xa39a8f });
  const vineTex = vineTextures();
  const vineMat = new THREE.MeshStandardMaterial({
    map: vineTex.map,
    alphaTest: 0.35,
    emissiveMap: vineTex.glow,
    emissive: 0xffffff,
    emissiveIntensity: 1.6,
    side: THREE.DoubleSide,
    roughness: 0.85,
    envMapIntensity: 0,
  });

  const walls: THREE.BufferGeometry[] = [];
  const vines: THREE.BufferGeometry[] = [];
  for (const s of arena.statics) {
    if (s.shape !== 'box' || s.kind === 'tower') continue;
    walls.push(wallGeometry(s, s.kind === 'slab' ? 0.8 : 0.85 + rand() * 0.2));
    if (s.climbable) vines.push(...wallVines(s, rand));
  }
  group.add(new THREE.Mesh(mergeGeometries(walls), concrete));
  if (vines.length) group.add(new THREE.Mesh(mergeGeometries(vines), vineMat));

  for (const t of arena.towers) group.add(createTower(t, facade, concretePlain, vineMat));

  let tether: THREE.MeshBasicMaterial | null = null;
  if (arena.pillar) {
    const a = arena.skynetAnchor;
    const pillar = createPillar(arena.pillar, new THREE.Vector3(a.x, a.y, a.z), concrete, vineMat);
    group.add(pillar.group);
    tether = pillar.tether;
  }

  // Scattered debris (visual only).
  const debris = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x6e655b, roughness: 1, flatShading: true }), 450);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < debris.count; i++) {
    const a = rand() * Math.PI * 2;
    const r = 8 + rand() * (ARENA_RADIUS - 8);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const sc = 0.12 + rand() * rand() * 0.6;
    q.setFromEuler(e.set(rand() * 3, rand() * 3, rand() * 3));
    m.compose(new THREE.Vector3(x, heightAt(x, z) + sc * 0.3, z), q, new THREE.Vector3(sc * (0.8 + rand() * 0.6), sc * 0.7, sc));
    debris.setMatrixAt(i, m);
  }
  group.add(debris);

  const shifterMeshes = arena.movers.map(mv => {
    const mesh = createShifterMesh(mv.base, concretePlain);
    group.add(mesh);
    return mesh;
  });

  return {
    group,
    update(t: number) {
      arena.movers.forEach((mv, i) => {
        const s = moverSolid(mv, t);
        shifterMeshes[i].position.set(s.x, s.y, s.z);
        shifterMeshes[i].rotation.y = -s.rot;
      });
      if (tether) tether.opacity = 0.55 + 0.25 * Math.sin(t * 5);
    },
  };
}
