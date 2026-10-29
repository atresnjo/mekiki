#!/usr/bin/env bun
// External CLI fixture: real subprocess transport, no model calls or real credentials.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
const dir = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR!
appendFileSync(
  join(dir, "calls.jsonl"),
  JSON.stringify({
    args: process.argv.slice(2),
    leaked: [
      "GITHUB_TOKEN",
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GLANCE_API_BASE_URL",
      "GLANCE_PRICES",
    ].filter((key) => process.env[key]),
    crossProvider: process.argv.includes("app-server") && !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
  }) + "\n",
)
if (process.argv.includes("app-server")) {
  for await (const line of console) {
    const message = JSON.parse(line)
    if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {} }))
    if (message.method === "account/rateLimits/read") {
      const mode = await Bun.file(join(dir, "mode")).text()
      if (mode === "timeout") continue
      console.log(
        JSON.stringify({
          id: message.id,
          result:
            mode === "malformed"
              ? { rateLimits: { primary: { usedPercent: "bad" } } }
              : {
                  rateLimits: {
                    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1893456000 },
                    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1893801600 },
                  },
                },
        }),
      )
    }
  }
} else if (process.argv.includes("-p")) {
  await Bun.stdin.text()
  console.log(
    JSON.stringify({
      structured_output: { summary: "Fixture review completed", findings: [] },
      usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 4500, output_tokens: 800 },
      total_cost_usd: 0.0123,
    }),
  )
} else if (process.argv[2] === "exec") {
  await Bun.stdin.text()
  const out = process.argv[process.argv.indexOf("-o") + 1]!
  await Bun.write(out, JSON.stringify({ summary: "Fixture review completed", findings: [] }))
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }))
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9000, cached_input_tokens: 6000, output_tokens: 700 } }))
} else if (process.argv.includes("--version")) console.log("fixture 1.0")
else console.log(JSON.stringify({ loggedIn: true }))
