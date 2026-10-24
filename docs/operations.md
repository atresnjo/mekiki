# Running glance in production

What the README's deploy section leaves out: setting up signing in, the GitHub App, a release rehearsal on staging, backups, alerts, upgrades and rollback. Work through it top to bottom the first time.

## 1. The machine

- A VPS with Docker and the compose plugin. 2 CPUs and 4 GB of memory review comfortably at `AGENT_CONCURRENCY=4`; the `glance` container is limited to `GLANCE_CPUS` / `GLANCE_MEMORY` (default 2 and 4g), postgres to 1 CPU and 1 GB, caddy to 256 MB. Container logs rotate at 5 × 20 MB each.
- Disk: the checkouts stay under `GLANCE_DISK_BUDGET_MB` (default 20 GB), plus postgres, plus the local backups. Leave headroom.
- Open ports 80 and 443 only. Point `GLANCE_DOMAIN`'s DNS at the machine before the first start: Caddy gets the certificate on its own.
- Run **one** glance per database. Who's reviewing what, the rate limits and the live feed live in the process's memory, so glance takes a postgres advisory lock at startup and a second instance refuses to start (`AlreadyRunning`).

## 2. Secrets

All in `.env` (mode 600, owned by root or the deploy user; never committed):

|                                                    |                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                                | `openssl rand -hex 24`                                                     |
| `BETTER_AUTH_SECRET`                               | `openssl rand -base64 32`. Changing it signs everyone out                  |
| `GITHUB_WEBHOOK_SECRET`                            | `openssl rand -hex 32`                                                     |
| `GITHUB_APP_PRIVATE_KEY_FILE`                      | the app's `.pem`, mounted into the container (or `GITHUB_APP_PRIVATE_KEY`) |
| `GITHUB_CLIENT_SECRET`, `GLANCE_SSO_CLIENT_SECRET` | from the provider you sign in with                                         |
| `CLAUDE_CODE_OAUTH_TOKEN`                          | from `claude setup-token`                                                  |

The agents never see any of these except their own login: they get an allowlist of the environment (`PATH`, `HOME`, locale, proxy and CA settings, the CLIs' own config and login), see `src/agent.ts`. git and tar get even less.

## 3. The GitHub App

Create it under the organization (Settings → Developer settings → GitHub Apps):

- **Repository permissions:** Contents: read, Pull requests: read & write, Issues: read & write, Metadata: read (glance asks it who may trigger a review).
- **Subscribe to events:** Pull request, Issue comment.
- **Webhook URL:** `https://<domain>/api/webhooks/github`, secret `GITHUB_WEBHOOK_SECRET`.
- Install it on the repositories glance should review, and set `GITHUB_APP_ID` and the private key.

The same app can sign people in: under the app's settings, add the callback URL `https://<domain>/api/auth/callback/github`, generate a client secret, and set `GITHUB_CLIENT_ID` (the app's client id, not its app id) and `GITHUB_CLIENT_SECRET`. A separate OAuth app works too, with the same callback.

Who may start a review from GitHub: someone with at least `GLANCE_TRIGGER_PERMISSION` (default `write`) on the repository, for `/glance` comments, ticked boxes (in glance's own comment only) and `glance:<depth>` labels. Bots never. Each person gets `GLANCE_REVIEWS_PER_USER_HOUR` reviews an hour, each pull request `GLANCE_REVIEWS_PER_PR_HOUR`. In auto mode, a pull request whose author lacks the permission (a fork's, say) gets the checkboxes instead of a review.

## 4. Signing in

Better Auth, with sessions in postgres (`GLANCE_SESSION_DAYS`, default 7). Production needs at least one way to sign in and at least one rule for who's allowed; glance refuses to start otherwise and says what's missing. Whether someone is allowed is checked when they sign in (a stranger gets no session and is sent back with "isn't allowed into this glance") and again on every call, so removing them from the rules locks them out within a minute (after a restart, for an env change).

Who's allowed:

- `GLANCE_ALLOWED_EMAILS`: addresses (`alice@acme.com`) and whole domains (`@acme.com`). An address from GitHub counts only when GitHub has verified it.
- `GLANCE_ALLOWED_GITHUB_ORGS`: members of these organizations, signing in with GitHub. If the organization restricts OAuth apps, approve glance's app for it.
- `GLANCE_SSO_DOMAIN`: anyone the company's SSO signs in with an address at that domain.

### SSO with OIDC (Okta, Microsoft Entra ID, Google Workspace, Keycloak, Authentik, JumpCloud…)

Create a web application (confidential client, authorization code with PKCE) in the identity provider, with the redirect URI `https://<domain>/api/auth/sso/callback/sso` and the scopes `openid email profile`. Then:

```bash
GLANCE_SSO_NAME=Okta                       # the button says "Continue with Okta"
GLANCE_SSO_ISSUER=https://acme.okta.com    # Entra: https://login.microsoftonline.com/<tenant id>/v2.0
GLANCE_SSO_CLIENT_ID=…
GLANCE_SSO_CLIENT_SECRET=…
GLANCE_SSO_DOMAIN=acme.com
```

