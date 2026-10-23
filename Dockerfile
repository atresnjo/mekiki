# glance as two images from one file:
#   server: the api (bun), git and tar for checkouts, and the claude and codex clis reviews run on
#   web:    caddy, serving the built dashboard and forwarding /api/ to the server, with https
ARG BUN_VERSION=1.4.2

# ---------- the dashboard, built ----------
FROM oven/bun:${BUN_VERSION} AS web-build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
# the dashboard imports the rpc contract (src/rpc.ts) and the domain it's made of
COPY src src
COPY web web
RUN bun run build

# ---------- the agent clis: installed with npm, kept as the native binaries they are ----------
FROM node:22-bookworm-slim AS clis
# pinned with --build-arg; latest by default, since both clis move fast and old ones lose model access
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && root="$(npm root -g)" \
 # claude: one self-contained binary (npm also brings a musl build, unused here)
 && mkdir -p /opt/claude && cp "$root/@anthropic-ai/claude-code/bin/claude.exe" /opt/claude/claude \
 # codex: its binary finds its helpers (rg, the sandbox) beside it, so the whole directory comes along
 && cp -r "$(echo "$root"/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*)" /opt/codex \
 && /opt/claude/claude --version && /opt/codex/bin/codex --version

# ---------- the server ----------
FROM oven/bun:${BUN_VERSION} AS server
# git and tar fetch the code; curl is the healthcheck
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tar \
 && rm -rf /var/lib/apt/lists/*
COPY --from=clis /opt/claude/claude /usr/local/bin/claude
COPY --from=clis /opt/codex /opt/codex
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex && claude --version && codex --version
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src src
# applied at startup: the database is brought up to date before anything else runs
COPY drizzle drizzle
# what glance keeps on disk (checkouts, codex's login) lives in /data: one volume. the database is postgres
RUN mkdir -p /data/codex && chown -R bun:bun /data
USER bun
ENV HOST=0.0.0.0 \
    PORT=7420 \
    GLANCE_CHECKOUTS=/data/checkouts \
    CODEX_HOME=/data/codex \
    GLANCE_LOG_FORMAT=json \
    GLANCE_TRUST_PROXY=true
VOLUME /data
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS http://127.0.0.1:7420/api/health || exit 1
CMD ["bun", "src/main.ts"]

# ---------- the dashboard, served ----------
FROM caddy:2-alpine AS web
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/web/dist /srv
