// the tables, for drizzle. a change here is a migration: `bun db:generate` writes it to drizzle/,
// and the server applies what's new when it starts
import { sql } from "drizzle-orm"
import { bigint, check, index, integer, jsonb, primaryKey, snakeCase, text, timestamp } from "drizzle-orm/pg-core"
import type { Review, Settings } from "./domain.ts"

/** a review, whole, in data: repo, number and status are copied out for the lookups */
export const reviews = snakeCase.table(
  "reviews",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    repo: text().notNull(),
    number: integer().notNull(),
    status: text().notNull(),
    data: jsonb().$type<Omit<Review, "id">>().notNull(),
  },
  (t) => [index("reviews_pr").on(t.repo, t.number, t.id)],
)

/** one row: the dashboard's settings */
export const settings = snakeCase.table("settings", { id: integer().primaryKey(), data: jsonb().$type<Settings>().notNull() }, (t) => [
  check("settings_one_row", sql`${t.id} = 1`),
])

/** glance's comment on each pull request */
export const panels = snakeCase.table(
  "panels",
  {
    repo: text().notNull(),
    number: integer().notNull(),
    // github's comment ids are past 2^31
    commentId: bigint({ mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.number] })],
)

/** webhook deliveries seen, so a redelivery isn't acted on twice */
export const deliveries = snakeCase.table("deliveries", {
  id: text().primaryKey(),
  at: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
