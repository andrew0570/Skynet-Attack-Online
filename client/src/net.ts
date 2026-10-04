import { ARMS, FEATURE_DIM, type FightSubmission, type Policy } from '@sao/sim';
import { DbConnection } from './module_bindings';

// Connection to Skynet's shared brain in SpacetimeDB. The game keeps working offline (it falls
// back to the local placeholder AI); online, every fight uses the community-trained weights.

const URI = (import.meta.env.VITE_SPACETIME_URI as string | undefined) ?? 'ws://127.0.0.1:3000';
const DB_NAME = (import.meta.env.VITE_SPACETIME_DB as string | undefined) ?? 'skynet-attack-online';
const TOKEN_KEY = 'sao.spacetime.token';

export interface BrainStatus {
  connected: boolean;
  /** Shared brain version (number of fights it has learned from, as accepted updates). */
  version: number;
  fights: number;
  decisions: number;
  rejected: number;
  /** null until the player's row arrives. */
  consented: boolean | null;
}

export interface BrainLink {
  status: BrainStatus;
  /** A fresh copy of the current shared policy (freeze it for a fight), or null if unavailable. */
  snapshotPolicy(): Policy | null;
  setConsent(consented: boolean): void;
  submit(sub: FightSubmission): void;
}

const storage = {
  get(key: string): string | undefined {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode etc. — identity just won't persist */
    }
  },
};

export function connectBrain(onChange: () => void): BrainLink {
  const status: BrainStatus = { connected: false, version: 0, fights: 0, decisions: 0, rejected: 0, consented: null };
  let conn: DbConnection | null = null;
  let identityHex = '';

  const refresh = () => {
    if (!conn) return;
    const meta = conn.db.policyMeta.id.find(0);
    if (meta) {
      status.version = meta.version;
      status.fights = meta.fights;
      status.decisions = meta.decisions;
      status.rejected = meta.rejected;
    }
    for (const p of conn.db.player.iter()) {
      if (p.identity.toHexString() === identityHex) status.consented = p.consented;
    }
    onChange();
  };

  try {
    conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB_NAME)
      .withToken(storage.get(TOKEN_KEY))
      .onConnect((c, identity, token) => {
        storage.set(TOKEN_KEY, token);
        identityHex = identity.toHexString();
        status.connected = true;
        c.subscriptionBuilder()
          .onApplied(refresh)
          .subscribe(['SELECT * FROM policy_meta', 'SELECT * FROM policy_arm', 'SELECT * FROM player']);
        c.db.policyMeta.onUpdate(refresh);
        c.db.policyMeta.onInsert(refresh);
        c.db.player.onUpdate(refresh);
        c.db.player.onInsert(refresh);
        onChange();
      })
      .onDisconnect(() => {
        status.connected = false;
        onChange();
      })
      .onConnectError((_ctx, err) => {
        console.warn('[brain] SpacetimeDB unavailable, using the local AI:', err);
        status.connected = false;
        onChange();
      })
      .build();
  } catch (err) {
    console.warn('[brain] could not connect:', err);
  }

  return {
    status,
    snapshotPolicy() {
      if (!conn || !status.connected) return null;
      const rows = [...conn.db.policyArm.iter()].sort((a, b) => a.arm - b.arm);
      if (rows.length !== ARMS.length || rows.some(r => r.theta.length !== FEATURE_DIM || r.ainv.length !== FEATURE_DIM * FEATURE_DIM)) return null;
      return {
        version: status.version,
        arms: rows.map(r => ({ A: [...r.a], b: [...r.b], Ainv: [...r.ainv], theta: [...r.theta], n: r.n, rewardSum: r.rewardSum })),
      };
    },
    setConsent(consented) {
      conn?.reducers.setConsent({ consented });
    },
    submit(sub) {
      if (!conn || !status.connected) return;
      conn.reducers.submitFight({ ...sub });
    },
  };
}
