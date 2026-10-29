# glance

Self-hosted pull request reviews. glance runs Claude Code or Codex on your own subscription, or any model through an API key: OpenAI, Anthropic, Google, or a gateway like LiteLLM or OpenRouter.

The server is Bun and Effect v4. The dashboard is React, TanStack Router and Cloudflare Kumo, talking to the server over Effect RPC. Everything is stored in Postgres.

## How it works

A review fetches the pull request, its diff and the repository at the head commit, all at the same time. Lockfiles, generated files, binaries and your exclude patterns are dropped. What's left is split into chunks of up to 150k characters (most pull requests fit in one), and every chunk goes to its own agent. The agent can read and search the checked-out code, so it looks at callers and types instead of guessing from the diff. Depth (light, medium, high) is the model's reasoning effort.

The agent answers in JSON. glance pins each finding to a line GitHub accepts, drops low-confidence ones and repeats, and posts everything as one GitHub review. After the first review, a push only gets what changed since. When a problem glance flagged goes away, it replies "Fixed in abc1234" and resolves the thread.

Each repository stays on disk as a bare git clone between reviews, so a push that touches 3 files downloads 3 files. A two-file pull request takes about 7 seconds at light depth.

## On GitHub

glance keeps one comment on each pull request:

```
⚡ glance
✅ Reviewed abcd712 at High in 8.8s: 2 issues in the review below.
Review again at:
- [ ] Light: the fastest pass
- [ ] Medium: more reasoning, catches more
- [ ] High: the most thorough, the slowest
```

Tick a box to review at that depth. You can also comment `/glance high` or add the label `glance:high`.

The mode decides what happens when a pull request opens. Set it in the dashboard (per repository too) or with `GLANCE_MODE`:

- **ask** (default): post the comment and wait for a tick.
- **auto**: review right away, and again on every push.

Some rules:

- Draft pull requests are skipped.
- A new review cancels the one still running.
- Only people with write access can start a review (`GLANCE_TRIGGER_PERMISSION`), and bots never can.
- Each person gets 30 reviews an hour and each pull request 10.
- Blocked authors (like `dependabot[bot]`) are ignored completely. If you set allowed authors, auto mode only reviews their pull requests on its own; everyone else gets the checkboxes.

If one chunk fails (a timeout, say), the review lists the files it didn't cover and the next review picks them up.

## Safety

A pull request is code from whoever wrote it, so the agent can read the checkout and nothing else.

- **Claude Code** only gets `Read`, `Grep` and `Glob`, with `--restricted` and `--safe-mode`. It has no shell, and the repository's settings, hooks and `CLAUDE.md` are ignored.
- **Codex** runs with a permission profile that reads the checkout and the system files a shell needs. It can't read your home directory or write anything, and the repository's `AGENTS.md` is ignored.
- **The API agent** has no shell, only glance's own `read_file`, `search` (plain text, no regex) and `list_files`. Every path has to stay inside the checkout, and every answer is size-capped.
- Child processes get an allowlisted environment, so the database URL, GitHub token, sign-in secrets and API keys never reach them.

`bun scripts/isolation-check.ts` points every configured agent at a pull request written to make it leak those secrets. It fails if anything comes back.

If the code can't be downloaded, the review runs on the diff alone and says so.

## Subscription or API key

Claude and ChatGPT subscriptions are for one person's own work. Use the `claude` or `codex` agent for your own repositories. For a team or a company, use the `api` agent with an API key.

**Subscription agents**

