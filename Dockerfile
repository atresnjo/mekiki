# mekiki's image: the server (bundled into one file, no node_modules) with git for checkouts, and the built
# dashboard, which it serves itself on the same port: one origin, as the session cookie and the rpc need.
# it reviews with the api agent, on an API key: the claude and codex clis aren't in it, and are off.
# it speaks plain http: https is the reverse proxy's in front of it (traefik, caddy, nginx, a load balancer)
#
# a v* tag publishes it to ghcr.io/atresnjo/mekiki-api, for amd64 and arm64 (.github/workflows/check.yml).
# from source:
#
#   docker build --target api -t ghcr.io/atresnjo/mekiki-api:dev .
ARG BUN_VERSION=1.4.5

# ---------- what both builds start from ----------
# on the machine's own platform: what it builds is javascript and static files, the same for every one
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./

# ---------- the server, built: one file each, everything they import inside ----------
FROM deps AS api-build
COPY src src
COPY scripts scripts
RUN bun build src/main.ts --target=bun --minify-syntax --minify-whitespace --outfile dist/main.js \
 # the isolation check, run on this image before a release
 && bun build scripts/isolation-check.ts --target=bun --minify-syntax --minify-whitespace --outfile dist/isolation-check.js

# ---------- the dashboard, built. it imports the rpc contract (src/rpc.ts) and the domain it's made of ----------
FROM deps AS web-build
COPY src src
COPY web web
RUN bun run build

# ---------- the api ----------
FROM oven/bun:${BUN_VERSION}-alpine AS api
# git fetches the code (tar, busybox's, when it can't); tini reaps them. apk upgrade: the base image's
# own packages (openssl, musl, zlib) get the security fixes released since it was built
RUN apk upgrade --no-cache && apk add --no-cache git tini
WORKDIR /app
COPY --from=api-build /app/dist dist
# the dashboard, served from here (MEKIKI_WEB_DIR)
COPY --from=web-build /app/web/dist web
# applied at startup: the database is brought up to date before anything else runs
COPY drizzle drizzle
# what mekiki keeps on disk (the checkouts) lives in /data: one volume. the database is postgres
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
# production: mekiki refuses to start until signing in is set up
ENV MEKIKI_ENV=production \
    MEKIKI_CLI_AGENTS=false \
    MEKIKI_AGENT=api \
    HOST=0.0.0.0 \
    PORT=7420 \
    MEKIKI_CHECKOUTS=/data/checkouts \
    MEKIKI_WEB_DIR=/app/web \
    MEKIKI_LOG_FORMAT=json \
    MEKIKI_TRUST_PROXY=true
VOLUME /data
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD wget -qO /dev/null http://127.0.0.1:7420/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "dist/main.js"]
