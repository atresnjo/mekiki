import { expect, test } from "bun:test"
import type { Review } from "../src/domain.ts"
import { render, tickedDepth } from "../src/panel.ts"

const review: Review = {
  id: 1,
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  headSha: "abcdef1234",
  agent: "claude",
  model: "",
  depth: "light",
  status: "done",
  trigger: "checkbox light",
  dryRun: false,
  incremental: false,
  posted: true,
  files: 2,
  skippedFiles: 0,
  chunks: 1,
  startedAt: 0,
  durationMs: 12_300,
  summary: "s",
  findings: [],
  unreviewed: [],
  steps: [],
  error: null,
  usage: null,
}

const tick = (body: string, depth: string) => body.replace(new RegExp(`- \\[ \\](.*<!-- glance:${depth} -->)`), "- [x]$1")

test("a ticked box is the depth to review at", () => {
  const panel = render({ kind: "waiting" })
  expect(tickedDepth(tick(panel, "high"), panel)).toBe("high")
  expect(tickedDepth(tick(panel, "light"), panel)).toBe("light")
  // edits without a fresh tick, including glance's own re-renders, start nothing
  expect(tickedDepth(panel, panel)).toBeUndefined()
  expect(tickedDepth(render({ kind: "running", depth: "high" }), tick(panel, "high"))).toBeUndefined()
  // several at once: the deepest
  expect(tickedDepth(tick(tick(panel, "light"), "medium"), panel)).toBe("medium")
  // a box that was already ticked isn't a new tick
  expect(tickedDepth(tick(tick(panel, "light"), "high"), tick(panel, "high"))).toBe("light")
  // not glance's comment
  expect(tickedDepth("- [x] High <!-- glance:high -->", "")).toBeUndefined()
})

test("renders every state with unticked boxes and no command glance would answer", () => {
  const states = [
    render({ kind: "waiting" }),
    render({ kind: "running", depth: "medium" }),
    render({ kind: "finished", review }),
    render({ kind: "finished", review, head: "9999999abc" }),
    render({ kind: "finished", review: { ...review, status: "failed", error: "boom" } }),
  ]
  for (const body of states) {
    expect(body.match(/- \[ \]/g)).toHaveLength(3)
    expect(body).not.toMatch(/\[x\]/i)
    expect(body).not.toMatch(/(^|\s)(\/glance|@glance)\b/i)
  }
  expect(states[2]).toContain("✅ Reviewed `abcdef1` at **Light** in 12.3s: no issues found.")
  expect(states[3]).toContain("🔁 New commits since: `abcdef1` → `9999999`.")
  expect(states[4]).toContain("❌ The **Light** review failed: boom")
})

test("a partial review says so instead of 'no issues found'", () => {
  const body = render({ kind: "finished", review: { ...review, files: 3, unreviewed: ["a.ts"], error: "1 of 2 chunks failed" } })
  expect(body).toContain("Partly reviewed")
  expect(body).toContain("1 of 3 files couldn't be reviewed")
  expect(body).not.toContain("✅")
})
