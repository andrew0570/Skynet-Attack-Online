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

export function stepPlayer(p: PlayerState, input: PlayerInput, dt: number): void {
  p.coyote = Math.max(0, p.coyote - dt);
  p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
  p.dashCooldown = Math.max(0, p.dashCooldown - dt);
  p.invuln = Math.max(0, p.invuln - dt);
  if (input.jump) p.jumpBuffer = PLAYER.jumpBuffer;

  const moveLen = Math.hypot(input.moveX, input.moveZ);
  const hasMove = moveLen > 0.1;
  const dirX = hasMove ? input.moveX / moveLen : 0;
  const dirZ = hasMove ? input.moveZ / moveLen : 0;

  if (input.dash && p.dashCooldown <= 0 && (p.onGround || p.airDashesLeft > 0)) {
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
    if (!p.onGround) p.airDashesLeft--;
    p.dashTimer = PLAYER.dashTime;
    p.dashCooldown = PLAYER.dashCooldown;
    p.invuln = PLAYER.dashInvuln;
  }

  if (p.dashTimer > 0) {
    p.dashTimer -= dt;
    // Full speed during the dash, then carry sprint-speed momentum along the dash direction.
    const speed = p.dashTimer > 0 ? PLAYER.dashSpeed : PLAYER.sprintSpeed;
    p.vel.x = p.dashDir.x * speed;
    p.vel.y = p.dashDir.y * speed;
    p.vel.z = p.dashDir.z * speed;
  } else if (p.onGround) {
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
  if (p.dashTimer <= 0) p.vel.y -= PLAYER.gravity * dt;

  if (p.jumpBuffer > 0) {
    if (p.onGround || p.coyote > 0) {
      launch(p, dirX, dirZ, hasMove, PLAYER.jumpSpeed, PLAYER.jumpBoost);
      p.coyote = 0;
    } else if (p.airJumpsLeft > 0) {
      launch(p, dirX, dirZ, hasMove, PLAYER.jumpSpeed * PLAYER.airJumpSpeedScale, 1);
      p.airJumpsLeft--;
    }
  }

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

  const ground = heightAt(p.pos.x, p.pos.z);
  const stickToSlope = p.onGround && p.vel.y <= 0 && p.pos.y - ground < 0.4;
  if (p.pos.y <= ground || stickToSlope) {
    // A downward air-dash ends on impact instead of sliding along the ground.
    if (!p.onGround && p.dashTimer > 0 && p.dashDir.y < -0.1) p.dashTimer = 0;
    p.pos.y = ground;
    p.vel.y = Math.max(p.vel.y, 0);
    p.onGround = true;
    p.airJumpsLeft = PLAYER.airJumps;
    p.airDashesLeft = PLAYER.airDashes;
    p.coyote = PLAYER.coyoteTime;
  } else {
    p.onGround = false;
  }

  if (Math.hypot(p.vel.x, p.vel.z) > 0.5) {
    p.yaw = approachAngle(p.yaw, Math.atan2(p.vel.x, p.vel.z), PLAYER.turnRate * dt);
  }
}
