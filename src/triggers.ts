// who may start a review from github, and how often. a review costs agent time on a subscription,
// so a comment, a ticked box or a label only starts one when the person behind it has (at least)
// MEKIKI_TRIGGER_PERMISSION on the repository, and each person and pull request gets a few an hour
import { Cache, Context, Duration, Effect, Exit, Layer } from "effect"
import { RateLimiter } from "effect/persistence"
import type { AppConfig } from "./config.ts"
import { type PrRef, prKey } from "./domain.ts"
import { GitHub, type Permission } from "./github.ts"

const RANK: Record<Permission, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 }

/** who did it, as a webhook names them */
export interface Sender {
  readonly login: string
  /** "User", "Bot", "Organization" */
  readonly type: string
}

export type Verdict =
  | { readonly ok: true }
  /** not theirs to ask for */
  | { readonly ok: false; readonly reason: string; readonly retryAfter?: undefined }
  /** too many: try again after this many seconds */
  | { readonly ok: false; readonly reason: string; readonly retryAfter: number }

export interface Interface {
  /** may this person start a review of this pull request now. counts it against their limits when they may */
  readonly allow: (pr: PrRef, sender: Sender) => Effect.Effect<Verdict>
  /** a push in auto mode: does the pull request's author have the permission (a fork's stranger doesn't), and is the pull request under its limit */
  readonly allowAutomatic: (pr: PrRef, author: Sender) => Effect.Effect<Verdict>
}

export class Service extends Context.Service<Service, Interface>()("mekiki/Triggers") {}

export const atLeast = (has: Permission, needs: Permission) => RANK[has] >= RANK[needs]

export const make = Effect.fn("Triggers.make")(function* (options: AppConfig["triggers"]) {
  const github = yield* GitHub.Service
  const limiter = yield* RateLimiter.RateLimiter

  // a permission changes rarely: five minutes. a failed lookup isn't kept. keys compare by value
  const permissions = yield* Cache.makeWith(
    ({ owner, repo, login }: { readonly owner: string; readonly repo: string; readonly login: string }) => github.permission({ owner, repo, number: 0 }, login),
    { capacity: 4096, timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(5) : Duration.zero) },
  )

  const permitted = Effect.fn("Triggers.permitted")(function* (pr: PrRef, sender: Sender) {
    if (sender.type === "Bot") return { ok: false, reason: `${sender.login} is a bot` } as const
    const has = yield* Cache.get(permissions, { owner: pr.owner, repo: pr.repo, login: sender.login }).pipe(
      // github didn't say: refused, never let through
      Effect.catch((e) =>
        Effect.logWarning(`couldn't look up ${sender.login}'s permission on ${pr.owner}/${pr.repo}: ${e.message}`).pipe(Effect.as("none" as const)),
      ),
    )
    return atLeast(has, options.permission)
      ? ({ ok: true } as const)
      : ({
          ok: false,
          reason: `${sender.login} ${has === "none" ? "isn't a collaborator on" : `has ${has} permission on`} ${pr.owner}/${pr.repo}; starting a review takes ${options.permission}`,
        } as const)
  })

  const consume = (key: string, limit: number, what: string): Effect.Effect<Verdict> =>
    limiter.consume({ key, limit, window: Duration.hours(1) }).pipe(
      Effect.as<Verdict>({ ok: true }),
      Effect.catchTag("RateLimiterError", (e) =>
        Effect.succeed<Verdict>({
          ok: false,
          reason: `${what} started ${limit} reviews this hour`,
          retryAfter: e.reason._tag === "RateLimitExceeded" ? Math.ceil(Duration.toSeconds(e.reason.retryAfter)) : 60,
        }),
      ),
    )

  const perPullRequest = (pr: PrRef) => consume(`review:${prKey(pr)}`, options.perPullRequestPerHour, prKey(pr))

  const allow = Effect.fn("Triggers.allow")(function* (pr: PrRef, sender: Sender) {
    const verdict = yield* permitted(pr, sender)
    if (!verdict.ok) return verdict
    const person = yield* consume(`review-by:${sender.login.toLowerCase()}`, options.perUserPerHour, sender.login)
    return person.ok ? yield* perPullRequest(pr) : person
  })

  const allowAutomatic = Effect.fn("Triggers.allowAutomatic")(function* (pr: PrRef, author: Sender) {
    const verdict = yield* permitted(pr, author)
    return verdict.ok ? yield* perPullRequest(pr) : verdict
  })

  return Service.of({ allow, allowAutomatic })
})

export const layer = (options: AppConfig["triggers"]) =>
  Layer.effect(Service, make(options)).pipe(Layer.provide(RateLimiter.layer), Layer.provide(RateLimiter.layerStoreMemory))

export * as Triggers from "./triggers.ts"
