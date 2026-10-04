# Skynet Attack Online (SAO) — MHacks 2026

Hackathon project for MHacks 2026 (University of Michigan). This file is the source of
truth for project context — keep it updated as decisions are made.

## Hackathon constraints
Full details in [docs/handbook.md](docs/handbook.md).
- **Hacking window:** Sat Oct 3, 12 PM → Sun Oct 4, 12 PM (24 hours).
- **Submission deadline:** Sun Oct 4, **12:00 PM** on Devpost — hard deadline, no exceptions.
- **Judging:** Sun Oct 4, 12:30–2:30 PM in person; 3-min pitch + demo; team must be present.
- **Judging criteria:** innovation, technical complexity, usability, presentation quality.
- **Rules:** teams of 1–4; all code written during the hackathon.
- **Team:** Solo — scope must stay tight; every feature needs a cut line.
- **Tracks targeted:**
  - **Actually Intelligent (AI)** — applied AI at the core, beyond an LLM wrapper or agent.
  - **Best use of Spacetime** — SpacetimeDB as the core real-time backend (must be meaningful).
  - Also eligible: Grand Prize. Optional low-effort: Notability, .Tech domain.

## Problem statement
AI in game development today mostly speeds up *making* games (e.g. AI plugins in engines).
AI could instead play an integral role *inside* games: dialogue and character interactions
become dynamic conversations, and boss battles go from pre-ordered movesets to complex,
adaptive fights. Deeper integration of AI brings games to life — the sci-fi games we dream of.

## Theme and naming
- **Project:** *Skynet Attack Online* (**SAO**) — a nod to *Sword Art Online*, which inspired
  the dream of realistic virtual worlds with truly intelligent game characters.
- **Boss:** **Skynet** (from *The Terminator*) — AI as a dangerous overlord that learns and
  adapts. A floating machine intelligence: glowing red core + orbiting blade rings, procedurally
  animated (no rigging).
- **Narrative:** the player community must come together to defeat a highly difficult AI —
  and the community's own fights are what make Skynet smarter.
- **Player:** armored space hero with a laser sword (procedural model + animation in
  `client/src/hero.ts`); armor (regenerates) / health (doesn't) / stamina (fast regen; pays
  for sprint, jumps, dashes — no fixed air-jump/air-dash limits); sprint, jumps with air
  steering, aimed 3D dash (up to
  ~83°), skills 1/2/3 (Lightning Strike, Blade Rush, Sword Beam) aimed with the center
  reticle, vine climbing + wall jump, Caps Lock glide with fold-out cybernetic wings (look down
  to dive). Glide was moved off Ctrl to avoid Ctrl+W closing the tab — don't bind gameplay to
  Ctrl.
- **Arena:** 100 m scorched-desert crater: Skynet atop a central pillar, four open cardinal
  corridors (its lines of attack), four walled multi-level fortresses with a shifting maze
  (sinking/sliding walls), leaning half-buried towers, fallen-tower ramps, climbable vines.
  No moving platforms. See design.md §2a.
- Use "Skynet" in code and UI (not "Warden" — that was a placeholder name).

## Idea
**A 3D browser boss battle where Skynet is driven by a learning algorithm, trained by the
community of players who fight it.** Every fight (from consenting players) becomes training
data; the boss's policy lives in SpacetimeDB and is shared by every player's game — so the
Skynet everyone faces keeps getting smarter.

Design details and reasoning: [docs/design.md](docs/design.md).

### Core demo flow (MVP)
1. Open the site → consent notice → spawn into a small 3D arena.
2. Fight Skynet with fast movement (sprint, dash, jump) and a basic attack.
3. Skynet chooses moves via the shared learned policy; fight ends in win/loss.
4. Show a live "Skynet brain" panel: fights learned from, how its move preferences have
   shifted, and how it has adapted to common player habits.

### Multiplayer
Single-player first (tonight). Multiplayer is a **high-value stretch for Sunday morning** —
it fits the "community unites against Skynet" theme. Two tiers, in order:
1. **Global Resistance** (cheap): a shared Skynet "core integrity" pool in SpacetimeDB; every
   player's damage in their own fight drains it live, and everyone sees the bar and a feed.
2. **Co-op raid** (expensive): players share one arena; Skynet runs server-side in a scheduled
   reducer using the same `sim/` code. Only if M1–M5 are done.

### Milestones
Schedule and done-criteria: [docs/milestones.md](docs/milestones.md).

## Architecture
- **Simulation (`sim/`, package `@sao/sim`)**: pure TypeScript game logic — terrain, arena
  generation + collision + `raycast` (line of sight), player controller, and (M3+) Skynet,
  moves, damage, features, bandit decision. `stepPlayer(p, input, dt, arena, time)`;
  the whole fight advances via `stepFight(fight, arena, input, dt, brain)` (combat.ts), which
  returns events the client turns into VFX. `Brain = (fight, arena, validArms) => armIndex`. **No Three.js, DOM, or Node imports**, so the same
  code runs in the browser, the bot trainer, and (for co-op) the SpacetimeDB module. Keep it
  **tick-based** (`step(state, inputs, dt)`) and free of wall-clock/`Math.random` calls
  (pass in an RNG) so the server can own the sim later.
- **Client (`client/`, `@sao/client`):** renders the sim with Three.js, reads input,
  subscribes to the policy, submits the fight log at fight end.
- **Brain (`sim/src/brain.ts`):** LinUCB features/model/validation shared by client, server,
  and bots. Design: docs/design.md §2c.
