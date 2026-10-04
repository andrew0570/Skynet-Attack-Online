# Design: Skynet Attack Online (SAO)

Status: theme **decided**; remaining items are proposals.

## 1. Theme (decided)
**Sci-fi arena vs. a machine intelligence.** The player community must unite to defeat
**Skynet**, an AI overlord that learns from every fight.
- **Boss — Skynet** (after *The Terminator*): a floating AI construct (glowing red core +
  orbiting blade rings).
  Geometric and procedurally animated, so it needs **no rigging or skeletal animation**, which
  is a major time saver when working solo. It also visually *reads* as "the AI".
- **Player:** agile pilot with an energy blade (short-range melee), sprint, jump, and a dash
  with brief invulnerability. Melee-only forces engagement, which gives the boss real
  decisions about spacing. A ranged weapon is a stretch goal.
- **Arena:** small crater on an alien plateau; the crater rim is the natural map boundary.

Swords vs. magic vs. human boss: a humanoid boss needs animation work that a solo 24h build
can't afford; a monster/construct with procedural motion can look great with primitives.

## 2a. Arena (decided, v2 built Sat 9:48 PM)
Scorched alien desert crater, **100 m walkable radius**, generated deterministically from
`ARENA_SEED` in `sim/src/arena.ts` (identical on client, server, bots). Tunables in `LAYOUT`.
- **Central pillar** (r 3.5 m, 16 m tall, vine-covered) — Skynet hovers 7 m above its crown,
  tethered by a red energy beam. Reach it by climbing the vines or from the tall towers.
- **Glade** (r < 24): open combat space with low vaultable rubble flanking each diagonal.
- **Four cardinal corridors** (14 m wide, N/E/S/W, glade → rim): fast, fully exposed lanes —
  Skynet's lines of attack (smoke test: 100% of corridor ground visible from Skynet).
- **Four walled fortresses** between the corridors, on a 10 m grid:
  - Ground-level maze (randomized DFS + loops), tall outer walls facing corridors/glade with
    doorways, some doorways gated by rising/sinking walls.
  - **Covered levels**: level-1 slabs at 6 m (~50% of cells) and level-2 slabs at 12 m, with
    upper-level walls and parapets for cover (only ~12% of fortress ground visible to Skynet).
  - **Shifting maze**: ~45 walls total that sink into the ground and rise again, or slide one
    cell along their line into a neighboring gap (alternating which path is blocked). Eased
    motion with holds at each end; amber seams mark them.
  - A **fallen-tower ramp** from the glade up onto level 1 (diagonal, ~32° slope).
  - A **leaning ruined skyscraper** (12–22° tilt, ~32 m tall, half-buried), vine face for
    climbing — a perch above Skynet's height for dive attacks.
- **Vines**: push into them to climb, jump to wall-jump off, auto-mantle at the top. Grabbing
  vines refills air jump/dash. Climbable walls under slabs are flush with the slab top so you
  can mantle onto the level above.
- **Physics**: walls, floors (step-up 0.45 m), ceilings (head bump), riding shifting walls,
  being shoved by sliding walls; tilted towers collide as stacks of exact cross-section slices.
- **Color language:** cyan = player, red = Skynet, amber = shifting walls, teal = climbable.
- **Combat intent (M3):** Skynet's ranged attacks use `raycast()` line of sight, so corridors
  are deadly and fortress walls/roofs are real cover; close-range attacks force Skynet down
  from the pillar, opening windows to strike.

## 2. Map — not Unreal
Unreal is the wrong tool here: no browser export (HTML5 was dropped), Pixel Streaming needs
GPU servers, heavy builds, and SpacetimeDB's browser SDK is TypeScript.

Use **Three.js** in the browser:
- Terrain = a plane displaced by a seeded noise heightmap (e.g. `simplex-noise`), flattened in
  the arena center, raised at the rim.
- One shared `terrain.ts` exposes `heightAt(x, z)`. Because client and server are both
  TypeScript, the **server uses the same function** to validate positions and jumps.
- Kinematic character controller (velocity + gravity + `heightAt` ground snap). No physics
  engine — that keeps movement fast, tight, and deterministic.

