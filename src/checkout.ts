// the code a review reads: the repository at the pull request's head commit, one directory per
// commit (another depth on the same commit is instant), least recently used pruned.
//
// each repository is a bare git repo kept between reviews, holding the file contents it has seen.
// a commit is fetched without contents (commit and trees: small), then only the files not already
// on disk come down, in one batch: a push that changes 3 files downloads 3 files. if git fails,
// the commit's tarball is streamed into tar instead.
//
// bounded: a download gives up after `timeout`, git may write no more than `maxMegabytes` (the
// tarball may download no more), and everything here together stays under `diskBudgetMegabytes`
import {
  Cache,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Queue,
  RcMap,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { PrRef } from "./domain.ts"
import { childEnv } from "./agent.ts"
import { GitHub } from "./github.ts"

export class CheckoutError extends Schema.TaggedError<CheckoutError>()("CheckoutError", { message: Schema.String }) {}

export interface Options {
  readonly dir: string
  /** a repository that needs more than this on disk (git) or to download (the tarball) isn't fetched */
  readonly maxMegabytes: number
  /** commits kept on disk */
  readonly keep: number
  /** everything under `dir`: past it, the least recently used commits (then repositories) go */
  readonly diskBudgetMegabytes: number
  /** seconds one download may take, git's or the tarball's */
  readonly timeout: number
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

  /** kilobytes on disk under the paths that exist */
  const kilobytes = (paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const existing = yield* Effect.filter(paths, (p) => fs.exists(p).pipe(Effect.orElseSucceed(() => false)))
      if (existing.length === 0) return 0
      const out = yield* run(ChildProcess.make("du", ["-sk", "-c", ...existing], { env: childEnv() }), "measuring the checkouts")
      return Number(out.trim().split("\n").at(-1)?.split(/\s/)[0] ?? 0)
    })

  /**
   * `effect`, stopped (and failed) once what it has written under `paths` grows past `maxMegabytes`:
   * git has no size limit of its own, so it's watched from outside, every second, and once more at
   * the end. `undo` cleans up what an oversized download left
   */
  const capped = <A>(effect: Effect.Effect<A, CheckoutError>, paths: ReadonlyArray<string>, undo: Effect.Effect<void> = Effect.void) =>
    Effect.gen(function* () {
      const before = yield* kilobytes(paths).pipe(Effect.orElseSucceed(() => 0))
      const over = yield* Ref.make(false)
      const check = kilobytes(paths).pipe(
        Effect.orElseSucceed(() => before),
        Effect.map((now) => now - before > options.maxMegabytes * 1024),
        Effect.tap((isOver) => Ref.set(over, isOver)),
        Effect.flatMap((isOver) => (isOver ? Effect.fail(fail(`the repository is over ${options.maxMegabytes} MB`)) : Effect.void)),
      )
      const watch = check.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(1))), Effect.andThen(Effect.never))
      // once the race is settled, git has stopped: only then is what it wrote removed
      return yield* Effect.raceFirst(effect, watch).pipe(
        Effect.tap(() => check),
        Effect.tapError(() => undo.pipe(Effect.when(Ref.get(over)))),
      )
    })

  /** a download that takes longer than `timeout` is given up */
  const timed = <A>(effect: Effect.Effect<A, CheckoutError>, what: string) =>
    Effect.timeoutOrElse(effect, {
      duration: Duration.seconds(options.timeout),
      orElse: () => Effect.fail(fail(`${what} took longer than ${options.timeout}s`)),
    })

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

  // one git operation per repository at a time: two fetches into the same repo trip over its locks.
  // a repository's lock is kept while something holds or waits for it
  const locks = yield* RcMap.make({ lookup: (_repo: string) => Semaphore.make(1) })
  const locked =
    (repo: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      RcMap.get(locks, repo).pipe(
        Effect.flatMap((lock) => Semaphore.withPermit(lock)(effect)),
        Effect.scoped,
      )

  /** most recently used: the last to be pruned */
  const touch = (path: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => fs.utimes(path, new Date(now), new Date(now))),
      Effect.ignore,
    )

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
        // nothing of glance's environment beyond what git needs: no database url, no secrets
        ChildProcess.make("git", [...args], {
          env: childEnv({ ...env, ...more.env }),
          ...(more.stdin === undefined ? {} : { stdin: Stream.encodeText(Stream.make(more.stdin)) }),
        }),
        what,
      )

    yield* locked(repo)(
      Effect.gen(function* () {
        // most recently used: the last to go when the disk budget is over
        yield* touch(repo)
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
      }).pipe((fetching) =>
        // too big: what came down is dropped with the repository, so it doesn't hold the disk
        capped(fetching, [repo], fs.remove(repo, { recursive: true }).pipe(Effect.ignore)),
      ),
    )

    // a separate index per checkout, so checkouts of the same repo don't share any state
    yield* fs.makeDirectory(into, { recursive: true }).pipe(Effect.mapError((e) => fail(e.message)))
    yield* git(["--git-dir", repo, "--work-tree", into, "-c", "core.symlinks=false", "checkout", "-q", "-f", key.sha, "--", "."], "git checkout", {
      env: { GIT_INDEX_FILE: `${into}.index` },
    }).pipe((checkingOut) => capped(checkingOut, [into]), Effect.ensuring(fs.remove(`${into}.index`).pipe(Effect.ignore)))
  })

  const viaTarball = Effect.fn("Checkout.viaTarball")(function* (key: Key, into: string) {
    // the stream's failure (a dropped download, a repo over the limit) can't travel through tar's
    // stdin: it ends the input early and is reported once tar is done
    const failure = yield* Ref.make(Option.none<CheckoutError>())
    const bytes = yield* Ref.make(0)
    const input = github.tarball(key.pr, key.sha).pipe(
      Stream.mapError((e) => fail(`couldn't download the code: ${e.message}`)),
      Stream.tap((chunk) =>
        Ref.updateAndGet(bytes, (n) => n + chunk.length).pipe(
          Effect.flatMap((n) => (n > limit ? Effect.fail(fail(`the repository is over ${options.maxMegabytes} MB`)) : Effect.void)),
        ),
      ),
      Stream.catchTag("CheckoutError", (e) => Stream.fromEffect(Ref.set(failure, Option.some(e))).pipe(Stream.drain)),
    )
    yield* fs.makeDirectory(into, { recursive: true }).pipe(Effect.mapError((e) => fail(e.message)))
    const extracted = yield* run(
      ChildProcess.make("tar", ["-xzf", "-", "-C", into, "--strip-components=1"], { env: childEnv(), stdin: input }),
      "extracting the code",
    ).pipe(Effect.exit)
    const failed = yield* Ref.get(failure)
    if (Option.isSome(failed)) return yield* failed.value
    if (Exit.isFailure(extracted)) return yield* extracted
    // a symlink in the repository could point the agent at files outside it
    yield* run(ChildProcess.make("find", [into, "-type", "l", "-delete"], { env: childEnv() }), "removing symlinks")
    yield* Effect.annotateCurrentSpan({ bytes: yield* Ref.get(bytes) })
  })

  // the least recently used commits past `keep` go; then, while everything together is over the
  // disk budget, the least recently used commits and (once no commit is left of it) repositories
  const prune = Effect.gen(function* () {
    const dirs: Array<{ path: string; at: number }> = []
    const list = (dir: string) => fs.readDirectory(dir).pipe(Effect.orElseSucceed((): Array<string> => []))
    const at = (path: string) => fs.stat(path).pipe(Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()))
    for (const owner of yield* list(trees))
      for (const repo of yield* list(`${trees}/${owner}`))
        for (const sha of yield* list(`${trees}/${owner}/${repo}`)) {
          const path = `${trees}/${owner}/${repo}/${sha}`
          // a checkout still being written
          if (sha.includes(".part-")) continue
          dirs.push({ path, at: yield* at(path) })
        }
    dirs.sort((a, b) => b.at - a.at)
    const stale = dirs.splice(options.keep)
    yield* Effect.forEach(stale, (d) => fs.remove(d.path, { recursive: true }), { concurrency: 4, discard: true })

    const budget = options.diskBudgetMegabytes * 1024
    let used = yield* kilobytes([options.dir])
    if (used <= budget) return
    const repos: Array<{ path: string; at: number }> = []
    for (const owner of yield* list(`${options.dir}/git`))
      for (const repo of yield* list(`${options.dir}/git/${owner}`)) {
        const path = `${options.dir}/git/${owner}/${repo}`
        repos.push({ path, at: yield* at(path) })
      }
    repos.sort((a, b) => b.at - a.at)
    // oldest first: commits before repositories, since a commit is quicker to fetch again
    for (const victim of [...dirs.reverse(), ...repos.reverse()]) {
      if (used <= budget) break
      const size = yield* kilobytes([victim.path])
      const remove = fs.remove(victim.path, { recursive: true })
      // a repository is removed between fetches, never under one
      yield* victim.path.endsWith(".git") ? locked(victim.path)(remove) : remove
      used -= size
      yield* Effect.logInfo(`the checkouts are over GLANCE_DISK_BUDGET_MB: removed ${victim.path}`)
    }
    if (used > budget) yield* Effect.logWarning(`the checkouts use ${Math.round(used / 1024)} MB, over GLANCE_DISK_BUDGET_MB, with nothing left to remove`)
  }).pipe(Effect.catch((error) => Effect.logWarning("couldn't prune checkouts", error)))

  // Coalesce prune requests into one pending pass. The worker stops before its filesystem and
  // process services close, and concurrent downloads never launch competing pruning passes.
  const pruneRequests = yield* Queue.sliding<void>(1)
  yield* Effect.addFinalizer(() => Queue.shutdown(pruneRequests))
  yield* Stream.fromQueue(pruneRequests).pipe(
    Stream.runForEach(() => prune),
    Effect.forkScoped,
  )

  const fetch = (key: Key): Effect.Effect<string, CheckoutError> =>
    Effect.gen(function* () {
      const dir = target(key)
      if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) {
        yield* touch(dir)
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
      const tmp = yield* attempt((k, into) => timed(viaGit(k, into), "git")).pipe(
        Effect.catch((e) =>
          Effect.logWarning(`git checkout failed, downloading the tarball: ${e.message}`).pipe(
            Effect.andThen(attempt((k, into) => timed(viaTarball(k, into), "downloading the tarball"))),
          ),
        ),
      )
      yield* fs.rename(tmp, dir).pipe(
        Effect.mapError((error) => fail(`couldn't publish the checkout: ${error.message}`)),
        Effect.onExit(() => fs.remove(tmp, { recursive: true }).pipe(Effect.ignore)),
      )
      yield* Queue.offer(pruneRequests, undefined)
      return dir
    }).pipe(Effect.withSpan("Checkout.fetch", { attributes: { repo: `${key.pr.owner}/${key.pr.repo}`, sha: key.sha } }))

  // reviews of the same commit at the same moment share one download: keys compare by value, and
  // the pull request's number isn't in them (two pull requests can share a commit). Completed lookups
  // expire immediately: the filesystem is authoritative, since pruning can remove a checkout at any time
  const inFlight = yield* Cache.makeWith(
    ({ owner, repo, sha }: { readonly owner: string; readonly repo: string; readonly sha: string }) => fetch({ pr: { owner, repo, number: 0 }, sha }),
    { capacity: 64, timeToLive: () => Duration.zero },
  )

  const at = (pr: PrRef, sha: string) => Cache.get(inFlight, { owner: pr.owner, repo: pr.repo, sha })

  return Service.of({ at })
})

export const layer = (options: Options) => Layer.effect(Service, make(options))

export * as Checkout from "./checkout.ts"
