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

/** Laser sword: three-swing combo toward the camera's aim. */
export const SWORD = {
  swingTime: 0.3,
  /** Extra time after a swing in which the next click continues the combo. */
  comboWindow: 0.35,
  /** Fraction of the swing at which the hit lands. */
  hitAt: 0.45,
  /** Reach from the chest (added to Skynet's hit radius). */
  reach: 3.2,
  /** Half-angle of the swing arc around the facing direction (radians). */
  arcHalf: 1.2,
  damage: [28, 28, 44],
  /** Swinging in the air briefly holds you up (min vertical speed). */
  airHang: 3,
  /** Ground movement speed multiplier while swinging. */
  moveScale: 0.45,
};

/** Damage hits armor first; overflow goes to health. Armor regenerates, health never does. */
export const VITALS = {
  health: 100,
  armor: 50,
  armorRegen: 5,
  /** Seconds after the last hit before armor starts regenerating. */
  armorRegenDelay: 4,
};
/** Invulnerability after taking a hit, so a volley can't shred you instantly. */
export const HURT_INVULN = 0.4;

/**
 * Stamina gates sprinting, jumping, and dashing (no fixed air-jump/air-dash charges).
 * It only regenerates on the ground or while climbing vines, so one airtime is limited to one
 * bar of stamina.
 */
export const STAMINA = {
  max: 100,
  regen: 32,
  /** Seconds after spending stamina (or while sprinting) before it regenerates. */
  regenDelay: 0.5,
  sprintDrain: 20,
  jumpCost: 10,
  airJumpCost: 16,
  dashCost: 22,
};

export const PLAYER = {
  radius: 0.4,
  height: 1.8,
  /** Ledges up to this height are walked onto; taller solids are walls. */
  stepHeight: 0.45,
  runSpeed: 10,
  sprintSpeed: 22,
  groundAccel: 90,
  gravity: 34,
  /** Air steering: velocity rotates toward input (rad/s) and speeds up to run/sprint speed. */
  airTurnRate: 6,
  airAccel: 35,
  jumpSpeed: 16,
  /** Horizontal speed multiplier applied on a ground jump (carries you farther). */
  jumpBoost: 1.2,
  airJumpSpeedScale: 0.9,
  maxAirSpeed: 28,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  // Dash goes where the camera aims (pitch included); ~11.5 m per dash.
  dashSpeed: 48,
  dashTime: 0.24,
  dashCooldown: 0.55,
  dashInvuln: 0.3,
  /** Max dash elevation (radians) up or down (~83°). */
  dashMaxPitch: 1.45,
  // Glide (hold in the air): slow descent, steerable. Looking down dives (faster, steeper);
  // looking up floats.
  glideSpeed: 15,
  glideDiveSpeed: 14,
  glideFallSpeed: 3,
  glideDiveFall: 12,
  glideMinFall: 1.5,
  glideGravityScale: 0.35,
  glideAccel: 22,
  // Vines: push into a climbable surface to climb; jump to kick off it.
  climbSpeed: 7,
  wallJumpOut: 10,
  /** Upward pop when reaching the top of a climbable surface, to mantle onto it. */
  mantleSpeed: 8,
  turnRate: 14,
};
