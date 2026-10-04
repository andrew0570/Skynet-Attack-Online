# Skynet Assault Online (SAO)

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

You drop into a crater arena to fight **Skynet**, a floating machine intelligence with a
glowing core and orbiting blade rings. Movement is fast: sprint, jump, and dash past its
attacks, then close in with your energy blade.

Skynet picks every attack using a **learned policy shared by the whole player community**:

- Every fight from a player who opts in becomes training data.
- Skynet scores each of its moves by how much damage it dealt and how much it took, and
  updates its strategy after each valid fight.
- The updated brain goes to every player right away. The Skynet you fight tonight has learned
  from everyone who fought it before you.

The longer people play, the harder Skynet gets. Beating it takes a community, not a single
hero.

## How we built it

- **Game:** TypeScript and [Three.js](https://threejs.org/) in the browser, with a custom
  character controller tuned for fast movement.
- **Shared simulation:** all combat rules and AI logic live in one pure-TypeScript package
  with no rendering code. The browser, the game server, and the overnight training bots all
  run the same code.
- **Boss AI:** a contextual bandit (LinUCB). Before each attack, Skynet reads the situation
  (distance, your movement, health, your dodge habits) and picks the move it expects to work
  best, while still trying new ones.
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
