# Skynet Attack Online (SAO)

**A boss fight against an AI that learns from every player who fights it.**

🎮 **Play it:** https://andrew0570.github.io/Skynet-Attack-Online/ · 💻 **Code:** https://github.com/andrew0570/Skynet-Attack-Online

Built solo by Andrew Gohlich (Team Redbull-ean Logic) for MHacks 2026, for the **Actually Intelligent** and **Best Use of SpacetimeDB** tracks.

---

## Inspiration

I grew up on *Sword Art Online*. The part that stuck with me wasn't the swords. It was the idea of a virtual world that feels alive: characters that react to you, enemies that think, fights that are different every time. That's the dream the name **SAO** nods to.

Then I looked at how AI is actually used in games today. Almost all of it helps people **make** games: generating textures, writing code, filling in dialogue drafts. Very little of it lives **inside** the game. Boss fights in particular haven't changed in decades. A designer writes a moveset, tunes it once, and ships it. Every player faces the same patterns, and once the community has figured out the pattern, the fight is solved forever. The "intelligence" is a script.

I wanted to flip that. What if the boss was an actual learning system? What if it watched how *you* play, picked counters on its own, and got smarter from every fight that every player had with it? A boss like that needed a name. **Skynet**, from *The Terminator*, is the classic AI that learns, adapts, and turns on the people who built it. Here, the community has to band together to beat an AI that the community itself is training.

So the premise of **Skynet Attack Online** is a little ironic on purpose. Every fight you win teaches Skynet how to beat the next player.

## What it does

Skynet Attack Online is a fast 3D boss fight that runs in the browser.

**You** play an armored space hero with a laser sword and fold-out cybernetic wings. You can sprint, chain jumps, steer in mid-air, dash in any direction (including straight up), climb glowing vines, wall-jump, and glide. You have a three-hit sword combo and three skills: a lightning strike from the sky, a charging blade rush, and a sword beam. Armor regenerates, health doesn't, and stamina pays for every jump and dash.

**Skynet** is a floating machine core with an orbiting blade ring, perched over a 100-meter scorched crater. The arena is built around a choice between speed and safety. Four open corridors run straight at Skynet and leave you exposed. Four ruined fortresses fill the space between them, with roofed levels to hide under and maze walls that sink and slide. Leaning, half-buried skyscrapers rise higher than Skynet itself.

### The boss learns, and it learns from everyone

Every half second or so, Skynet looks at the fight and picks one of **25 options**. There are 24 moves and a short wait. The moves include volleys, homing orbs, mortars that arc over walls, a dive slam, and repositioning moves that let it hunt you down, flank around cover, rise, or retreat.

It picks with a learned policy that is **shared by every player**. When a player who has opted in finishes a fight, the server checks the whole fight log and then learns from it. Every player gets the updated brain right away, so the Skynet you fight today has learned from everyone who fought it before you. The HUD shows which version of the brain you're facing.

### It reads how you play, and counters it

Skynet keeps a running profile of your habits:
- how far away you fight
- how much you hide in cover
- how much time you spend in the air or on the central pillar
- how much you run
- how often you swing your sword near it, use skills, and dash

Those habits are inputs to its brain, so it learns which moves work against which *kinds* of players. Some of its moves exist specifically to counter a play style:

- **Hunter Drones** phase through walls to reach players who camp in cover.
- **Reflect Shield** bounces sword beams back at snipers and punishes button-mashing brawlers.
- **Feint** fakes a volley wind-up to bait your dodge, then fires late.
- **Sweeping Laser** rakes the open ground where strafing players run. You escape it by changing range or jumping, not by strafing.

Nobody hard-coded "use drones against campers." The AI has to discover which counter pays off.

### It explains itself

A learning AI is only impressive if you can see it learning, so Skynet shows its reasoning:
- **A "Skynet's read on you" panel** shows the style it thinks you have ("CAMPER: hidden 71% of the time"), your habit bars, and its last decision.
- **Every counter-move is called out with its reason**, for example *"HUNTER DRONES: because you hide in cover"*. This works because the model is linear: I can show which of your habits pushed that move's score up the most.
- **Holding Tab** shows what the community has taught it: its best moves against five types of player (sniper, camper, brawler, dodger, runner), next to the untrained version that picked at random.

### It fights back hard

Skynet has per-move cooldowns, so it has to rotate its whole kit instead of spamming one attack. It sidesteps sword beams and lightning strikes it sees coming. Below half health it **enrages** into a second phase with faster energy, chained attacks, and shorter cooldowns.

### Raid mode: the community, literally together

The theme is a community uniting against an AI, so I built a **co-op raid**. On the start screen you pick Solo or Raid. Raid drops you into an open lobby with up to five fighters. Anyone can start, and empty slots fill with bots, the same scripted bots that trained Skynet. Skynet's health scales with the team.

