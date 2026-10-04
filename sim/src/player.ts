import { moverOffset, moverSolid, solidTop, type Arena, type Solid } from './arena';
import { ARENA_WALK_RADIUS, PLAYER, STAMINA, SWORD } from './config';
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
  /** Dash elevation in radians: positive dashes upward, negative downward. Also steers glides. */
  aimPitch: number;
  /** Held: glide while airborne. */
  glide: boolean;
  /** True only on the tick the attack button was pressed. */
  attack: boolean;
}

export const NO_INPUT: PlayerInput = { moveX: 0, moveZ: 0, sprint: false, jump: false, dash: false, aimX: 0, aimZ: 0, aimPitch: 0, glide: false, attack: false };

export interface PlayerState {
  pos: Vec3;
  vel: Vec3;
  /** Facing angle around Y; 0 faces +Z. */
  yaw: number;
  onGround: boolean;
  /** Gates sprinting, jumping, and dashing. */
  stamina: number;
  /** Seconds until stamina starts regenerating. */
  staminaDelay: number;
  /** Increments on every air jump (lets the renderer play the flip). */
  airJumpCount: number;
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
  gliding: boolean;
  /** Seconds left in a vine mantle (air control paused). */
  mantle: number;
  /** Sword: time left in the current swing, which swing of the combo (0-2), combo window. */
  swingTimer: number;
  comboStep: number;
  comboWindow: number;
  /** Whether the current swing has already resolved its hit. */
  swingHit: boolean;
  /** Increments on every new swing (lets the renderer detect swings). */
  swingCount: number;
  /** Index into arena.movers of the shifting wall being stood on, or -1. */
  mover: number;
}

export function createPlayer(x: number, z: number): PlayerState {
  return {
    pos: vec3(x, heightAt(x, z), z),
    vel: vec3(),
    yaw: Math.atan2(-x, -z),
    onGround: true,
    stamina: STAMINA.max,
    staminaDelay: 0,
    airJumpCount: 0,
    coyote: 0,
    jumpBuffer: 0,
    dashTimer: 0,
    dashCooldown: 0,
    invuln: 0,
    dashDir: vec3(0, 0, 1),
    climbing: false,
    wallNX: 0,
    wallNZ: 0,
    gliding: false,
    mantle: 0,
    swingTimer: 0,
    comboStep: 0,
    comboWindow: 0,
    swingHit: true,
    swingCount: 0,
    mover: -1,
  };
}

