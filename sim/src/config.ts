/** Fixed simulation timestep (seconds). Client, bots, and server all step at this rate. */
export const SIM_DT = 1 / 60;

export const ARENA_RADIUS = 60;
/** Players are kept inside this radius (partway up the crater rim). */
export const ARENA_WALK_RADIUS = ARENA_RADIUS - 4;
export const TERRAIN_SEED = 1984;

export const PLAYER = {
  runSpeed: 10,
  sprintSpeed: 16,
  groundAccel: 90,
  airAccel: 30,
  gravity: 34,
  jumpSpeed: 13,
  airJumps: 1,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  dashSpeed: 38,
  dashTime: 0.16,
  dashCooldown: 0.55,
  dashInvuln: 0.25,
  turnRate: 14,
  height: 1.8,
};
