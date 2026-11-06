import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted, Stream } from "effect"
import { Checkout } from "../src/checkout.ts"
import { GitHubError } from "../src/domain.ts"
import { GitHub } from "../src/github.ts"
import { fakeGitHub } from "./support.ts"

const git = (cwd: string, ...args: Array<string>) => {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

/** a repository on disk, served over file:// the way github serves it: partial clones, any commit by its id */
const origin = (files: Record<string, string | Uint8Array>) => {
  const dir = mkdtempSync(join(tmpdir(), "mekiki-origin-"))
  git(dir, "init", "-q")
  git(dir, "config", "uploadpack.allowFilter", "true")
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true")
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "c")
  return { url: `file://${dir}`, sha: git(dir, "rev-parse", "HEAD") }
}

const checkoutWith = (url: string, options: { maxMegabytes: number }) => {
  const dir = mkdtempSync(join(tmpdir(), "mekiki-checkouts-"))
  const github = Layer.effect(
    GitHub.Service,
    Effect.map(GitHub.Service, (fake) =>
      GitHub.Service.of({
        ...fake,
        gitRemote: () => Effect.succeed({ url, authorization: Redacted.make("Basic none") }),
        tarball: () => Stream.fail(new GitHubError({ operation: "tarball", message: "no tarball in tests" })),
      }),
    ),
  ).pipe(Layer.provide(fakeGitHub([])))
  const layer = Checkout.layer({ dir, maxMegabytes: options.maxMegabytes, keep: 10, diskBudgetMegabytes: 1024, timeout: 60 }).pipe(
    Layer.provide(github),
    Layer.provide(BunServices.layer),
  )
  return {
    dir,
    at: (sha: string) =>
      Effect.runPromise(
        Effect.flatMap(Checkout.Service, (c) => c.at({ owner: "acme", repo: "api", number: 1 }, sha).pipe(Effect.result)).pipe(Effect.provide(layer)),
      ),
  }
}

test("the code at a commit is checked out with git", async () => {
  const repo = origin({ "index.ts": "export const one = 1\n" })
  const checkouts = checkoutWith(repo.url, { maxMegabytes: 10 })
  const result = await checkouts.at(repo.sha)
  expect(result._tag).toBe("Success")
  if (result._tag === "Success") expect(readFileSync(join(result.success, "index.ts"), "utf8")).toBe("export const one = 1\n")
})

test("git may not bring down more than MAX_REPO_MB: the download fails and what came is dropped", async () => {
  const repo = origin({ "big.bin": crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024)) })
  const checkouts = checkoutWith(repo.url, { maxMegabytes: 1 })
  const result = await checkouts.at(repo.sha)
  expect(result._tag).toBe("Failure")
  expect(existsSync(join(checkouts.dir, "git/acme/api.git"))).toBe(false)
  expect(existsSync(join(checkouts.dir, "trees/acme/api", repo.sha))).toBe(false)
})
