#!/usr/bin/env bun
// External CLI fixture: real subprocess transport, no model calls or real credentials.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
const dir = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR!
appendFileSync(
  join(dir, "calls.jsonl"),
  JSON.stringify({
    args: process.argv.slice(2),
    leaked: ["GITHUB_TOKEN", "DATABASE_URL", "BETTER_AUTH_SECRET", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].filter((key) => process.env[key]),
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
  console.log(JSON.stringify({ structured_output: { summary: "Fixture review completed", findings: [] } }))
} else if (process.argv.includes("--version")) console.log("fixture 1.0")
else console.log(JSON.stringify({ loggedIn: true }))