## 2b. Combat (built in M3 — `sim/src/combat.ts`)
- **Skynet** perches 7 m above the pillar (1200 HP). An **energy bar** (max 100, +9/s) pays
  for attacks (20–40 each) plus a 0.5 s pause after each, capping it at ~1 attack / 2.5–3 s.
- **Attacks** (telegraphed: core charges, aim line for ranged, red ground rings for landings):
  - Bolt Volley — 5 fast bolts, re-aimed per shot · Spread Shot — 7-bolt fan
  - Seeker Orbs — 3 slow homing orbs · Mortar — 4 lobbed shells that arc over walls (AoE)
  - Blade Sweep — ring AoE around Skynet (close range)
  - Dive Slam — dives onto the target, shockwave AoE, then **stunned 2.4 s (1.5× damage)**
- Bolts/orbs are blocked by walls and roofs (`raycast`); mortars are the anti-camping tool.
- **Decision = arm** (17): wait 0.6 s / wait 1.6 s, or attack × aim mode
  (direct / lead / flank — flank offsets toward the player's last dodge side). The brain
  chooses frequency (by waiting) and aim; energy enforces the hard limit.
- **Player vitals** (`VITALS`, `STAMINA` in config.ts): **armor** 50 absorbs damage first and
  regenerates 5/s after 4 s unhit; **health** 100 never regenerates (0 = defeat); **stamina**
  100 regenerates 32/s after a 0.5 s pause and pays for sprinting (20/s), jumps (10 ground /
  16 air), and dashes (22). No fixed double-jump/air-dash limits — chain them while stamina
  lasts (dash keeps its 0.55 s cooldown). Sprint 22 m/s.
- 0.4 s invulnerability after a hit; dash i-frames dodge everything.
  Laser sword: 3-hit combo (28/28/44) toward the camera aim; air swings hang briefly.
- **Decision log** (`fight.decisions`): per decision, damage dealt and damage taken — the
  reward signal for M4.

## 3. AI algorithm
### What the AI controls
Split the boss into two layers, like most shipped game AI:
- **Tactical brain (learned):** every time the boss finishes a move, it picks the next one.
- **Motor control (scripted):** pathing, facing, telegraphs, hitboxes for each move.

Action space — discrete *move × aim* arms (~12–15 total):
| Move | Description |
|---|---|
| Lunge | fast gap-closing strike |
| Sweep | 360° short-range blade spin |
| Slam | leap + AoE at a target point (telegraphed) |
| Volley | spread of slow projectiles |
| Beam | sweeping laser |
| Reposition | dash to flank / create distance |

Aim modes: *current position*, *lead 0.5s*, *lead 1.0s*, *predicted dodge side*. Learning which
aim works against which player is where adaptation becomes visible.

### Algorithm: contextual bandit (LinUCB or linear Thompson sampling)
- **Context vector (~12 features):** distance to target, target relative velocity/direction,
  target HP, boss HP, players alive, target airborne, time since target's last dash, target's
  historical dodge-direction tendencies (from their profile), recent damage taken, bias.
- **Per arm:** a `d×d` inverse matrix and a `d` vector (~180 numbers). Updates are a
  Sherman–Morrison rank-1 step, cheap enough to run **inside the SpacetimeDB module**.
- **Why this and not deep RL:** sample efficiency. A hackathon yields maybe hundreds of fights
  (~10k decisions). A linear bandit learns visibly from that; PPO on 3D combat from scratch
  would not converge in time. The logging and feature pipeline is reusable for deep RL later.

### Reward: per decision, not per battle
Answering the "whole battle vs. each step" question: **per step**, for learning.
- `reward = damage dealt to players − λ · damage taken by boss`, measured over the move's
  window (start → end of recovery, ~1.5–3s), clipped to [-1, 1].
- Whole-battle reward is too sparse: one signal per ~2 minutes means far more fights than we'll
  get. **Win rate** is used instead as the *evaluation metric* on the dashboard.
- Stretch: n-step return (add discounted rewards of the next k decisions) for a little
  lookahead without changing the algorithm.

## 4. Data storage (SpacetimeDB tables)
| Table | Purpose |
|---|---|
| `player` | identity, display name, `consented`, `flagged`, online |
| `player_state` | position, velocity, yaw, HP, action state (realtime, ~20 Hz) |
| `player_profile` | running stats: dodge direction counts, aggression, etc. |
| `boss` | position, HP, current move, move start time, target |
| `fight` | start/end, outcome, players, `valid` |
| `decision` | fight, time, context vector, arm, reward, resolved |
| `policy_arm` | per-arm bandit parameters + pull count |
| `policy_snapshot` | copy of all arms every K fights ("Boss v12") for rollback + dashboard |

Only what learning needs is persisted long-term (decision contexts, not 20 Hz position logs).
Reducers resolve decision rewards when windows close; the policy updates at **fight end**.

**Single-player (multiplayer cut):** the fight simulates entirely in the browser. The client
subscribes to `policy_arm` and makes boss decisions locally with the shared weights. At fight end
it calls `submit_fight(log)`; the server validates the log, writes `fight` + `decision` rows,
applies the bandit update, and snapshots the policy. `player_state` and `boss` realtime tables
are not needed. Because the sim is client-side, validation of the submitted log (§5) matters
more: check timestamps, reward ranges, decision counts vs. fight duration, and arm ids.

## 5. Rejecting bad runs
Filter what is **impossible**, not what is **unusual** — novel player strategies are exactly the
data the boss should learn from.
- **Server validation:** max speed, no teleports, cooldowns enforced, `heightAt` ground checks,
  hits validated by range/angle. Violations increment a counter; past a threshold the player is
  `flagged` and their decisions are excluded.
- **Fight validity (checked at fight end, before updating):** minimum duration, at least one
  active consenting player, AFK players (no input >10s) excluded.
- **Bounded influence:** clipped rewards and a cap on decisions per player per hour, so one
  player can't steer the boss.
- **Rollback:** policy snapshots allow reverting a poisoned policy.

## 6. Training in limited time
1. **Warm start:** hand-set priors so the untrained boss is sensible (sweep up close, volley at
   range).
2. **Bot players:** a Node script using the SpacetimeDB client SDK runs several bots with
   different styles (aggressive, kiter, always-dodges-left) and fights all night →
   thousands of decisions by morning. Bot data is tagged.
3. **Real players:** the **Web Games Competition (Sat 9 PM)**, Discord, and friends.
4. **Demo moment:** let a judge fight **Boss v0** and then the **current boss**, with the brain
   panel showing what changed.

## 7. Consent
On first visit, before joining:
> This boss learns from the players who fight it. If you agree, your in-game actions
> (movement, attacks, dodges, timing) are recorded anonymously to train it. No personal
> information is collected. **[Fight & help train]** **[Just fight]**

Stored as `player.consented`; decisions involving non-consenting players aren't used for
updates. Identity is SpacetimeDB's anonymous identity — no accounts, no PII.

## 8. Multiplayer (Sunday stretch)
**Tier 1 — Global Resistance.** Table `global_skynet { id, coreIntegrity, defeatedCount }` and
`resistance_event { fighter, damage, at }`. `submit_fight` subtracts validated damage from the
shared integrity; clients subscribe and show a live global bar + feed ("Pilot 3f2a dealt 420").
When integrity hits 0, Skynet is "defeated" community-wide and respawns stronger (next policy
snapshot). Reuses the single-player architecture; ~45 min.

**Tier 2 — Co-op raid.** Tables `raid { id, state }`, `raid_player { identity, raidId, pos,
vel, yaw, hp, action }`, `raid_boss { raidId, pos, hp, move, moveStartedAt }`, plus a scheduled
`raid_tick` reducer (~20 Hz) that imports `sim/` and steps Skynet server-side. Players send
inputs/positions ~20 Hz (sanity-checked); clients interpolate others and Skynet; all damage
resolved server-side. Boss HP scales with player count; the bandit picks a target + move.
This only works because `sim/` is pure, tick-based, and RNG-injected — keep it that way.
Verify scheduled-reducer tick rates in the SpacetimeDB 2.x docs before starting.

## 9. Pitch angle for the tracks
- **AI track:** online learning from a crowd of players, not an LLM wrapper — the boss's
  behavior is a model trained on community data and updated live.
- **Spacetime track:** SpacetimeDB is the game server *and* the boss's brain — policy weights,
  training data, and real-time state all live in the database, and every player shares one
  evolving boss.
