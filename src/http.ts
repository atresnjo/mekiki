// the github webhook. handlers stay thin: decode, call a service, answer
import { createHmac, timingSafeEqual } from "node:crypto"
import { Effect, FiberSet, Layer, Option, Redacted, Schema, Stream } from "effect"
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http"
import type { AppConfig } from "./config.ts"
import { type Depth, depthIn, listsAuthor, prKey } from "./domain.ts"
import { Checkout } from "./checkout.ts"
import { GitHub } from "./github.ts"
import { MARKER, Panel, tickedDepth } from "./panel.ts"
import { Reviewer } from "./reviewer.ts"
import { Store } from "./store.ts"
import { type Sender as Who, Triggers, type Verdict } from "./triggers.ts"

/** constant time, for secrets */
const equal = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })
const problem = (status: number, message: string) => json({ error: message }, status)

const Label = Schema.Struct({ name: Schema.String })

/** who did it: whose permission a review asked for is checked against */
const Sender = Schema.Struct({ login: Schema.String, type: Schema.String })

const PullRequestEvent = Schema.Struct({
  action: Schema.String,
  number: Schema.Finite,
  /** the label just added, on `labeled` */
  label: Schema.optional(Label),
  pull_request: Schema.Struct({
    draft: Schema.optional(Schema.Boolean),
    head: Schema.Struct({ sha: Schema.String }),
    labels: Schema.optional(Schema.Array(Label)),
    /** who opened it */
    user: Sender,
  }),
  repository: Schema.Struct({ name: Schema.String, owner: Schema.Struct({ login: Schema.String }) }),
  sender: Sender,
})

const CommentEvent = Schema.Struct({
  action: Schema.String,
  issue: Schema.Struct({ number: Schema.Finite, pull_request: Schema.optional(Schema.Unknown), labels: Schema.optional(Schema.Array(Label)) }),
  /** `user` wrote it; on `edited`, `sender` is who edited it (who ticked the box) */
  comment: Schema.Struct({ id: Schema.Finite, body: Schema.String, user: Sender }),
  /** on `edited`: the body before the edit */
  changes: Schema.optional(Schema.Struct({ body: Schema.optional(Schema.Struct({ from: Schema.String })) })),
  repository: Schema.Struct({ name: Schema.String, owner: Schema.Struct({ login: Schema.String }) }),
  sender: Sender,
})

/** a `glance:<depth>` label pins the depth every review of that pull request runs at */
const labelDepth = (labels: ReadonlyArray<{ readonly name: string }> | undefined) => (labels ?? []).map((l) => depthIn(l.name)).find((d) => d !== undefined)

const depthOverride = (depth: Depth | undefined) => (depth ? { depth } : {})

class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", {}) {}

/** the body as text, read no further than `max` bytes: a chunked upload has no content-length to check up front */
const readCapped = (request: HttpServerRequest.HttpServerRequest, max: number) =>
  request.stream.pipe(
    Stream.runFoldEffect(
      (): { chunks: Array<Uint8Array>; bytes: number } => ({ chunks: [], bytes: 0 }),
      (acc, chunk) => {
        acc.bytes += chunk.length
        acc.chunks.push(chunk)
        return acc.bytes > max ? Effect.fail(new TooLarge()) : Effect.succeed(acc)
      },
    ),
    Effect.map(({ chunks }) => Buffer.concat(chunks).toString("utf8")),
  )

const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"])
/** `/glance` or `@glance`, optionally with a depth: `/glance high` */
const COMMAND = /(^|\s)(\/glance|@glance)\b/i

