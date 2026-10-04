import * as THREE from 'three';
import { createPlayer, type FightEvent, type FightState, type PlayerShot, type PlayerState, type Projectile, type RaidSim } from '@sao/sim';
import { createHero, tintHero, type Hero } from './hero';
import type { BrainLink } from './net';
import type { RaidMember } from './module_bindings/types';

// Raid mode on the client. The server (SpacetimeDB) runs Skynet, its projectiles, the bots, and
// everyone's health; this client moves its own hero locally, streams that movement up ~20×/s,
// reports its own hits on Skynet, and renders everything else from the subscribed raid tables.

const SEND_EVERY = 1 / 20;
/** The movement/animation fields teammates need to render this hero. */
const SENT_FIELDS: (keyof PlayerState)[] = ['pos', 'vel', 'yaw', 'onGround', 'invuln', 'dashTimer', 'dashDir', 'climbing', 'gliding', 'airJumpCount', 'swingTimer', 'comboStep', 'rushing', 'stamina'];

interface Remote {
  hero: Hero;
  label: HTMLDivElement;
  color: string;
  shown: THREE.Vector3;
  state: PlayerState;
  diedAt: number;
}

export interface RaidClient {
  /** In a raid lobby or an active/finished raid. */
  inRaid(): boolean;
  status(): 'none' | 'lobby' | 'active' | 'won' | 'lost';
  /** My member slot index (spawn offset), once the raid has started. */
  mySlot(): number;
  /**
   * Sync the local fight from the server before a local tick: Skynet and its projectiles come
   * from the latest raid state; my health comes from my member row. Returns server effects to
   * render (once per server tick).
   */
  syncBefore(f: FightState, dt: number): FightEvent[];
  /** After a local tick: report my hits on Skynet and stream my movement. */
  syncAfter(f: FightState, events: FightEvent[], prevCd: number[], dt: number): void;
  /** Teammates' heroes and nameplates; bots' beams (for the projectile renderer). */
  renderRemotes(dt: number, time: number, camera: THREE.Camera): PlayerShot[];
  /** Smoothed Skynet position for rendering (server updates arrive at 20 Hz). */
  bossRenderPos(dt: number, f: FightState): THREE.Vector3;
  reset(): void;
}

