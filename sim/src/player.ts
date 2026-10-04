import { moverOffset, moverSolid, solidTop, type Arena, type Solid } from './arena';
import { ARENA_WALK_RADIUS, PLAYER } from './config';
import { approachAngle, clamp, vec3, type Vec3 } from './math';
import { heightAt } from './terrain';

/** One tick of player intent. `move` is a world-space XZ direction (length <= 1). */
export interface PlayerInput {
  moveX: number;
  moveZ: number;
  sprint: boolean;
  /** True only on the tick the button was pressed. */
  jump: boolean;
  /** True only on the tick the button was pressed. */
  dash: boolean;
  /** Camera's horizontal forward direction; a dash with no move input goes this way. */
  aimX: number;
  aimZ: number;
  /** Dash elevation in radians: positive dashes upward, negative downward. */
  aimPitch: number;
}

export const NO_INPUT: PlayerInput = { moveX: 0, moveZ: 0, sprint: false, jump: false, dash: false, aimX: 0, aimZ: 0, aimPitch: 0 };

export interface PlayerState {
  pos: Vec3;
  vel: Vec3;
  /** Facing angle around Y; 0 faces +Z. */
  yaw: number;
  onGround: boolean;
  airJumpsLeft: number;
  airDashesLeft: number;
  coyote: number;
  jumpBuffer: number;
  dashTimer: number;
  dashCooldown: number;
  invuln: number;
  /** Unit 3D dash direction. */
  dashDir: Vec3;
  /** Holding onto vines. `wallN` is the surface normal (pointing away from it). */
  climbing: boolean;
  wallNX: number;
  wallNZ: number;
  /** Index into arena.movers of the shifting wall being stood on, or -1. */
  mover: number;
}

export function createPlayer(x: number, z: number): PlayerState {
  return {
    pos: vec3(x, heightAt(x, z), z),
    vel: vec3(),
    yaw: Math.atan2(-x, -z),
    onGround: true,
    airJumpsLeft: PLAYER.airJumps,
    airDashesLeft: PLAYER.airDashes,
    coyote: 0,
    jumpBuffer: 0,
    dashTimer: 0,
    dashCooldown: 0,
    invuln: 0,
    dashDir: vec3(0, 0, 1),
    climbing: false,
    wallNX: 0,
    wallNZ: 0,
    mover: -1,
  };
}

/**
 * Launch into a jump. With move input, horizontal velocity snaps to that direction; without
 * it, current momentum is kept. Either way it is then locked until the next jump/dash/landing.
 */
function launch(p: PlayerState, dirX: number, dirZ: number, hasMove: boolean, vy: number, boost: number): void {
  const speed = Math.hypot(p.vel.x, p.vel.z);
  if (hasMove) {
    const s = Math.min(Math.max(speed, PLAYER.runSpeed) * boost, PLAYER.maxAirSpeed);
    p.vel.x = dirX * s;
    p.vel.z = dirZ * s;
  } else if (speed > 0.1) {
    const k = Math.min(speed * boost, PLAYER.maxAirSpeed) / speed;
    p.vel.x *= k;
    p.vel.z *= k;
  }
  p.vel.y = vy;
  p.onGround = false;
  p.jumpBuffer = 0;
  p.dashTimer = 0;
}

function refillAirMoves(p: PlayerState): void {
  p.airJumpsLeft = PLAYER.airJumps;
  p.airDashesLeft = PLAYER.airDashes;
}

/** Is (x, z) over the solid's footprint (with `margin` of overhang allowed)? */
function overFootprint(s: Solid, x: number, z: number, margin: number): boolean {
  const dx = x - s.x;
  const dz = z - s.z;
  if (s.shape === 'cylinder') return Math.hypot(dx, dz) <= s.r + margin;
  const c = Math.cos(s.rot);
  const sn = Math.sin(s.rot);
  return Math.abs(dx * c + dz * sn) <= s.hx + margin && Math.abs(-dx * sn + dz * c) <= s.hz + margin;
}

/** Horizontal push-out of the player circle from a solid; null if not overlapping. */
function pushOut(s: Solid, x: number, z: number): { nx: number; nz: number; depth: number } | null {
  const R = PLAYER.radius;
  const dx = x - s.x;
  const dz = z - s.z;
  if (s.shape === 'cylinder') {
    const d = Math.hypot(dx, dz);
    if (d >= s.r + R) return null;
    return d > 1e-6 ? { nx: dx / d, nz: dz / d, depth: s.r + R - d } : { nx: 1, nz: 0, depth: s.r + R };
  }
  const c = Math.cos(s.rot);
  const sn = Math.sin(s.rot);
  const lx = dx * c + dz * sn;
  const lz = -dx * sn + dz * c;
  const qx = clamp(lx, -s.hx, s.hx);
  const qz = clamp(lz, -s.hz, s.hz);
  let nlx = lx - qx;
  let nlz = lz - qz;
  let d = Math.hypot(nlx, nlz);
  let depth: number;
  if (d > 1e-6) {
    if (d >= R) return null;
    nlx /= d;
    nlz /= d;
    depth = R - d;
  } else {
    // Center is inside the box: exit through the nearest face.
    const px = s.hx - Math.abs(lx);
    const pz = s.hz - Math.abs(lz);
    if (px < pz) {
      nlx = Math.sign(lx) || 1;
      nlz = 0;
      depth = px + R;
    } else {
      nlx = 0;
      nlz = Math.sign(lz) || 1;
      depth = pz + R;
    }
  }
  return { nx: nlx * c - nlz * sn, nz: nlx * sn + nlz * c, depth };
}

