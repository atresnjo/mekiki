# Effect conventions

Mekiki uses the aligned Effect **4.0.5** packages pinned in `package.json`. Research against
the local Effect checkout (`../effect`, currently 4.0.3), then check the installed package
source for the exact API. In this release the error constructor is `Schema.TaggedError`
and the public HTTP, SQL, RPC and reactivity modules have their own package subpaths.
Do not copy APIs from a different Effect release just because a guide uses them.

## Services and boundaries

- Services use `Context.Service`, `Service.of` and `Layer.effect`. Reusable operations use
  named `Effect.fn` functions. Assemble dependencies in `app.ts` and the entrypoints;
  use `provideMerge` only when downstream consumers need the dependency too.
- Operational failures belong in the error channel. Store queries and persisted review
  decoding fail with `StoreError`, including the operation and original cause. The review
  pipeline handles agent/GitHub failures; a storage failure propagates instead of trying
  another database write to describe the outage. Background reviews log storage failures.
- RPC translates `StoreError` to the public `Failed` schema, logs the cause, and preserves
  `Invalid`, `NotFound` and `Unauthorized`. The webhook returns 500 and releases only a
  delivery it successfully claimed. Defect recovery is reserved for transport boundaries.
- Decode external JSON and persisted data with Schema. Do not assert an unknown response
  into a TypeScript interface or use a cast to bypass a library's generic types.

## Resource ownership and concurrency

- A layer owns its background work. Reviewer fibers live in `FiberMap`; webhook prefetches
  live in `FiberSet`; checkout pruning has one scoped worker with a sliding queue holding
  at most one pending pass. Scope closure interrupts work before releasing its services.
- Admission and replacement are serialized with a semaphore; actual agent concurrency
  has a separate semaphore. Agent and checkout subprocesses have scoped lifetimes.
  Per-repository git locks live in an `RcMap`, released once nothing holds or waits for them.
- The instance lock uses a reserved Effect PostgreSQL connection for the layer's lifetime.
  Its separate pool closes on shutdown, releasing the session advisory lock.
- Permission, authentication and installation lookups use bounded Effect caches. Failed
  authentication lookups are not cached; after an authorization answer expires, an
  unavailable membership service refuses access instead of extending a stale grant.
- Cache keys are plain objects (`{ owner, repo, sha }`): Effect compares them structurally,
  so there is no string encoding to split back apart.
- Checkout caching deduplicates in-flight downloads only. Completed lookups expire
  immediately so each later access checks the filesystem after pruning.
- Review timestamps and durations, GitHub App tokens and checkout recency use Effect's `Clock`
  so they follow the injected clock. State shared across effects lives in `Ref` or `Deferred`,
  not closure variables.
- The CLI (`src/cli.ts`) is an `effect/cli` command: flags are validated, and a failed review
  fails the program, so `runMain` exits 1 after the layers' finalizers have run.

Better Auth remains a Promise adapter: it requires an asynchronous Drizzle database and
owns OAuth/session callbacks. Its small Bun SQL pool is acquired and closed by a layer;
callbacks enter a scoped `FiberSet` runtime. The authorization workflow and GitHub
membership requests use Effect, with status handling, schema decoding and timeouts.
Browser-facing Better Auth calls remain at the browser framework boundary.

The AI SDK (the `api` agent) is a Promise library too. One `generateText` call is one
`Effect.tryPromise` whose `AbortSignal` the fiber owns: an interrupted or timed-out review
aborts the request. Its failures map to the same `AgentError` as the CLIs'. Its tools call
back into Effect with `Effect.runPromiseWith` on the review's captured context, so their spans
nest under `Agent.api` and the tool's own abort signal stops a search mid-walk.

## Verification

```sh
bun run typecheck
bun run lint
bun run fmt:check
bun test
bun run build
bun run test:e2e:postgres # requires Docker and postgres:18-alpine
```

`bun run test:e2e` runs the application pipeline with real HTTP requests to a local GitHub
fixture, actual fixture agent subprocesses, tarball checkout, the real store/migrations on
PGlite, and RPC handlers. It checks complete and partial reviews, process cancellation,
typed storage failures, sanitized RPC responses and invalid GitHub App key handling.
The report is `.data/effect-e2e.json`.

`bun run test:e2e:postgres` creates and removes an isolated PostgreSQL container. It verifies
production migrations, review persistence, delivery deduplication, competing instance
locks and lock release, plus session authorization and sign-out through Better Auth's
actual Bun SQL pool. The report is `.data/effect-postgres-e2e.json`.

These rehearsals do not call GitHub or real agent subscriptions. They do not verify live
OAuth/SSO provider configuration or production deployment.