export function createRaidClient(scene: THREE.Scene, net: BrainLink, labels: HTMLElement): RaidClient {
  const remotes = new Map<string, Remote>();
  let lastTick = -1;
  let sendTimer = 0;
  let skillsSinceSend = 0;
  let serverSim: RaidSim | null = null;
  const bossShown = new THREE.Vector3();
  let bossInit = false;

  const myKey = (m: RaidMember) => `${m.isBot ? 'b' : 'h'}${m.slot}:${m.id}`;

  function parseSim(): RaidSim | null {
    const raid = net.raid.current();
    if (!raid || !raid.sim) return null;
    if (raid.tick === lastTick && serverSim) return serverSim;
    try {
      serverSim = JSON.parse(raid.sim) as RaidSim;
    } catch {
      return serverSim;
    }
    return serverSim;
  }

  const client: RaidClient = {
    inRaid: () => !!net.raid.me(),
    status: () => (net.raid.current()?.status as 'lobby' | 'active' | 'won' | 'lost' | undefined) ?? 'none',
    mySlot: () => net.raid.me()?.slot ?? 0,

    syncBefore(f, dt) {
      const raid = net.raid.current();
      const me = net.raid.me();
      const out: FightEvent[] = [];
      if (!raid || !me) return out;
      const fresh = raid.tick !== lastTick;
      const sim = parseSim();
      if (sim && fresh) {
        lastTick = raid.tick;
        // Skynet and its projectiles are the server's; keep my own shots and player state.
        Object.assign(f.boss, sim.fight.boss);
        // Only the server decides Skynet's moves: the local copy must never sidestep on its own.
        f.boss.evadeCd = 1e9;
        f.projectiles = sim.fight.projectiles;
        try {
          out.push(...(JSON.parse(raid.events) as FightEvent[]));
        } catch {
          /* no effects this tick */
        }
      } else {
        // Between server ticks, glide projectiles along their velocity (purely visual).
        for (const p of f.projectiles as Projectile[]) {
          p.vel.y -= p.gravity * dt;
          p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt, z: p.pos.z + p.vel.z * dt };
        }
      }
      // My vitals are server-authoritative.
      f.health = me.health;
      f.armor = me.armor;
      if (me.dead && f.outcome === 'active') f.outcome = 'lost';
      if (raid.status === 'won' && f.outcome === 'active') f.outcome = 'won';
      return out;
    },

    syncAfter(f, events, prevCd, dt) {
      if (!net.raid.me() || client.status() !== 'active') return;
      // Report the hits my client resolved against the Skynet it shows me (base damage; the server
      // applies the stun bonus, the shield, and its own checks).
      for (const e of events) {
        if (e.type === 'bossHit') net.raid.hit(e.base, e.source);
        if (e.type === 'reflected') net.raid.hit(e.amount, e.source);
      }
      skillsSinceSend += f.skillCd.filter((c, i) => c > prevCd[i]).length;
      sendTimer -= dt;
      if (sendTimer <= 0 && f.outcome === 'active') {
        sendTimer = SEND_EVERY;
        const p = f.player as unknown as Record<string, unknown>;
        const state: Record<string, unknown> = {};
        for (const k of SENT_FIELDS) state[k] = p[k];
        net.raid.update(JSON.stringify(state), skillsSinceSend);
        skillsSinceSend = 0;
      }
    },

    renderRemotes(dt, time, camera) {
      const me = net.raid.me();
      const members = client.status() === 'none' ? [] : net.raid.members();
      const seen = new Set<string>();
      const botShots: PlayerShot[] = [];
      const w = window.innerWidth;
      const h = window.innerHeight;
      for (const m of members) {
        if (me && m.id === me.id) continue;
        const key = myKey(m);
        seen.add(key);
        let r = remotes.get(key);
        if (!r) {
          const hero = createHero();
          tintHero(hero, m.color);
          scene.add(hero.group, hero.worldFx);
          const label = document.createElement('div');
          label.className = 'nameplate';
          labels.appendChild(label);
          r = { hero, label, color: m.color, shown: new THREE.Vector3(), state: createPlayer(0, 0), diedAt: -1 };
          remotes.set(key, r);
        }
        if (m.state) {
          try {
            const s = JSON.parse(m.state) as Partial<PlayerState> & { shots?: PlayerShot[] };
            Object.assign(r.state, s);
            if (s.shots) botShots.push(...s.shots);
          } catch {
            /* keep the last good state */
          }
        }
        const target = new THREE.Vector3(r.state.pos.x, r.state.pos.y, r.state.pos.z);
        if (r.shown.lengthSq() === 0 || r.shown.distanceToSquared(target) > 400) r.shown.copy(target);
        else r.shown.lerp(target, 1 - Math.exp(-dt * 14));
        if (m.dead && r.diedAt < 0) r.diedAt = time;
        if (!m.dead) r.diedAt = -1;
        r.hero.group.position.copy(r.shown);
        r.hero.group.rotation.y = r.state.yaw;
        r.hero.update(r.state, dt, time, r.diedAt >= 0 ? time - r.diedAt : -1);
        // Nameplate above the head (hidden when behind the camera).
        const head = r.shown.clone().add(new THREE.Vector3(0, 2.5, 0)).project(camera);
        const visible = head.z < 1 && Math.abs(head.x) < 1.2 && Math.abs(head.y) < 1.2;
        r.label.style.display = visible ? 'block' : 'none';
        if (visible) {
          r.label.style.transform = `translate(${((head.x + 1) / 2) * w}px, ${((1 - head.y) / 2) * h}px) translate(-50%, -100%)`;
          const hp = Math.max(0, m.health) / 100;
          r.label.innerHTML = `<b style="color:${m.color}">${escapeHtml(m.name)}</b><i><s style="width:${hp * 100}%"></s></i>`;
          r.label.classList.toggle('down', m.dead);
        }
      }
      for (const [key, r] of remotes) {
        if (seen.has(key)) continue;
        scene.remove(r.hero.group, r.hero.worldFx);
        r.label.remove();
        remotes.delete(key);
      }
      return botShots;
    },

    bossRenderPos(dt, f) {
      const target = new THREE.Vector3(f.boss.pos.x, f.boss.pos.y, f.boss.pos.z);
      if (!bossInit || bossShown.distanceToSquared(target) > 900) {
        bossShown.copy(target);
        bossInit = true;
      } else bossShown.lerp(target, 1 - Math.exp(-dt * 12));
      return bossShown;
    },

    reset() {
      lastTick = -1;
      serverSim = null;
      bossInit = false;
      sendTimer = 0;
      skillsSinceSend = 0;
    },
  };
  return client;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
