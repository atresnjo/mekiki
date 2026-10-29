// the review pipeline. everything that can overlap does: the pull request, its diff and the last
// review are fetched together, every chunk goes to its own agent process at once, and filtering is
// plain code. a review is: ~3 github calls, one agent call per chunk, one github call to post, and
// alongside it a graphql read of the threads (plus one call per thread that's fixed)
import { Clock, Context, Deferred, Effect, Fiber, FiberMap, Layer, Option, PubSub, Ref, Result, Schema, type Scope, Semaphore } from "effect"
import { Agent } from "./agent.ts"
import { Checkout } from "./checkout.ts"
import * as Diff from "./diff.ts"
import {
  addUsage,
  type AgentKind,
  type Depth,
  EFFORT,
  type Finding,
  type PrRef,
  prKey,
  type Review,
  type Settings,
  type Severity,
  type Step,
  type GitHubError,
  type Usage,
} from "./domain.ts"
import { GitHub } from "./github.ts"
import { Panel } from "./panel.ts"
import { reviewPrompt, system } from "./prompt.ts"
import { Store } from "./store.ts"

export interface Limits {
  /** total diff characters reviewed per pull request */
  readonly maxDiffChars: number
  /** a file whose diff is bigger is skipped */
  readonly maxFileChars: number
  /** diff characters per agent call */
  readonly chunkChars: number
  /** agent processes running at once, across all reviews */
  readonly concurrency: number
  /** reviews running or waiting at once: another is turned away, and says so */
  readonly maxQueued: number
}

export interface Options {
  /** after a review, resolve glance's own threads whose problem is gone: see fixedThreads */
  readonly resolveFixed: boolean
}

export interface StartOptions {
  readonly trigger: string
  /** review, but post nothing */
  readonly dryRun?: boolean
  /** a pushed commit: skip drafts and commits that were already reviewed */
  readonly automatic?: boolean
  /** this review only: on top of the saved settings (the repository's, on top of the global ones) */
  readonly overrides?: Partial<Settings>
}

export interface Interface {
  /** review in the background; a newer review of the same pull request replaces a running one */
  readonly start: (pr: PrRef, options: StartOptions) => Effect.Effect<void, Store.StoreError>
  /** review and wait for the result */
  readonly run: (pr: PrRef, options: StartOptions) => Effect.Effect<Review, Store.StoreError>
  readonly cancel: (pr: PrRef) => Effect.Effect<void>
  /** every review, each time it changes, from the moment of subscribing until the scope closes */
  readonly subscribe: Effect.Effect<PubSub.Subscription<Review>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("glance/Reviewer") {}

class Skip extends Schema.TaggedError<Skip>()("Skip", { reason: Schema.String }) {}

class Failed extends Schema.TaggedError<Failed>()("Failed", { message: Schema.String }) {}

/** a review cut short longer ago than this isn't started again */
const RESUME_WITHIN_MS = 60 * 60 * 1000

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
const ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" }

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

/** pin each finding to a line github will accept a comment on, or drop it */
export const anchor = (findings: ReadonlyArray<Finding>, lines: Map<string, Set<number>>): Array<Finding> =>
  findings.flatMap((f) => {
    const valid = lines.get(f.path)
    if (!valid) return []
    if (valid.has(f.line)) return [f]
    // models are often off by a line or two
    for (let d = 1; d <= 3; d++) {
      if (valid.has(f.line - d)) return [{ ...f, line: f.line - d, suggestion: null }]
      if (valid.has(f.line + d)) return [{ ...f, line: f.line + d, suggestion: null }]
    }
    return []
  })

/** the same problem said twice: same title near the same line, or the same kind of problem on the same line */
const same = (a: Finding, b: Finding) =>
  a.path === b.path && ((Math.abs(a.line - b.line) <= 3 && normalize(a.title) === normalize(b.title)) || (a.line === b.line && a.category === b.category))

/** the comments worth posting: confident, not said before, worst first, capped */
export const triage = (
  findings: ReadonlyArray<Finding>,
  options: { readonly previous: ReadonlyArray<Finding>; readonly minConfidence: number; readonly max: number },
) => {
  const kept: Array<Finding> = []
  const sorted = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.confidence - a.confidence)
  for (const f of sorted) {
    // a critical finding is worth a little doubt
    const threshold = f.severity === "critical" ? Math.min(options.minConfidence, 0.4) : options.minConfidence
    if (f.confidence < threshold) continue
    if (options.previous.some((p) => same(p, f)) || kept.some((k) => same(k, f))) continue
    kept.push(f)
    if (kept.length >= options.max) break
  }
  return kept
}

