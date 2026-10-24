import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { PGlite } from "@electric-sql/pglite"
import { BunServices } from "@effect/platform-bun"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import { Effect, Option } from "effect"
import { allowedByEmail, Auth, emailListed, LOCAL, problems, SSO_ID } from "../src/auth.ts"
import { Database } from "../src/database.ts"
import { authAccounts, authSessions, users } from "../src/schema.ts"
import { configFrom } from "./support.ts"

const SECRET = "a-test-secret-that-is-long-enough-to-sign"
const GITHUB = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }
const PRODUCTION = {
  GLANCE_ENV: "production",
  BETTER_AUTH_URL: "https://glance.acme.com",
  BETTER_AUTH_SECRET: SECRET,
  GLANCE_ALLOWED_EMAILS: "@acme.com",
  ...GITHUB,
}

test("production doesn't start until someone can sign in, safely", () => {
  expect(problems(configFrom({ GLANCE_ENV: "production" }))).toEqual([expect.stringContaining("nobody could sign in")])
  // listening beyond this machine counts as production
  expect(problems(configFrom({ HOST: "0.0.0.0" }))).toEqual([expect.stringContaining("nobody could sign in")])
  expect(problems(configFrom(PRODUCTION))).toEqual([])
  expect(problems(configFrom({ ...PRODUCTION, BETTER_AUTH_SECRET: "short" }))).toEqual([expect.stringContaining("BETTER_AUTH_SECRET")])
  expect(problems(configFrom({ ...PRODUCTION, BETTER_AUTH_URL: "http://glance.acme.com" }))).toEqual([expect.stringContaining("https")])
  expect(problems(configFrom({ ...PRODUCTION, GLANCE_ALLOWED_EMAILS: "" }))).toEqual([expect.stringContaining("nobody is allowed in")])
  expect(problems(configFrom({ ...PRODUCTION, GITHUB_CLIENT_SECRET: "" }))).not.toEqual([])
  // sso: one kind, and the company's domain
  expect(problems(configFrom({ ...PRODUCTION, GLANCE_SSO_ISSUER: "https://acme.okta.com" }))).toEqual([expect.stringContaining("GLANCE_SSO_CLIENT_ID")])
  const oidc = { GLANCE_SSO_ISSUER: "https://acme.okta.com", GLANCE_SSO_CLIENT_ID: "c", GLANCE_SSO_CLIENT_SECRET: "s" }
  expect(problems(configFrom({ ...PRODUCTION, ...oidc }))).toEqual([expect.stringContaining("GLANCE_SSO_DOMAIN")])
  expect(problems(configFrom({ ...PRODUCTION, ...oidc, GLANCE_SSO_DOMAIN: "acme.com" }))).toEqual([])
  // development on this machine may run without anyone signing in
  expect(problems(configFrom({}))).toEqual([])
})

test("an address is listed by itself or by its domain", () => {
  const list = ["alice@acme.com", "@corp.io"]
  expect(emailListed(list, "Alice@Acme.com")).toBe(true)
  expect(emailListed(list, "bob@acme.com")).toBe(false)
  expect(emailListed(list, "bob@corp.io")).toBe(true)
  expect(emailListed(list, "bob@evilcorp.io")).toBe(false)
  expect(emailListed(list, "bob@corp.io.evil.com")).toBe(false)
})

test("github's address must be verified; the company's sso vouches for its own", () => {
  const { auth } = configFrom({ ...PRODUCTION, GLANCE_SSO_DOMAIN: "sso.acme.com" })
  expect(allowedByEmail(auth, { email: "a@acme.com", emailVerified: true, providers: ["github"] })).toBe(true)
  expect(allowedByEmail(auth, { email: "a@acme.com", emailVerified: false, providers: ["github"] })).toBe(false)
  expect(allowedByEmail(auth, { email: "a@acme.com", emailVerified: false, providers: [SSO_ID] })).toBe(true)
  expect(allowedByEmail(auth, { email: "b@sso.acme.com", emailVerified: false, providers: [SSO_ID] })).toBe(true)
  // the sso's domain lets in only who came through the sso
  expect(allowedByEmail(auth, { email: "b@sso.acme.com", emailVerified: true, providers: ["github"] })).toBe(false)
  expect(allowedByEmail(auth, { email: "x@gmail.com", emailVerified: true, providers: ["github", SSO_ID] })).toBe(false)
})

