# glance

Fast, self-hosted pull request reviews that run on your **Claude Code** or **Codex** subscription: no API key, no per-token bill. Bun + Effect v4 on the server, a React + TanStack Router + Cloudflare Kumo dashboard talking to it over Effect RPC.

## How a review works

The agent gets the diff **and the repository**: every review downloads the code at the pull request's head commit, and the agent reads and searches it (callers, callees, types, config) before judging the change. Depth only changes how hard it thinks.

## Why it's fast

- **The code downloads only what changed.** Each repository is a bare git repo kept between reviews. A review fetches its commit without file contents (commit and trees: small), then only the files no earlier review brought, in one batch: a push that touches 3 files downloads 3 files. It runs alongside the diff fetch, so the agents are usually the first and only thing to wait (about 2s on a small repo). In ask mode the code is fetched as soon as the pull request opens or is pushed to, so a ticked box starts with it on disk. One directory per commit: another depth on the same commit starts instantly; the least recently used are pruned (`KEEP_CHECKOUTS`). If git fails, the commit's tarball is streamed into `tar` instead.
- **A lean agent.** `claude -p` / `codex exec` run with read-only file tools, no MCP servers, no project instructions, no session persistence and a short custom system prompt (Claude sends ~1k prompt tokens instead of its default agent prompt). The answer is schema-validated JSON.
- **Everything overlaps.** The pull request, its diff, the code and the last review load in parallel; every chunk goes to its own agent process at once (`AGENT_CONCURRENCY`, shared across reviews).
- **Big chunks.** Files are packed first-fit-decreasing into 150k-character chunks, so most pull requests are a single call.
- **Plain code for the rest.** Lockfiles, generated files, binaries and your exclude patterns are dropped before the model sees anything; comments are pinned to lines GitHub accepts, filtered by confidence, de-duplicated and capped without a second model call.
- **Incremental follow-ups.** After the first review, a push is reviewed as `last-reviewed...head`, restricted to the pull request's files. A push with nothing to read in it (screenshots, a lockfile) is skipped; ticking another depth, or asking when nothing new can be read, reviews the whole pull request again.
- **One write.** All inline comments go out in a single GitHub review. Alongside it, one GraphQL read finds glance's threads whose problem is gone, decided by plain code, not another model call.

