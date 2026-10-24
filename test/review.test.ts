import { describe, expect, test } from "bun:test"
import { agentEnv, childEnv } from "../src/agent.ts"
import { chunk, commentable, parseDiff, render, restrictTo, select } from "../src/diff.ts"
import { depthIn, type Finding, parsePrUrl } from "../src/domain.ts"
import { anchor, reviewBody, triage } from "../src/reviewer.ts"
import { review } from "./support.ts"

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,4 +10,5 @@ export const login = () => {
   const user = find()
-  if (!user) throw new Error("no user")
+  if (!user) return null
+  audit(user)
   return user
 }
diff --git a/bun.lock b/bun.lock
index 3333333..4444444 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1,1 +1,1 @@
-old
+new
diff --git a/docs/readme.md b/docs/readme.md
new file mode 100644
--- /dev/null
+++ b/docs/readme.md
@@ -0,0 +1,2 @@
+# hi
+there
`

const finding = (overrides: Partial<Finding>): Finding => ({
  path: "src/auth.ts",
  line: 11,
  severity: "high",
  category: "bug",
  title: "Returns null instead of throwing",
  body: "callers expect a user",
  suggestion: null,
  confidence: 0.9,
  ...overrides,
})

describe("diff", () => {
  test("parses files, statuses and new-file line numbers", () => {
    const files = parseDiff(DIFF)
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/auth.ts", "modified", 2, 1],
      ["bun.lock", "modified", 1, 1],
      ["docs/readme.md", "added", 2, 0],
    ])
    expect([...(commentable(files).get("src/auth.ts") ?? [])]).toEqual([10, 11, 12, 13, 14])
  })

  test("renders line numbers the model can cite", () => {
    const [auth] = parseDiff(DIFF)
    expect(auth && render(auth)).toContain("   11 +   if (!user) return null")
    expect(auth && render(auth)).toContain("      -   if (!user) throw")
  })

  test("skips lockfiles and reviews risky paths first", () => {
    const { selected, skipped } = select(parseDiff(DIFF), { maxTotalChars: 10_000, maxFileChars: 10_000 })
    expect(selected.map((f) => f.path)).toEqual(["src/auth.ts", "docs/readme.md"])
    expect(skipped).toEqual([{ path: "bun.lock", reason: "generated or lockfile" }])
  })

  test("drops what doesn't fit the budget, lowest priority first", () => {
    const { selected, skipped } = select(parseDiff(DIFF), { maxTotalChars: 250, maxFileChars: 10_000 })
    expect(selected.map((f) => f.path)).toEqual(["src/auth.ts"])
    expect(skipped.map((s) => s.reason)).toContain("diff budget")
  })

  test("packs files into as few chunks as fit", () => {
    const files = parseDiff(DIFF)
    expect(chunk(files, 100_000)).toHaveLength(1)
    expect(chunk(files, 1)).toHaveLength(3)
  })

  test("restricts a diff to some paths", () => {
    expect(parseDiff(restrictTo(DIFF, new Set(["docs/readme.md"]))).map((f) => f.path)).toEqual(["docs/readme.md"])
  })
})

describe("triage", () => {
  const lines = commentable(parseDiff(DIFF))

  test("keeps findings on commentable lines and snaps near misses", () => {
    const out = anchor([finding({ line: 11 }), finding({ line: 16 }), finding({ line: 40 }), finding({ path: "nope.ts" })], lines)
    expect(out.map((f) => f.line)).toEqual([11, 14])
  })

  test("drops low confidence, duplicates and what was said before, worst first, capped", () => {
    const out = triage(
      [
        finding({ severity: "low", line: 13, title: "minor", category: "maintainability" }),
        finding({ severity: "high" }),
        finding({ severity: "high", title: "returns null instead of throwing!" }),
        finding({ severity: "medium", confidence: 0.3, line: 10, title: "unsure", category: "performance" }),
        finding({ severity: "critical", confidence: 0.5, line: 12, title: "auth bypass", category: "security" }),
      ],
      { previous: [], minConfidence: 0.6, max: 10 },
    )
    expect(out.map((f) => f.title)).toEqual(["auth bypass", "Returns null instead of throwing", "minor"])

    expect(triage([finding({})], { previous: [finding({ line: 12 })], minConfidence: 0.6, max: 10 })).toEqual([])
    expect(triage([finding({}), finding({ line: 13, title: "b", category: "security" })], { previous: [], minConfidence: 0, max: 1 })).toHaveLength(1)
  })
})

test("parses pull request references", () => {
  expect(parsePrUrl("https://github.com/acme/api/pull/42/files")).toEqual({ owner: "acme", repo: "api", number: 42 })
  expect(parsePrUrl("acme/api#7")).toEqual({ owner: "acme", repo: "api", number: 7 })
  expect(parsePrUrl("nope")).toBeUndefined()
})

test("reads a depth from labels and comments", () => {
  expect(depthIn("glance:high")).toBe("high")
  expect(depthIn("glance-light")).toBe("light")
  expect(depthIn("Glance/Medium")).toBe("medium")
  expect(depthIn("/glance high")).toBe("high")
  expect(depthIn("thanks! @glance medium please")).toBe("medium")
  expect(depthIn("/glance")).toBeUndefined()
  expect(depthIn("high priority")).toBeUndefined()
  expect(depthIn("myglance:high")).toBeUndefined()
})

test("child processes get an allowlist of glance's environment: no secrets, no api keys", () => {
  const glance = {
    PATH: "/usr/bin",
    HOME: "/home/bun",
    LC_ALL: "C.UTF-8",
    HTTPS_PROXY: "http://proxy:3128",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat",
    CODEX_HOME: "/data/codex",
    DATABASE_URL: "postgres://glance:secret@postgres/glance",
    GITHUB_TOKEN: "ghp_secret",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "whsec",
    GITHUB_CLIENT_SECRET: "oauth",
    BETTER_AUTH_SECRET: "auth",
    GLANCE_SSO_CLIENT_SECRET: "sso",
    ANTHROPIC_API_KEY: "sk-ant-api",
    OPENAI_API_KEY: "sk-openai",
  }
  expect(agentEnv(glance)).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/bun",
    LC_ALL: "C.UTF-8",
    HTTPS_PROXY: "http://proxy:3128",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat",
    CODEX_HOME: "/data/codex",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    NO_COLOR: "1",
  })
  // git and tar don't even get the agents' logins
  expect(Object.keys(childEnv({ GIT_TERMINAL_PROMPT: "0" }, glance)).sort()).toEqual(["GIT_TERMINAL_PROMPT", "HOME", "HTTPS_PROXY", "LC_ALL", "PATH"])
})

test("the review on github says when part of the pull request wasn't reviewed", () => {
  const whole = reviewBody({ ...review(), id: 1, files: 3 }, [])
  const part = reviewBody({ ...review(), id: 1, files: 3, unreviewed: ["src/a.ts", "src/b.ts"] }, [], { failure: "claude timed out after 600s" })
  expect(whole).toContain("**No issues found**")
  expect(whole).not.toContain("Partial")
  expect(part).toContain("Partial review: 2 of 3 files couldn't be reviewed** (claude timed out after 600s)")
  expect(part).toContain("No issues found in the files reviewed")
  expect(part).toContain("`src/b.ts`")
})
