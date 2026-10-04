import { schema, table, t } from 'spacetimedb/server';

const spacetimedb = schema({
  player: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      consented: t.bool(),
      joinedAt: t.timestamp(),
    }
  ),
});
export default spacetimedb;

export const onConnect = spacetimedb.clientConnected(ctx => {
  if (!ctx.db.player.identity.find(ctx.sender)) {
    ctx.db.player.insert({ identity: ctx.sender, consented: false, joinedAt: ctx.timestamp });
  }
});

// Player opted in (or out) of contributing fight data to train Skynet.
export const setConsent = spacetimedb.reducer({ consented: t.bool() }, (ctx, { consented }) => {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) throw new Error('unknown player');
  ctx.db.player.identity.update({ ...player, consented });
});
