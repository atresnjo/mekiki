// signing in to the dashboard: better auth, with github and/or the company's sso (oidc or saml), its
// sessions in postgres. who may come in is glance's own rule (`allowed`): listed addresses and
// domains, github organizations, and the sso provider's domain. it's checked when a session starts
// (a stranger never gets one) and again on every call, so taking someone off the list locks them out.
//
// production refuses to start until signing in is set up: see `problems`
import { sso } from "@better-auth/sso"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { decryptOAuthToken } from "better-auth/oauth2"
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/bun-sql"
import { Context, Effect, FiberSet, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { AppConfig } from "./config.ts"
import { Database } from "./database.ts"
import { authAccounts, authSessions, authVerifications, ssoProviders, users } from "./schema.ts"

/** the one sso provider's id: its callback is /api/auth/sso/callback/sso (oidc) or /api/auth/sso/saml2/sp/acs/sso (saml) */
export const SSO_ID = "sso"

/** the header glance tells better auth the client's address in: set from the socket (or a trusted proxy), never the client's own */
const CLIENT_IP = "x-glance-client-ip"

/** how long a github organization membership is believed before it's asked again */
const MEMBERSHIP_TTL = 10 * 60_000
/** how long the answer to "may this user come in" is kept, per user */
const ALLOWED_TTL = 60_000

/** glance won't start like this: the message lists what to fix */
export class Misconfigured extends Schema.TaggedError<Misconfigured>()("Misconfigured", { message: Schema.String }) {}

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", { operation: Schema.String, cause: Schema.Defect() }) {}

export interface User {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly image: string | null
}

/** what the sign-in page offers */
export interface Methods {
  readonly github: boolean
  readonly sso: { readonly name: string; readonly kind: "oidc" | "saml" } | null
}

// ---------- the rules, as plain functions ----------

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])

/** glance won't run without signing in: production, or reachable from other machines */
export const requiresSignIn = (config: Pick<AppConfig, "env" | "host">) => config.env === "production" || !LOOPBACK.has(config.host)

export const methods = ({ auth }: Pick<AppConfig, "auth">): Methods => {
  const github = Option.isSome(auth.github.clientId) && Option.isSome(auth.github.clientSecret)
  const oidc = Option.isSome(auth.sso.issuer) && Option.isSome(auth.sso.clientId) && Option.isSome(auth.sso.clientSecret)
  const saml = Option.isSome(auth.sso.samlMetadataFile)
  return { github, sso: oidc || saml ? { name: auth.sso.name, kind: saml ? "saml" : "oidc" } : null }
}

/** some way to sign in is configured: the dashboard and the api need a session */
export const enabled = (config: Pick<AppConfig, "auth">) => {
  const m = methods(config)
  return m.github || m.sso !== null
}

