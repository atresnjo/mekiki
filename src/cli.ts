// bun review <pr-url> [--post] [--agent claude|codex|api] [--model name] [--depth light|medium|high] [--json]
// reviews once and prints the findings. posts nothing unless --post
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import * as App from "./app.ts"
import { AppConfig } from "./config.ts"
import { parsePrUrl, type Settings } from "./domain.ts"
import { Reviewer } from "./reviewer.ts"

/** the review ran and failed: the process exits 1, after its services have shut down */
class ReviewFailed extends Schema.TaggedError<ReviewFailed>()("ReviewFailed", { message: Schema.String }) {}

const review = Command.make(
  "review",
  {
    pr: Argument.String("pr").pipe(
      Argument.withDescription("https://github.com/owner/repo/pull/123, or owner/repo#123"),
      Argument.filterMap(
        (input) => Option.fromUndefinedOr(parsePrUrl(input)),
        () => "a pull request: https://github.com/owner/repo/pull/123 or owner/repo#123",
      ),
    ),
    post: Flag.Boolean("post").pipe(Flag.withDefault(false), Flag.withDescription("post the review on github")),
    agent: Flag.Literals("agent", ["claude", "codex", "api"]).pipe(Flag.optional),
    model: Flag.String("model").pipe(Flag.optional),
    depth: Flag.Literals("depth", ["light", "medium", "high"]).pipe(Flag.optional),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("print the whole review as json")),
  },
  Effect.fn("Cli.review")(function* ({ pr, post, agent, model, depth, json }) {
    const overrides: Partial<Settings> = {
      ...Option.match(agent, { onNone: () => ({}), onSome: (agent) => ({ agent }) }),
      ...Option.match(model, { onNone: () => ({}), onSome: (model) => ({ model }) }),
      ...Option.match(depth, { onNone: () => ({}), onSome: (depth) => ({ depth }) }),
    }
    // the services start once the arguments are known to be right: --help needs no database
    const config = yield* AppConfig
    const review = yield* Reviewer.Service.use((reviewer) => reviewer.run(pr, { trigger: "cli", dryRun: !post, overrides })).pipe(
      Effect.provide(App.layer(config)),
    )
    if (json) yield* Console.log(JSON.stringify(review, null, 2))
    else {
      const seconds = ((review.durationMs ?? 0) / 1000).toFixed(1)
      yield* Console.log(
        `\n${review.repo}#${review.number} ${review.title}\n${review.status} in ${seconds}s · ${review.agent}${review.model ? ` ${review.model}` : ""} · ${review.depth} · ${review.files} files, ${review.chunks} chunk(s)`,
      )
      yield* Console.log(review.steps.map((s) => `  ${s.name.padEnd(14)} ${(s.ms / 1000).toFixed(1)}s`).join("\n"))
      if (review.usage)
        yield* Console.log(
          `  ${review.usage.inputTokens} in (${review.usage.cachedInputTokens} cached), ${review.usage.outputTokens} out${review.usage.costUsd === null ? "" : ` · ≈ $${review.usage.costUsd.toFixed(2)}, an estimate`}`,
        )
      if (review.error) yield* Console.error(`\n${review.error}`)
      if (review.summary) yield* Console.log(`\n${review.summary}`)
      for (const f of review.findings) yield* Console.log(`\n[${f.severity}] ${f.path}:${f.line}  ${f.title}\n  ${f.body.replaceAll("\n", "\n  ")}`)
      if (review.status === "done") yield* Console.log(`\n${review.findings.length} finding(s)${review.posted ? ", posted" : ""}`)
    }
    if (review.status === "failed") return yield* new ReviewFailed({ message: review.error ?? "the review failed" })
  }),
).pipe(Command.withDescription("review a pull request once and print the findings"))

Command.run(review, { version: "dev" }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
