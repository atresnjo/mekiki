// postgres, through drizzle on @effect/sql-pg. every start applies the migrations in drizzle/ that
// the database hasn't seen yet, so a deploy is just a restart
import { fileURLToPath } from "node:url"
import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import type { PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { PgEffectDatabase } from "drizzle-orm/pg-core/effect"
import { Context, Effect, Layer, type Redacted } from "effect"

/** a drizzle database whose queries are effects: postgres in production, pglite in the tests */
export type Interface = PgEffectDatabase<PgDrizzle.EffectPgQueryEffectHKT, PgQueryResultHKT>

export class Service extends Context.Service<Service, Interface>()("glance/Database") {}

export const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url))

export const layer = (options: { readonly url: Redacted.Redacted }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults()
      yield* migrate(db, { migrationsFolder: MIGRATIONS })
      return db
    }).pipe(Effect.withSpan("Database.migrate")),
  ).pipe(Layer.provide(PgClient.layer({ url: options.url, applicationName: "glance" })))

export * as Database from "./database.ts"
