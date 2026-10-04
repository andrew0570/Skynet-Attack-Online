import { ARENA_WALK_RADIUS, PLAYER } from './config';
import { approachAngle, vec3, type Vec3 } from './math';
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
}

export const NO_INPUT: PlayerInput = { moveX: 0, moveZ: 0, sprint: false, jump: false, dash: false };

export interface PlayerState {
  pos: Vec3;
  vel: Vec3;
  /** Facing angle around Y; 0 faces +Z. */
  yaw: number;
  onGround: boolean;
  airJumpsLeft: number;
  coyote: number;
  jumpBuffer: number;
  dashTimer: number;
  dashCooldown: number;
  invuln: number;
  dashDirX: number;
  dashDirZ: number;
}

export function createPlayer(x: number, z: number): PlayerState {
  return {
    pos: vec3(x, heightAt(x, z), z),
    vel: vec3(),
    yaw: Math.atan2(-x, -z),
    onGround: true,
    airJumpsLeft: PLAYER.airJumps,
    coyote: 0,
    jumpBuffer: 0,
    dashTimer: 0,
    dashCooldown: 0,
    invuln: 0,
    dashDirX: 0,
    dashDirZ: 1,
  };
}

export function stepPlayer(p: PlayerState, input: PlayerInput, dt: number): void {
  p.coyote = Math.max(0, p.coyote - dt);
  p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
  p.dashCooldown = Math.max(0, p.dashCooldown - dt);
  p.invuln = Math.max(0, p.invuln - dt);
  if (input.jump) p.jumpBuffer = PLAYER.jumpBuffer;

  let mx = input.moveX;
  let mz = input.moveZ;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }

  if (input.dash && p.dashCooldown <= 0) {
    // Dash toward input, or straight ahead if there is none.
    const dl = Math.hypot(mx, mz);
    p.dashDirX = dl > 0.1 ? mx / dl : Math.sin(p.yaw);
    p.dashDirZ = dl > 0.1 ? mz / dl : Math.cos(p.yaw);
    p.dashTimer = PLAYER.dashTime;
    p.dashCooldown = PLAYER.dashCooldown;
    p.invuln = PLAYER.dashInvuln;
  }

  if (p.dashTimer > 0) {
    p.dashTimer -= dt;
    const speed = p.dashTimer > 0 ? PLAYER.dashSpeed : PLAYER.sprintSpeed;
    p.vel.x = p.dashDirX * speed;
    p.vel.z = p.dashDirZ * speed;
    p.vel.y = Math.max(p.vel.y, 0);
  } else {
    const speed = input.sprint ? PLAYER.sprintSpeed : PLAYER.runSpeed;
    const dvx = mx * speed - p.vel.x;
    const dvz = mz * speed - p.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const maxDv = (p.onGround ? PLAYER.groundAccel : PLAYER.airAccel) * dt;
    const k = dl > maxDv ? maxDv / dl : 1;
    p.vel.x += dvx * k;
    p.vel.z += dvz * k;
    p.vel.y -= PLAYER.gravity * dt;
  }

  if (p.jumpBuffer > 0) {
    if (p.onGround || p.coyote > 0) {
      p.vel.y = PLAYER.jumpSpeed;
      p.onGround = false;
      p.coyote = 0;
      p.jumpBuffer = 0;
    } else if (p.airJumpsLeft > 0) {
      p.vel.y = PLAYER.jumpSpeed * 0.9;
      p.airJumpsLeft--;
      p.jumpBuffer = 0;
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
    p.pos.y = ground;
    p.vel.y = Math.max(p.vel.y, 0);
    p.onGround = true;
    p.airJumpsLeft = PLAYER.airJumps;
    p.coyote = PLAYER.coyoteTime;
  } else {
    p.onGround = false;
  }

  if (Math.hypot(p.vel.x, p.vel.z) > 0.5) {
    p.yaw = approachAngle(p.yaw, Math.atan2(p.vel.x, p.vel.z), PLAYER.turnRate * dt);
  }
}
