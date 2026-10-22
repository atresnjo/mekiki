import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { check, Session, sign } from "../src/session.ts"
import { configFrom } from "./support.ts"

const withSessions = <A, E>(env: Record<string, string>, f: (sessions: Session.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* Session.Service)
    }).pipe(Effect.provide(Session.layer(configFrom(env)).pipe(Layer.provide(BunServices.layer)))),
  )

test("a session is the expiry signed with the token: tampering, expiry and a new token all end it", () => {
  const now = 1_000_000
  const cookie = sign("token", now + 1000)
  expect(check("token", cookie, now)).toBe(true)
  expect(check("token", cookie, now + 1001)).toBe(false)
  expect(check("rotated", cookie, now)).toBe(false)
  expect(check("token", cookie.replace(/^\d+/, String(now + 10_000_000)), now)).toBe(false)
  expect(check("token", "garbage", now)).toBe(false)
})

test("without a token everyone is in", async () => {
  expect(await withSessions({}, (s) => s.verify(undefined))).toBe(true)
})

test("signing in gives a cookie the next call is let in with; a wrong token is refused", async () => {
  const [cookie, refused, verified, missing] = await withSessions({ GLANCE_TOKEN: "s3cret" }, (s) =>
    Effect.all([
      s.signIn("s3cret", "1.2.3.4"),
      s.signIn("nope", "1.2.3.4").pipe(Effect.flip),
      Effect.flatMap(s.signIn("s3cret", "1.2.3.4"), (c) => s.verify(c)),
      s.verify(undefined),
    ]),
  )
  expect(cookie).toMatch(/^\d+\./)
  expect(refused.retryAfter).toBeUndefined()
  expect(verified).toBe(true)
  expect(missing).toBe(false)
})

test("ten attempts per client, then it has to wait, even with the right token", async () => {
  const result = await withSessions({ GLANCE_TOKEN: "s3cret" }, (s) =>
    Effect.gen(function* () {
      for (let i = 0; i < 10; i++) yield* s.signIn("nope", "9.9.9.9").pipe(Effect.ignore)
      const blocked = yield* s.signIn("s3cret", "9.9.9.9").pipe(Effect.flip)
      // another client isn't held up
      const other = yield* s.signIn("s3cret", "8.8.8.8")
      return { blocked, other }
    }),
  )
  expect(result.blocked.retryAfter).toBeGreaterThan(0)
  expect(result.other).toMatch(/^\d+\./)
})