/**
 * Advance the player one tick. `time` is the sim time at the start of the tick (drives
 * shifting walls). Deterministic: same inputs + arena + time => same result.
 */
export function stepPlayer(p: PlayerState, input: PlayerInput, dt: number, arena: Arena, time: number): void {
  p.coyote = Math.max(0, p.coyote - dt);
  p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
  p.dashCooldown = Math.max(0, p.dashCooldown - dt);
  p.invuln = Math.max(0, p.invuln - dt);
  if (input.jump) p.jumpBuffer = PLAYER.jumpBuffer;

  // Ride the shifting wall we're standing on.
  if (p.mover >= 0 && p.onGround) {
    const m = arena.movers[p.mover];
    const a = moverOffset(m, time);
    const b = moverOffset(m, time + dt);
    p.pos.x += b.x - a.x;
    p.pos.y += b.y - a.y;
    p.pos.z += b.z - a.z;
  }

  const moveLen = Math.hypot(input.moveX, input.moveZ);
  const hasMove = moveLen > 0.1;
  const dirX = hasMove ? input.moveX / moveLen : 0;
  const dirZ = hasMove ? input.moveZ / moveLen : 0;

  if (input.dash && p.dashCooldown <= 0 && (p.onGround || p.climbing || p.airDashesLeft > 0)) {
    // Horizontal heading: move input, else camera aim, else facing.
    let hx = Math.sin(p.yaw);
    let hz = Math.cos(p.yaw);
    const aimLen = Math.hypot(input.aimX, input.aimZ);
    if (hasMove) {
      hx = dirX;
      hz = dirZ;
    } else if (aimLen > 0.1) {
      hx = input.aimX / aimLen;
      hz = input.aimZ / aimLen;
    }
    // Can't dash into the ground from the ground.
    const pitch = clamp(p.onGround ? Math.max(input.aimPitch, 0) : input.aimPitch, -PLAYER.dashMaxPitch, PLAYER.dashMaxPitch);
    const cp = Math.cos(pitch);
    p.dashDir.x = hx * cp;
    p.dashDir.y = Math.sin(pitch);
    p.dashDir.z = hz * cp;
    if (!p.onGround && !p.climbing) p.airDashesLeft--;
    p.climbing = false;
    p.dashTimer = PLAYER.dashTime;
    p.dashCooldown = PLAYER.dashCooldown;
    p.invuln = PLAYER.dashInvuln;
  }

  if (p.climbing) {
    const into = -(dirX * p.wallNX + dirZ * p.wallNZ);
    if (p.jumpBuffer > 0) {
      // Wall jump: kick away from the surface.
      p.vel.x = p.wallNX * PLAYER.wallJumpOut;
      p.vel.z = p.wallNZ * PLAYER.wallJumpOut;
      p.vel.y = PLAYER.jumpSpeed;
      p.jumpBuffer = 0;
      p.climbing = false;
    } else if (into > 0.3) {
      // Climb, pressing into the surface to keep contact (leaning towers recede as you climb).
      p.vel.x = -p.wallNX * 3;
      p.vel.z = -p.wallNZ * 3;
      p.vel.y = PLAYER.climbSpeed;
    } else {
      p.climbing = false; // let go
    }
  }

  if (p.dashTimer > 0) {
    p.dashTimer -= dt;
    // Full speed during the dash, then carry sprint-speed momentum along the dash direction.
    const speed = p.dashTimer > 0 ? PLAYER.dashSpeed : PLAYER.sprintSpeed;
    p.vel.x = p.dashDir.x * speed;
    p.vel.y = p.dashDir.y * speed;
    p.vel.z = p.dashDir.z * speed;
  } else if (p.onGround && !p.climbing) {
    const speed = input.sprint ? PLAYER.sprintSpeed : PLAYER.runSpeed;
    const dvx = dirX * speed - p.vel.x;
    const dvz = dirZ * speed - p.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const maxDv = PLAYER.groundAccel * dt;
    const k = dl > maxDv ? maxDv / dl : 1;
    p.vel.x += dvx * k;
    p.vel.z += dvz * k;
  }
  // Airborne and not dashing: horizontal velocity is locked (committed jump).
  if (p.dashTimer <= 0 && !p.climbing) p.vel.y -= PLAYER.gravity * dt;

  if (p.jumpBuffer > 0 && !p.climbing) {
    if (p.onGround || p.coyote > 0) {
      launch(p, dirX, dirZ, hasMove, PLAYER.jumpSpeed, PLAYER.jumpBoost);
      p.coyote = 0;
    } else if (p.airJumpsLeft > 0) {
      launch(p, dirX, dirZ, hasMove, PLAYER.jumpSpeed * PLAYER.airJumpSpeedScale, 1);
      p.airJumpsLeft--;
    }
  }

  const prevFeet = p.pos.y;
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  p.pos.z += p.vel.z * dt;

  // Arena boundary: push back inside and cancel outward velocity.
  const r = Math.hypot(p.pos.x, p.pos.z);
  if (r > ARENA_WALK_RADIUS) {
    const nx = p.pos.x / r;
    const nz = p.pos.z / r;
    p.pos.x = nx * ARENA_WALK_RADIUS;
    p.pos.z = nz * ARENA_WALK_RADIUS;
    const outward = p.vel.x * nx + p.vel.z * nz;
    if (outward > 0) {
      p.vel.x -= outward * nx;
      p.vel.z -= outward * nz;
    }
  }

  // Solids at the start and end of this tick (shifting walls move).
  const solids: { s: Solid; prevTop: number; prevBottom: number; mover: number }[] = [];
  for (const s of arena.statics) solids.push({ s, prevTop: solidTop(s), prevBottom: s.y, mover: -1 });
  arena.movers.forEach((m, i) => {
    const prev = moverSolid(m, time);
    solids.push({ s: moverSolid(m, time + dt), prevTop: solidTop(prev), prevBottom: prev.y, mover: i });
  });

  // Classify each solid by where we were last tick: above it (floor), below it (ceiling), or
  // beside it (wall).
  const wasClimbing = p.climbing;
  p.climbing = false;
  let climbTop = 0;
  for (const { s, prevTop, prevBottom } of solids) {
    const top = solidTop(s);
    if (prevTop <= prevFeet + PLAYER.stepHeight) continue; // floor candidate
    if (p.pos.y >= top || p.pos.y + PLAYER.height <= s.y) continue;
    const hit = pushOut(s, p.pos.x, p.pos.z);
    if (!hit) continue;
    if (prevFeet + PLAYER.height <= prevBottom + 0.05) {
      // Ceiling: bump our head instead of being shoved sideways.
      p.pos.y = s.y - PLAYER.height;
      if (p.vel.y > 0) p.vel.y = 0;
      continue;
    }
    p.pos.x += hit.nx * hit.depth;
    p.pos.z += hit.nz * hit.depth;
    const vn = p.vel.x * hit.nx + p.vel.z * hit.nz;
    if (vn < 0) {
      p.vel.x -= vn * hit.nx;
      p.vel.z -= vn * hit.nz;
    }
    // Grab vines when pushing into a climbable surface.
    if (s.climbable && p.dashTimer <= 0 && hasMove && -(dirX * hit.nx + dirZ * hit.nz) > 0.3) {
      p.climbing = true;
      p.wallNX = hit.nx;
      p.wallNZ = hit.nz;
      climbTop = top;
      if (!wasClimbing) refillAirMoves(p);
    }
  }

  // Mantle: near the top of a climbable surface, pop up and over.
  if (p.climbing && p.pos.y > climbTop - 0.9) {
    p.vel.y = Math.max(p.vel.y, PLAYER.mantleSpeed);
    p.vel.x = -p.wallNX * 4;
    p.vel.z = -p.wallNZ * 4;
    p.climbing = false;
  }

  // Floors: terrain, plus tops of solids we were above (or within a step of) last tick.
  let support = heightAt(p.pos.x, p.pos.z);
  let supportMover = -1;
  for (const { s, prevTop, mover } of solids) {
    if (prevTop > prevFeet + PLAYER.stepHeight) continue;
    const top = solidTop(s);
    if (top > support && overFootprint(s, p.pos.x, p.pos.z, PLAYER.radius * 0.5)) {
      support = top;
      supportMover = mover;
    }
  }

  const stickToGround = p.onGround && p.vel.y <= 0 && p.pos.y - support < 0.4;
  if (p.pos.y <= support || stickToGround) {
    // A downward air-dash ends on impact instead of sliding along the ground.
    if (!p.onGround && p.dashTimer > 0 && p.dashDir.y < -0.1) p.dashTimer = 0;
    p.pos.y = support;
    p.vel.y = Math.max(p.vel.y, 0);
    p.onGround = true;
    p.mover = supportMover;
    refillAirMoves(p);
    p.coyote = PLAYER.coyoteTime;
  } else {
    p.onGround = false;
    p.mover = -1;
  }

  if (Math.hypot(p.vel.x, p.vel.z) > 0.5 && !p.climbing) {
    p.yaw = approachAngle(p.yaw, Math.atan2(p.vel.x, p.vel.z), PLAYER.turnRate * dt);
  } else if (p.climbing) {
    p.yaw = Math.atan2(-p.wallNX, -p.wallNZ);
  }
}
