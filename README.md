# glance

Fast, self-hosted pull request reviews that run on your **Claude Code** or **Codex** subscription: no API key, no per-token bill. Bun + Effect v4 on the server, a React + TanStack Router + Cloudflare Kumo dashboard talking to it over Effect RPC.

## How a review works

The agent gets the diff **and the repository**: every review downloads the code at the pull request's head commit, and the agent reads and searches it (callers, callees, types, config) before judging the change. Depth only changes how hard it thinks.

## Why it's fast

- **The code downloads only what changed.** Each repository is a bare git repo kept between reviews. A review fetches its commit without file contents (commit and trees: small), then only the files no earlier review brought, in one batch: a push that touches 3 files downloads 3 files. It runs alongside the diff fetch, so the agents are usually the first and only thing to wait (about 2s on a small repo). In ask mode the code is fetched as soon as the pull request opens or is pushed to, so a ticked box starts with it on disk. One directory per commit: another depth on the same commit starts instantly; the least recently used are pruned (`KEEP_CHECKOUTS`). If git fails, the commit's tarball is streamed into `tar` instead.
- **A lean agent.** `claude -p` / `codex exec` run with read-only file tools, no MCP servers, no project instructions, no session persistence and a short custom system prompt (Claude sends ~1k prompt tokens instead of its default agent prompt). The answer is schema-validated JSON.
- **Everything overlaps.** The pull request, its diff, the code and the last review load in parallel; every chunk goes to its own agent process at once (`AGENT_CONCURRENCY`, shared across reviews).
- **Big chunks.** Files are packed first-fit-decreasing into 150k-character chunks, so most pull requests are a single call.
- **Plain code for the rest.** Lockfiles, generated files and binaries are dropped before the model sees anything; comments are pinned to lines GitHub accepts, filtered by confidence, de-duplicated and capped without a second model call.
- **Incremental follow-ups.** After the first review, a push is reviewed as `last-reviewed...head`, restricted to the pull request's files.
- **One write.** All inline comments go out in a single GitHub review.

