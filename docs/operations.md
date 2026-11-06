# Running mekiki in production

What the README's deploy section leaves out: setting up signing in, the GitHub App, a release rehearsal on staging, backups, alerts, upgrades and rollback. Work through it top to bottom the first time.

## 1. The machine

- A VPS with Docker and the compose plugin, amd64 or arm64. 2 CPUs and 4 GB of memory review comfortably at `AGENT_CONCURRENCY=4`; the `mekiki` container is limited to `MEKIKI_CPUS` / `MEKIKI_MEMORY` (default 2 and 4g), postgres to 1 CPU and 1 GB, caddy to 256 MB. Container logs rotate at 5 × 20 MB each.
- Disk: the checkouts stay under `MEKIKI_DISK_BUDGET_MB` (default 20 GB), plus postgres, plus the local backups. Leave headroom.
- Open ports 80 and 443 only. Point `MEKIKI_DOMAIN`'s DNS at the machine before the first start: Caddy gets the certificate on its own.
- Run **one** mekiki per database. Who's reviewing what, the rate limits and the live feed live in the process's memory, so mekiki takes a postgres advisory lock at startup and a second instance refuses to start (`AlreadyRunning`).

### The directory

mekiki runs from a directory holding a release's `docker-compose.yml`, the `.env` beside it and the backup scripts. No source checkout is needed. The README's deploy section has the commands; with the scripts:

```bash
mkdir -p /srv/mekiki/scripts && cd /srv/mekiki
release=https://github.com/atresnjo/mekiki/releases/latest/download
curl -fsSLO $release/docker-compose.yml
curl -fsSL $release/env.example -o .env && chmod 600 .env
curl -fsSL $release/backup.sh -o scripts/backup.sh
curl -fsSL $release/restore-check.sh -o scripts/restore-check.sh
chmod +x scripts/*.sh
```

## 2. Secrets

All in `.env` (mode 600, owned by root or the deploy user; never committed):

|                                                                       |                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                                                   | `openssl rand -hex 24`                                                     |
| `BETTER_AUTH_SECRET`                                                  | `openssl rand -base64 32`. Changing it signs everyone out                  |
| `GITHUB_WEBHOOK_SECRET`                                               | `openssl rand -hex 32`                                                     |
| `GITHUB_APP_PRIVATE_KEY_FILE`                                         | the app's `.pem`, mounted into the container (or `GITHUB_APP_PRIVATE_KEY`) |
| `GITHUB_CLIENT_SECRET`, `MEKIKI_SSO_CLIENT_SECRET`                    | from the provider you sign in with                                         |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | the api agent's, for `MEKIKI_API_PROVIDER`: from the provider's console    |

git and tar never see any of these: they get an allowlist of the environment (`PATH`, `HOME`, locale, proxy and CA settings), see `src/agent.ts`. An API key is read by mekiki's own process only, for the api agent's requests; it isn't stored, sent to the dashboard or logged.

## 3. The GitHub App

Create it under the organization (Settings → Developer settings → GitHub Apps):

- **Repository permissions:** Contents: read, Pull requests: read & write, Issues: read & write, Metadata: read (mekiki asks it who may trigger a review). Pull requests: read & write covers replying in review threads, but GitHub lets an app _resolve_ a thread only with **Contents: read & write** (an app's version of write access to the repository). Without it, mekiki closes its fixed threads the other way: it replies "✅ Fixed in …" and hides its own comment as outdated. Granting Contents: write means the token mekiki holds could push code; mekiki never pushes, and the token never reaches the agents.
- **Subscribe to events:** Pull request, Issue comment.
- **Webhook URL:** `https://<domain>/api/webhooks/github`, secret `GITHUB_WEBHOOK_SECRET`.
- Install it on the repositories mekiki should review, and set `GITHUB_APP_ID` and the private key.

The same app can sign people in: under the app's settings, add the callback URL `https://<domain>/api/auth/callback/github`, generate a client secret, and set `GITHUB_CLIENT_ID` (the app's client id, not its app id) and `GITHUB_CLIENT_SECRET`. A separate OAuth app works too, with the same callback.