/**
 * hidden in each inline comment: how glance knows its own threads again, and what each was about.
 * the title is uri-encoded, so it can't close the html comment
 */
const FINDING = /<!-- glance:finding (\w+) (\S*) -->/
/** hidden in glance's "fixed" reply: a thread it resolved once, and someone reopened, is left to them */
const FIXED = "<!-- glance:fixed -->"

/** why files weren't reviewed, counted: "5 binary, 1 generated or lockfile" */
export const skippedSummary = (skipped: ReadonlyArray<{ readonly reason: string }>) => {
  const counts = new Map<string, number>()
  for (const { reason } of skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  return [...counts].map(([reason, n]) => `${n} ${reason}`).join(", ")
}

/** a suggestion block that holds any text: its fence is longer than every run of backticks inside */
export const suggestionBlock = (text: string) => {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${fence}suggestion\n${text}\n${fence}`
}

export const commentBody = (f: Finding, agent: { readonly kind: AgentKind; readonly model: string; readonly depth: Depth }) =>
  [
    `${ICON[f.severity]} **${f.title}**`,
    f.body,
    f.suggestion === null ? "" : suggestionBlock(f.suggestion),
    `<sub>${f.severity} · ${f.category} · ${Math.round(f.confidence * 100)}% · glance/${agent.kind}${agent.model ? ` ${agent.model}` : ""} ${agent.depth}</sub>`,
    `<!-- glance:finding ${f.category} ${encodeURIComponent(f.title)} -->`,
  ]
    .filter(Boolean)
    .join("\n\n")

export const fixedReply = (sha: string) => `✅ Fixed in ${sha.slice(0, 7)}: glance doesn't find this any more.\n\n${FIXED}`

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const words = (s: string) =>
  new Set(
    normalize(s)
      .split(" ")
      .filter((w) => w.length > 2),
  )

/** two titles for one problem: half the shorter one's words are in the other */
const similar = (a: string, b: string) => {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return normalize(a) === normalize(b)
  return [...x].filter((w) => y.has(w)).length / Math.min(x.size, y.size) >= 0.5
}

/**
 * glance's threads whose problem looks fixed: unresolved, the code under them changed since (github
 * says outdated), in a file this review read, and not found again near there. the agent's every
 * finding counts, even one triage dropped (said before, unsure): only what it didn't say again is
 * fixed. never a thread someone else started, nor one glance already resolved once
 */
export const fixedThreads = (
  threads: ReadonlyArray<GitHub.ReviewThread>,
  review: { readonly reviewed: ReadonlySet<string>; readonly findings: ReadonlyArray<Finding> },
) =>
  threads.filter((t) => {
    const [first] = t.comments
    const mark = first?.ours ? FINDING.exec(first.body) : null
    if (!mark || t.resolved || first?.collapsed || !t.outdated || !review.reviewed.has(t.path)) return false
    if (t.comments.some((c) => c.ours && c.body.includes(FIXED))) return false
    const [, category, title = ""] = mark
    // the code moved under it: near is wider for the same title than for the same kind of problem
    const again = review.findings.some(
      (f) =>
        f.path === t.path &&
        (t.line === null ||
          (Math.abs(f.line - t.line) <= 20 && similar(f.title, decoded(title))) ||
          (Math.abs(f.line - t.line) <= 3 && f.category === category)),
    )
    return !again
  })

export const reviewBody = (
  review: Review,
  skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>,
  notes: { readonly failure?: string | undefined; readonly code?: string | undefined } = {},
) => {
  const seconds = ((review.durationMs ?? 0) / 1000).toFixed(1)
  const missing = review.unreviewed.length
  const found = review.findings.length === 0 ? "No issues found" : `${review.findings.length} issue${review.findings.length === 1 ? "" : "s"}`
  // partial: "no issues" would claim more than was looked at
  const counts = missing > 0 ? `${found} in the files reviewed` : found
  const lines = [`### glance`]
  if (missing > 0)
    lines.push(
      `> [!WARNING]\n> **Partial review: ${missing} of ${review.files} file${review.files === 1 ? "" : "s"} couldn't be reviewed**${notes.failure ? ` (${notes.failure.slice(0, 200)})` : ""}. Tick a depth in glance's comment to try again.`,
    )
  lines.push(
    review.summary,
    `**${counts}** · ${review.files - missing} file${review.files - missing === 1 ? "" : "s"} in ${seconds}s · ${review.agent}${review.model ? ` ${review.model}` : ""} · ${review.depth}${review.incremental ? " · new commits only" : ""}`,
  )
  if (notes.code) lines.push(`> [!NOTE]\n> ${notes.code}`)
  if (missing > 0)
    lines.push(
      `<details><summary>${missing} file(s) not reviewed: their agent failed</summary>\n\n${review.unreviewed.map((p) => `- \`${p}\``).join("\n")}\n</details>`,
    )
  if (skipped.length > 0)
    lines.push(
      `<details><summary>${skipped.length} file(s) not reviewed</summary>\n\n${skipped.map((s) => `- \`${s.path}\`: ${s.reason}`).join("\n")}\n</details>`,
    )
  return lines.join("\n\n")
}

export const make = Effect.fn("Reviewer.make")(function* (limits: Limits, { resolveFixed }: Options = { resolveFixed: true }) {
  const github = yield* GitHub.Service
  const agent = yield* Agent.Service
  const store = yield* Store.Service
  const panel = yield* Panel.Service
  const checkout = yield* Checkout.Service
  const changes = yield* PubSub.sliding<Review>(256)
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes))
  const running = yield* FiberMap.make<string, Review | void, never>()
  const admissions = yield* Semaphore.make(1)
  const permits = yield* Semaphore.make(limits.concurrency)

  // stopping: the reviews about to be interrupted stay "running", and the next start takes them up.
  // added after the fiber map, so it runs before the map interrupts them
  const stopping = yield* Ref.make(false)
  yield* Effect.addFinalizer(() => Ref.set(stopping, true))

  const save = (id: number, patch: Partial<Omit<Review, "id">>) => store.update(id, patch).pipe(Effect.tap((r) => PubSub.publish(changes, r)))

  // a fixed thread is resolved where github allows it, and its comment hidden as outdated where it doesn't (an
  // app without write access to the contents). one that can't be read or closed stays open: a warning, never the review's failure
  const resolve = Effect.fn("Reviewer.resolve")(
    function* (ref: PrRef, sha: string, review: Parameters<typeof fixedThreads>[1]) {
      const fixed = fixedThreads(yield* github.reviewThreads(ref), review)
      const closed = yield* Effect.forEach(
        fixed,
        (t) => {
          const [first] = t.comments
          const close: Effect.Effect<"resolved" | "collapsed" | undefined, GitHubError> = t.canResolve
            ? github.resolveThread(ref, t.id, fixedReply(sha)).pipe(Effect.as("resolved" as const))
            : first?.canCollapse
              ? github.collapseThread(ref, t.id, first.id, fixedReply(sha)).pipe(Effect.as("collapsed" as const))
              : Effect.succeed(undefined)
          return close.pipe(
            Effect.catchTag("GitHubError", (error) => Effect.logWarning(`couldn't close glance's thread on ${t.path}`, error).pipe(Effect.as(undefined))),
          )
        },
        { concurrency: 4 },
      )
      const count = (how: string) => closed.filter((c) => c === how).length
      const [resolved, collapsed] = [count("resolved"), count("collapsed")]
      if (resolved > 0) yield* Effect.logInfo(`resolved ${resolved} fixed thread${resolved === 1 ? "" : "s"}`)
      if (collapsed > 0)
        yield* Effect.logInfo(
          `hid ${collapsed} fixed comment${collapsed === 1 ? "" : "s"} as outdated: resolving threads takes the github app's Contents: read and write`,
        )
    },
    Effect.catchTag("GitHubError", (error) => Effect.logWarning("couldn't read the review threads to resolve fixed ones", error)),
  )

  /** `reviewing` runs once the review is past its skip checks and about to call the agents */
  const pipeline = Effect.fn("Reviewer.pipeline")(function* (
    ref: PrRef,
    id: number,
    settings: Settings,
    options: StartOptions,
    reviewing: Effect.Effect<void>,
  ) {
    const started = yield* Clock.currentTimeMillis
    const steps: Array<Step> = []
    const timed = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        return yield* effect.pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const finished = yield* Clock.currentTimeMillis
              steps.push({ name, ms: finished - started })
            }),
          ),
        )
      })
    const repo = `${ref.owner}/${ref.repo}`

    // the code downloads from the moment the head commit is known, alongside the diff and
    // everything after it; the agents are the first to wait for it
    const head = yield* Deferred.make<string>()
    const code = yield* Deferred.await(head).pipe(
      Effect.flatMap((sha) => checkout.at(ref, sha)),
      Effect.result,
      Effect.forkChild,
    )
    const [pr, fullDiff, previous] = yield* timed(
      "fetch",
      Effect.all([github.pullRequest(ref).pipe(Effect.tap((p) => Deferred.succeed(head, p.head.sha))), github.diff(ref), store.lastDone(repo, ref.number)], {
        concurrency: "unbounded",
      }),
    )
    yield* save(id, { title: pr.title, url: pr.html_url, headSha: pr.head.sha, steps: [...steps] })

    if (options.automatic && pr.draft) return yield* new Skip({ reason: "draft pull request" })
    if (pr.state !== "open" && options.automatic) return yield* new Skip({ reason: `pull request is ${pr.state}` })

    const select = (text: string) =>
      Diff.select(Diff.parseDiff(text), { maxTotalChars: limits.maxDiffChars, maxFileChars: limits.maxFileChars, exclude: settings.exclude })

    // after the first review, a push is reviewed as what was pushed since: fewer tokens, no repeated
    // findings. someone asking for another depth wants the whole pull request looked at again
    let diff = fullDiff
    let incremental = false
    const sameDepth = Option.isSome(previous) && previous.value.depth === settings.depth
    if (Option.isSome(previous) && previous.value.headSha && (options.automatic || sameDepth)) {
      if (previous.value.headSha === pr.head.sha) {
        if (options.automatic) return yield* new Skip({ reason: "this commit was already reviewed" })
      } else {
        const prPaths = new Set(Diff.parseDiff(fullDiff).map((f) => f.path))
        // a force-push leaves the old head unreachable: fall back to the whole diff
        const since = yield* timed("compare", github.compare(ref, previous.value.headSha, pr.head.sha)).pipe(Effect.option)
        if (Option.isSome(since)) {
          // a merge from the base branch brings in commits that aren't this pull request's
          const pushed = Diff.restrictTo(since.value, prPaths)
          const nothing = !pushed.trim() || select(pushed).selected.length === 0
          // nothing to read in what was pushed (screenshots, a lockfile): a push stays quiet, someone asking gets the whole pull request
          if (!nothing || options.automatic) {
            diff = pushed
            incremental = true
          }
          if (nothing && options.automatic) {
            const { skipped } = select(pushed)
            yield* save(id, { files: 0, skippedFiles: skipped.length, incremental: true, steps: [...steps] })
            return yield* new Skip({ reason: `nothing to review since the last review${skipped.length > 0 ? `: ${skippedSummary(skipped)}` : ""}` })
          }
        }
      }
    }

    const { selected, skipped } = select(diff)
    if (selected.length === 0) {
      yield* save(id, { files: 0, skippedFiles: skipped.length, incremental, steps: [...steps] })
      return yield* new Skip({ reason: skipped.length > 0 ? `nothing to review: ${skippedSummary(skipped)}` : "no changes" })
    }

    const chunks = Diff.chunk(selected, limits.chunkChars)
    yield* save(id, { files: selected.length, skippedFiles: skipped.length, chunks: chunks.length, incremental, steps: [...steps] })
    yield* reviewing

    // what's left of the download once the diff is ready: usually nothing
    const checkedOut = yield* timed("code", Fiber.join(code))
    const dir = Result.isSuccess(checkedOut) ? checkedOut.success : undefined
    // without the code the review still runs, on the diff alone, and says so
    const codeProblem = Result.isFailure(checkedOut) ? `reviewed the diff only: ${checkedOut.failure.message}` : undefined

    const results = yield* Effect.forEach(
      chunks,
      (chunkFiles, i) =>
        timed(
          chunks.length === 1 ? "review" : `review ${i + 1}/${chunks.length}`,
          agent
            .review({
              agent: settings.agent,
              model: settings.model,
              effort: EFFORT[settings.depth],
              system: system(dir !== undefined, settings.rules),
              code: dir,
              prompt: reviewPrompt({ title: pr.title, body: pr.body ?? "", files: chunkFiles, part: i + 1, parts: chunks.length, incremental }),
            })
            .pipe(Semaphore.withPermit(permits)),
        ).pipe(Effect.result),
      { concurrency: "unbounded" },
    )

    const failures = results.flatMap((r) => (Result.isFailure(r) ? [r.failure.message] : []))
    const reviews = results.flatMap((r) => (Result.isSuccess(r) ? [r.success.review] : []))
    // what every call spent, a failed one's too where its agent knows
    const spent = results.flatMap((r) => {
      const usage = Result.isSuccess(r) ? r.success.usage : r.failure.usage
      return usage ? [usage] : []
    })
    const usage: Usage | null = spent.length === 0 ? null : spent.reduce(addUsage)
    if (usage) yield* save(id, { usage })
    // a failed chunk's files weren't looked at: the review is partial, and says which
    const unreviewed = results.flatMap((r, i) => (Result.isFailure(r) ? (chunks[i] ?? []).map((f) => f.path) : []))
    if (reviews.length === 0) return yield* new Failed({ message: failures[0] ?? "the agent returned nothing" })

    const found = reviews.flatMap((r) => r.findings)
    const findings = triage(anchor(found, Diff.commentable(selected)), {
      // a follow-up shouldn't repeat what the last review said; a fresh review of the same commit should
      previous: incremental && Option.isSome(previous) ? previous.value.findings : [],
      minConfidence: settings.minConfidence,
      max: settings.maxFindings,
    })
    const summary = reviews
      .map((r) => r.summary.trim())
      .filter(Boolean)
      .join(" ")

    const review = yield* save(id, {
      findings,
      unreviewed,
      summary,
      durationMs: (yield* Clock.currentTimeMillis) - started,
      error:
        [codeProblem, failures.length > 0 ? `${failures.length} of ${chunks.length} chunks failed: ${failures[0]}` : undefined].filter(Boolean).join("; ") ||
        null,
      steps: [...steps],
    })

    const posting = settings.postComments && !options.dryRun
    const agentInfo = { kind: settings.agent, model: settings.model, depth: settings.depth }
    // a follow-up with nothing new stays quiet; a first review always says it looked, and a partial one says so
    const post =
      posting && (findings.length > 0 || !incremental || unreviewed.length > 0)
        ? timed(
            "post",
            github.postReview(ref, {
              commitId: pr.head.sha,
              body: reviewBody(review, skipped, { failure: failures[0], code: codeProblem }),
              comments: findings.map((f) => ({ path: f.path, line: f.line, body: commentBody(f, agentInfo) })),
            }),
          ).pipe(Effect.andThen(save(id, { posted: true })))
        : Effect.void
    // alongside it, glance's threads whose problem is gone are resolved; a file that wasn't read proves nothing
    const reviewed = new Set(selected.map((f) => f.path).filter((path) => !unreviewed.includes(path)))
    const resolving = posting && resolveFixed ? timed("resolve", resolve(ref, pr.head.sha, { reviewed, findings: found })) : Effect.void
    yield* Effect.all([post, resolving], { concurrency: "unbounded", discard: true })

    return yield* save(id, { status: "done", durationMs: (yield* Clock.currentTimeMillis) - started, steps: [...steps] })
  })

  const record = Effect.fn("Reviewer.record")(function* (ref: PrRef, options: StartOptions, settings: Settings) {
    return yield* store.create({
      repo: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      title: "",
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      headSha: "",
      agent: settings.agent,
      model: settings.model,
      depth: settings.depth,
      status: "running",
      trigger: options.trigger,
      dryRun: options.dryRun ?? false,
      incremental: false,
      posted: false,
      files: 0,
      skippedFiles: 0,
      chunks: 0,
      startedAt: yield* Clock.currentTimeMillis,
      durationMs: null,
      summary: "",
      findings: [],
      unreviewed: [],
      steps: [],
      error: null,
      usage: null,
    })
  })

  const run = Effect.fn("Reviewer.run")(function* (ref: PrRef, options: StartOptions) {
    const settings = { ...(yield* store.settingsFor(`${ref.owner}/${ref.repo}`)), ...options.overrides }
    const created = yield* record(ref, options, settings)
    yield* PubSub.publish(changes, created)
    const finish = (patch: Partial<Omit<Review, "id">>) =>
      Clock.currentTimeMillis.pipe(Effect.flatMap((now) => save(created.id, { ...patch, durationMs: now - created.startedAt })))

    // the panel on github follows the review: "reviewing at high…", then the result. it's written
    // alongside the review, never in its way, and only for reviews that will be posted
    let shown: Fiber.Fiber<void> | undefined
    const reviewing =
      settings.postComments && !options.dryRun
        ? panel.show(ref, { kind: "running", depth: settings.depth }).pipe(
            Effect.forkChild,
            Effect.tap((fiber) => Effect.sync(() => (shown = fiber))),
            Effect.asVoid,
          )
        : Effect.void

    const review = yield* pipeline(ref, created.id, settings, options, reviewing).pipe(
      Effect.catchTag("Skip", (skip) => finish({ status: "skipped", summary: skip.reason })),
      Effect.catchTag(["Failed", "GitHubError"], (error) =>
        finish({ status: "failed", error: error._tag === "Failed" ? error.message : `${error._tag}: ${error.message}` }),
      ),
      // cancelled, or replaced by a newer review: the comment on github says so instead of "reviewing…"
      Effect.onInterrupt(() =>
        finish({ status: "cancelled" }).pipe(
          Effect.flatMap((review) => (shown ? panel.show(ref, { kind: "finished", review }) : Effect.void)),
          Effect.catchTag("StoreError", (error) => Effect.logError("couldn't persist review cancellation", error)),
          Effect.when(Effect.map(Ref.get(stopping), (stopping) => !stopping)),
        ),
      ),
      Effect.annotateLogs({ pr: prKey(ref) }),
    )
    if (shown) {
      yield* Effect.exit(Fiber.join(shown))
      yield* panel.show(ref, { kind: "finished", review })
    }
    return review
  })

  const cancel = (ref: PrRef) => FiberMap.remove(running, prKey(ref))

  // too many reviews at once: this one is recorded as skipped (the dashboard and github's comment
  // say why, and the boxes are there to try again) instead of waiting in a queue that only grows
  const turnAway = Effect.fn("Reviewer.turnAway")(function* (ref: PrRef, options: StartOptions, queued: number) {
    const settings = { ...(yield* store.settingsFor(`${ref.owner}/${ref.repo}`)), ...options.overrides }
    const created = yield* record(ref, options, settings)
    const review = yield* save(created.id, {
      status: "skipped",
      summary: `glance is busy (${queued} reviews running or waiting): try again in a few minutes`,
      durationMs: 0,
    })
    yield* Effect.logWarning(`turned away ${prKey(ref)}: ${queued} reviews running or waiting (MAX_QUEUED_REVIEWS)`)
    if (settings.postComments && !options.dryRun) yield* panel.show(ref, { kind: "finished", review })
  })

  // the one it replaces is cancelled first (and its comment written), then this one starts
  const start = Effect.fn("Reviewer.start")(function* (ref: PrRef, options: StartOptions) {
    const queued = yield* FiberMap.size(running)
    // replacing a running review doesn't add to the queue
    if (queued >= limits.maxQueued && !(yield* FiberMap.has(running, prKey(ref)))) return yield* turnAway(ref, options, queued)
    yield* cancel(ref)
    yield* FiberMap.run(
      running,
      prKey(ref),
    )(run(ref, options).pipe(Effect.catchTag("StoreError", (error) => Effect.logError("review persistence failed", error))))
  }, Semaphore.withPermit(admissions))

  // reviews a stop or a crash cut short: a recent one starts again, once; older ones (or one that
  // was itself a restart, which may be what crashed) are marked failed, and their comment says so
  const resume = Effect.fn("Reviewer.resume")(function* (review: Review) {
    const [owner = "", repo = ""] = review.repo.split("/")
    const ref = { owner, repo, number: review.number }
    const again = (yield* Clock.currentTimeMillis) - review.startedAt < RESUME_WITHIN_MS && !review.trigger.startsWith("resumed")
    const ended = yield* save(review.id, {
      status: again ? "cancelled" : "failed",
      error: again ? "glance restarted mid-review: reviewing again" : "glance restarted mid-review",
      durationMs: (yield* Clock.currentTimeMillis) - review.startedAt,
    })
    if (again)
      return yield* start(ref, {
        trigger: `resumed ${review.trigger}`,
        dryRun: review.dryRun,
        overrides: { agent: review.agent, model: review.model, depth: review.depth },
      })
    if (!review.dryRun && Option.isSome(yield* store.panel(review.repo, review.number))) yield* panel.show(ref, { kind: "finished", review: ended })
  })
  yield* Effect.forEach(yield* store.interrupted, resume, { discard: true })

  return Service.of({ start, run, cancel, subscribe: PubSub.subscribe(changes) })
})

export const layer = (limits: Limits, options?: Options) => Layer.effect(Service, make(limits, options))

export * as Reviewer from "./reviewer.ts"
