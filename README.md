# Skynet Attack Online (SAO)

**A browser boss fight against an AI that learns from every player who fights it.**

Built at MHacks 2026.

## Inspiration

The name is a nod to two stories about where games and AI are heading.

**Skynet**, from *The Terminator*, is the classic picture of AI as an overlord: a system that
learns, adapts, and takes over the society that built it. Here, Skynet is the boss. It isn't
a scripted enemy with a fixed set of attacks. It is a learning system that studies how players
fight and changes its tactics to beat them.

**SAO** honors *Sword Art Online*, the anime that made a generation dream about fully
realistic virtual worlds full of truly intelligent game characters. That dream is the goal
here: enemies that think rather than repeat.

AI in game development today mostly speeds up *making* games, through code assistants and
engine plugins. AI could play a far bigger role *inside* games, turning static dialogue into
real conversation and boss fights with fixed patterns into complex, adaptive battles. SAO is
a first step toward that.

## What it does

You play an armored space hero with a laser sword and fold-out cybernetic wings. Your target
is **Skynet**, a floating machine intelligence with a glowing red core, perched on a
vine-covered pillar at the center of a scorched alien crater.

The arena is built around a choice between speed and safety:

- **Four open corridors** run straight to Skynet from the north, south, east, and west. They
  are the fastest route in, and they leave you fully exposed to its attacks.
- **Four ruined fortresses** fill the space between them. Each has a maze of crumbling
  concrete walls, roofed upper levels to hide under, and walls that sink, rise, and slide to
  open one path while closing another.
- **Leaning skyscrapers**, half-buried in the sand, rise higher than Skynet itself. Climb
  their vines and dive at it from above.

Movement is fast and free: sprint, double jump, steer in mid-air, dash in any direction
including straight up, climb glowing vines, wall-jump, and spread your wings to glide.

Skynet picks every attack using a **learned policy shared by the whole player community**:

- Every fight from a player who opts in becomes training data.
- Skynet scores each of its moves by how much damage it dealt and how much it took, and
  updates its strategy after each valid fight.
- The updated brain goes to every player right away. The Skynet you fight tonight has learned
  from everyone who fought it before you.

Skynet doesn't just aim better over time; it learns to counter **how you play**:

- It keeps a running profile of your habits: how far away you fight, how much you hide, how
  often you dash, swing, sprint, or use skills. A panel shows its read on you ("CAMPER: hidden
  71% of the time").
- It has 24 moves to choose from, including counters it only uses once it has learned they
  work. **Hunter Drones** phase through walls to reach campers. A **Reflect Shield** bounces
  sword beams back at snipers and punishes button-mashing brawlers. A **Feint** fakes a volley
  to bait your dodge. A **Sweeping Laser** rakes the open ground where strafers run.
- It leaves its perch to **hunt** you down, **flank** around cover for a clear shot, rise,
  or retreat.
- Every counter-move is called out on screen with Skynet's reason, for example "HUNTER DRONES:
  because you hide in cover". Hold Tab to see what the community has taught it: its best
  moves against each kind of player, next to the untrained version that picked at random.

The longer people play, the harder Skynet gets. Beating it takes a community, not a single
hero.

## How we built it

- **Game:** TypeScript and [Three.js](https://threejs.org/) in the browser, with a custom
  character controller tuned for fast movement. The hero, Skynet, and the whole arena are
  built and animated in code, with no imported 3D models.
- **Arena:** generated from a fixed seed, so every player, the server, and the training bots
  get exactly the same map. A custom collision system handles walls, ceilings, moving walls,
  climbable surfaces, and tilted towers. The same line-of-sight check that decides whether
  Skynet can hit you also keeps the camera from clipping through walls.
- **Shared simulation:** all combat rules and AI logic live in one pure-TypeScript package
  with no rendering code. The browser, the game server, and the overnight training bots all
  run the same code.
- **Boss AI:** a contextual bandit (LinUCB) with 25 options and 29 inputs. Before each move,
  Skynet reads the situation (distance, cover, your movement, health, cooldowns) and your
  play-style profile, then picks the move it expects to work best, while still trying new
  ones. Because the model is linear, every choice can be explained: the HUD shows which of
  your habits pushed Skynet toward it.
- **Training:** five scripted bot styles (brawler, kiter, camper, dodger, sniper) fought it
  1,500 times through the real server before the event, so Skynet arrives with counters
  already learned, and human fights keep refining them.
- **Backend:** [SpacetimeDB](https://spacetimedb.com/) stores the boss's brain, the fight
  history, and the training data. Every fight log is checked on the server before it can
  change the model, and every player stays in sync with the latest version.

## Challenges we ran into

_TODO_

## Accomplishments we're proud of

_TODO_

## What we learned

_TODO_

## What's next

- Co-op raids, where squads fight one shared Skynet in real time.
- Deeper learning models (deep reinforcement learning) trained on the collected fight data.
- Dynamic, AI-driven dialogue: Skynet taunting and reacting to each player.

## Controls

| Action | Key |
|---|---|
| Move | WASD |
| Look / aim | Mouse (click the game to capture it, Esc to release) |
| Sprint | Shift |
| Jump / double jump | Space |
| Dash (follows your aim, including up and down) | Q or right-click |
| Glide (in the air; look down to dive) | Hold Caps Lock |
| Laser sword (3-hit combo) | Left-click |
| Lightning Strike (at the reticle, medium range) | 1 |
| Blade Rush (charge through, slashing) | 2 |
| Sword Beam (laser toward the reticle) | 3 |
| Climb | Push into glowing vines; jump to kick off |
| What Skynet has learned | Hold Tab |

## Data and consent

Skynet only learns from players who opt in. If you agree, your in-game actions (movement,
attacks, dodges, timing) are recorded anonymously. No personal information is collected.
You can always fight without contributing.

## Running locally

Everything (Node.js, SpacetimeDB CLI, local database) runs from inside the repo; nothing is
installed system-wide. Toolchain binaries live in `.tools/` (gitignored). See
[CLAUDE.md](CLAUDE.md) for setup.

```powershell
. .\env.ps1            # put project-local node + spacetime on PATH
npm install
npm run db:start       # terminal 1: local SpacetimeDB on :3000
npm run db:publish     # terminal 2: publish the server module
npm run dev            # client on http://localhost:5173
```
