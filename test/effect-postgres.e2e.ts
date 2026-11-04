// Live adapter rehearsal. Requires Docker; owns and removes its temporary PostgreSQL container.
import { createHmac } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, Option, Scope } from "effect"
import { Auth } from "../src/auth.ts"
import { Database } from "../src/database.ts"
import { Instance } from "../src/instance.ts"
import { authAccounts, authSessions, users } from "../src/schema.ts"
import { Store } from "../src/store.ts"
import { configFrom, review } from "./support.ts"

const docker = (...args: Array<string>) => {
  const result = Bun.spawnSync(["docker", ...args])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const name = `mekiki-effect-e2e-${crypto.randomUUID().slice(0, 8)}`
docker("run", "--rm", "-d", "--name", name, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=mekiki", "-p", "127.0.0.1::5432", "postgres:18-alpine")
try {
  // pg_isready is the readiness condition; a bounded retry only paces that check.
  for (let attempt = 0; ; attempt++) {
    if (Bun.spawnSync(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "mekiki"]).exitCode === 0) break
    if (attempt >= 100) throw new Error(`temporary postgres did not become ready: ${docker("logs", name)}`)
    await Bun.sleep(100)
  }
  const port = Number(docker("port", name, "5432/tcp").split(":").at(-1))
  const secret = "an-e2e-secret-that-is-long-enough-for-better-auth"
  const config = configFrom({
    DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/mekiki`,
    BETTER_AUTH_SECRET: secret,
    GITHUB_CLIENT_ID: "fixture-client",
    GITHUB_CLIENT_SECRET: "fixture-secret",
    MEKIKI_ALLOWED_EMAILS: "@example.com",
  })
  const database = Database.layer({ url: config.databaseUrl })
  const services = Layer.mergeAll(Store.layer({ defaults: config.defaults }), Auth.layer(config)).pipe(Layer.provideMerge(database))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lockScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      yield* Layer.build(Instance.layer({ url: config.databaseUrl })).pipe(Scope.provide(lockScope))
      const refused = yield* Layer.build(Instance.layer({ url: config.databaseUrl })).pipe(Effect.scoped, Effect.result)
      if (refused._tag !== "Failure" || refused.failure._tag !== "AlreadyRunning") throw new Error("a second instance was not refused")
      yield* Scope.close(lockScope, Exit.void)
      yield* Layer.build(Instance.layer({ url: config.databaseUrl })).pipe(Effect.scoped)

      const store = yield* Store.Service
      const created = yield* store.create(review())
      const persisted = yield* store.get(created.id)
      if (Option.isNone(persisted) || persisted.value.status !== "done") throw new Error("live review did not round-trip")
      if (!(yield* store.claimDelivery("live-e2e")) || (yield* store.claimDelivery("live-e2e"))) throw new Error("delivery deduplication failed")

      // Seed a real signed session, then exercise Better Auth through its actual Bun SQL pool.
      const db = yield* Database.Service
      const id = crypto.randomUUID()
      const token = crypto.randomUUID()
      yield* db.insert(users).values({ id, name: "E2E", email: "e2e@example.com", emailVerified: true })
      yield* db.insert(authAccounts).values({ id: crypto.randomUUID(), accountId: id, providerId: "github", userId: id })
      yield* db.insert(authSessions).values({ id: crypto.randomUUID(), token, userId: id, expiresAt: new Date(Date.now() + 60_000) })
      const signature = createHmac("sha256", secret).update(token).digest("base64")
      const headers = new Headers({ cookie: `mekiki.session_token=${encodeURIComponent(`${token}.${signature}`)}` })
      const auth = yield* Auth.Service
      const user = yield* auth.user(headers)
      if (Option.isNone(user) || user.value.email !== "e2e@example.com") throw new Error("live session was not authorized")
      headers.set("origin", config.auth.url)
      const signedOut = yield* auth.handler(new Request(`${config.auth.url}/api/auth/sign-out`, { method: "POST", headers }))
      if (!signedOut.ok || Option.isSome(yield* auth.user(headers))) throw new Error("sign-out did not revoke the session")
      return {
        lockRefusal: refused.failure._tag,
        lockReacquired: true,
        migrations: true,
        reviewRoundTrip: true,
        deliveryDeduplication: true,
        sessionAuthorized: true,
        signOutRevoked: true,
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(services),
      Effect.provide(BunServices.layer),
      Effect.timeout("30 seconds"),
      Effect.tapCause((cause) => Effect.logError(Cause.pretty(cause), cause)),
    ),
  )
  mkdirSync(".data", { recursive: true })
  writeFileSync(
    ".data/effect-postgres-e2e.json",
    JSON.stringify({ command: "bun run test:e2e:postgres", passedAt: new Date().toISOString(), ...result }, null, 2),
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  docker("rm", "-f", name)
}
