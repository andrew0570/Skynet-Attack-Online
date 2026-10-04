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
- **Skynet** perches 7 m above the pillar (1200 HP). An **energy bar** (max 100, +12/s since the
  Oct 4 balance pass; was 9) pays for attacks (20–40 each) plus a 0.5 s pause after each,
  capping it at ~1 attack / 2–3 s. Bolt Volley bolts fly at 60 m/s (was 42).
- **Attacks** (telegraphed: core charges, aim line for ranged, red ground rings for landings):
  - Bolt Volley — 5 fast bolts, re-aimed per shot · Spread Shot — 7-bolt fan
  - Seeker Orbs — 3 slow homing orbs · Mortar — 4 lobbed shells that arc over walls (AoE)
  - Blade Sweep — ring AoE around Skynet (close range)
  - Dive Slam — dives onto the target, shockwave AoE, then **stunned 2.4 s (1.5× damage)**
- Bolts/orbs are blocked by walls and roofs (`raycast`); mortars are the anti-camping tool.
- **Decision = arm** (25 since moveset 2.0, §2d): wait 0.5 s, attack × aim mode
  (direct / lead / flank — flank offsets toward the player's last dodge side), or a
  repositioning move. The brain chooses frequency (by waiting), aim, and position; energy
  enforces the hard limit.
- **Player vitals** (`VITALS`, `STAMINA` in config.ts): **armor** 50 absorbs damage first and
  regenerates 5/s after 4 s unhit; **health** 100 never regenerates (0 = defeat); **stamina**
  100 regenerates 32/s after a 0.5 s pause — only on the ground or while climbing vines, never
  in the air or gliding — and pays for sprinting (20/s), jumps (15 ground / 20 air / 15 wall),
  and dashes (25). No fixed double-jump/air-dash limits — chain them while stamina lasts (dash
  keeps its 0.55 s cooldown). Sprint 22 m/s.
- 0.4 s invulnerability after a hit; dash i-frames dodge everything.
- **Skills** (`SKILLS` in config.ts; aimed by the reticle ray, `aimRay` in combat.ts, which
  hits Skynet, walls, or terrain): **1 Lightning Strike** — column from the sky at the aim
  point clamped to 6–35 m, 0.35 s cast, 80 dmg, 7 s cooldown; **2 Blade Rush** — 14 m
  invulnerable charge along the aim, an 8-slash flurry (up to 8 × 12 dmg) passing through, 9 s; **3 Sword
  Beam** — 70 m/s laser from the sword, 40 dmg, blocked by walls, 2.5 s.
  Laser sword: 3-hit combo (28/28/44) toward the camera aim; air swings hang briefly.
- **Decision log** (`fight.decisions`): per decision, damage dealt and damage taken — the
  reward signal for M4.

## 2c. Learning brain — final M4 design (decided Sat 11:40 PM; supersedes §3–§6 details)
- **Model:** disjoint LinUCB — one ridge-regression model per arm over a 20-feature context.
  Score = θ·x + α·√(xᵀA⁻¹x); pick the best *valid* arm. Per arm we store A (d×d), b, and the
  cached A⁻¹ and θ. Update: A ← γA + (1−γ)λI + xxᵀ, b ← γb + r·x, then recompute A⁻¹ exactly
  (d = 20: ~8k flops) — forgetting (γ ≈ 0.999) without the numerical drift of rank-1 inverse
  updates. Deterministic: same weights + context ⇒ same choice.
- **Arms (25, moveset 2.0 — see §2d):** wait 0.5 s · {volley, spread, homing, mortar} ×
  {direct, lead, flank} · sweep · dive × {direct, lead} · reflect · feint × {lead, flank} ·
  drones · laser (lead) · move × {hunt, flank, rise, retreat}. Validity: energy affordable;
  sweep only when close; dive ≤ 75 m; hunt only when not already close; rise below max
  altitude; retreat only when off the perch. (M4 shipped the first 16.)
- **Context (29, normalized):** bias · distance · height diff · player visible · under roof ·
  horizontal speed · closing speed · airborne · climbing · stamina · can-dodge-now · health ·
  armor · lightning/rush/beam ready · Skynet energy · Skynet HP · Skynet projectiles in flight ·
  player's recent dodge rate · Skynet away from perch · **8 play-style habits** (§2d).
- **Cadence:** a decision whenever Skynet is free — after an attack's recovery + 0.5 s pause,
  or 0.5 s after a wait (≈ every 0.5 s while holding back).
- **Reward (HP-fraction):** `clip(dealt/30 − taken/240 − 0.1·cost/40, −1, 1)`. *Dealt* = damage
  from the projectiles/hits that decision caused (even if they land later); *taken* = damage
  Skynet takes from that decision until the next. Scored once its window ended and all its
  projectiles resolved (all forced at fight end). No win/loss term (win rate is the metric).
  **Moves** deal no damage themselves, so a move also earns 0.6 × the reward of the decision
  right after it (the attack it set up) — otherwise a one-step bandit would never reposition.
- **Where it runs:** choices in the client's sim with weights **frozen at fight start** (the
  version shown on screen). At fight end the client calls `submit_fight` with every
  (context, arm, reward); the server **validates the whole fight first**, then applies all
  updates, bumps the policy version, and snapshots every 10 fights. Clients subscribe and pick
  up new weights for their next fight.
