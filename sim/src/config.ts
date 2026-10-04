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
  gravity: 34,
  // Jumps are committed: no air control, so direction only changes on a jump, dash, or landing.
  jumpSpeed: 16,
  /** Horizontal speed multiplier applied on a ground jump (carries you farther). */
  jumpBoost: 1.2,
  airJumpSpeedScale: 0.9,
  maxAirSpeed: 24,
  airJumps: 1,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  // Dash goes where the camera aims (pitch included); ~11.5 m per dash.
  dashSpeed: 48,
  dashTime: 0.24,
  dashCooldown: 0.55,
  dashInvuln: 0.3,
  /** Dashes allowed per airtime (reset on landing); keeps players from flying over Skynet. */
  airDashes: 1,
  /** Max dash elevation (radians) up or down. */
  dashMaxPitch: 1.2,
  turnRate: 14,
  height: 1.8,
};
