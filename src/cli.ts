// bun review <pr-url> [--post] [--agent claude|codex] [--model name] [--depth light|medium|high]
// reviews once and prints the findings. posts nothing unless --post
import { parseArgs } from "node:util"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import * as App from "./app.ts"
import { AppConfig } from "./config.ts"
import { parsePrUrl, type Settings } from "./domain.ts"
import { Reviewer } from "./reviewer.ts"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    post: { type: "boolean", default: false },
    agent: { type: "string" },
    model: { type: "string" },
    depth: { type: "string" },
    json: { type: "boolean", default: false },
  },
})

const ref = parsePrUrl(positionals[0] ?? "")
if (!ref) {
  console.error(
    "usage: bun review <https://github.com/owner/repo/pull/123> [--post] [--agent claude|codex] [--model name] [--depth light|medium|high] [--json]",
  )
  process.exit(2)
}

const overrides: Partial<Settings> = {
  ...(values.agent === "claude" || values.agent === "codex" ? { agent: values.agent } : {}),
  ...(values.model !== undefined ? { model: values.model } : {}),
  ...(values.depth === "light" || values.depth === "medium" || values.depth === "high" ? { depth: values.depth } : {}),
}

const program = Effect.gen(function* () {
  const reviewer = yield* Reviewer.Service
  const review = yield* reviewer.run(ref, { trigger: "cli", dryRun: !values.post, overrides })
  if (values.json) return yield* Console.log(JSON.stringify(review, null, 2))

  const seconds = ((review.durationMs ?? 0) / 1000).toFixed(1)
  yield* Console.log(
    `\n${review.repo}#${review.number} ${review.title}\n${review.status} in ${seconds}s · ${review.agent}${review.model ? ` ${review.model}` : ""} · ${review.depth} · ${review.files} files, ${review.chunks} chunk(s)`,
  )
  yield* Console.log(review.steps.map((s) => `  ${s.name.padEnd(14)} ${(s.ms / 1000).toFixed(1)}s`).join("\n"))
  if (review.error) yield* Console.error(`\n${review.error}`)
  if (review.summary) yield* Console.log(`\n${review.summary}`)
  for (const f of review.findings) yield* Console.log(`\n[${f.severity}] ${f.path}:${f.line}  ${f.title}\n  ${f.body.replaceAll("\n", "\n  ")}`)
  if (review.status === "done") yield* Console.log(`\n${review.findings.length} finding(s)${review.posted ? ", posted" : ""}`)
  if (review.status === "failed") return yield* Effect.sync(() => process.exit(1))
})

Effect.gen(function* () {
  const config = yield* AppConfig
  return yield* program.pipe(Effect.provide(App.layer(config)))
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
