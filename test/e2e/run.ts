// Run with bun run test:e2e:browser. Uses only local fixtures; no GitHub writes or paid model calls.
import { chromium, expect } from "@playwright/test"
import { createHmac } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

const artifacts = resolve(".data/e2e")
await Bun.$`mkdir -p ${artifacts}`.quiet()
const credentials = await mkdtemp(join(tmpdir(), "glance-e2e-"))
await Bun.write(join(credentials, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-oauth" } }))
await Bun.write(join(credentials, "mode"), "ok")
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: credentials,
  CODEX_HOME: credentials,
  CLAUDE_CODE_OAUTH_TOKEN: "",
  GITHUB_TOKEN: "server-secret",
  BETTER_AUTH_SECRET: "server-secret",
  DATABASE_URL: "server-secret",
  OPENAI_API_KEY: "must-not-bill",
  ANTHROPIC_API_KEY: "must-not-bill",
}
const api = Bun.spawn(["bun", "test/e2e/server.ts"], {
  env,
  stdout: Bun.file(join(artifacts, "server.log")),
  stderr: Bun.file(join(artifacts, "server-errors.log")),
})
const web = Bun.spawn(["bun", "run", "dev:web", "--port", "7521", "--strictPort", "--host", "127.0.0.1"], {
  env: { ...process.env, GLANCE_API_URL: "http://127.0.0.1:7520" },
  stdout: Bun.file(join(artifacts, "web.log")),
  stderr: Bun.file(join(artifacts, "web-errors.log")),
})
const checks: string[] = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.context().tracing.start({ screenshots: true, snapshots: true })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
const record = (name: string) => {
  checks.push(name)
  console.log(`PASS ${name}`)
}
try {
  await expect
    .poll(
      async () =>
        fetch("http://127.0.0.1:7520/_fixture")
          .then((r) => r.status)
          .catch(() => 0),
      { timeout: 20000 },
    )
    .toBe(200)
  await expect
    .poll(
      async () =>
        fetch("http://127.0.0.1:7521")
          .then((r) => r.status)
          .catch(() => 0),
      { timeout: 20000 },
    )
    .toBe(200)
  const denied = await fetch("http://127.0.0.1:7520/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _tag: "Request", id: "1", tag: "GetUsage", payload: null, headers: [] }) + "\n",
  }).then((r) => r.text())
  expect(denied).toContain("Unauthorized")
  expect(denied).not.toContain("usedPercent")
  record("subscription usage requires authentication")
  await page.goto("http://127.0.0.1:7521")
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Subscription usage" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Subscription usage" })).toHaveCount(0)
  record("signed-out dashboard asks to sign in and shows no usage")
  await page.context().addCookies([{ name: "glance-e2e", value: "signed-in", url: "http://127.0.0.1:7521" }])
  await page.reload()
  // the header: one line of health (codex isn't logged in on the fixture), and the closest limit
  await expect(page.getByRole("button", { name: /^Status: Codex logged out/ })).toBeVisible()
  const usageButton = page.getByRole("button", { name: "Subscription usage" })
  await expect(usageButton).toHaveText("100%")
  record("header shows what's wrong in one line and the closest subscription limit")
  await usageButton.click()
  await expect(page.getByRole("heading", { name: "Subscription usage" })).toBeVisible()
  await expect(page.getByRole("meter", { name: "Claude Code 5-hour usage" })).toHaveAttribute("aria-valuenow", "42")
  await expect(page.getByRole("meter", { name: "Codex 5-hour usage" })).toHaveAttribute("aria-valuenow", "0")
  await expect(page.getByRole("meter", { name: "Codex Weekly usage" })).toHaveAttribute("aria-valuenow", "100")
  await expect(page.getByText("76.5% used")).toBeVisible()
  record("signed-in dashboard displays real transport values, zero and exhausted quotas")
  await page.getByRole("button", { name: "Refresh subscription usage" }).click()
  await expect(page.getByRole("button", { name: "Refresh subscription usage" })).toBeEnabled()
  expect(
    await fetch("http://127.0.0.1:7520/_fixture")
      .then((r) => r.json())
      .then((r) => r.usage),
  ).toBe(1)
  record("refresh uses cached provider data")
  await page.screenshot({ path: join(artifacts, "desktop.png"), fullPage: true })
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 390, height: 844 })
  await usageButton.click()
  await expect(page.getByRole("meter", { name: "Codex Weekly usage" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: join(artifacts, "mobile.png"), fullPage: true })
  await page.keyboard.press("Escape")
  record("mobile layout has no horizontal overflow")
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole("switch", { name: "Dry run" }).click()
  await page.getByLabel("Pull request URL").fill("https://github.com/acme/api/pull/7")
  await page.getByRole("button", { name: "Review", exact: true }).click()
  await expect(page.getByText("Fixture review completed")).toBeVisible({ timeout: 15000 })
  const rpc = (tag: string, payload: unknown) =>
    page.evaluate(
      async ({ tag, payload }) => {
        const response = await fetch("/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ _tag: "Request", id: "2", tag, payload, headers: [] }) + "\n",
        })
        return response.text()
      },
      { tag, payload },
    )
  const first = await rpc("ListReviews", { before: 999999 })
  expect(first).toContain('"dryRun":true')
  const retry = await rpc("RetryReview", { id: 1, depth: "high" })
  expect(retry).not.toContain('"Failure"')
  await expect.poll(() => rpc("ListReviews", { before: 999999 }), { timeout: 15000 }).toContain('"trigger":"retry high by e2e@acme.com"')
  await expect.poll(async () => (await rpc("ListReviews", { before: 999999 })).includes('"status":"running"'), { timeout: 15000 }).toBe(false)
  const reviews = await rpc("ListReviews", { before: 999999 })
  expect(reviews).not.toContain('"dryRun":false')
  const counts = await fetch("http://127.0.0.1:7520/_fixture").then((r) => r.json())
  expect(counts.posts).toBe(0)
  expect(counts.panels).toBe(0)
  record("dry-run start and retry complete without any GitHub writes")
  const calls = (await readFile(join(credentials, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(calls.length).toBeGreaterThan(2)
  expect(calls.every((call) => call.leaked.length === 0 && !call.crossProvider)).toBe(true)
  record("real child processes cannot see server secrets or API billing keys")
  await fetch("http://127.0.0.1:7520/_panel")
  const deliver = async (id: number, command?: { by: string }) => {
    const by = command?.by ?? "writer"
    const body = JSON.stringify({
      action: command ? "created" : "edited",
      issue: { number: 7, pull_request: {} },
      comment: {
        id,
        body: command ? "/glance high" : "<!-- glance:panel -->\n- [x] High <!-- glance:high -->",
        user: command ? { login: by, type: "User" } : { login: "glance[bot]", type: "Bot" },
      },
      repository: { name: "api", owner: { login: "acme" } },
      sender: { login: by, type: "User" },
    })
    return fetch("http://127.0.0.1:7520/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": `fixture-${id}`,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "e2e-webhook").update(body).digest("hex")}`,
      },
    })
  }
  expect(await (await deliver(999)).json()).toMatchObject({ reviewing: false })
  expect((await deliver(77)).status).toBe(202)
  record("copied checkbox rejected while the saved panel still starts a review")
  expect(await (await deliver(1000, { by: "stranger" })).json()).toMatchObject({ reviewing: false, refused: expect.any(String) })
  expect((await deliver(1001, { by: "writer" })).status).toBe(202)
  record("comment commands from people without write access refused while collaborators' still work")
  for (const mode of ["rate-limited", "forbidden", "expired", "malformed", "timeout"]) {
    const result = await fetch("http://127.0.0.1:7520/_mode", { method: "POST", body: mode }).then((r) => r.json())
    expect(JSON.stringify(result)).not.toContain("private upstream diagnostic")
    if (mode === "timeout") {
      expect(result.codex.windows).toEqual([])
      expect(result.claude.windows).toHaveLength(2)
    } else {
      expect(result.claude.windows).toEqual([])
      expect(result.claude.unavailable).toBeTruthy()
    }
    if (!["malformed", "timeout"].includes(mode)) expect(result.codex.windows).toHaveLength(2)
    record(`${mode} provider response handled without fabricated usage or leaked diagnostics`)
    if (mode === "rate-limited") {
      expect(result.claude.unavailable).toBe("Claude is rate limiting usage checks. Next check in 29 minutes.")
      const before = await fetch("http://127.0.0.1:7520/_fixture").then((r) => r.json())
      for (let i = 0; i < 3; i++) expect((await fetch("http://127.0.0.1:7520/_usage").then((r) => r.json())).claude).toEqual(result.claude)
      expect((await fetch("http://127.0.0.1:7520/_fixture").then((r) => r.json())).usage).toBe(before.usage)
      record("rate-limited Claude usage waits out Retry-After before calling the provider again")
    }
  }
  await page.getByRole("button", { name: "Settings" }).click()
  const sections = page.getByRole("navigation", { name: "Settings sections" })
  await expect(sections).toBeVisible()
  // past the dialog's opening animation
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(artifacts, "settings.png") })
  // one page: a section in the list scrolls to it, and the list follows what's being read
  await sections.getByRole("button", { name: "Repositories" }).click()
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeInViewport()
  await expect(sections.getByRole("button", { name: "Repositories" })).toHaveAttribute("aria-current", "true")
  record("settings sections scroll into view and the list marks the one being read")
  await sections.getByRole("button", { name: "Team rules" }).click()
  await page.getByRole("textbox", { name: "Team rules" }).fill("We use Effect: never throw.")
  await sections.getByRole("button", { name: "Repositories" }).click()
  // a repository glance has reviewed is suggested
  await page.getByLabel("Add a repository").fill("acme")
  await page.getByRole("option", { name: "acme/api" }).click()
  await page.getByRole("button", { name: "Add", exact: true }).click()
  // the repository's own blocked authors: the global ones come first on the page
  await page.getByLabel("Blocked authors").last().fill("dependabot[bot]")
  await page.getByLabel("Blocked authors").last().press("Enter")
  await page.screenshot({ path: join(artifacts, "repo-settings.png") })
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Settings saved")).toBeVisible()
  expect(await rpc("GetSettings", null)).toContain('"rules":"We use Effect: never throw."')
  expect(await rpc("GetRepoSettings", null)).toContain('"repo":"acme/api","mode":null,"depth":null,"rules":"","blockedAuthors":["dependabot[bot]"]')
  const opened = JSON.stringify({
    action: "opened",
    number: 8,
    pull_request: { draft: false, head: { sha: "d1" }, labels: [], user: { login: "dependabot[bot]", type: "Bot" } },
    repository: { name: "api", owner: { login: "acme" } },
    sender: { login: "dependabot[bot]", type: "Bot" },
  })
  const panelsBefore = (await fetch("http://127.0.0.1:7520/_fixture").then((r) => r.json())).panels
  const blocked = await fetch("http://127.0.0.1:7520/api/webhooks/github", {
    method: "POST",
    body: opened,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "fixture-blocked",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "e2e-webhook").update(opened).digest("hex")}`,
    },
  })
  expect(await blocked.json()).toMatchObject({ reviewing: false, blocked: "dependabot[bot]" })
  expect((await fetch("http://127.0.0.1:7520/_fixture").then((r) => r.json())).panels).toBe(panelsBefore)
  record("team rules and a repository's blocked author saved in the dashboard; that author's pull request gets no comment")
  expect(errors).toEqual([])
  record("no browser runtime errors")
  await Bun.write(join(artifacts, "report.json"), JSON.stringify({ passed: checks, browserErrors: errors, completedAt: new Date().toISOString() }, null, 2))
} catch (error) {
  await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
  await Bun.write(join(artifacts, "report.json"), JSON.stringify({ passed: checks, error: String(error), browserErrors: errors }, null, 2))
  throw error
} finally {
  await page.context().tracing.stop({ path: join(artifacts, "trace.zip") })
  await browser.close()
  api.kill()
  web.kill()
  await Promise.all([api.exited, web.exited])
  await rm(credentials, { recursive: true, force: true })
}
