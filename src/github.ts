import { createPrivateKey, createSign } from "node:crypto"
import { Cache, Clock, Context, Duration, Effect, Exit, FileSystem, flow, Layer, Option, Redacted, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { GitHubError, type PrRef } from "./domain.ts"

export const PullRequest = Schema.Struct({
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  draft: Schema.optional(Schema.Boolean),
  state: Schema.String,
  html_url: Schema.String,
  head: Schema.Struct({ sha: Schema.String }),
})
export interface PullRequest extends Schema.Schema.Type<typeof PullRequest> {}

/** what someone may do in a repository, least to most */
export type Permission = "none" | "read" | "triage" | "write" | "maintain" | "admin"
const PERMISSIONS: ReadonlyArray<Permission> = ["none", "read", "triage", "write", "maintain", "admin"]

export interface ReviewComment {
  readonly path: string
  readonly line: number
  readonly body: string
}

/** a review thread on a pull request, as graphql has it */
export interface ReviewThread {
  /** graphql node id: what resolving takes */
  readonly id: string
  readonly resolved: boolean
  /** the code it was left on has changed since */
  readonly outdated: boolean
  readonly path: string
  /** the line it's on, or (outdated) the line it was left on */
  readonly line: number | null
  /** oldest first, the first one started the thread. `ours`: written by whoever glance is on github */
  readonly comments: ReadonlyArray<{ readonly body: string; readonly ours: boolean }>
}

export interface Interface {
  readonly pullRequest: (pr: PrRef) => Effect.Effect<PullRequest, GitHubError>
  /** the whole pull request as a unified diff */
  readonly diff: (pr: PrRef) => Effect.Effect<string, GitHubError>
  /** what changed between two commits, as a unified diff */
  readonly compare: (pr: PrRef, base: string, head: string) => Effect.Effect<string, GitHubError>
  /** one review with every inline comment: a single api call */
  readonly postReview: (
    pr: PrRef,
    review: { readonly commitId: string; readonly body: string; readonly comments: ReadonlyArray<ReviewComment> },
  ) => Effect.Effect<void, GitHubError>
  /** where git fetches the repository from, and the header that lets it */
  readonly gitRemote: (pr: PrRef) => Effect.Effect<{ readonly url: string; readonly authorization: Redacted.Redacted }, GitHubError>
  /** the repository at a commit, as a gzipped tarball, streamed */
  readonly tarball: (pr: PrRef, sha: string) => Stream.Stream<Uint8Array, GitHubError>
  /** a comment in the pull request's conversation: its id */
  readonly createComment: (pr: PrRef, body: string) => Effect.Effect<number, GitHubError>
  readonly updateComment: (pr: PrRef, id: number, body: string) => Effect.Effect<void, GitHubError>
  /** 👀 on a comment: the command was seen */
  readonly acknowledge: (pr: PrRef, commentId: number) => Effect.Effect<void, GitHubError>
  /** someone's permission on the pull request's repository: none when they aren't a collaborator */
  readonly permission: (pr: PrRef, login: string) => Effect.Effect<Permission, GitHubError>
  /** every review thread on the pull request: graphql, a page per hundred */
  readonly reviewThreads: (pr: PrRef) => Effect.Effect<ReadonlyArray<ReviewThread>, GitHubError>
  /** reply in a review thread and resolve it: one graphql call */
  readonly resolveThread: (pr: PrRef, threadId: string, reply: string) => Effect.Effect<void, GitHubError>
}

export class Service extends Context.Service<Service, Interface>()("glance/GitHub") {}

export interface Options {
  readonly apiUrl: string
  /** none (and no app): borrow the gh cli's login */
  readonly token: Option.Option<Redacted.Redacted>
  /** a github app: each repository is reached through the app's installation on it */
  readonly app: {
    readonly id: Option.Option<string>
    readonly privateKey: Option.Option<Redacted.Redacted>
    readonly privateKeyFile: Option.Option<string>
  }
}

const decodePullRequest = Schema.decodeUnknownEffect(PullRequest)
const decodeComment = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))
const decodeInstallation = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))
const decodePermission = Schema.decodeUnknownEffect(Schema.Struct({ permission: Schema.String, role_name: Schema.optional(Schema.String) }))
const decodeAccessToken = Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String, expires_at: Schema.String }))