The raid doesn't run on any player's computer. **It runs inside the database.** SpacetimeDB steps Skynet, its attacks, the bots, and everyone's health twenty times a second, using the exact same game code as solo play. Every player sees every teammate (in their chosen color, with nameplates), every attack, and every hit in real time.

### Consent and privacy

Skynet only learns from players who opt in. You choose on the start screen every time you load the game. If you agree, the situations Skynet saw in your fights and how its attacks turned out are sent anonymously. Your callsign and armor color never leave your browser in solo. In a raid they're shown to your teammates and deleted from the server when you leave.

## How I built it

Everything is **TypeScript**, split into three packages in one npm workspace.

### A shared, pure simulation (`@sao/sim`)
The whole game lives in one package with no rendering code, no DOM, and no Node APIs:
- arena generation, collision, and movement
- combat, damage, and Skynet's moves
- the play-style profile
- the AI itself

It's tick-based (60 steps a second) and deterministic, with a seeded random number generator. That decision paid off over and over. The **browser**, the **game server**, and the **training bots** all run the exact same code, so there's one source of truth for what happens in a fight.

### The game client
**Three.js** with **Vite**. There are no imported 3D models: the hero, Skynet, the arena, the wings, and the sword trails are all built and animated in code. A custom collision system handles walls, ceilings, moving walls, climbable vines, and tilted towers. The same line-of-sight check that decides whether Skynet can hit you also keeps the camera out of walls. Bloom post-processing makes the laser sword, Skynet's core, and the attacks glow.

### The AI: a contextual bandit (LinUCB)
Skynet's brain is a **disjoint LinUCB contextual bandit**: one ridge-regression model per option, over **29 inputs**.
- **20 situational inputs:** distance, line of sight, whether you're under a roof, your speed, your health, armor, and stamina, which of your skills are ready, Skynet's own energy and health, projectiles already in the air, and so on.
- **1 input for Skynet's position:** how far it is from its perch.
- **8 play-style habits.**

Each decision, it scores every allowed option by expected reward plus an exploration bonus, so it keeps trying things it isn't sure about. The model keeps an exact matrix inverse (recomputed after each update) with a forgetting factor, so it can track a player base whose habits change over time.

The reward for each decision is roughly:

> damage Skynet dealt, as a share of the player's health, minus damage Skynet took, as a share of its own health, minus a small energy cost

A decision is only scored after every projectile it launched has landed. Repositioning moves deal no damage themselves, so they also earn the reward of the attack they set up. Without that, a bandit that scores one decision at a time would never learn to move.

### SpacetimeDB: the shared brain and the game server
**SpacetimeDB** (on Maincloud) is the backbone:
- **The brain lives in tables:** one row per option holding its model, plus version, stats, and snapshots every 10 fights.
- **`submit_fight` validates before it learns.** A fight is only trained on if the player consented and it passes every check: plausible length, a sane decision rate, valid option IDs, finite and in-range inputs, rewards in range, and a per-player rate limit. Rejected fights are logged with a reason and never touch the brain.
- **Clients subscribe** to the brain tables, so every player picks up the new version for their next fight. Weights are frozen during a fight so a fight is consistent from start to finish.
- **The raid is a scheduled reducer.** It runs at 20 Hz, applies each player's streamed movement and queued hit reports, then steps the raid with the shared simulation. It runs the bots, picks who Skynet targets, and resolves Skynet's attacks against everyone. A tick takes about **2 ms**.
- **Raid hits are validated on the server.** Players report their own hits on Skynet, and the server checks the damage per source, the range, and a per-player damage budget. A forged 5,000-damage hit simply gets ignored.

### Training before the event
A brand-new brain picks at random, so I wrote **scripted bot players** in five styles: brawler, kiter, camper, dodger, and sniper. They play by the same rules as humans and fight Skynet thousands of times **through the real server**: same validation, same learning path as people.

The final training round ran **1,500 fights** starting from an untrained brain, with **zero** rejected.

| | First 150 fights | Last 150 fights |
|---|---|---|
| Skynet win rate | 16% | 45% |
| Bot win rate | 17% | 5% |

It also learned a distinct favorite against each style, all of them unscripted:

| Bot style | Skynet wins (first → last 150) | Move it learned to lean on |
|---|---|---|
| Brawler | 23% → 60% | Reflect Shield |
| Camper | 10% → 50% | Flank for sight |
| Sniper | 40% → 57% | Seeker Orbs |
| Kiter | 7% → 33% | Bolt Volley (lead) |
| Dodger | 0% → 23% | Rise |

Each round produces a report with charts of outcomes over time and how Skynet's move mix shifted against each style.

### Testing and deployment
I wrote headless tests (about 100 checks) covering:
- movement and collision
- every attack and counter-move
- validation, and learning end to end
- the raid simulation, including saving and reloading its state between ticks