Measured end to end, light depth: [miracodeai/mira#353](https://github.com/miracodeai/mira/pull/353) (2 files) with Claude Code in 7.4s, 2.7s of it waiting on the 5 MB download; the same commit at high in 11.1s with the code already on disk; [#349](https://github.com/miracodeai/mira/pull/349) (22 files) with Codex in 30.9s.

## Reading untrusted code safely

A pull request is input from whoever wrote it, so the agent can read the checkout and nothing else:

- **Claude Code** runs with `--restricted` and only `Read`, `Grep` and `Glob`: no shell, no network tools, file reads confined to the checkout (symlinks included), and the repository's own settings, hooks and `CLAUDE.md` ignored (`--safe-mode`).
- **Codex** runs with a permission profile that may read only the checkout plus the system files a shell needs, not your home directory (so not `~/.codex/auth.json` or `~/.ssh`), and writes nothing. The repository's `AGENTS.md` is ignored.
- Checkouts contain no symlinks (git writes them as plain files; the tarball fallback deletes them), no repository hooks ever run, the GitHub token reaches git only through its environment (never its arguments), and API keys are stripped from the agents' environment.

If the code can't be fetched at all (git and the tarball both fail, or the tarball is over `MAX_REPO_MB`), the review runs on the diff alone and says so.

## Run

```bash
bun install
claude          # once: log in to Claude Code (or `codex login`)
gh auth login   # or set GITHUB_TOKEN
bun dev         # api on http://127.0.0.1:7420, dashboard on http://localhost:7421
```

The server is the api only (Effect RPC at `/api/rpc`, http + ndjson, and the webhook); it doesn't serve the dashboard. `web/` is a plain Vite + TanStack Router app: `bun dev:web` runs it alone, `bun run build` writes `web/dist` for any static host. The dashboard calls the api on its own origin: Vite forwards `/api/` to it (`GLANCE_API_URL`, default `http://127.0.0.1:7420`); in production a reverse proxy does the same.

## Deploy on a VPS

Docker Compose runs two containers: `glance` (the api, git, and the `claude` and `codex` CLIs) and `web` (Caddy: the built dashboard, `/api/` forwarded to glance, https from Let's Encrypt). Only Caddy is reachable from outside.

```bash
git clone <this repo> glance && cd glance
cp .env.example .env    # set GLANCE_DOMAIN, GLANCE_TOKEN, GITHUB_WEBHOOK_SECRET, and a GitHub app or token
docker compose up -d --build
docker compose logs -f glance
```

1. **DNS:** point `GLANCE_DOMAIN` at the VPS before starting, and open ports 80 and 443. Caddy gets the certificate on its own.
2. **Agent logins** (at least one):
   - Claude Code: on any machine, `claude setup-token`, and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
   - Codex: `docker compose exec glance codex login --device-auth`. The login is kept in the `glance-data` volume.

   `https://<domain>/api/health` answers 200 once the database works and at least one agent is logged in, and 503 otherwise. Docker's healthcheck reads it, and glance logs an error when an agent stops working (an expired login, say). Point an uptime monitor at it.

3. **GitHub:** a GitHub App is best: its own rate limits, comments under its name, and access only to the repositories it's installed on. Give it read access to contents and write access to pull requests and issues, subscribe it to **Pull requests** and **Issue comments**, and set its webhook to `https://<domain>/api/webhooks/github` with `GITHUB_WEBHOOK_SECRET`. Set `GITHUB_APP_ID` and either `GITHUB_APP_PRIVATE_KEY` (newlines as `\n`) or `GITHUB_APP_PRIVATE_KEY_FILE` (mount the `.pem` into the container). A personal token (`GITHUB_TOKEN`) works too, with a repository or organization webhook.
4. **Sign in:** open `https://<domain>` and enter `GLANCE_TOKEN`.

Everything glance keeps is in the `glance-data` volume: the database, its daily backups (`/data/backups`, the last 7), the checkouts and Codex's login. The backups sit on the same disk, so copy them off the machine (restic, rclone, a provider snapshot). To update, `git pull && docker compose up -d --build`. A stop or restart leaves running reviews to the next start, which reviews them again if they're less than an hour old.

Pin the CLIs with `--build-arg CLAUDE_CODE_VERSION=… --build-arg CODEX_VERSION=…` (in `docker-compose.yml` under `build.args`); by default each build takes the latest.

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

What happens when a pull request opens is the **mode** (dashboard settings or `GLANCE_MODE`):

- **ask** (default): glance posts the comment and waits for a tick. Pushes don't start reviews; the comment notes there are new commits, and the next tick reviews just those.
- **auto**: glance reviews right away at the default depth and on every push after, at the depth the pull request was last reviewed at. The boxes are there to go deeper.

Drafts are skipped until they're ready for review. A new review of a pull request cancels the one still running.

Other ways to pick a depth: comment `/glance high` (glance reacts 👀), or label the pull request `glance:high` (`glance:light`, `glance:medium`) to pin it; adding the label starts a review too. The Light / Medium / High switch in the dashboard sets the default.

## Subscription auth

glance always strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and friends from the agent's environment, so reviews bill your subscription, never an API key.

- **Claude Code:** the login from `claude` (keychain). On a headless server, run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`.
- **Codex:** `~/.codex/auth.json` from `codex login`; set `CODEX_HOME` to use another directory.

## Configuration

Everything is optional; see [`.env.example`](.env.example). Agent, model, depth, mode, posting and comment limits can also be changed in the dashboard's settings and are stored in SQLite (`GLANCE_DB`).

Set `GLANCE_TOKEN` before exposing glance. The dashboard asks for it once per browser and exchanges it at `POST /api/session` for an HTTP-only session cookie (30 days, `GLANCE_SESSION_DAYS`), which every rpc call then carries. The cookie is an expiry signed with the token, so changing the token signs everyone out. With `GLANCE_TOKEN_FILE` instead, the file is read again every 30 seconds, so the token rotates without a restart. Sign-in attempts are limited to 10 per 15 minutes per client. The webhook is protected by its signature, and each delivery is acted on once (GitHub redeliveries are ignored).

Logs are JSON lines in the Docker image (`GLANCE_LOG_FORMAT`), and `GLANCE_OTLP_URL` sends traces and logs to an OpenTelemetry collector.

## Layout

```
src/
  main.ts       server: Effect HTTP router on Bun.serve: the rpc, sign-in, health and the webhook
  cli.ts        bun review <url>
  reviewer.ts   the pipeline: fetch → select → chunk → agents in parallel → triage → post
  panel.ts      glance's comment on a pull request, and its depth checkboxes
  checkout.ts   the repository at the head commit: incremental git fetch (tarball fallback), cached per commit
  agent.ts      claude -p / codex exec drivers
  github.ts     REST client (Effect HttpClient)
  diff.ts       diff parsing, file selection, chunking, line anchoring (pure)
  prompt.ts     system and review prompts
  store.ts      bun:sqlite
  rpc.ts        the dashboard's api: one Effect RPC group, shared with web/ (as @glance/api)
  rpc-server.ts its handlers, and the session middleware
  session.ts    sign-in: the access token for a signed session cookie, attempts limited
  health.ts     /api/health, and the monitor that logs when an agent stops working
  backup.ts     database snapshots
  observability.ts  json logs, otlp
  http.ts       webhook
web/            the dashboard: Vite, TanStack Router (file routes in src/routes), Kumo
  src/lib/glance.ts  the rpc client (AtomRpc, http + ndjson) and the live review feed
```

```bash
bun test && bun run typecheck && bun run lint && bun run fmt:check
```