/** better auth on a fresh in-process postgres, with the real migrations */
const withAuth = <A>(env: Record<string, string>, f: (auth: Auth.Interface, db: ReturnType<typeof drizzle>) => Promise<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = drizzle({ client: new PGlite() })
      yield* Effect.promise(() => migrate(db, { migrationsFolder: Database.MIGRATIONS }))
      const auth = yield* Auth.make(configFrom(env), db)
      return yield* Effect.promise(() => f(auth, db))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

/** someone who signed in with `provider`: their user, account and the session cookie a browser would hold */
const signedIn = async (db: ReturnType<typeof drizzle>, who: { email: string; emailVerified: boolean; provider: string }) => {
  const id = crypto.randomUUID()
  const token = crypto.randomUUID()
  await db.insert(users).values({ id, name: who.email, email: who.email, emailVerified: who.emailVerified })
  await db.insert(authAccounts).values({ id: crypto.randomUUID(), accountId: id, providerId: who.provider, userId: id })
  await db.insert(authSessions).values({ id: crypto.randomUUID(), token, userId: id, expiresAt: new Date(Date.now() + 60_000) })
  const signature = createHmac("sha256", SECRET).update(token).digest("base64")
  return new Headers({ cookie: `glance.session_token=${encodeURIComponent(`${token}.${signature}`)}` })
}

const env = { BETTER_AUTH_SECRET: SECRET, GLANCE_ALLOWED_EMAILS: "@acme.com", ...GITHUB }

test("a session is let in only while its user is allowed in", async () => {
  const [member = Option.none(), stranger, unverified, nobody] = await withAuth(env, async (auth, db) =>
    Promise.all([
      signedIn(db, { email: "alice@acme.com", emailVerified: true, provider: "github" }),
      signedIn(db, { email: "eve@evil.com", emailVerified: true, provider: "github" }),
      signedIn(db, { email: "mallory@acme.com", emailVerified: false, provider: "github" }),
      Promise.resolve(new Headers()),
    ]).then((headers) => Promise.all(headers.map((h) => Effect.runPromise(auth.user(h))))),
  )
  expect(Option.map(member, (u) => u.email)).toEqual(Option.some("alice@acme.com"))
  expect(stranger).toEqual(Option.none())
  expect(unverified).toEqual(Option.none())
  expect(nobody).toEqual(Option.none())
})

test("a stranger never gets a session: the hook refuses to make one", async () => {
  const sessions = await withAuth(env, async (auth, db) => {
    const ctx = await auth.instance!.$context
    const make = async (email: string) => {
      const user = await ctx.internalAdapter.createUser({ email, name: email, emailVerified: true }, { method: "oauth" })
      await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "github", accountId: email })
      return ctx.internalAdapter.createSession(user.id)
    }
    const made = { member: await make("bob@acme.com"), stranger: await make("eve@evil.com") }
    return { ...made, rows: (await db.select().from(authSessions)).length }
  })
  expect(sessions.member?.token).toBeString()
  expect(sessions.stranger).toBeNull()
  expect(sessions.rows).toBe(1)
})

test("without sign-in set up, development is open: everyone is the local user", async () => {
  const user = await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.make(configFrom({}), drizzle({ client: new PGlite() }))
      return yield* auth.user(new Headers())
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
  expect(user).toEqual(Option.some(LOCAL))
})

test("better auth answers under /api/auth, and offers github", async () => {
  const response = await withAuth(env, (auth) =>
    Effect.runPromise(
      auth.handler(
        new Request("http://localhost:7421/api/auth/sign-in/social", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:7421", "x-glance-client-ip": "1.2.3.4" },
          body: JSON.stringify({ provider: "github", callbackURL: "/" }),
        }),
      ),
    ),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { url: string }
  expect(body.url).toStartWith("https://github.com/login/oauth/authorize")
})