/** what's wrong with the sign-in setup: glance doesn't start until it's empty */
export const problems = (config: Pick<AppConfig, "auth" | "env" | "host">): ReadonlyArray<string> => {
  const { auth } = config
  const found: Array<string> = []
  const m = methods(config)
  if (Option.isSome(auth.github.clientId) !== Option.isSome(auth.github.clientSecret))
    found.push("signing in with github needs both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET")
  const oidcParts = [Option.isSome(auth.sso.issuer), Option.isSome(auth.sso.clientId), Option.isSome(auth.sso.clientSecret)].filter(Boolean).length
  if (oidcParts > 0 && oidcParts < 3) found.push("oidc sso needs GLANCE_SSO_ISSUER, GLANCE_SSO_CLIENT_ID and GLANCE_SSO_CLIENT_SECRET")
  if (oidcParts === 3 && Option.isSome(auth.sso.samlMetadataFile)) found.push("pick one sso: oidc (GLANCE_SSO_ISSUER…) or saml (GLANCE_SSO_SAML_METADATA_FILE)")
  if (m.sso && Option.isNone(auth.sso.domain)) found.push("sso needs GLANCE_SSO_DOMAIN: the company's email domain (acme.com)")
  if (auth.allowedGithubOrgs.length > 0 && !m.github)
    found.push("GLANCE_ALLOWED_GITHUB_ORGS needs signing in with github (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)")
  const url = URL.parse(auth.url)
  if (!url) found.push(`BETTER_AUTH_URL isn't a url: ${auth.url}`)
  if (!enabled(config)) {
    if (requiresSignIn(config))
      found.push(
        "glance is in production (GLANCE_ENV=production, or HOST isn't loopback) and nobody could sign in: set up github (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET) or sso (GLANCE_SSO_*)",
      )
    return found
  }
  const secret = Option.getOrElse(Option.map(auth.secret, Redacted.value), () => "")
  if (requiresSignIn(config)) {
    if (secret.length < 32) found.push("BETTER_AUTH_SECRET must be set, 32 characters at least: `openssl rand -base64 32`")
    if (url && url.protocol !== "https:") found.push(`BETTER_AUTH_URL must be https in production: ${auth.url}`)
  }
  if (auth.allowedEmails.length === 0 && auth.allowedGithubOrgs.length === 0 && Option.isNone(auth.sso.domain))
    found.push("nobody is allowed in: set GLANCE_ALLOWED_EMAILS, GLANCE_ALLOWED_GITHUB_ORGS or GLANCE_SSO_DOMAIN")
  for (const entry of auth.allowedEmails)
    if (!/^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(entry))
      found.push(`GLANCE_ALLOWED_EMAILS: "${entry}" is neither an address (alice@acme.com) nor a domain (@acme.com)`)
  return found
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase()

/** `alice@acme.com` is that address, `@acme.com` everyone at that domain */
export const emailListed = (list: ReadonlyArray<string>, email: string) => {
  const address = email.trim().toLowerCase()
  return list.some((entry) => {
    const rule = entry.trim().toLowerCase()
    return rule.startsWith("@") ? domainOf(address) === rule.slice(1) : address === rule
  })
}

/** who's signing in: their address, whether a provider vouched for it, and the providers they've signed in with */
export interface Identity {
  readonly email: string
  readonly emailVerified: boolean
  readonly providers: ReadonlyArray<string>
}

/**
 * may they in, before asking github about organizations. an address counts when github verified it,
 * or when it came from the company's sso (which glance's operator set up, so its word is trusted)
 */
export const allowedByEmail = (auth: AppConfig["auth"], who: Identity) => {
  const fromSso = who.providers.includes(SSO_ID)
  const trusted = who.emailVerified || fromSso
  if (trusted && emailListed(auth.allowedEmails, who.email)) return true
  return fromSso && Option.isSome(auth.sso.domain) && domainOf(who.email) === auth.sso.domain.value.toLowerCase()
}

// ---------- better auth ----------

/** a drizzle postgres database whose queries are promises, as better auth's adapter wants */
export type AuthDatabase = PgAsyncDatabase<PgQueryResultHKT, any>

const create = (input: {
  readonly config: AppConfig
  readonly db: AuthDatabase
  /** the idp's metadata xml, for saml */
  readonly samlMetadata: string | undefined
  readonly allowed: (userId: string) => Promise<boolean>
  readonly log: (level: string, message: string) => void
}) => {
  const { auth } = input.config
  const m = methods(input.config)
  const base = auth.url.replace(/\/$/, "")
  const value = <A>(option: Option.Option<A>) => Option.getOrThrow(option)
  const secret = (option: Option.Option<Redacted.Redacted>) => Redacted.value(value(option))
  const oidc = m.sso?.kind === "oidc"
  const issuer = oidc ? value(auth.sso.issuer).replace(/\/$/, "") : ""
  const discovery = Option.getOrElse(auth.sso.discoveryUrl, () => `${issuer}/.well-known/openid-configuration`)
  // the idp is fetched from the server (discovery, the token exchange): better auth only goes where it's told it may
  const idpOrigins = oidc ? [...new Set([new URL(issuer).origin, new URL(discovery).origin])] : []

  return betterAuth({
    appName: "glance",
    baseURL: base,
    basePath: "/api/auth",
    secret: Option.getOrUndefined(Option.map(auth.secret, Redacted.value)),
    trustedOrigins: [new URL(base).origin, ...idpOrigins],
    database: drizzleAdapter(input.db, {
      provider: "pg",
      schema: { user: users, session: authSessions, account: authAccounts, verification: authVerifications, ssoProvider: ssoProviders },
    }),
    socialProviders: m.github
      ? {
          github: {
            clientId: value(auth.github.clientId),
            clientSecret: secret(auth.github.clientSecret),
            // organization membership is what lets them in: github only tells with read:org
            ...(auth.allowedGithubOrgs.length > 0 ? { scope: ["read:org"] } : {}),
          },
        }
      : {},
    session: { expiresIn: auth.sessionDays * 86_400, updateAge: 86_400 },
    account: {
      // the github token is kept to ask about organization memberships: encrypted with the secret
      encryptOAuthTokens: true,
      // the company's sso vouches for its addresses: a github account with the same one becomes the same person
      accountLinking: { enabled: true, trustedProviders: [SSO_ID] },
    },
    // in memory: glance is one instance (see the readme)
    rateLimit: { enabled: true, storage: "memory" },
    // providers come from the environment, never from the api; nobody links more accounts or edits themselves
    disabledPaths: [
      "/sso/register",
      "/sso/update-provider",
      "/sso/delete-provider",
      "/sso/providers",
      "/sso/get-provider",
      "/sso/request-domain-verification",
      "/sso/verify-domain",
      "/link-social",
      "/unlink-account",
      "/update-user",
    ],
    databaseHooks: {
      session: {
        create: {
          // the one door: a stranger gets no session. sent back to the dashboard, which says why
          before: async (session, ctx) => {
            if (await input.allowed(session.userId)) return
            if (!ctx) return false
            // a stranger who was never let in isn't kept: no row with their name and address
            const internal = ctx.context.internalAdapter
            if ((await internal.listSessions(session.userId)).length === 0) await internal.deleteUser(session.userId)
            throw ctx.redirect(`${base}/?error=not_allowed`)
          },
        },
      },
    },
    plugins: m.sso
      ? [
          sso({
            providersLimit: 0,
            defaultSSO: [
              {
                domain: value(auth.sso.domain),
                providerId: SSO_ID,
                ...(oidc
                  ? {
                      oidcConfig: {
                        issuer,
                        clientId: value(auth.sso.clientId),
                        clientSecret: secret(auth.sso.clientSecret),
                        discoveryEndpoint: discovery,
                        pkce: true,
                        scopes: ["openid", "email", "profile"],
                      },
                    }
                  : {
                      samlConfig: {
                        issuer: `${base}/api/auth/sso/saml2/sp/metadata?providerId=${SSO_ID}`,
                        // taken from the metadata
                        entryPoint: "",
                        callbackUrl: `${base}/`,
                        idpMetadata: { metadata: input.samlMetadata ?? "" },
                        wantAssertionsSigned: true,
                      },
                    }),
              },
            ],
          }),
        ]
      : [],
    advanced: {
      cookiePrefix: "glance",
      ipAddress: { ipAddressHeaders: [CLIENT_IP] },
    },
    // a sign-in that goes wrong comes back to the dashboard, which says why (?error=…)
    onAPIError: { errorURL: `${base}/` },
    telemetry: { enabled: false },
    logger: { log: (level, message) => input.log(level, message) },
  })
}

export type Instance = ReturnType<typeof create>

// ---------- the service ----------

export interface Interface {
  /** signing in is on: every call needs a session */
  readonly enabled: boolean
  readonly methods: Methods
  /** better auth's own routes (/api/auth/*): sign in, the callbacks, sign out */
  readonly handler: (request: Request) => Effect.Effect<Response, AuthError>
  /** who's calling, if they're signed in and still allowed in. with signing in off: always someone, the local user */
  readonly user: (headers: Headers) => Effect.Effect<Option.Option<User>>
  /** better auth itself, when signing in is on: for its server api */
  readonly instance: Instance | null
}

export class Service extends Context.Service<Service, Interface>()("glance/Auth") {}

/** whoever's using a glance that has no sign-in: development on this machine */
export const LOCAL: User = { id: "local", name: "local", email: "", image: null }

/** the headers of an effect request, as the web Headers better auth reads */
export const webHeaders = (headers: { readonly [name: string]: string }) => new Headers(Object.entries(headers))

const githubMember = async (token: string, org: string) => {
  const response = await fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "glance" },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 404 || response.status === 403) return false
  if (!response.ok) throw new Error(`github answered ${response.status} about ${org}`)
  const body = (await response.json()) as { state?: string }
  return body.state === "active"
}