- **Validation (M4):** consent required; 5–1800 s duration; ≤ 2.5 decisions/s and ≤ 600 per
  fight; arm ids valid; contexts finite, in range, bias = 1; rewards in [−1, 1]; ≥ 5 s between
  submissions per identity. Rejected fights are recorded with a reason, never learned from.
  **Stretch (M5):** server replays the fight from seed + input log (the sim is deterministic).

## 2d. Moveset 2.0 — adapting to play styles (built Sun ~2–3 AM)

Goal: make Skynet's learning visible as *counters to how you play*, not just better aim.
- **Play-style profile** (`fight.style`, rolling ~20 s memory, `updateStyle` in combat.ts):
  average range · share of time hidden from Skynet · airborne · on the pillar top · moving
  fast (> 12 m/s) · close sword swings / min · skills / min · dashes / min. These are the 8
  "habit" features, so the bandit learns *style → best move*. `describeStyle` labels the
  dominant habit: Sniper · Camper · Brawler · Pillar climber · Dodger · Aerialist · Runner.
- **Mobility** (move arms, 6 energy, flown at 24 m/s, 0.35–2 s): **Hunt** (hover 7 m from you,
  inside Blade Sweep range) · **Flank** (nearest point 20 m around you with line of sight) ·
  **Rise** (+12 m) · **Retreat** (back to the perch). Hover height clears fortress roofs.
  Dive Slam now returns to wherever Skynet dove from.
- **Style counters:** **Reflect Shield** (1.6 s; sword beams bounce back for 30, sword/rush
  hits do 15 + knockback, lightning is absorbed — vs beam spammers and brawlers) ·
  **Feint** (wind-up identical to Bolt Volley, 0.35 s pause to bait the dash, then 3 bolts at
  70 m/s — vs reactive dodgers) · **Hunter Drones** (2 slow homing drones that phase through
  walls; a sword swing or beam destroys them — vs campers) · **Sweeping Laser** (beam sweeps
  a ±0.6 rad arc in 1 s; pitch locks onto waist height at your predicted range, so changing
  range or jumping slips it while strafing sideways doesn't; walls block it — vs kiters).
- **Showing it:** "Skynet's read on you" panel (style label, habit bars, last decision and
  *why* — `explainDecision`: the features whose θⱼ·(xⱼ − typical) most raised that move's
  score) · callouts naming each counter / repositioning move with the reason · hold **Tab**
  for "What Skynet has learned": the top 3 moves the live brain predicts against five
  archetype players (`ARCHETYPES`), vs. v0 where every move scored 0.
- **Bots:** five styles (aggressor, kiter, hider under fortress roofs, dodger that pre-dodges
  volley wind-ups, sniper at 55–75 m). Skilled bots hold fire into a shield; drone swats are
  skill-limited. `tools/train-offline.ts` dry-runs a round without the DB.

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
