/** Fixed simulation timestep (seconds). Client, bots, and server all step at this rate. */
export const SIM_DT = 1 / 60;

/** Walkable radius of the arena; the crater rim rises beyond it. */
export const ARENA_RADIUS = 100;
export const ARENA_WALK_RADIUS = ARENA_RADIUS;
export const TERRAIN_SEED = 1984;
/** Arena layout seed (Judgment Day, 1997). Same seed => identical arena on client, server, bots. */
export const ARENA_SEED = 1997;

export const PILLAR = {
  radius: 3.5,
  height: 16,
  /** Skynet hovers this far above the pillar top. */
  skynetHover: 7,
};

export const LAYOUT = {
  /** Open ground around the pillar. */
  gladeRadius: 24,
  /** The four cardinal corridors (Skynet's lines of attack) are 2x this wide. */
  corridorHalfWidth: 7,
  /** Fortress grid cell size (m). */
  cell: 10,
  wallThickness: 1,
  /** Floor slab bottoms (absolute heights) for the covered upper levels. */
  level1: 6,
  level2: 12,
  slabThickness: 0.6,
};

export const PLAYER = {
  radius: 0.4,
  height: 1.8,
  /** Ledges up to this height are walked onto; taller solids are walls. */
  stepHeight: 0.45,
  runSpeed: 10,
  sprintSpeed: 16,
  groundAccel: 90,
  gravity: 34,
  // Jumps are committed: no air control, so direction only changes on a jump, dash, wall grab,
  // or landing.
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
  /** Dashes allowed per airtime (reset on landing or grabbing vines). */
  airDashes: 1,
  /** Max dash elevation (radians) up or down. */
  dashMaxPitch: 1.2,
  // Vines: push into a climbable surface to climb; jump to kick off it.
  climbSpeed: 7,
  wallJumpOut: 10,
  /** Upward pop when reaching the top of a climbable surface, to mantle onto it. */
  mantleSpeed: 8,
  turnRate: 14,
};