export const make = Effect.fn("Auth.make")(function* (config: AppConfig, db: AuthDatabase) {
  const fs = yield* FileSystem.FileSystem
  const found = problems(config)
  if (found.length > 0) return yield* new Misconfigured({ message: `signing in isn't set up right:\n- ${found.join("\n- ")}` })
  const m = methods(config)
  if (!enabled(config)) {
    yield* Effect.logWarning("nobody signs in to this glance: anyone who reaches it can use it. set up github or sso before exposing it")
    return Service.of({
      enabled: false,
      methods: m,
      handler: () => Effect.succeed(new Response(null, { status: 404 })),
      user: () => Effect.succeed(Option.some(LOCAL)),
      instance: null,
    })
  }

  const samlMetadata =
    m.sso?.kind === "saml"
      ? yield* fs.readFileString(Option.getOrThrow(config.auth.sso.samlMetadataFile)).pipe(
          Effect.mapError((cause) => new AuthError({ operation: "readSamlMetadata", cause })),
          Effect.orDie,
        )
      : undefined

  // better auth logs and hooks through callbacks: each runs here, and stops with this layer
  const runFork = yield* FiberSet.makeRuntime()
  const log = (level: string, message: string) =>
    void runFork(
      (level === "error" ? Effect.logError(message) : level === "warn" ? Effect.logWarning(message) : Effect.logDebug(message)).pipe(
        Effect.annotateLogs("module", "better-auth"),
      ),
    )

  // "may they in", per user, for a minute; organization memberships for ten
  const answers = new Map<string, { readonly allowed: boolean; readonly at: number }>()
  const memberships = new Map<string, { readonly member: boolean; readonly at: number }>()
  let instance: Instance | undefined

  const inAnOrg = async (userId: string): Promise<boolean> => {
    if (!instance || config.auth.allowedGithubOrgs.length === 0) return false
    const cached = memberships.get(userId)
    if (cached && Date.now() - cached.at < MEMBERSHIP_TTL) return cached.member
    const ctx = await instance.$context
    const account = (await ctx.internalAdapter.findAccounts(userId)).find((a) => a.providerId === "github")
    if (!account?.accessToken) return false
    try {
      // better auth's own context: its type is narrower than the one the helper names
      const token = await decryptOAuthToken(account.accessToken, ctx as unknown as Parameters<typeof decryptOAuthToken>[1])
      let member = false
      for (const org of config.auth.allowedGithubOrgs) if ((member = await githubMember(token, org))) break
      memberships.set(userId, { member, at: Date.now() })
      return member
    } catch (error) {
      // github didn't answer: what it said last stands, for a while
      log("warn", `couldn't ask github about ${userId}'s organizations: ${String(error)}`)
      return cached?.member ?? false
    }
  }

  const allowed = async (userId: string): Promise<boolean> => {
    const cached = answers.get(userId)
    if (cached && Date.now() - cached.at < ALLOWED_TTL) return cached.allowed
    if (!instance) return false
    const ctx = await instance.$context
    const [user, accounts] = await Promise.all([ctx.internalAdapter.findUserById(userId), ctx.internalAdapter.findAccounts(userId)])
    if (!user) return false
    const providers = accounts.map((a) => a.providerId)
    const yes =
      allowedByEmail(config.auth, { email: user.email, emailVerified: user.emailVerified, providers }) ||
      (providers.includes("github") && (await inAnOrg(userId)))
    if (!yes) log("warn", `${user.email} signed in and isn't allowed in`)
    answers.set(userId, { allowed: yes, at: Date.now() })
    return yes
  }

  instance = create({ config, db, samlMetadata, allowed, log })
  const auth = instance

  const call = <A>(operation: string, f: (auth: Instance) => Promise<A>) =>
    Effect.tryPromise({ try: () => f(auth), catch: (cause) => new AuthError({ operation, cause }) }).pipe(Effect.withSpan(`Auth.${operation}`))

  const user = (headers: Headers) =>
    call("getSession", async (a) => {
      const found = await a.api.getSession({ headers })
      if (!found || !(await allowed(found.user.id))) return Option.none<User>()
      const { id, name, email, image } = found.user
      return Option.some<User>({ id, name, email, image: image ?? null })
    }).pipe(
      // who's calling can't be checked (the database failed): refused, never let through
      Effect.catch((e) => Effect.logError("couldn't check who's calling", e).pipe(Effect.as(Option.none<User>()))),
    )

  yield* Effect.logInfo(`signing in with ${[m.github ? "github" : "", m.sso ? `${m.sso.name} (${m.sso.kind})` : ""].filter(Boolean).join(" and ")}`)
  return Service.of({ enabled: true, methods: m, handler: (request) => call("handler", (a) => a.handler(request)), user, instance: auth })
})