const handlers = (config: AppConfig) =>
  Effect.gen(function* () {
    const reviewer = yield* Reviewer.Service
    const store = yield* Store.Service
    const github = yield* GitHub.Service
    const panel = yield* Panel.Service
    const checkout = yield* Checkout.Service
    const triggers = yield* Triggers.Service
    const background = yield* FiberSet.make<void>()

    /** not theirs to ask for, or too many: nothing starts, and github's delivery log says why */
    const refused = (verdict: Exclude<Verdict, { ok: true }>, who: Who) =>
      Effect.logInfo(`not reviewing for ${who.login}: ${verdict.reason}`).pipe(
        Effect.as(
          verdict.retryAfter === undefined
            ? json({ ok: true, reviewing: false, refused: verdict.reason })
            : HttpServerResponse.jsonUnsafe(
                { ok: true, reviewing: false, refused: verdict.reason },
                { status: 429, headers: { "Retry-After": String(verdict.retryAfter) } },
              ),
        ),
      )

    /** what the delivery asks for, once it's known to be github's and new */
    const handle = Effect.fnUntraced(function* (event: string | undefined, body: string) {
      if (event === "pull_request") {
        const payload = yield* decodeJson(PullRequestEvent)(body)
        const ref = { owner: payload.repository.owner.login, repo: payload.repository.name, number: payload.number }
        if (payload.action === "closed") yield* reviewer.cancel(ref)
        else if (payload.action === "labeled" && payload.label && depthIn(payload.label.name)) {
          // adding glance:high is asking for a review at that depth, now
          const depth = depthIn(payload.label.name)
          const verdict = yield* triggers.allow(ref, payload.sender)
          if (!verdict.ok) return yield* refused(verdict, payload.sender)
          yield* reviewer.start(ref, { trigger: `label ${depth}`, overrides: depthOverride(depth) })
          return json({ ok: true, reviewing: true, depth }, 202)
        } else if (REVIEW_ACTIONS.has(payload.action)) {
          // the repository's own settings, on top of the global ones
          const settings = yield* store.settingsFor(`${ref.owner}/${ref.repo}`)
          const author = payload.pull_request.user
          // a blocked author's pull request (a dependency bot's, say) is left alone: no review, no comment.
          // a /glance comment, a label or the dashboard still reviews it
          if (listsAuthor(settings.blockedAuthors, author.login)) {
            yield* Effect.logInfo(`not reviewing ${prKey(ref)}: ${author.login} is a blocked author`)
            return json({ ok: true, reviewing: false, blocked: author.login })
          }
          const last = yield* store.lastDone(`${ref.owner}/${ref.repo}`, ref.number)
          // a stranger's pull request (from a fork, say), or one by someone off the allowed authors list,
          // isn't reviewed on its own: it gets the checkboxes, for someone with the permission to tick
          const automatic =
            settings.mode !== "auto"
              ? undefined
              : settings.allowedAuthors.length > 0 && !listsAuthor(settings.allowedAuthors, author.login)
                ? ({ ok: false, reason: `${author.login} isn't one of the allowed authors` } as const)
                : yield* triggers.allowAutomatic(ref, author)
          if (automatic && !automatic.ok) yield* Effect.logInfo(`asking instead of reviewing ${prKey(ref)}: ${automatic.reason}`)
          if (automatic?.ok) {
            // follow-ups keep the depth this pull request was last reviewed at
            const depth = labelDepth(payload.pull_request.labels) ?? Option.getOrUndefined(Option.map(last, (r) => r.depth))
            yield* reviewer.start(ref, { trigger: payload.action, automatic: true, overrides: depthOverride(depth) })
            return json({ ok: true, reviewing: true, depth: depth ?? settings.depth }, 202)
          }
          // ask: show the checkboxes (and whether there's something new to review) and wait for a tick
          if (settings.postComments && !payload.pull_request.draft) {
            yield* panel.show(
              ref,
              Option.match(last, {
                onNone: () => ({ kind: "waiting" }) as const,
                onSome: (review) => ({ kind: "finished", review, head: payload.pull_request.head.sha }) as const,
              }),
            )
            // fetch the code now, while the pull request waits for a tick: the review then starts with it on disk
            yield* FiberSet.run(
              background,
              checkout.at(ref, payload.pull_request.head.sha).pipe(
                Effect.catchTag("CheckoutError", (error) => Effect.logWarning("checkout prefetch failed", error)),
                Effect.asVoid,
              ),
            )
            return json({ ok: true, reviewing: false, asked: true })
          }
        }
      } else if (event === "issue_comment") {
        const payload = yield* decodeJson(CommentEvent)(body)
        const ref = { owner: payload.repository.owner.login, repo: payload.repository.name, number: payload.issue.number }
        const ticked =
          payload.action === "edited" && payload.issue.pull_request !== undefined ? tickedDepth(payload.comment.body, payload.changes?.body?.from) : undefined
        if (ticked) {
          // a box ticked in glance's comment, and only glance's: a copy of the panel elsewhere ticks nothing
          const panelId = yield* store.panel(`${ref.owner}/${ref.repo}`, ref.number)
          if (Option.getOrUndefined(panelId) !== payload.comment.id) return json({ ok: true, reviewing: false, refused: "not glance's comment" })
          const verdict = yield* triggers.allow(ref, payload.sender)
          if (!verdict.ok) return yield* refused(verdict, payload.sender)
          // review at that depth. the panel unticks it as it starts
          yield* reviewer.start(ref, { trigger: `checkbox ${ticked}`, overrides: { depth: ticked } })
          return json({ ok: true, reviewing: true, depth: ticked }, 202)
        }
        if (
          payload.action === "created" &&
          payload.issue.pull_request !== undefined &&
          !payload.comment.body.includes(MARKER) &&
          COMMAND.test(payload.comment.body)
        ) {
          // read first: a database that's down shouldn't use up the person's reviews this hour
          const settings = yield* store.settingsFor(`${ref.owner}/${ref.repo}`)
          const verdict = yield* triggers.allow(ref, payload.comment.user)
          if (!verdict.ok) return yield* refused(verdict, payload.comment.user)
          // a depth in the comment beats the label, which beats the default
          const depth = depthIn(payload.comment.body) ?? labelDepth(payload.issue.labels)
          yield* Effect.all(
            [
              reviewer.start(ref, { trigger: depth ? `comment ${depth}` : "comment", overrides: depthOverride(depth) }),
              github.acknowledge(ref, payload.comment.id).pipe(Effect.ignore),
            ],
            { concurrency: "unbounded" },
          )
          return json({ ok: true, reviewing: true, depth: depth ?? settings.depth }, 202)
        }
      }
      return json({ ok: true, reviewing: false })
    })

    /** glance's own failure: logged, and github sees a 500 (and shows it in the delivery log) */
    const failed = (cause: unknown) => Effect.logError("webhook failed", cause).pipe(Effect.as(problem(500, "glance failed handling this delivery")))

    const webhook = Effect.fn("Webhook.github")(
      function* (request: HttpServerRequest.HttpServerRequest) {
        if (Option.isNone(config.github.webhookSecret)) return problem(503, "set GITHUB_WEBHOOK_SECRET to enable the webhook")
        if (Number(request.headers["content-length"] ?? 0) > config.github.maxWebhookBytes) return problem(413, "payload too large")
        const body = yield* readCapped(request, config.github.maxWebhookBytes)
        const signature = `sha256=${createHmac("sha256", Redacted.value(config.github.webhookSecret.value)).update(body).digest("hex")}`
        if (!equal(request.headers["x-hub-signature-256"] ?? "", signature)) return problem(401, "bad signature")

        const event = request.headers["x-github-event"]
        const delivery = request.headers["x-github-delivery"]
        if (!delivery) return yield* handle(event, body)
        // github redelivers on request (and sometimes on its own): each delivery is acted on once
        if (!(yield* store.claimDelivery(delivery))) return json({ ok: true, duplicate: true })
        // glance failed handling it: let go of it, so a redelivery is acted on
        const release = store
          .releaseDelivery(delivery)
          .pipe(Effect.catchTag("StoreError", (error) => Effect.logError("couldn't release webhook delivery", error)))
        return yield* handle(event, body).pipe(
          Effect.tapErrorTag("StoreError", () => release),
          Effect.tapDefect(() => release),
        )
      },
      // a body that didn't arrive whole, or a payload that isn't what github sends: the sender's problem
      Effect.catchTags({
        SchemaError: (e) => Effect.succeed(problem(400, `unexpected payload: ${e.message}`)),
        TooLarge: () => Effect.succeed(problem(413, "payload too large")),
        HttpServerError: (e) => Effect.succeed(problem(400, e.message)),
      }),
      Effect.catchTag("StoreError", failed),
      Effect.catchDefect(failed),
    )

    return [HttpRouter.route("POST", "/api/webhooks/github", webhook)]
  })

export const routes = (config: AppConfig) =>
  Layer.unwrap(Effect.map(handlers(config), (list): Layer.Layer<never, never, HttpRouter.HttpRouter> => HttpRouter.addAll(list)))