- **Claude Code**: log in with `claude`. On a server, run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`.
- **Codex**: log in with `codex login`. Set `CODEX_HOME` to use another directory.

The dashboard shows how much of each subscription is used.

**API agent**

```sh
GLANCE_AGENT=api                       # or pick it in the dashboard
GLANCE_API_PROVIDER=anthropic          # openai | anthropic | google
GLANCE_API_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=sk-ant-...           # OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY for the others
# GLANCE_API_MODELS=claude-haiku-5-5,claude-opus-5-5   extra models to choose from in the dashboard
```

The key only lives in the server's environment. It isn't stored, logged, sent to the dashboard or passed to a child process.

### LiteLLM and other gateways

Any OpenAI-compatible endpoint works, including LiteLLM, OpenRouter, Azure OpenAI and vLLM. Set the provider to `openai`, point the base URL at the gateway, and put the gateway's key in `OPENAI_API_KEY`:

```sh
GLANCE_AGENT=api
GLANCE_API_PROVIDER=openai             # always openai for a gateway, whatever model is behind it
GLANCE_API_BASE_URL=https://litellm.example.com/v1
OPENAI_API_KEY=sk-...                  # a LiteLLM virtual key
GLANCE_API_MODEL=claude-sonnet         # a model_name from your LiteLLM config
```

glance sends chat completions to the gateway. Some things to know:

- The model needs tool calling and JSON schema output. Small local models often fail the schema, and that chunk then shows up as failed.
- Depth is sent as `reasoning_effort`. If a model behind LiteLLM rejects it, set `drop_params: true` under `litellm_settings`.
- The cost estimate looks up prices by model name, and LiteLLM aliases aren't in `src/prices.ts`. Add yours with `GLANCE_PRICES` (below), or use LiteLLM's own spend tracking.

### Cost

Each review shows an estimated cost. It uses Claude Code's own figure when there is one; otherwise it multiplies the tokens by the prices in [`src/prices.ts`](src/prices.ts). For a subscription agent, it's what the same tokens would cost on an API key. To add or override prices:

```sh
GLANCE_PRICES='{"claude-sonnet": {"input": 3, "cachedInput": 0.3, "output": 15}}'   # dollars per million tokens
```

## Run locally

```bash
bun install
claude          # log in once (or `codex login`)
gh auth login   # or set GITHUB_TOKEN
docker run -d --name glance-postgres -e POSTGRES_USER=glance -e POSTGRES_PASSWORD=glance -e POSTGRES_DB=glance -p 127.0.0.1:5432:5432 postgres:18-alpine
bun dev         # api on http://127.0.0.1:7420, dashboard on http://localhost:7421
```

Locally nobody has to sign in. Migrations run when the server starts. After you change `src/schema.ts`, run `bun db:generate`.

Review a pull request from the terminal. It's a dry run unless you add `--post`:

```bash
bun review https://github.com/owner/repo/pull/123 [--agent codex|api] [--model sonnet] [--depth high] [--post] [--json]
```

### Webhooks while developing

GitHub has to reach your machine. `bun run tunnel` gives glance a fixed address through a named Cloudflare tunnel; the domain's DNS has to be on Cloudflare. Run `cloudflared tunnel login` once and set `GLANCE_TUNNEL_HOSTNAME=glance.example.com` in `.env`. The first run creates the tunnel and the DNS record. Set `BETTER_AUTH_URL` to the same address.

Then add a webhook to the repository or organization:

- Payload URL: `https://<host>/api/webhooks/github`
- Content type: `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET`
- Events: **Pull requests** and **Issue comments**

The GitHub token needs read access to contents, and write access to pull requests and issues.

## Deploy

Docker Compose runs three containers: `glance` (the api plus git and the CLIs), `postgres`, and `web` (Caddy, which serves the dashboard, forwards `/api/` to glance and gets the TLS certificate). Only Caddy is reachable from outside.

```bash
cp .env.example .env    # domain, passwords, sign-in, webhook secret, github app
docker compose up -d --build
```

1. Point `GLANCE_DOMAIN` at the server and open ports 80 and 443.
2. Log in at least one agent: put `claude setup-token`'s output in `CLAUDE_CODE_OAUTH_TOKEN`, or run `docker compose exec glance codex login --device-auth`. Using an API key instead also works.
3. Create a GitHub App with read access to contents, write access to pull requests and issues, and the **Pull requests** and **Issue comments** events. Its webhook goes to `https://<domain>/api/webhooks/github`. A personal `GITHUB_TOKEN` works too.
4. Set up sign-in with GitHub and/or SSO (OIDC or SAML), and say who's allowed in with `GLANCE_ALLOWED_EMAILS`, `GLANCE_ALLOWED_GITHUB_ORGS` or `GLANCE_SSO_DOMAIN`. In production glance won't start without this.

`/api/health` returns 200 once the database works and an agent is logged in. Point an uptime monitor at it. Run only one glance per database; a second one refuses to start.

[docs/operations.md](docs/operations.md) covers the GitHub App, every sign-in provider, backups, alerts, upgrades and rollback.

## Configuration

Everything is optional; [`.env.example`](.env.example) lists all of it. The dashboard settings cover the agent, model, depth, mode and comment limits, plus:

- **Team rules**: plain-language rules like "we never throw, use Effect" go into the agent's prompt. The repository's own `CLAUDE.md` and `AGENTS.md` are ignored on purpose, because a pull request can edit them.
- **Blocked and allowed authors**: lists of GitHub logins.
- **Exclude**: `.gitignore`-style globs for files that should never be reviewed.
- **Per repository**: its own mode and depth, plus extra rules, author lists and exclude patterns.

Limits: `AGENT_TIMEOUT_SECONDS`, `GLANCE_API_MAX_STEPS`, `CHECKOUT_TIMEOUT_SECONDS`, `MAX_REPO_MB`, `GLANCE_DISK_BUDGET_MB`, `MAX_QUEUED_REVIEWS` and `AGENT_CONCURRENCY`. `GLANCE_OTLP_URL` sends traces and logs to an OpenTelemetry collector.

## Development

```
src/reviewer.ts   the pipeline: fetch → select → chunk → agents → triage → post
src/agent.ts      claude / codex drivers and the API agent (AI SDK)
src/sandbox.ts    the API agent's read-only tools
src/checkout.ts   incremental git fetch, cached per commit
src/diff.ts       diff parsing, filtering, chunking (pure)
src/github.ts     REST and GraphQL client
src/rpc.ts        the dashboard's API, shared with web/
web/              the dashboard
```

```bash
bun test && bun run typecheck && bun run lint && bun run fmt:check
bun run test:e2e            # the review pipeline with real agent processes and a fake GitHub
bun run test:e2e:browser    # the dashboard in Playwright; no model calls, nothing posted to GitHub
```

Tests run on an in-process Postgres (PGlite) and don't need a database. [docs/effect.md](docs/effect.md) explains the Effect conventions.