Measured end to end, light depth: [miracodeai/mira#353](https://github.com/miracodeai/mira/pull/353) (2 files) with Claude Code in 7.4s, 2.7s of it waiting on the 5 MB download; the same commit at high in 11.1s with the code already on disk; [#349](https://github.com/miracodeai/mira/pull/349) (22 files) with Codex in 30.9s.

## Reading untrusted code safely

A pull request is input from whoever wrote it, so the agent can read the checkout and nothing else:

- **Claude Code** runs with `--restricted` and only `Read`, `Grep` and `Glob`: no shell, no network tools, file reads confined to the checkout (symlinks included), and the repository's own settings, hooks and `CLAUDE.md` ignored (`--safe-mode`).
- **Codex** runs with a permission profile that may read only the checkout plus the system files a shell needs, not your home directory (so not `~/.codex/auth.json` or `~/.ssh`), and writes nothing. The repository's `AGENTS.md` is ignored.
- Checkouts contain no symlinks (git writes them as plain files; the tarball fallback deletes them), no repository hooks ever run, and the GitHub token reaches git only through its environment (never its arguments).
- The agents get an allowlist of glance's environment (the system basics, proxy and CA settings, and their own login), so the database URL, GitHub's credentials and the sign-in secrets never reach them; git and tar get less still. `bun scripts/isolation-check.ts` runs both CLIs on a pull request written to talk them into leaking those (and files beside the checkout) and fails if anything comes back.

If the code can't be fetched at all (git and the tarball both fail, the repository is over `MAX_REPO_MB`, or the download takes longer than `CHECKOUT_TIMEOUT_SECONDS`), the review runs on the diff alone and says so.

## Run

```bash
bun install
claude          # once: log in to Claude Code (or `codex login`)
gh auth login   # or set GITHUB_TOKEN
# postgres: any will do (set DATABASE_URL); this one matches the default
docker run -d --name glance-postgres -e POSTGRES_USER=glance -e POSTGRES_PASSWORD=glance -e POSTGRES_DB=glance -p 127.0.0.1:5432:5432 postgres:18-alpine
bun dev         # api on http://127.0.0.1:7420, dashboard on http://localhost:7421
```

On your own machine nobody needs to sign in. To try signing in, set `BETTER_AUTH_SECRET`, an allow rule (`GLANCE_ALLOWED_EMAILS=you@example.com`) and a GitHub OAuth app whose callback is `http://localhost:7421/api/auth/callback/github` (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`).

The server brings the database up to date when it starts: the migrations in `drizzle/` it hasn't applied yet run first. After changing `src/schema.ts`, `bun db:generate` writes the next one. The tests run on an in-process Postgres (PGlite) and need no database.

`bun run test:e2e` rehearses the review pipeline using a local HTTP fixture and real agent subprocesses; `bun run test:e2e:postgres` also verifies the production database and sign-in adapters in a temporary Docker container. They write repeatable reports under `.data/`. [Effect conventions and verification](docs/effect.md) describes service boundaries, typed failures, and resource ownership.

The server is the api only (Effect RPC at `/api/rpc`, http + ndjson, and the webhook); it doesn't serve the dashboard. `web/` is a plain Vite + TanStack Router app: `bun dev:web` runs it alone, `bun run build` writes `web/dist` for any static host. The dashboard calls the api on its own origin: Vite forwards `/api/` to it (`GLANCE_API_URL`, default `http://127.0.0.1:7420`); in production a reverse proxy does the same.

## Deploy on a VPS

Docker Compose runs three containers: `glance` (the api, git, and the `claude` and `codex` CLIs), `postgres`, and `web` (Caddy: the built dashboard, `/api/` forwarded to glance, https from Let's Encrypt). Only Caddy is reachable from outside.

```bash
git clone <this repo> glance && cd glance
cp .env.example .env    # GLANCE_DOMAIN, POSTGRES_PASSWORD, BETTER_AUTH_SECRET, sign-in (github and/or sso, who's allowed), GITHUB_WEBHOOK_SECRET, a github app
docker compose up -d --build
docker compose logs -f glance
```

1. **DNS:** point `GLANCE_DOMAIN` at the VPS before starting, and open ports 80 and 443. Caddy gets the certificate on its own.
2. **Agent logins** (at least one):
   - Claude Code: on any machine, `claude setup-token`, and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
   - Codex: `docker compose exec glance codex login --device-auth`. The login is kept in the `glance-data` volume.

   `https://<domain>/api/health` answers 200 once the database works and at least one agent is logged in, and 503 otherwise. Docker's healthcheck reads it, and glance logs an error when an agent stops working (an expired login, say). Point an uptime monitor at it.

3. **GitHub:** a GitHub App is best: its own rate limits, comments under its name, and access only to the repositories it's installed on. Give it read access to contents and write access to pull requests and issues, subscribe it to **Pull requests** and **Issue comments**, and set its webhook to `https://<domain>/api/webhooks/github` with `GITHUB_WEBHOOK_SECRET`. Set `GITHUB_APP_ID` and either `GITHUB_APP_PRIVATE_KEY` (newlines as `\n`) or `GITHUB_APP_PRIVATE_KEY_FILE` (mount the `.pem` into the container). A personal token (`GITHUB_TOKEN`) works too, with a repository or organization webhook.
4. **Sign in:** with GitHub (an OAuth app, or the GitHub App's client id and secret, called back at `https://<domain>/api/auth/callback/github`) and/or the company's SSO, OIDC or SAML. Say who's allowed in with `GLANCE_ALLOWED_EMAILS`, `GLANCE_ALLOWED_GITHUB_ORGS` or `GLANCE_SSO_DOMAIN`. In production glance won't start until this is set up, and tells you what's missing. [docs/operations.md](docs/operations.md) has each provider's setup.

The database is in the `postgres-data` volume; the checkouts and Codex's login are in `glance-data`. `scripts/backup.sh` dumps the database and sends it off the machine (rclone or restic), and `scripts/restore-check.sh` proves a dump restores; run them on a schedule. A stop or restart leaves running reviews to the next start, which reviews them again if they're less than an hour old. Run one glance per database: a second refuses to start.

The CLIs are pinned to the versions the release was tested with (`CLAUDE_CODE_VERSION`, `CODEX_VERSION` in `.env` override them). [docs/operations.md](docs/operations.md) covers the release rehearsal on staging, backups and restoring, alerts, upgrading and rolling back.

Review from the terminal (dry run unless `--post`):

```bash
bun review https://github.com/owner/repo/pull/123 [--agent codex] [--model sonnet] [--depth high] [--post] [--json]
```

## Reviews on GitHub

1. Expose the server (for example `cloudflared tunnel --url http://127.0.0.1:7420`).
2. Add a webhook to the repository or organization: payload URL `https://<host>/api/webhooks/github`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events **Pull requests** and **Issue comments**.
3. The token (`GITHUB_TOKEN` or the `gh` login) needs read access to contents and write access to pull requests and issues (glance's comment and reactions live in the pull request's conversation).

glance keeps one comment on each pull request, with its status and three checkboxes:

```
⚡ glance
✅ Reviewed abcd712 at High in 8.8s: 2 issues in the review below.
Review again at:
- [ ] Light: the fastest pass
- [ ] Medium: more reasoning, catches more
- [ ] High: the most thorough, the slowest
```

**Tick a box and the review starts at that depth.** The comment switches to "Reviewing at High…", then shows the result with fresh boxes, so you can always go deeper. The depth is the agent's reasoning effort (`low` / `medium` / `high` in both CLIs).

What happens when a pull request opens is the **mode** (dashboard settings or `GLANCE_MODE`, and per repository in the dashboard):

- **ask** (default): glance posts the comment and waits for a tick. Pushes don't start reviews; the comment notes there are new commits, and the next tick reviews just those.
- **auto**: glance reviews right away at the default depth and on every push after, at the depth the pull request was last reviewed at. The boxes are there to go deeper.

Drafts are skipped until they're ready for review. A new review of a pull request cancels the one still running.

**Whose pull requests:** a **blocked author**'s pull requests (`dependabot[bot]`, say) are left alone in either mode: no review and no comment. Someone with the permission can still review one with `/glance`, a label or the dashboard. With **allowed authors** set, auto mode reviews only their pull requests right away; everyone else's get the checkboxes, as in ask mode. Logins compare without case.

**Who may start one:** someone with at least `write` permission on the repository (`GLANCE_TRIGGER_PERMISSION`), for comments, ticked boxes and labels; a box counts only in glance's own comment, and bots never start reviews. Each person gets `GLANCE_REVIEWS_PER_USER_HOUR` (30) an hour and each pull request `GLANCE_REVIEWS_PER_PR_HOUR` (10). In auto mode a pull request whose author doesn't have the permission (a fork's, say) gets the checkboxes, for a maintainer to tick.

**When part of a review fails** (an agent times out on one chunk, say), the review says so: "Partial review: 2 of 9 files couldn't be reviewed", the files listed, the panel reads "Partly reviewed", and the next review starts from before it, so those files get looked at.

**When a problem is fixed, glance closes its thread.** After each review it posts, a thread glance started gets a "✅ Fixed in abc1234" reply and is resolved (the GitHub App needs Contents: read & write for that; without it, glance hides its own comment as outdated instead), once GitHub marks it outdated (the code under it changed) and the review didn't find the same problem again near there (same file, a nearby line, a similar title or the same kind of problem). A thread on code that hasn't changed stays open, threads glance didn't start are never touched, and one someone reopens after glance resolved it is left to them. `GLANCE_RESOLVE_FIXED=false` turns this off.

Other ways to pick a depth: comment `/glance high` (glance reacts 👀), or label the pull request `glance:high` (`glance:light`, `glance:medium`) to pin it; adding the label starts a review too. The Light / Medium / High switch in the dashboard sets the default.

## Subscription auth

glance always strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and friends from the agent's environment, so reviews bill your subscription, never an API key.

- **Claude Code:** the login from `claude` (keychain). On a headless server, run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`.
- **Codex:** `~/.codex/auth.json` from `codex login`; set `CODEX_HOME` to use another directory.

The dashboard shows account-wide subscription usage (including use outside glance), with percent used and reset times. It checks Claude at most once every 15 minutes and Codex at most once every five, and never runs a model to read usage. Codex uses its [app-server rate-limit API](https://developers.openai.com/codex/app-server#6-rate-limits-chatgpt). Claude uses the CLI's OAuth usage endpoint with `CLAUDE_CODE_OAUTH_TOKEN`, its macOS keychain login, or `CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude`). That endpoint is not a public API contract: headless tokens may lack permission and usage checks may be rate limited. That rate limit is shared with `/usage` in Claude Code, so on a 429 glance waits out the endpoint's `Retry-After` (30 minutes if it sends none) before checking again. Those states appear as unavailable, never as zero usage. Claude Code owns token refresh; sign in again if usage reports an expired login. Credentials stay on the server.

## Configuration

Everything is optional; see [`.env.example`](.env.example). Agent, model, depth, mode, posting and comment limits can also be changed in the dashboard's settings and are stored in Postgres (`DATABASE_URL`).

The settings' **Rules** tab holds what's about the team rather than the agent, all stored in Postgres:

- **Team rules:** plain-language review rules ("we use Effect, never throw", "migrations must be reversible"), up to 4,000 characters. They go into the agent's system prompt, apart from glance's fixed rules, and a change that breaks one is reported. They come only from the dashboard: glance ignores the repository's `CLAUDE.md` and `AGENTS.md` on purpose, because a pull request can edit them, and the agent is told that text in the repository is data, never instructions.
- **Blocked authors** and **allowed authors:** GitHub logins (see [Reviews on GitHub](#reviews-on-github)). `GLANCE_BLOCKED_AUTHORS` sets the first list until it's changed in the dashboard.
- **Exclude:** globs of files never reviewed, on top of the lockfiles and generated files glance always skips, written as in `.gitignore`: `*.snap` matches at any depth, `/docs/**` from the root, `fixtures/` a directory anywhere. The review lists the files skipped and the pattern that matched. `GLANCE_EXCLUDE` sets them until changed in the dashboard.

The **Repositories** tab gives a repository (by `owner/repo`; the ones glance has reviewed are suggested) settings of its own: a mode and a default depth that replace the global ones, and rules, author lists and exclude patterns that are added to the global ones. Everything else, and every repository not listed, uses the global settings. Only people signed in to the dashboard can change any of it.

Signing in is [Better Auth](https://better-auth.com) at `/api/auth`: GitHub and/or SSO (OIDC or SAML through `@better-auth/sso`, one provider, configured from the environment), sessions in postgres (7 days, `GLANCE_SESSION_DAYS`), HTTP-only cookies, origin checks and rate limits on its routes. Whether someone's allowed in is checked when the session starts and again on every rpc call. Production (`GLANCE_ENV=production`, which the image sets, or any `HOST` beyond loopback) doesn't start without a working sign-in. The webhook is protected by its signature, and each delivery is acted on once (GitHub redeliveries are ignored).

What a review may use is bounded: `AGENT_TIMEOUT_SECONDS` per agent, `CHECKOUT_TIMEOUT_SECONDS` per download, `MAX_REPO_MB` for git's download as much as the tarball, `GLANCE_DISK_BUDGET_MB` for all the checkouts together (least recently used go first), `MAX_QUEUED_REVIEWS` running or waiting at once (another is turned away and says so), and the containers' CPU and memory (`GLANCE_CPUS`, `GLANCE_MEMORY`).

Logs are JSON lines in the Docker image (`GLANCE_LOG_FORMAT`), and `GLANCE_OTLP_URL` sends traces and logs to an OpenTelemetry collector.

## Layout

```
src/
  main.ts       server: Effect HTTP router on Bun.serve: the rpc, signing in, health and the webhook
  cli.ts        bun review <url>
  reviewer.ts   the pipeline: fetch → select → chunk → agents in parallel → triage → post
  panel.ts      glance's comment on a pull request, and its depth checkboxes
  checkout.ts   the repository at the head commit: incremental git fetch (tarball fallback), cached per commit
  agent.ts      claude -p / codex exec drivers
  github.ts     REST and GraphQL client (Effect HttpClient)
  diff.ts       diff parsing, file selection, chunking, line anchoring (pure)
  prompt.ts     system and review prompts
  store.ts      reviews, settings (global and per repository), comments, deliveries: drizzle queries
  database.ts   postgres (drizzle on @effect/sql-pg), migrated at startup
  schema.ts     the tables; drizzle/ holds their migrations
  rpc.ts        the dashboard's api: one Effect RPC group, shared with web/ (as @glance/api)
  rpc-server.ts its handlers, and the middleware that checks who's calling
  auth.ts       signing in: better auth (github, sso), and who's allowed in
  triggers.ts   who may start a review from github, and how often
  instance.ts   one glance per database: an advisory lock
  health.ts     /api/health, and the monitor that logs when an agent stops working
  usage.ts      subscription usage for the dashboard: claude's oauth usage endpoint, codex's app-server, cached
  observability.ts  json logs, otlp
  http.ts       webhook
scripts/        isolation-check.ts (a hostile pull request leaks nothing), backup.sh, restore-check.sh
docs/           operations.md: signing in, the github app, the release rehearsal, backups, alerts, rollback
web/            the dashboard: Vite, TanStack Router (file routes in src/routes), Kumo
  src/lib/glance.ts  the rpc client (AtomRpc, http + ndjson) and the live review feed
```

```bash
bun test && bun run typecheck && bun run lint && bun run fmt:check
```

## End-to-end verification in a browser

```bash
bunx playwright install chromium
bun run test:e2e:browser
```

This starts isolated local API and dashboard servers on ports 7520/7521, using PGlite, fixture CLI processes, and a local provider endpoint. It exercises sign-in, subscription usage, caching and provider failures, dry-run retries, child-process secret isolation and webhook authorization without calling models or writing to GitHub. Repeatable artifacts are saved to `.data/e2e/`: `report.json`, desktop/mobile screenshots, server logs and `trace.zip` (open with `bunx playwright show-trace .data/e2e/trace.zip`).