/** a graphql answer: an error comes back with status 200, in `errors` */
const GraphQL = <A extends Schema.Top>(data: A) =>
  Schema.Struct({ data: Schema.optional(Schema.NullOr(data)), errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))) })

const ThreadPage = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          reviewThreads: Schema.Struct({
            pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
            nodes: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                isResolved: Schema.Boolean,
                isOutdated: Schema.Boolean,
                path: Schema.String,
                line: Schema.NullOr(Schema.Finite),
                originalLine: Schema.NullOr(Schema.Finite),
                comments: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ body: Schema.String, viewerDidAuthor: Schema.Boolean })) }),
              }),
            ),
          }),
        }),
      ),
    }),
  ),
})
const decodeThreadPage = Schema.decodeUnknownEffect(GraphQL(ThreadPage))
const decodeMutation = Schema.decodeUnknownEffect(GraphQL(Schema.Unknown))

// the first fifty comments: the one that started the thread, and whether glance already said it's fixed
const THREADS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 50) { nodes { body viewerDidAuthor } }
        }
      }
    }
  }
}`

// the reply first, so the thread reads "fixed in …", then resolved
const RESOLVE = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
  resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } }
}`

/** a pull request with more threads than this is read only this far */
const MAX_THREAD_PAGES = 10

/** github.com's graphql is api.github.com/graphql; enterprise's is /api/graphql beside /api/v3 */
export const graphqlUrl = (apiUrl: string) =>
  /\/api\/v3\/?$/.test(apiUrl) ? apiUrl.replace(/\/api\/v3\/?$/, "/api/graphql") : `${apiUrl.replace(/\/$/, "")}/graphql`

