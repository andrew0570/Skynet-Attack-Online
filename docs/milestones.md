# Milestones — Skynet Attack Online (Sat Oct 3 → Sun Oct 4)

Planned at 7:51 PM Saturday. Devpost deadline: **Sun 12:00 PM**.
Each milestone ends in a working, committed state. If a milestone runs over by more than
30 minutes, apply its cut line and move on.

## M1 — Setup · 8:00 → 8:45 PM ✅
- Project-local Node.js + SpacetimeDB CLI (`.tools/`), npm workspaces `sim`/`client`/`server`.
- **Done:** placeholder Skynet core renders at http://localhost:5173, module publishes to the
  local DB, client bindings generated, first commit.

## M2 — Arena + movement · 8:45 → 10:45 PM ✅ (first pass 8:24 PM — needs playtest tuning)
Controls: WASD, mouse look (click to lock), Shift sprint, Space jump + double jump,
Q / right-click dash. Tunables in `sim/src/config.ts` (`PLAYER`).
- Seeded heightmap crater terrain (`sim/terrain.ts` → `heightAt(x, z)`), rim as boundary.
- Third-person camera (mouse look, pointer lock).
- Kinematic controller in `sim/` (tick-based): WASD, sprint, jump, dash with brief
  invulnerability. Tune for speed.
- **Done when:** you can run, jump, and dash around the crater and it feels fast and responsive.
- **Cut line:** flat ground with a circular boundary wall instead of the heightmap.

## M2.5 — Hero + maze arena · 8:40 → 9:22 PM ✅ (added; M3+ times below include ~30 min buffer)
Armored hero + laser sword + bloom; 100 m maze arena with pillar, vines, moving platforms,
collision, camera wall-avoidance, `raycast` line of sight. Schedule below shifted to match.

## M3 — Skynet + combat loop · 10:00 PM → 12:30 AM ✅ (done 10:47 PM)
Built: `sim/src/combat.ts` (fight state, Skynet energy + 17-arm action space, 4 projectile and
2 melee attacks, sword combo, decision log), combat VFX + HUD + restart on the client.
Placeholder `heuristicBrain` picks arms until M4 swaps in the learned policy.
Arena-aware design: Skynet perches above the pillar; ranged moves (Volley) are blocked by walls
via `raycast`; Lunge/Slam bring it down to the target, opening a window to strike. Sword
swing trail lands here too.
- Skynet visuals: glowing core + orbiting blade ring, procedural bob/spin, color telegraphs.
- 4 moves in `sim/`: **Lunge, Sweep, Slam, Volley**, each with telegraph → active → recovery.
- Player blade attack (short arc, cooldown); HP for both; hit detection in `sim/`.
- HUD: player HP, Skynet HP. Win/lose screen, restart.
- Skynet picks moves with a simple scripted rule (placeholder for M4).
- **Done when:** a full fight is playable start to finish, and both win and loss are possible.
- **Cut line:** 3 moves (drop Volley); skip aim modes.

## M4 — Learning brain + SpacetimeDB · 12:30 → 2:45 AM ✅ (done 12:09 AM)
Built: LinUCB brain in `sim/src/brain.ts` (20 features, 16 arms, HP-fraction reward, exact
inverse with forgetting), SpacetimeDB tables + `submit_fight` (validate whole fight, then
train), client sync (`client/src/net.ts`) with per-fight frozen weights, consent screen,
brain status line, fight pauses until engaged. Verified end-to-end in a real browser
(fight with v1 → lost → trained to v2). Brain panel moved to Sunday.
- `sim/brain.ts`: feature vector (~10 features), LinUCB arm selection, reward windows
  (damage dealt − λ·damage taken, clipped).
- Server tables: `player` (consent — exists), `fight`, `decision`, `policy_arm`,
  `policy_snapshot`.
- Reducers: `set_consent` (exists), `submit_fight(log)` → validate → insert rows → bandit
  update → snapshot every K fights.
- Client: subscribe to `policy_arm`, use it for decisions, submit the log at fight end.
- Consent screen before the first fight.
- **Done when:** finishing a fight changes `policy_arm` rows in the DB, and the next fight uses
  the updated policy.
- **Cut line:** skip snapshots and player profiles; minimal validation (counts + ranges only).

## M5 — Overnight bot trainer · 2:45 → 3:30 AM ✅ (done ~1:00 AM)
Round 1: 250 fights, old balance (Skynet 2% wins in the last 50). Balance pass (bolts 60 m/s,
energy 12/s), DB reset to v0. Round 2: 1000 fights → brain v1000, Skynet win rate 15% (first
100) → 31% (last 100), 0 rejected, 21 backups (v0, v50 … v1000) in backups/.
- `tools/train-bots.ts`: runs `sim/` headless in Node with 3 scripted player styles
  (aggressive, kiter, always-dodges-left), many fights at accelerated time, submitting logs
  through the same `submit_fight` path. Tag bot fights.
- **Done when:** the trainer runs unattended and the fight count climbs. **Start it before
  you sleep** — this is what makes Skynet look smart in the demo.
- **Cut line:** one bot style.

## Sleep · ~3:30 → 8:00 AM

---

## Sunday morning
| Time | Milestone | Done when / cut line |
|---|---|---|
| 8:00 – 8:45 | **M6 Global Resistance** — shared Skynet core-integrity bar + live damage feed | Two browser tabs see each other's damage drain the global bar live |
| 8:45 – 10:00 | **M7 Co-op raid** *(only if M1–M5 all done)* — shared arena, server-side Skynet tick | Two tabs fight one Skynet together. **Hard stop 10:00**; keep behind a "Raid" button so solo mode stays demoable |
| 10:00 – 10:30 | Deploy: SpacetimeDB Maincloud + static frontend host | Live URL works on a second device |
| 10:30 – 11:00 | Skynet brain panel: fights learned, move-preference bars, v0 vs. current toggle | Cut line: fights-learned counter + bars only |
| 11:00 – 11:40 | Devpost (README is the draft), screenshots, short demo video | **Submit by 11:40** |
| 12:30 – 2:30 | Judging — 3-min pitch: problem → live fight → brain panel → global bar | — |

## Skipped deliberately
- 9 PM Web Games Competition (no playable build by then), aim modes, Beam and Reposition moves,
  deep RL, voice — stretch only if ahead of schedule.