- **Server (`server/`, `@sao/server`):** SpacetimeDB TypeScript module (imports `@sao/sim`).
  Tables: player (consent, rate limit), policy_meta, policy_arm, fight, policy_snapshot.
  `submit_fight` validates the whole fight, then trains and bumps the version. Only the
  server learns; clients freeze the weights per fight (`client/src/net.ts`).
- **Client fight loop:** the fight only advances while the mouse is captured (Esc pauses);
  `?autoplay` / `?shot` keep it running for tests and screenshots.
- **Client bindings:** `client/src/module_bindings/` is generated — regenerate with
  `npm run db:generate` after changing server tables/reducers; never edit by hand.
- SpacetimeDB 2.x TypeScript API reference: [docs/spacetimedb-guide.md](docs/spacetimedb-guide.md).

## Tech stack
- **Language:** TypeScript everywhere; npm workspaces (`sim`, `client`, `server`).
- **Client:** Vite 8 + Three.js 0.186; custom kinematic character controller (no physics engine).
- **Backend:** SpacetimeDB 2.10 (TypeScript module + TypeScript client SDK).
- **Boss AI:** contextual bandit (LinUCB) over discrete Skynet moves; decisions computed from
  the shared policy, updates applied server-side.
- **Hosting (Sunday):** SpacetimeDB Maincloud + static frontend host.

## Directory layout
```
.
├── CLAUDE.md            # Project context for Claude (this file)
├── README.md            # Public-facing description (doubles as Devpost draft)
├── env.ps1              # Puts project-local node + spacetime on PATH
├── package.json         # npm workspaces root + scripts
├── spacetime.json       # SpacetimeDB project config (module path, default server)
├── spacetime.local.json # Database name
├── sim/src/             # Shared pure-TS game simulation + AI
├── client/              # Vite + Three.js game (src/module_bindings is generated)
├── server/src/          # SpacetimeDB module
├── tools/               # Headless bot trainer (M5)
├── docs/                # design, milestones, handbook, SpacetimeDB guide, notes
└── .tools/              # Gitignored toolchain: node, spacetime CLI, local DB data, npm cache
    └── bin/spacetime.cmd  # Wrapper pinning the CLI to .tools/spacetime-root (tracked)
```

## Toolchain (project-local, nothing installed system-wide)
- Node.js v24.21.0 LTS → `.tools/node-v24.21.0-win-x64/`
- SpacetimeDB CLI + standalone v2.10.2 → `.tools/spacetime/`, all config/keys/data in
  `.tools/spacetime-root/` via the `spacetime` wrapper.
- npm cache → `.tools/npm-cache/`.
- VS Code terminals get the PATH automatically (`.vscode/settings.json`). In other shells (and
  in every Claude PowerShell call) run `. .\env.ps1` first.
- The path is under `OneDrive\Desktop`, but the user has **signed out of OneDrive** on this
  machine (Oct 3), so nothing syncs or locks files. If OneDrive is ever signed back in, move
  the project out (e.g. `C:\dev\skynet-attack-online`, then `npm install` to rebuild the
  absolute-path workspace junctions in `node_modules/@sao`).

## Commands
Run from the repo root after `. .\env.ps1`:
| Command | What |
|---|---|
| `npm install` | Install all workspace deps (single root `node_modules`) |
| `npm run db:start` | Local SpacetimeDB on `127.0.0.1:3000` (keep running) |
| `npm run db:publish` | Build + publish `server/` to local DB `skynet-attack-online` |
| `npm run db:generate` | Regenerate client bindings |
| `npm run db:logs` | Module logs |
| `npm run dev` | Client dev server → http://localhost:5173 (hot reload is OFF — refresh manually; see `client/vite.config.ts`) |
| `npm run build` | Type-check (client + sim) + production build of the client |
| `npm run sim:smoke` | Headless movement checks for `sim/` (run after touching `sim/`) |
| `npm run test:browser` | Drives the real client in headless Edge (needs `npm run dev`). `SAO_SLOW_CLOCK=1` simulates a high-refresh display; `SAO_SKILLS=1` tests skills; `SAO_BRAIN=1` tests the full learning loop (needs the DB); `SAO_URL` overrides the page |
| `npx tsx tools/db-smoke.ts` | End-to-end brain test against the local DB: consent, validation, rate limit, training |
| `npm run train:bots` | Bot training through the real server (`RUNS`, `BACKUP_EVERY` env; defaults 250 / 50) |
| `npm run train:report` | Builds `backups/skynet-training.html` from the newest training run |
| `npm run brain:backup` | Backs up the current brain to `backups/`; `-- --v0` writes the untrained v0 brain |
| `npm run db:reset` | Wipes the local DB and republishes (fresh v0 brain) — back up first |
| `npx tsc --noEmit -p server` | Type-check the server module (`spacetime build` skips it) |
| `spacetime sql --server local skynet-attack-online "SELECT * FROM player"` | Inspect data |

## Working conventions
- Hackathon pace: favor working demos over polish; hardcode/mock anything not on the demo path.
- Keep each milestone demoable before starting the next; commit at every milestone.
- Keep secrets in `.env` (gitignored); never commit API keys or tokens.
- Never rewrite files with Windows PowerShell 5.1 `Get-Content`/`Set-Content`/`WriteAllText`
  round-trips: it reads UTF-8 as ANSI and corrupts non-ASCII characters (em dashes, ×, →).
  Use the Edit tool or bash `sed`.