/**
 * Launch into a jump. With move input, horizontal velocity snaps to that direction; without
 * it, current momentum is kept (and boosted on a ground jump).
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

/** Spend stamina if there's enough; pauses regeneration. */
function spendStamina(p: PlayerState, cost: number): boolean {
  if (p.stamina < cost) return false;
  p.stamina -= cost;
  p.staminaDelay = STAMINA.regenDelay;
  return true;
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
  p.mantle = Math.max(0, p.mantle - dt);
  p.swingTimer = Math.max(0, p.swingTimer - dt);
  p.comboWindow = Math.max(0, p.comboWindow - dt);
  if (input.jump) p.jumpBuffer = PLAYER.jumpBuffer;

  // Sword swing toward the camera's aim; chains into a 3-hit combo inside the combo window.
  if (input.attack && p.swingTimer <= 0 && !p.climbing) {
    p.comboStep = p.comboWindow > 0 ? (p.comboStep + 1) % 3 : 0;
    p.swingTimer = SWORD.swingTime;
    p.comboWindow = SWORD.swingTime + SWORD.comboWindow;
    p.swingHit = false;
    p.swingCount++;
    const al = Math.hypot(input.aimX, input.aimZ);
    if (al > 0.1) p.yaw = Math.atan2(input.aimX / al, input.aimZ / al);
    if (!p.onGround) p.vel.y = Math.max(p.vel.y, SWORD.airHang);
  }

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

  // Dashes: unlimited (ground or air) as long as stamina lasts; the cooldown stops spamming.
  if (input.dash && p.dashCooldown <= 0 && spendStamina(p, STAMINA.dashCost)) {
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
    p.climbing = false;
    p.dashTimer = PLAYER.dashTime;
    p.dashCooldown = PLAYER.dashCooldown;
    p.invuln = PLAYER.dashInvuln;
  }

  if (p.climbing) {
    const into = -(dirX * p.wallNX + dirZ * p.wallNZ);
    if (p.jumpBuffer > 0 && spendStamina(p, STAMINA.jumpCost)) {
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

  /** Accelerate horizontal velocity toward (tx, tz) by at most accel·dt. */
  const steer = (tx: number, tz: number, accel: number) => {
    const dvx = tx - p.vel.x;
    const dvz = tz - p.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const maxDv = accel * dt;
    const k = dl > maxDv ? maxDv / dl : 1;
    p.vel.x += dvx * k;
    p.vel.z += dvz * k;
  };

  p.gliding = input.glide && !p.onGround && !p.climbing && p.dashTimer <= 0;
  const hs = Math.hypot(p.vel.x, p.vel.z);
  let maxFall = Infinity;
  // Sprinting drains stamina on the ground; with none left you drop back to running speed.
  const canSprint = input.sprint && p.stamina > 0;
  const sprinting = canSprint && hasMove && p.onGround && !p.climbing && p.dashTimer <= 0;
  if (sprinting) {
    p.stamina = Math.max(0, p.stamina - STAMINA.sprintDrain * dt);
    p.staminaDelay = STAMINA.regenDelay;
  }

  if (p.dashTimer > 0) {
    p.dashTimer -= dt;
    // Full speed during the dash, then carry sprint-speed momentum along the dash direction.
    const speed = p.dashTimer > 0 ? PLAYER.dashSpeed : PLAYER.sprintSpeed;
    p.vel.x = p.dashDir.x * speed;
    p.vel.y = p.dashDir.y * speed;
    p.vel.z = p.dashDir.z * speed;
  } else if (p.onGround && !p.climbing) {
    const speed = (canSprint ? PLAYER.sprintSpeed : PLAYER.runSpeed) * (p.swingTimer > 0 ? SWORD.moveScale : 1);
    steer(dirX * speed, dirZ * speed, PLAYER.groundAccel);
  } else if (p.gliding) {
    const dive = Math.max(0, -input.aimPitch);
    const rise = Math.max(0, input.aimPitch);
    const speed = PLAYER.glideSpeed + dive * PLAYER.glideDiveSpeed;
    maxFall = Math.max(PLAYER.glideMinFall, PLAYER.glideFallSpeed + dive * PLAYER.glideDiveFall - rise * 1.5);
    if (hasMove) steer(dirX * speed, dirZ * speed, PLAYER.glideAccel);
    else if (hs > 0.5) steer((p.vel.x / hs) * speed, (p.vel.z / hs) * speed, PLAYER.glideAccel);
  } else if (!p.climbing && hasMove && p.mantle <= 0) {
    // Air control: rotate velocity toward the input (no momentum loss through the turn) and
    // build up to run/sprint speed if slower.
    const speed = Math.min(Math.max(hs, canSprint ? PLAYER.sprintSpeed : PLAYER.runSpeed), PLAYER.maxAirSpeed);
    if (hs < 1) {
      steer(dirX * speed, dirZ * speed, PLAYER.airAccel);
    } else {
      const ang = approachAngle(Math.atan2(p.vel.z, p.vel.x), Math.atan2(dirZ, dirX), PLAYER.airTurnRate * dt);
      const mag = Math.min(speed, hs + PLAYER.airAccel * dt);
      p.vel.x = Math.cos(ang) * mag;
      p.vel.z = Math.sin(ang) * mag;
    }
  }
  if (p.dashTimer <= 0 && !p.climbing) {
    // Gliding only softens the fall; rising uses full gravity so it can't stretch jumps upward.
    p.vel.y -= PLAYER.gravity * (p.gliding && p.vel.y <= 0 ? PLAYER.glideGravityScale : 1) * dt;
    p.vel.y = Math.max(p.vel.y, -maxFall);
  }

  // Jumps cost stamina; air jumps are unlimited while it lasts.
  if (p.jumpBuffer > 0 && !p.climbing) {
    if (p.onGround || p.coyote > 0) {
      if (spendStamina(p, STAMINA.jumpCost)) {
        launch(p, dirX, dirZ, hasMove, PLAYER.jumpSpeed, PLAYER.jumpBoost);
        p.coyote = 0;
      }
    } else if (spendStamina(p, STAMINA.airJumpCost)) {
      launch(p, dirX, dirZ, hasMove, PLAYER.jumpSpeed * PLAYER.airJumpSpeedScale, 1);
      p.airJumpCount++;
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
      p.gliding = false;
      p.wallNX = hit.nx;
      p.wallNZ = hit.nz;
      climbTop = top;
    }
  }

  // Mantle: near the top of a climbable surface, pop up and over. Air control pauses briefly
  // so holding forward doesn't carry you straight off the far side of a thin wall.
  if (p.climbing && p.pos.y > climbTop - 0.9) {
    p.vel.y = Math.max(p.vel.y, PLAYER.mantleSpeed);
    p.vel.x = -p.wallNX * 4;
    p.vel.z = -p.wallNZ * 4;
    p.climbing = false;
    p.mantle = 0.35;
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
    p.gliding = false;
    p.mover = supportMover;
    p.coyote = PLAYER.coyoteTime;
  } else {
    p.onGround = false;
    p.mover = -1;
  }

  if (p.swingTimer > 0) {
    // Keep facing the swing direction.
  } else if (Math.hypot(p.vel.x, p.vel.z) > 0.5 && !p.climbing) {
    p.yaw = approachAngle(p.yaw, Math.atan2(p.vel.x, p.vel.z), PLAYER.turnRate * dt);
  } else if (p.climbing) {
    p.yaw = Math.atan2(-p.wallNX, -p.wallNZ);
  }

  // Stamina regenerates quickly after a short pause (none while sprinting).
  if (!sprinting) {
    p.staminaDelay = Math.max(0, p.staminaDelay - dt);
    if (p.staminaDelay <= 0) p.stamina = Math.min(STAMINA.max, p.stamina + STAMINA.regen * dt);
  }
}