Browser tests drive the real game in a headless browser. One of them puts **two separate browsers** in the same raid to check the lobby, movement sync, and hit reporting.

The module runs on **SpacetimeDB Maincloud**, with the trained brain imported through a one-time, locked reducer. The game page deploys to **GitHub Pages** through **GitHub Actions** on every push.

## Challenges I ran into

**Balancing flexibility against difficulty.** The whole point of Skynet is to show what AI can do in game design: a boss that adapts instead of cycling through a fixed moveset. That turned out to be as much a balancing problem as an AI problem.

- **Too strong hides the learning.** If one move is simply best, the AI learns to spam it against everyone, and the fight looks scripted again. My first Sweeping Laser almost always hit, and Skynet used it for 60–80% of its actions against every style. I reworked it so it only punishes one habit (strafing sideways in the open).
- **Bots can teach the wrong lesson.** Training bots happily fired sword beams into the Reflect Shield, so the AI learned "shield is great" in general. Humans stop doing that after one try. I gave the bots a human-like reaction delay so the shield's value became realistic.
- **Too weak and a move never shows up.** A counter only appears if it actually pays off. The Feint, designed for reflex dodgers, rarely beat a plain volley against the bots, so Skynet rarely chose it.
- **Some smart moves look bad to the AI.** Repositioning deals no damage by itself, so a one-step learner never left its perch. Giving moves credit for the attack they set up fixed that.
- **Variety had to be designed in.** Even a well-tuned bandit will collapse onto its few favorite moves. Per-move cooldowns force it to rotate its kit, and the learning decides which available move fits you right now.
- **Difficulty has to stay fair.** After the final tuning, bots almost never win, but about half of fights still push Skynet into its second phase. I kept a backup of the brain every 50 versions so I could pick how tough the demo boss should be.

**Turning a single-player simulation into a multiplayer one.** The combat code assumed one player everywhere. Instead of rewriting it, I added "player slots": each raid member's state is swapped into the fight before they act. So all the single-player rules (dodging, armor, the reflect shield) work for five players without being duplicated.

**Getting the details right in real time.** Small things broke in surprising ways:
- the local copy of Skynet sidestepping on one screen but not on the server
- keyboard focus getting stuck on a menu button, so a player couldn't move
- a screen filter on the game canvas lifting it above every HUD overlay

The automated browser tests caught most of these before a human ever did.

## Accomplishments that I'm proud of

- **The AI discovers counters nobody wrote.** Against campers it learned to fly around their cover; against brawlers it learned to raise its shield. That's the moment the project stops being a scripted boss.
- **It explains its own decisions.** "HUNTER DRONES: because you hide in cover" is generated from the model's actual weights, not a canned line.
- **The database is the game server.** A full co-op raid with five fighters, bots, projectiles, and damage runs inside SpacetimeDB at 20 Hz in about 2 ms per tick.
- **One simulation runs everywhere:** browser, server, and training bots share the same code, so solo, raid, and training can't disagree about the rules.
- **Training goes through the real pipeline.** 1,500 bot fights went through the same validation as human players, with zero rejected.
- **Everything is procedural.** The hero, the wings, Skynet, and the whole arena are generated in code, with no art assets.
- **I built it solo in 24 hours**, with tests, deployment, and a live multiplayer mode.

## What I learned

- **Reward design is the real AI work.** The learning algorithm took an hour. Deciding *what counts as a good decision* (when to score it, how to credit setup moves, how to weigh damage dealt against damage taken) took the rest of the night, and every change visibly reshaped Skynet's personality.
- **Balance and learning are tangled together.** An adaptive boss is only as interesting as the options it can choose between. If the options are unbalanced, the AI "learns" the imbalance.
- **Simple, explainable models can feel smart.** A linear bandit with good inputs was enough to produce behavior that reads as intelligent, and its simplicity is what makes it explainable.
- **SpacetimeDB can be more than storage.** Scheduled reducers plus subscriptions made it possible to run an authoritative game loop next to the data, with clients that just subscribe and render.
- **Keeping the simulation pure and deterministic from hour one** is what made training bots, server validation, and multiplayer possible later.

## What's next for Skynet Attack Online

- **Training from raids.** Each raid would produce one training log on the server, counting only decisions aimed at players who consented.
- **Global Resistance.** A shared, server-wide Skynet health bar that every player's fights drain together, with a live feed of the community's progress.
- **Deeper learning.** The fight logs the game already collects are exactly the data a sequence model or reinforcement learning agent would need to plan combos, not just single moves.
- **Dynamic dialogue.** Skynet could taunt players based on what it has read about them ("Still hiding behind walls, Camper?").
- **More of everything:** more counter-moves, more arenas, and player progression to see whether the community can keep up with the AI it's training.
