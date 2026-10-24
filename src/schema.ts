// the tables, for drizzle. a change here is a migration: `bun db:generate` writes it to drizzle/,
// and the server applies what's new when it starts
import { sql } from "drizzle-orm"
import { bigint, boolean, check, index, integer, jsonb, primaryKey, snakeCase, text, timestamp } from "drizzle-orm/pg-core"
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

// ---------- signing in: better auth's models (auth.ts). the property names are the ones it expects ----------

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/** someone who signed in, with github or the company's sso */
export const users = snakeCase.table("users", {
  id: text().primaryKey(),
  name: text().notNull().default(""),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const authSessions = snakeCase.table(
  "auth_sessions",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_sessions_user_id").on(t.userId)],
)

/** how a user signs in: one row per provider (github, sso). the oauth tokens are encrypted */
export const authAccounts = snakeCase.table(
  "auth_accounts",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_accounts_user_id").on(t.userId)],
)

/** oauth state while a sign-in is under way */
export const authVerifications = snakeCase.table(
  "auth_verifications",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier").on(t.identifier)],
)

/**
 * the sso plugin's providers. glance's one provider comes from the environment and isn't stored,
 * and registering more is turned off: the table is there because the plugin looks in it
 */
export const ssoProviders = snakeCase.table("sso_providers", {
  id: text().primaryKey(),
  issuer: text().notNull(),
  oidcConfig: text(),
  samlConfig: text(),
  userId: text().references(() => users.id, { onDelete: "cascade" }),
  providerId: text().notNull().unique(),
  organizationId: text(),
  domain: text().notNull(),
})