/**
 * better auth on its own small pool (bun's postgres client, drizzle on top: its adapter wants promises).
 * built after the database layer, so the tables it uses are migrated before anything signs in
 */
export const layer = (config: AppConfig) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      yield* Database.Service
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new Bun.SQL(Redacted.value(config.databaseUrl), { max: 4 })),
        (c) => Effect.promise(() => c.close({ timeout: 5 })),
      )
      return yield* make(config, drizzle({ client }))
    }),
  )

// ---------- http: better auth's routes, and what the sign-in page offers ----------

/** who's asking, for limiting attempts: the proxy's word for it when there's a trusted proxy in front */
export const clientOf = (request: HttpServerRequest.HttpServerRequest, trustProxy: boolean) =>
  (trustProxy ? request.headers["x-forwarded-for"]?.split(",")[0]?.trim() : undefined) || Option.getOrElse(request.remoteAddress, () => "unknown")

export const routes = (config: AppConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const auth = yield* Service

      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const web = yield* HttpServerRequest.toWeb(request)
        const headers = new Headers(web.headers)
        headers.set(CLIENT_IP, clientOf(request, config.auth.trustProxy))
        const response = yield* auth.handler(new Request(web, { headers }))
        return HttpServerResponse.fromWeb(response)
      }).pipe(
        Effect.catch((e) => Effect.logError("sign-in failed", e).pipe(Effect.as(HttpServerResponse.jsonUnsafe({ error: "sign-in failed" }, { status: 500 })))),
      )

      // public: the page that asks people to sign in needs to know how
      const options = HttpServerResponse.jsonUnsafe({ enabled: auth.enabled, ...auth.methods })

      return HttpRouter.addAll([HttpRouter.route("*", "/api/auth/*", handler), HttpRouter.route("GET", "/api/sign-in", Effect.succeed(options))])
    }),
  )

export * as Auth from "./auth.ts"
