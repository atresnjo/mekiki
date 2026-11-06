// signing in: better auth's browser client, against /api/auth on this origin. github and the
// company's sso both leave the page and come back to "/", with ?error=… when it didn't work
import { ssoClient } from "@better-auth/sso/client"
import { createAuthClient } from "better-auth/client"
import { forgetShapes } from "skullet"

const client = createAuthClient({ baseURL: window.location.origin, basePath: "/api/auth", plugins: [ssoClient()] })

/** what the server offers (GET /api/sign-in): public, so the sign-in page can show its buttons */
export interface Methods {
  readonly enabled: boolean
  readonly github: boolean
  readonly sso: { readonly name: string; readonly kind: "oidc" | "saml" } | null
}

export const methods = (): Promise<Methods> => fetch("/api/sign-in").then((r) => r.json() as Promise<Methods>)

/** the provider sends them back here either way */
const back = { callbackURL: "/", errorCallbackURL: "/" }

/** null once the browser is on its way to the provider, else why it isn't */
export const signInWith = async (provider: "github" | "sso"): Promise<string | null> => {
  const result = provider === "github" ? await client.signIn.social({ provider: "github", ...back }) : await client.signIn.sso({ providerId: "sso", ...back })
  return result.error ? (result.error.message ?? `sign-in failed (${result.error.status})`) : null
}

/** the pages' remembered skeleton shapes are layout only, but they're the last person's: dropped too */
export const signOut = () =>
  client.signOut().then(() => {
    forgetShapes()
    window.location.assign("/")
  })

const REASONS: Record<string, string> = {
  not_allowed: "That account isn't allowed into this mekiki. Ask whoever runs it to add your address or organization.",
  access_denied: "Signing in was cancelled.",
  account_not_linked: "That address already belongs to someone who signed in another way: use that.",
}

/** why the last sign-in didn't work, from the ?error=… the provider came back with; the url is tidied up */
export const takeSignInError = (): string | null => {
  const url = new URL(window.location.href)
  const code = url.searchParams.get("error")
  if (!code) return null
  url.searchParams.delete("error")
  url.searchParams.delete("error_description")
  window.history.replaceState(null, "", url)
  return REASONS[code] ?? `Signing in didn't work (${code.replaceAll("_", " ")}).`
}
