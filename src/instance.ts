// one mekiki per database. who's reviewing what, the rate limits and the review feed live in this
// process's memory, so a second instance on the same database would review twice and limit nothing.
// the first to start holds a postgres advisory lock on a connection of its own until it stops; another
// refuses to start while it does
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, type Redacted, Schema } from "effect"

/** any number, as long as it's always the same one: "mekiki" */
const LOCK = 0x676c616e

export class AlreadyRunning extends Schema.TaggedError<AlreadyRunning>()("AlreadyRunning", { message: Schema.String }) {}

export const layer = (options: { readonly url: Redacted.Redacted }) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient
      const connection = yield* client.reserve
      const [row] = yield* connection
        .executeValues("select pg_try_advisory_lock($1)", [LOCK])
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Schema.Boolean])))))
      if (!row?.[0])
        return yield* new AlreadyRunning({
          message: "another mekiki is running against this database: run one (it keeps who's reviewing what in memory), or stop the other first",
        })
      // the session ends with the connection, and the lock with it
    }),
  ).pipe(Layer.provide(PgClient.layer({ url: options.url, maxConnections: 1, applicationName: "mekiki-instance" })))

export * as Instance from "./instance.ts"
