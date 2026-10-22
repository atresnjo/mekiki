// the code a review reads: the repository at the pull request's head commit, one directory per
// commit (another depth on the same commit is instant), least recently used pruned.
//
// each repository is a bare git repo kept between reviews, holding the file contents it has seen.
// a commit is fetched without contents (commit and trees: small), then only the files not already
// on disk come down, in one batch: a push that changes 3 files downloads 3 files. if git fails,
// the commit's tarball is streamed into tar instead
import { Cache, Context, Duration, Effect, Exit, FileSystem, Layer, Option, Redacted, Ref, Schema, Semaphore, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { PrRef } from "./domain.ts"
import { GitHub } from "./github.ts"

export class CheckoutError extends Schema.TaggedError<CheckoutError>()("CheckoutError", { message: Schema.String }) {}

export interface Options {
  readonly dir: string
  /** a repository whose tarball is bigger isn't downloaded */
  readonly maxMegabytes: number
  /** commits kept on disk */
  readonly keep: number
}

export interface Interface {
  /** the directory holding the repository at `sha` */
  readonly at: (pr: PrRef, sha: string) => Effect.Effect<string, CheckoutError>
}

export class Service extends Context.Service<Service, Interface>()("glance/Checkout") {}

interface Key {
  readonly pr: PrRef
  readonly sha: string
}

export const make = Effect.fn("Checkout.make")(function* (options: Options) {
  const github = yield* GitHub.Service
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const limit = options.maxMegabytes * 1024 * 1024

  const fail = (message: string) => new CheckoutError({ message })
  const trees = `${options.dir}/trees`
  const target = ({ pr, sha }: Key) => `${trees}/${pr.owner}/${pr.repo}/${sha}`
  const bare = (pr: PrRef) => `${options.dir}/git/${pr.owner}/${pr.repo}.git`

  /** run to completion: its stdout */
  const run = (command: ChildProcess.Command, what: string) =>
    Effect.gen(function* () {
      const crashed = (e: unknown) => fail(`${what} failed: ${e instanceof Error ? e.message : String(e)}`)
      const child = yield* spawner.spawn(command).pipe(Effect.mapError(crashed))
      const text = (s: Stream.Stream<Uint8Array, unknown>) => s.pipe(Stream.decodeText(), Stream.mkString)
      const [stdout, stderr, code] = yield* Effect.all([text(child.stdout), text(child.stderr), child.exitCode], { concurrency: "unbounded" }).pipe(
        Effect.mapError(crashed),
      )
      if (code !== 0) return yield* fail(`${what} failed: ${stderr.trim().slice(-500)}`)
      return stdout
    }).pipe(Effect.scoped)

  // one git operation per repository at a time: two fetches into the same repo trip over its locks
  const locks = new Map<string, Semaphore.Semaphore>()
  const locked = (key: string) => {
    let lock = locks.get(key)
    if (!lock) locks.set(key, (lock = Semaphore.makeUnsafe(1)))
    return Semaphore.withPermit(lock)
  }

  const viaGit = Effect.fn("Checkout.viaGit")(function* (key: Key, into: string) {
    const remote = yield* github.gitRemote(key.pr).pipe(Effect.mapError((e) => fail(e.message)))
    const repo = bare(key.pr)
    // the token reaches git through its environment, never its arguments (which `ps` shows anyone)
    const env = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: ${Redacted.value(remote.authorization)}`,
      // nothing from the repository runs: no hooks, and symlinks are written as plain files
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
    }
    const git = (args: ReadonlyArray<string>, what: string, more: { stdin?: string; env?: Record<string, string> } = {}) =>
      run(
        ChildProcess.make("git", [...args], {
          env: { ...env, ...more.env },
          extendEnv: true,
          ...(more.stdin === undefined ? {} : { stdin: Stream.encodeText(Stream.make(more.stdin)) }),
        }),
        what,
      )

    yield* locked(repo)(
      Effect.gen(function* () {
        if (!(yield* fs.exists(`${repo}/HEAD`).pipe(Effect.orElseSucceed(() => false)))) {
          yield* fs.makeDirectory(repo, { recursive: true }).pipe(Effect.mapError((e) => fail(e.message)))
          yield* git(["init", "-q", "--bare", repo], "git init")
          for (const [k, v] of [
            ["remote.origin.url", remote.url],
            // a partial clone: contents come down only when asked for
            ["remote.origin.promisor", "true"],
            ["remote.origin.partialclonefilter", "blob:none"],
          ] as const)
            yield* git(["-C", repo, "config", k, v], "git config")
        }
        // the commit and its trees, no file contents
        yield* git(["-C", repo, "fetch", "-q", "--depth=1", "--filter=blob:none", "--no-tags", "origin", key.sha], "git fetch")
        // the contents this commit needs that no earlier review brought: all at once, not one by one
        const missing = (yield* git(["-C", repo, "rev-list", "--objects", "--missing=print", key.sha], "listing files"))
          .split("\n")
          .flatMap((line) => (line.startsWith("?") ? [line.slice(1)] : []))
        if (missing.length > 0)
          yield* git(
            ["-C", repo, "-c", "fetch.negotiationAlgorithm=noop", "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--stdin", "origin"],
            "fetching files",
            {
              stdin: `${missing.join("\n")}\n`,
            },
          )
        yield* Effect.annotateCurrentSpan({ fetchedFiles: missing.length })
      }),
    )

    // a separate index per checkout, so checkouts of the same repo don't share any state
    yield* fs.makeDirectory(into, { recursive: true }).pipe(Effect.mapError((e) => fail(e.message)))
    yield* git(["--git-dir", repo, "--work-tree", into, "-c", "core.symlinks=false", "checkout", "-q", "-f", key.sha, "--", "."], "git checkout", {
      env: { GIT_INDEX_FILE: `${into}.index` },
    }).pipe(Effect.ensuring(fs.remove(`${into}.index`).pipe(Effect.ignore)))
  })

  const viaTarball = Effect.fn("Checkout.viaTarball")(function* (key: Key, into: string) {
    // the stream's failure (a dropped download, a repo over the limit) can't travel through tar's
    // stdin: it ends the input early and is reported once tar is done
    const failure = yield* Ref.make(Option.none<CheckoutError>())
    let bytes = 0
    const input = github.tarball(key.pr, key.sha).pipe(
      Stream.mapError((e) => fail(`couldn't download the code: ${e.message}`)),
      Stream.tap((chunk) => {
        bytes += chunk.length
        return bytes > limit ? Effect.fail(fail(`the repository is over ${options.maxMegabytes} MB`)) : Effect.void
      }),
      Stream.catchTag("CheckoutError", (e) => Stream.fromEffect(Ref.set(failure, Option.some(e))).pipe(Stream.drain)),
    )
    yield* fs.makeDirectory(into, { recursive: true }).pipe(Effect.mapError((e) => fail(e.message)))
    const extracted = yield* run(ChildProcess.make("tar", ["-xzf", "-", "-C", into, "--strip-components=1"], { stdin: input }), "extracting the code").pipe(
      Effect.exit,
    )
    const failed = yield* Ref.get(failure)
    if (Option.isSome(failed)) return yield* failed.value
    if (Exit.isFailure(extracted)) return yield* extracted
    // a symlink in the repository could point the agent at files outside it
    yield* run(ChildProcess.make("find", [into, "-type", "l", "-delete"]), "removing symlinks")
    yield* Effect.annotateCurrentSpan({ bytes })
  })

  const prune = Effect.gen(function* () {
    const dirs: Array<{ path: string; at: number }> = []
    for (const owner of yield* fs.readDirectory(trees))
      for (const repo of yield* fs.readDirectory(`${trees}/${owner}`))
        for (const sha of yield* fs.readDirectory(`${trees}/${owner}/${repo}`)) {
          const path = `${trees}/${owner}/${repo}/${sha}`
          const info = yield* fs.stat(path)
          dirs.push({ path, at: Option.getOrElse(info.mtime, () => new Date(0)).getTime() })
        }
    const stale = dirs.sort((a, b) => b.at - a.at).slice(options.keep)
    yield* Effect.forEach(stale, (d) => fs.remove(d.path, { recursive: true }), { concurrency: 4, discard: true })
  }).pipe(Effect.ignore)

  const fetch = (key: Key): Effect.Effect<string, CheckoutError> =>
    Effect.gen(function* () {
      const dir = target(key)
      if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) {
        // most recently used: the last to be pruned
        yield* fs.utimes(dir, new Date(), new Date()).pipe(Effect.ignore)
        return dir
      }
      // written beside its target, then renamed into place: a half-written checkout is never used
      const attempt = (how: (key: Key, into: string) => Effect.Effect<void, CheckoutError>) => {
        const tmp = `${dir}.part-${crypto.randomUUID().slice(0, 8)}`
        return how(key, tmp).pipe(
          Effect.as(tmp),
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : fs.remove(tmp, { recursive: true }).pipe(Effect.ignore))),
        )
      }
      const tmp = yield* attempt(viaGit).pipe(
        Effect.catch((e) => Effect.logWarning(`git checkout failed, downloading the tarball: ${e.message}`).pipe(Effect.andThen(attempt(viaTarball)))),
      )
      yield* fs.rename(tmp, dir).pipe(
        // another review of the same commit got there first
        Effect.catch(() => fs.remove(tmp, { recursive: true }).pipe(Effect.ignore)),
      )
      yield* Effect.forkDetach(prune)
      return dir
    }).pipe(Effect.withSpan("Checkout.fetch", { attributes: { repo: `${key.pr.owner}/${key.pr.repo}`, sha: key.sha } }))

  // reviews of the same commit at the same moment share one download. the key is a string:
  // the cache compares keys by value, and two equal objects aren't
  const inFlight = yield* Cache.makeWith(
    (key: string) => {
      const [owner = "", repo = "", sha = ""] = key.split("/")
      return fetch({ pr: { owner, repo, number: 0 }, sha })
    },
    { capacity: 64, timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero) },
  )

  const at = (pr: PrRef, sha: string) => Cache.get(inFlight, `${pr.owner}/${pr.repo}/${sha}`)

  return Service.of({ at })
})

export const layer = (options: Options) => Layer.effect(Service, make(options))

export * as Checkout from "./checkout.ts"