/** what an app proves it's the app with: a jwt signed with its private key, good for ten minutes */
export const appJwt = (appId: string, privateKey: string, now: number) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const seconds = Math.floor(now / 1000)
  // a minute back: github's clock may be behind ours
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`
}

/** `gh auth token`, for running locally without minting a token */
const ghToken = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const token = yield* spawner.string(ChildProcess.make("gh", ["auth", "token"]))
  return Redacted.make(token.trim())
}).pipe(
  Effect.mapError(() => new GitHubError({ operation: "auth", message: "no GITHUB_TOKEN set and `gh auth token` failed: set one or run `gh auth login`" })),
)

export const make = Effect.fn("GitHub.make")(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem
  const http = yield* HttpClient.HttpClient
  const headers = HttpClientRequest.setHeaders({ "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "glance" })
  const base = http.pipe(HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(options.apiUrl), headers)))
  // reads are idempotent: retry what failed for a moment. writes are never retried
  const reader = base.pipe(HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 2 }))
  // graphql has one url, not under the rest api's on enterprise. its queries are reads, retried the same
  const graph = http.pipe(HttpClient.mapRequest(flow(HttpClientRequest.setUrl(graphqlUrl(options.apiUrl)), headers)))
  const graphReader = graph.pipe(HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 2 }))

  const execute = (client: HttpClient.HttpClient, operation: string, request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.mapError((e) => new GitHubError({ operation, message: e.message })),
      Effect.flatMap((response: HttpClientResponse.HttpClientResponse) =>
        response.status < 400
          ? Effect.succeed(response)
          : response.text.pipe(
              Effect.orElseSucceed(() => ""),
              Effect.flatMap((body) =>
                Effect.fail(new GitHubError({ operation, status: response.status, message: body.slice(0, 1000) || `status ${response.status}` })),
              ),
            ),
      ),
    )

  const json = <A>(operation: string, response: HttpClientResponse.HttpClientResponse, decode: (u: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
    response.json.pipe(
      Effect.flatMap(decode),
      Effect.mapError((e) => new GitHubError({ operation, message: e.message })),
    )

  // ---------- who glance is on github: an app's installation on each repository, else one token ----------

  const appId = options.app.id
  const privateKey = Option.isSome(options.app.privateKey)
    ? Option.some(Redacted.value(options.app.privateKey.value).replaceAll("\\n", "\n"))
    : Option.isSome(options.app.privateKeyFile)
      ? Option.some(
          yield* fs
            .readFileString(options.app.privateKeyFile.value)
            .pipe(Effect.mapError((e) => new GitHubError({ operation: "auth", message: `couldn't read GITHUB_APP_PRIVATE_KEY_FILE: ${e.message}` }))),
        )
      : Option.none<string>()

  const tokenFor: (pr: PrRef) => Effect.Effect<string, GitHubError> = yield* Option.isSome(appId) && Option.isSome(privateKey)
    ? Effect.gen(function* () {
        // Parse operator-supplied key material in the typed channel during layer acquisition.
        yield* Effect.try({
          try: () => createPrivateKey(privateKey.value),
          catch: (cause) =>
            new GitHubError({ operation: "auth", message: `invalid GitHub App private key: ${cause instanceof Error ? cause.message : String(cause)}` }),
        })
        const asApp = (request: HttpClientRequest.HttpClientRequest) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Effect.try({
                try: () => HttpClientRequest.bearerToken(request, appJwt(appId.value, privateKey.value, now)).pipe(HttpClientRequest.acceptJson),
                catch: (cause) =>
                  new GitHubError({ operation: "auth", message: `couldn't sign GitHub App token: ${cause instanceof Error ? cause.message : String(cause)}` }),
              }),
            ),
          )
        // which installation reaches a repository changes rarely: an hour
        const installations = yield* Cache.makeWith(
          (repo: string) =>
            asApp(HttpClientRequest.get(`/repos/${repo}/installation`)).pipe(
              Effect.flatMap((request) => execute(reader, "installation", request)),
              Effect.flatMap((r) => json("installation", r, decodeInstallation)),
              Effect.map((i) => i.id),
            ),
          { capacity: 1024, timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.hours(1) : Duration.zero) },
        )
        // an installation token lasts an hour: kept until five minutes before it runs out
        const tokens = yield* Cache.makeWith(
          Effect.fnUntraced(function* (installation: number) {
            const response = yield* execute(base, "accessToken", yield* asApp(HttpClientRequest.post(`/app/installations/${installation}/access_tokens`)))
            const { token, expires_at } = yield* json("accessToken", response, decodeAccessToken)
            const now = yield* Clock.currentTimeMillis
            return { token, keepFor: Duration.millis(Math.max(0, Date.parse(expires_at) - now - 5 * 60_000)) }
          }),
          { capacity: 1024, timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.keepFor : Duration.zero) },
        )
        return (pr: PrRef) =>
          Cache.get(installations, `${pr.owner}/${pr.repo}`).pipe(
            Effect.flatMap((id) => Cache.get(tokens, id)),
            Effect.map((t) => t.token),
            Effect.mapError((e) =>
              e.status === 404 ? new GitHubError({ operation: "auth", status: 404, message: `the github app isn't installed on ${pr.owner}/${pr.repo}` }) : e,
            ),
          )
      })
    : Effect.map(Option.isSome(options.token) ? Effect.succeed(options.token.value) : ghToken, (token) => () => Effect.succeed(Redacted.value(token)))

  if (Option.isSome(appId) !== Option.isSome(privateKey))
    return yield* new GitHubError({ operation: "auth", message: "a github app needs both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or _FILE)" })

  /** a request on a pull request's repository, with whichever token reaches it */
  const send = (client: HttpClient.HttpClient, operation: string, pr: PrRef, request: HttpClientRequest.HttpClientRequest) =>
    tokenFor(pr).pipe(Effect.flatMap((token) => execute(client, operation, HttpClientRequest.bearerToken(request, token))))

  const text = (operation: string, pr: PrRef, request: HttpClientRequest.HttpClientRequest) =>
    send(reader, operation, pr, request).pipe(Effect.flatMap((r) => r.text.pipe(Effect.mapError((e) => new GitHubError({ operation, message: e.message })))))

  const path = (pr: PrRef) => `/repos/${pr.owner}/${pr.repo}`

  const pullRequest = Effect.fn("GitHub.pullRequest")(function* (pr: PrRef) {
    const response = yield* send(reader, "pullRequest", pr, HttpClientRequest.get(`${path(pr)}/pulls/${pr.number}`).pipe(HttpClientRequest.acceptJson))
    return yield* json("pullRequest", response, decodePullRequest)
  })

  const diff = Effect.fn("GitHub.diff")(function* (pr: PrRef) {
    return yield* text(
      "diff",
      pr,
      HttpClientRequest.get(`${path(pr)}/pulls/${pr.number}`).pipe(HttpClientRequest.setHeader("Accept", "application/vnd.github.diff")),
    )
  })

  const compare = Effect.fn("GitHub.compare")(function* (pr: PrRef, from: string, to: string) {
    return yield* text(
      "compare",
      pr,
      HttpClientRequest.get(`${path(pr)}/compare/${from}...${to}`).pipe(HttpClientRequest.setHeader("Accept", "application/vnd.github.diff")),
    )
  })

  const postReview: Interface["postReview"] = Effect.fn("GitHub.postReview")(function* (pr, review) {
    const request = (comments: ReadonlyArray<ReviewComment>, body: string) =>
      HttpClientRequest.post(`${path(pr)}/pulls/${pr.number}/reviews`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJsonUnsafe({
          commit_id: review.commitId,
          event: "COMMENT",
          body,
          comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
        }),
      )
    yield* send(base, "postReview", pr, request(review.comments, review.body)).pipe(
      // github rejects the whole review when one line moved under us (a push mid-review):
      // say it all in the review body instead of losing it
      Effect.catchIf(
        (e) => e.status === 422 && review.comments.length > 0,
        () =>
          send(
            base,
            "postReview",
            pr,
            request([], `${review.body}\n\n${review.comments.map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`).join("\n\n---\n\n")}`),
          ),
      ),
    )
  })

  const acknowledge = Effect.fn("GitHub.acknowledge")(function* (pr: PrRef, commentId: number) {
    yield* send(
      base,
      "acknowledge",
      pr,
      HttpClientRequest.post(`${path(pr)}/issues/comments/${commentId}/reactions`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJsonUnsafe({ content: "eyes" }),
      ),
    )
  })

  // github answers with a redirect to codeload, which fetch follows
  const tarball = (pr: PrRef, sha: string) =>
    Stream.unwrap(
      send(reader, "tarball", pr, HttpClientRequest.get(`${path(pr)}/tarball/${sha}`)).pipe(
        Effect.map((response) => response.stream.pipe(Stream.mapError((e) => new GitHubError({ operation: "tarball", message: e.message })))),
      ),
    )

  const createComment = Effect.fn("GitHub.createComment")(function* (pr: PrRef, body: string) {
    const response = yield* send(
      base,
      "createComment",
      pr,
      HttpClientRequest.post(`${path(pr)}/issues/${pr.number}/comments`).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyJsonUnsafe({ body })),
    )
    const comment = yield* json("createComment", response, decodeComment)
    return comment.id
  })

  const updateComment = Effect.fn("GitHub.updateComment")(function* (pr: PrRef, id: number, body: string) {
    yield* send(
      base,
      "updateComment",
      pr,
      HttpClientRequest.patch(`${path(pr)}/issues/comments/${id}`).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyJsonUnsafe({ body })),
    )
  })

  const permission = Effect.fn("GitHub.permission")(function* (pr: PrRef, login: string): Effect.fn.Return<Permission, GitHubError> {
    const response = yield* send(
      reader,
      "permission",
      pr,
      HttpClientRequest.get(`${path(pr)}/collaborators/${encodeURIComponent(login)}/permission`).pipe(HttpClientRequest.acceptJson),
    ).pipe(
      Effect.map(Option.some),
      // not a collaborator (or not a user at all)
      Effect.catchIf(
        (e) => e.status === 404,
        () => Effect.succeedNone,
      ),
    )
    if (Option.isNone(response)) return "none"
    const body = yield* json("permission", response.value, decodePermission)
    // role_name tells triage and maintain apart; permission folds them into read and write
    return PERMISSIONS.find((p) => p === body.role_name) ?? PERMISSIONS.find((p) => p === body.permission) ?? "none"
  })

  /** a graphql query or mutation; an answer carrying `errors` is a failure, even one with some data */
  const graphql = <A>(
    client: HttpClient.HttpClient,
    operation: string,
    pr: PrRef,
    query: string,
    variables: Record<string, unknown>,
    decode: (
      u: unknown,
    ) => Effect.Effect<{ readonly data?: A | null | undefined; readonly errors?: ReadonlyArray<{ readonly message: string }> | undefined }, Schema.SchemaError>,
  ) =>
    send(client, operation, pr, HttpClientRequest.post("").pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyJsonUnsafe({ query, variables }))).pipe(
      Effect.flatMap((response) => json(operation, response, decode)),
      Effect.flatMap(({ data, errors }) =>
        errors && errors.length > 0
          ? Effect.fail(
              new GitHubError({
                operation,
                message: errors
                  .map((e) => e.message)
                  .join("; ")
                  .slice(0, 1000),
              }),
            )
          : data === null || data === undefined
            ? Effect.fail(new GitHubError({ operation, message: "graphql answered without data" }))
            : Effect.succeed(data),
      ),
    )

  const reviewThreads = Effect.fn("GitHub.reviewThreads")(function* (pr: PrRef) {
    const threads: Array<ReviewThread> = []
    let after: string | null = null
    for (let page = 0; page < MAX_THREAD_PAGES; page++) {
      const data: typeof ThreadPage.Type = yield* graphql(
        graphReader,
        "reviewThreads",
        pr,
        THREADS,
        { owner: pr.owner, repo: pr.repo, number: pr.number, after },
        decodeThreadPage,
      )
      const connection = data.repository?.pullRequest?.reviewThreads
      if (!connection)
        return yield* new GitHubError({ operation: "reviewThreads", status: 404, message: `no pull request ${pr.owner}/${pr.repo}#${pr.number}` })
      for (const t of connection.nodes)
        threads.push({
          id: t.id,
          resolved: t.isResolved,
          outdated: t.isOutdated,
          path: t.path,
          line: t.line ?? t.originalLine,
          comments: t.comments.nodes.map((c) => ({ body: c.body, ours: c.viewerDidAuthor })),
        })
      if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) break
      after = connection.pageInfo.endCursor
    }
    return threads
  })

  const resolveThread = Effect.fn("GitHub.resolveThread")(function* (pr: PrRef, threadId: string, reply: string) {
    yield* graphql(graph, "resolveThread", pr, RESOLVE, { thread: threadId, body: reply }, decodeMutation)
  })

  // github.com's api lives on api.github.com; enterprise's under /api/v3 of the same host
  const webUrl = options.apiUrl === "https://api.github.com" ? "https://github.com" : options.apiUrl.replace(/\/api\/v3\/?$/, "")
  const gitRemote = (pr: PrRef) =>
    Effect.map(tokenFor(pr), (token) => ({
      url: `${webUrl}/${pr.owner}/${pr.repo}.git`,
      authorization: Redacted.make(`Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`),
    }))

  return Service.of({
    pullRequest,
    diff,
    compare,
    postReview,
    gitRemote,
    tarball,
    createComment,
    updateComment,
    acknowledge,
    permission,
    reviewThreads,
    resolveThread,
  })
})

export const layer = (options: Options) => Layer.effect(Service, make(options)).pipe(Layer.provide(FetchHttpClient.layer))

export * as GitHub from "./github.ts"