Assign the application to the people (or group) who should have it. Use a tenant-specific issuer: a shared one (Entra's `common`, plain Google accounts) would let in anyone who can put an address at your domain on an account there. With Google, make the OAuth consent screen _Internal_.

### SSO with SAML

Create a SAML application in the identity provider with the ACS URL `https://<domain>/api/auth/sso/saml2/sp/acs/sso` and the entity ID (audience) `https://<domain>/api/auth/sso/saml2/sp/metadata?providerId=sso`; NameID the user's email, signed assertions. Download the IdP's metadata XML, mount it into the container (for example to `/data/idp-metadata.xml` in the `glance-data` volume) and set `GLANCE_SSO_SAML_METADATA_FILE` and `GLANCE_SSO_DOMAIN`. SAML hasn't been through the staging rehearsal yet; rehearse it before relying on it.

## 5. Agent logins

- Claude Code: on any machine, `claude setup-token`; put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
- Codex: `docker compose exec glance codex login --device-auth`. The login is kept in the `glance-data` volume.

`https://<domain>/api/health` answers 200 once the database works and an agent is logged in.

## 6. Release rehearsal on staging

Before the first production deploy, and before every release that bumps the CLIs (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`) or touches signing in, the webhook or the reviewer. Staging is a second VPS (or the same one under another domain and compose project) with its own GitHub App installed on a test repository, its own database and its own SSO application.

```bash
docker compose up -d --build                          # the production images, exactly
docker compose exec glance bun scripts/isolation-check.ts   # a hostile pull request leaks nothing: both clis say "nothing leaked"
```

Then, on the test repository:

- [ ] **Sign in** with GitHub and with SSO; an account outside the rules is turned away with "isn't allowed into this glance"; signing out works; `curl -X POST https://<domain>/api/rpc` without a cookie answers `Unauthorized`.
- [ ] **Ask mode:** open a pull request: glance's comment appears with three boxes. Tick _Light_: it reviews, comments inline, the panel says what it found.
- [ ] **Permissions:** from an account with read access only, comment `/glance high` and tick a box: nothing starts (the delivery's response in the app's _Advanced_ tab says why). A collaborator's `/glance high` starts a review and gets 👀.
- [ ] **Labels:** add `glance:medium`: a review at medium.
- [ ] **Auto mode** (dashboard settings): push a commit: reviewed incrementally. A pull request from a fork by a non-collaborator gets the boxes instead.
- [ ] **Duplicate delivery:** redeliver a delivery from the app's _Advanced_ tab: answered `duplicate: true`, nothing starts twice.
- [ ] **Cancellation:** tick _High_ during a review: the running one is cancelled and the new one starts; close the pull request mid-review: cancelled.
- [ ] **Restart recovery:** `docker compose restart glance` mid-review: after the restart it's reviewed again (trigger `resumed …`), once.
- [ ] **Partial review:** set `AGENT_TIMEOUT_SECONDS=20`, review a large pull request at _High_: the review on GitHub opens with "Partial review: n of m files couldn't be reviewed", the panel says "Partly reviewed", the dashboard shows _Partial_, and the next push is reviewed from before it. Put the timeout back.
- [ ] **Limits:** `MAX_QUEUED_REVIEWS=1` and two reviews at once: the second is skipped with "glance is busy". `MAX_REPO_MB=1` on a bigger repository: reviewed on the diff alone, and says so.
- [ ] **Health:** `codex logout` in the container (or a bad `CLAUDE_CODE_OAUTH_TOKEN`) with the other agent logged out: `/api/health` answers 503 and the log says which agent stopped working. Log back in.
- [ ] **Backups:** `scripts/backup.sh` then `scripts/restore-check.sh` (below).

Write down the CLI versions and the commit that passed; those are what production runs.

## 7. Backups

glance's state is the postgres database (reviews, settings, glance's comment ids, sessions). The checkouts are a cache and Codex's login can be redone, so the `glance-data` volume needs no backup.

`scripts/backup.sh` dumps the database (`pg_dump -Fc`), checks the dump reads, copies it off the machine with rclone (`GLANCE_BACKUP_RCLONE=remote:bucket/glance`) or restic (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD`), keeps the newest 14 locally, and pings `GLANCE_BACKUP_PING_URL` when it's done. It fails when there's nowhere off the machine to put the dump. Put the settings in `backup.env` beside the checkout and run it daily:

```cron
17 3 * * *  cd /srv/glance && scripts/backup.sh >> /var/log/glance-backup.log 2>&1
```

**Test the restore** after setting it up and then monthly: `scripts/restore-check.sh` restores the newest dump into a throwaway postgres container and checks the tables.

**Restoring for real:**

```bash
docker compose stop glance
docker compose exec -T postgres dropdb -U glance glance
docker compose exec -T postgres createdb -U glance glance
docker compose exec -T postgres pg_restore -U glance -d glance --no-owner --exit-on-error < backups/glance-….dump
docker compose up -d glance
```

## 8. Alerts

- **Uptime:** point a monitor (Uptime Kuma, Better Stack, healthchecks…) at `https://<domain>/api/health`: 503 means the database is down or no agent is logged in.
- **Backups:** `GLANCE_BACKUP_PING_URL` on a check that alerts when a day passes without a ping.
- **Logs:** with `GLANCE_OTLP_URL` set, alert on error logs: `… isn't installed or logged in`, `couldn't check who's calling`, `webhook failed`, `rpc failed`. Without a collector, `docker compose logs glance | grep '"level":"ERROR"'` is the same list.
- **Disk:** alert at 80% on the volume holding Docker's data.
- **GitHub:** the app's _Advanced_ tab lists failed deliveries (glance answers 500 when it failed on its side).

## 9. Upgrades and rollback

Upgrading:

```bash
scripts/backup.sh                       # a dump from just before
git rev-parse HEAD > .previous-release  # where a rollback goes back to
git pull && docker compose up -d --build
docker compose logs -f glance           # migrations, "glance api on …", both agents' versions
```

A restart leaves running reviews to the new process, which takes them up again. The database migrates forward at startup and migrations aren't undone.

Rolling back:

```bash
git checkout "$(cat .previous-release)" && docker compose up -d --build
```

If the release being undone added a migration the previous one can't run with, restore the dump taken before the upgrade (section 7) as well. Every migration so far only adds tables and columns, which an older glance ignores, except that a glance from before Better Auth signs in with `GLANCE_TOKEN` instead.
