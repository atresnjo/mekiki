// one glance per database. who's reviewing what, the rate limits and the review feed live in this
// process's memory, so a second instance on the same database would review twice and limit nothing.
// the first to start holds a postgres advisory lock on a connection of its own until it stops; another
// refuses to start while it does
import { Effect, Layer, Redacted, Schema } from "effect"

/** any number, as long as it's always the same one: "glance" */
const LOCK = 0x676c616e

export class AlreadyRunning extends Schema.TaggedError<AlreadyRunning>()("AlreadyRunning", { message: Schema.String }) {}

export const layer = (options: { readonly url: Redacted.Redacted }) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new Bun.SQL(Redacted.value(options.url), { max: 1 })),
        (c) => Effect.promise(() => c.close({ timeout: 5 })),
      )
      const connection = yield* Effect.acquireRelease(
        Effect.promise(() => client.reserve()),
        (c) => Effect.promise(async () => c.release()),
      )
      const [row] = yield* Effect.promise(() => connection<Array<{ locked: boolean }>>`select pg_try_advisory_lock(${LOCK}) as locked`)
      if (!row?.locked)
        return yield* new AlreadyRunning({
          message: "another glance is running against this database: run one (it keeps who's reviewing what in memory), or stop the other first",
        })
      // the session ends with the connection, and the lock with it
    }),
  )

export * as Instance from "./instance.ts"