**Fixed threads.** After each review it posts (not dry runs, not with posting off), mekiki reads the pull request's review threads over GraphQL (`https://api.github.com/graphql`, or `/api/graphql` beside an enterprise `GITHUB_API_URL`'s `/api/v3`, with the same token as the REST calls) and resolves the ones it started (a hidden `<!-- mekiki:finding … -->` mark in its comment, written by mekiki's own login) that are unresolved, outdated (the code under them changed), in a file the review read, and not found again near there. Each gets a "✅ Fixed in <sha>" reply and, in the same call, is resolved where GitHub allows it (`viewerCanResolve`: Contents: write) or has mekiki's comment hidden as outdated (`minimizeComment`) where it doesn't; where it can do neither, mekiki leaves it, without a reply. A thread mekiki closed once and someone reopened is left alone. Failing to read or resolve threads logs a warning and never fails the review. `MEKIKI_RESOLVE_FIXED=false` turns it off.

Who may start a review from GitHub: someone with at least `MEKIKI_TRIGGER_PERMISSION` (default `write`) on the repository, for `/mekiki` comments, ticked boxes (in mekiki's own comment only) and `mekiki:<depth>` labels. Bots never. Each person gets `MEKIKI_REVIEWS_PER_USER_HOUR` reviews an hour, each pull request `MEKIKI_REVIEWS_PER_PR_HOUR`. In auto mode, a pull request whose author lacks the permission (a fork's, say) gets the checkboxes instead of a review.

## 4. Signing in

Better Auth, with sessions in postgres (`MEKIKI_SESSION_DAYS`, default 7). Production needs at least one way to sign in and at least one rule for who's allowed; mekiki refuses to start otherwise and says what's missing. Whether someone is allowed is checked when they sign in (a stranger gets no session and is sent back with "isn't allowed into this mekiki") and again on every call, so removing them from the rules locks them out within a minute (after a restart, for an env change).

Who's allowed:

- `MEKIKI_ALLOWED_EMAILS`: addresses (`alice@acme.com`) and whole domains (`@acme.com`). An address from GitHub counts only when GitHub has verified it.
- `MEKIKI_ALLOWED_GITHUB_ORGS`: members of these organizations, signing in with GitHub. If the organization restricts OAuth apps, approve mekiki's app for it.
- `MEKIKI_SSO_DOMAIN`: anyone the company's SSO signs in with an address at that domain.

### SSO with OIDC (Okta, Microsoft Entra ID, Google Workspace, Keycloak, Authentik, JumpCloud…)

Create a web application (confidential client, authorization code with PKCE) in the identity provider, with the redirect URI `https://<domain>/api/auth/sso/callback/sso` and the scopes `openid email profile`. Then:

```bash
MEKIKI_SSO_NAME=Okta                       # the button says "Continue with Okta"
MEKIKI_SSO_ISSUER=https://acme.okta.com    # Entra: https://login.microsoftonline.com/<tenant id>/v2.0
MEKIKI_SSO_CLIENT_ID=…
MEKIKI_SSO_CLIENT_SECRET=…
MEKIKI_SSO_DOMAIN=acme.com
```

Assign the application to the people (or group) who should have it. Use a tenant-specific issuer: a shared one (Entra's `common`, plain Google accounts) would let in anyone who can put an address at your domain on an account there. With Google, make the OAuth consent screen _Internal_.

### SSO with SAML

Create a SAML application in the identity provider with the ACS URL `https://<domain>/api/auth/sso/saml2/sp/acs/sso` and the entity ID (audience) `https://<domain>/api/auth/sso/saml2/sp/metadata?providerId=sso`; NameID the user's email, signed assertions. Download the IdP's metadata XML, mount it into the container (for example to `/data/idp-metadata.xml` in the `mekiki-data` volume) and set `MEKIKI_SSO_SAML_METADATA_FILE` and `MEKIKI_SSO_DOMAIN`. SAML hasn't been through the staging rehearsal yet; rehearse it before relying on it.

## 5. The API key

The api image reviews with the api agent alone: Claude Code and Codex aren't in it, and `MEKIKI_CLI_AGENTS=false` keeps them out of the dashboard.

In `.env`, `MEKIKI_API_PROVIDER`, `MEKIKI_API_MODEL` and the provider's key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`); `MEKIKI_API_BASE_URL` for an OpenAI-compatible gateway. Restart mekiki after changing a key. The key isn't checked against the provider until a review uses it: a wrong one fails that review with the provider's 401.

`https://<domain>/api/health` answers 200 once the database works and the api agent has its provider, model and key.

**Spend.** Every review keeps the tokens its agent calls used and an estimated cost (the review's page shows it), priced from `src/prices.ts` or `MEKIKI_PRICES`. For the api agent, the provider's own console is the bill; set a spending limit there. A chunk is capped at `MEKIKI_API_MAX_STEPS` model calls (default 30) and `AGENT_TIMEOUT_SECONDS`, and at most `AGENT_CONCURRENCY` run at once.

## 6. Release rehearsal on staging

Before the first production deploy, and before every release that touches signing in, the webhook, the reviewer or the api agent. Staging is a second VPS (or the same one under another domain and compose project) with its own GitHub App installed on a test repository, its own database and its own SSO application.

What staging runs is a release candidate: tag it `v0.2.0-rc.1`, and CI publishes images tagged `0.2.0-rc.1` (never `latest`) and a pre-release on GitHub. Production only ever gets a tag whose candidate passed.

```bash
# in staging's .env: MEKIKI_VERSION=0.2.0-rc.1
docker compose pull && docker compose up -d                  # the images production will get, exactly
docker compose exec mekiki bun dist/isolation-check.js api  # a hostile pull request leaks nothing: "nothing leaked" (bills the key)
```

Then, on the test repository:

- [ ] **Sign in** with GitHub and with SSO; an account outside the rules is turned away with "isn't allowed into this mekiki"; signing out works; `curl -X POST https://<domain>/api/rpc` without a cookie answers `Unauthorized`.
- [ ] **Ask mode:** open a pull request: mekiki's comment appears with three boxes. Tick _Light_: it reviews, comments inline, the panel says what it found.
- [ ] **Permissions:** from an account with read access only, comment `/mekiki high` and tick a box: nothing starts (the delivery's response in the app's _Advanced_ tab says why). A collaborator's `/mekiki high` starts a review and gets 👀.
- [ ] **Labels:** add `mekiki:medium`: a review at medium.
- [ ] **Fixed threads:** push a commit that fixes a problem mekiki commented on, and review again: its thread gets "✅ Fixed in …" and is resolved, while a thread on code the push didn't change stays open. Reopen the resolved one and review again: it stays open.
- [ ] **Auto mode** (dashboard settings): push a commit: reviewed incrementally. A pull request from a fork by a non-collaborator gets the boxes instead.
- [ ] **Per repository:** give the test repository auto mode of its own while the global mode is ask: its pull requests are reviewed right away, another repository's get the boxes. Add a team rule ("never use `any`") and open a pull request that breaks it: the review flags it. Add an exclude pattern (`docs/**`): those files are listed as skipped with the pattern. Block a login and open a pull request as them: no review and no comment; `/mekiki` from a collaborator still reviews it.
- [ ] **Duplicate delivery:** redeliver a delivery from the app's _Advanced_ tab: answered `duplicate: true`, nothing starts twice.
- [ ] **Cancellation:** tick _High_ during a review: the running one is cancelled and the new one starts; close the pull request mid-review: cancelled.
- [ ] **Restart recovery:** `docker compose restart mekiki` mid-review: after the restart it's reviewed again (trigger `resumed …`), once.
- [ ] **Partial review:** set `AGENT_TIMEOUT_SECONDS=20`, review a large pull request at _High_: the review on GitHub opens with "Partial review: n of m files couldn't be reviewed", the panel says "Partly reviewed", the dashboard shows _Partial_, and the next push is reviewed from before it. Put the timeout back.
- [ ] **Limits:** `MAX_QUEUED_REVIEWS=1` and two reviews at once: the second is skipped with "mekiki is busy". `MAX_REPO_MB=1` on a bigger repository: reviewed on the diff alone, and says so.
- [ ] **Health:** take `MEKIKI_API_MODEL` out of `.env` and restart: `/api/health` answers 503 and the log says the api agent isn't set up. Put it back.
- [ ] **Backups:** `scripts/backup.sh` then `scripts/restore-check.sh` (below).

When it passes, tag the same commit as the release (`git tag v0.2.0 <the rc's commit> && git push origin v0.2.0`): its images are built from the same source.

## 7. Backups

mekiki's state is the postgres database (reviews, settings and each repository's, mekiki's comment ids, sessions). The checkouts are a cache, so the `mekiki-data` volume needs no backup.

`scripts/backup.sh` dumps the database (`pg_dump -Fc`), checks the dump reads, copies it off the machine with rclone (`MEKIKI_BACKUP_RCLONE=remote:bucket/mekiki`) or restic (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD`), keeps the newest 14 locally, and pings `MEKIKI_BACKUP_PING_URL` when it's done. It fails when there's nowhere off the machine to put the dump. Put the settings in `backup.env` in mekiki's directory and run it daily:

```cron
17 3 * * *  cd /srv/mekiki && scripts/backup.sh >> /var/log/mekiki-backup.log 2>&1
```

**Test the restore** after setting it up and then monthly: `scripts/restore-check.sh` restores the newest dump into a throwaway postgres container and checks the tables.

**Restoring for real:**

```bash
docker compose stop mekiki
docker compose exec -T postgres dropdb -U mekiki mekiki
docker compose exec -T postgres createdb -U mekiki mekiki
docker compose exec -T postgres pg_restore -U mekiki -d mekiki --no-owner --exit-on-error < backups/mekiki-….dump
docker compose up -d mekiki
```

## 8. Alerts

- **Uptime:** point a monitor (Uptime Kuma, Better Stack, healthchecks…) at `https://<domain>/api/health`: 503 means the database is down or no agent is ready.
- **Backups:** `MEKIKI_BACKUP_PING_URL` on a check that alerts when a day passes without a ping.
- **Logs:** with `MEKIKI_OTLP_URL` set, alert on error logs: `… isn't installed or logged in`, `the api agent has no provider, model or key`, `couldn't check who's calling`, `webhook failed`, `rpc failed`. Without a collector, `docker compose logs mekiki | grep '"level":"ERROR"'` is the same list.
- **Disk:** alert at 80% on the volume holding Docker's data.
- **GitHub:** the app's _Advanced_ tab lists failed deliveries (mekiki answers 500 when it failed on its side).

## 9. Upgrades and rollback

Releases are listed at [github.com/atresnjo/mekiki/releases](https://github.com/atresnjo/mekiki/releases), with what changed. Run a fixed one: `MEKIKI_VERSION` in `.env`, never `latest`, so a restart or a new machine doesn't upgrade on its own.

Upgrading:

```bash
scripts/backup.sh                       # a dump from just before
# in .env: MEKIKI_VERSION=0.3.0 (write down the one it was: a rollback goes back to it)
docker compose pull && docker compose up -d
docker compose logs -f mekiki           # migrations, "mekiki api on …"
```

When a release's notes say its `docker-compose.yml` or `env.example` changed, download them again from that release (`https://github.com/atresnjo/mekiki/releases/download/v0.3.0/docker-compose.yml`) before pulling; `.env` stays yours.

A restart leaves running reviews to the new process, which takes them up again. The database migrates forward at startup and migrations aren't undone.

Rolling back: put the previous `MEKIKI_VERSION` back in `.env`, then `docker compose up -d`.

If the release being undone added a migration the previous one can't run with, restore the dump taken before the upgrade (section 7) as well. Every migration so far only adds tables and columns, which an older mekiki ignores, except that a mekiki from before Better Auth signs in with `MEKIKI_TOKEN` instead.
