// granular imports throughout: the kumo barrel would pull its maps and globe into the bundle
import { useAtomSet } from "@effect/atom-react"
import { Badge } from "@cloudflare/kumo/components/badge"
import { Button } from "@cloudflare/kumo/components/button"
import { Input } from "@cloudflare/kumo/components/input"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Switch } from "@cloudflare/kumo/components/switch"
import { Text } from "@cloudflare/kumo/components/text"
import { Tooltip } from "@cloudflare/kumo/components/tooltip"
import { GithubLogoIcon, IdentificationCardIcon, LightningIcon, SignOutIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { type FormEvent, useEffect, useState } from "react"
import { type Methods, methods, signInWith, signOut, takeSignInError } from "../lib/auth.ts"
import { type Depth, type Review, startReview, type Status, type User } from "../lib/glance.ts"
import { SettingsDialog } from "./settings.tsx"
import { DepthPicker, report } from "./ui.tsx"

export const Header = ({ status, live }: { status: Status | undefined; live: boolean }) => (
  <header className="flex flex-wrap items-center justify-between gap-4">
    <Link to="/" className="flex items-center gap-3">
      <div className="flex size-9 items-center justify-center rounded-lg bg-kumo-brand text-white shadow-sm">
        <LightningIcon size={20} weight="fill" />
      </div>
      <div className="flex flex-col">
        <Text variant="heading" size="lg" as="span">
          glance
        </Text>
        <Text variant="secondary" size="sm">
          Fast pull request reviews on your Claude and Codex subscription
        </Text>
      </div>
    </Link>
    <div className="flex items-center gap-2">
      {status &&
        (["claude", "codex"] as const).map((agent) => (
          <Tooltip key={agent} content={status.agents[agent] ?? "not installed or not logged in"} render={<span className="inline-flex" />}>
            <Badge variant={status.agents[agent] ? "success" : "neutral"} appearance="dot" className={status.agents[agent] ? "" : "opacity-60"}>
              {agent === "claude" ? "Claude Code" : "Codex"}
            </Badge>
          </Tooltip>
        ))}
      <Tooltip
        content={live ? "Live updates connected" : "Reconnecting…"}
        render={<span className={`mx-1 size-2 rounded-full ${live ? "bg-kumo-success" : "animate-pulse bg-kumo-warning"}`} />}
      />
      <SettingsDialog webhook={status?.webhook ?? false} />
      {status?.auth && <Account user={status.user} />}
    </div>
  </header>
)

export const StartForm = ({ reviews, depth, onDepth }: { reviews: ReadonlyArray<Review>; depth: Depth | undefined; onDepth: (depth: Depth) => void }) => {
  const [url, setUrl] = useState("")
  const [dryRun, setDryRun] = useState(false)
  const [busy, setBusy] = useState(false)
  const start = useAtomSet(startReview, { mode: "promiseExit" })
  const navigate = useNavigate()

  // a review started from here opens as soon as it shows up
  const [awaiting, setAwaiting] = useState<{ url: string; afterId: number } | undefined>()
  useEffect(() => {
    if (!awaiting) return
    const found = reviews.find((r) => r.id > awaiting.afterId && r.url.toLowerCase() === awaiting.url)
    if (found) {
      setAwaiting(undefined)
      navigate({ to: "/reviews/$id", params: { id: String(found.id) } })
    }
  }, [reviews, awaiting, navigate])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim()) return
    const afterId = Math.max(0, ...reviews.map((review) => review.id))
    setBusy(true)
    const exit = report(await start({ payload: { url: url.trim(), dryRun, depth } }))
    setBusy(false)
    if (Exit.isFailure(exit)) return
    const m = url.trim().match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i)
    if (m) setAwaiting({ url: `https://${m[0].toLowerCase()}`, afterId })
    setUrl("")
  }

  return (
    <LayerCard>
      <LayerCard.Primary>
        <form onSubmit={submit} className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="flex-1">
            <Input
              className="w-full"
              aria-label="Pull request URL"
              size="lg"
              placeholder="https://github.com/owner/repo/pull/123"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              passwordManagerIgnore
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4">
            {depth && <DepthPicker value={depth} onChange={onDepth} />}
            <Tooltip content="Review, but don't post anything to GitHub" render={<span className="inline-flex" />}>
              <Switch label="Dry run" size="sm" checked={dryRun} onCheckedChange={setDryRun} />
            </Tooltip>
            <Button type="submit" variant="primary" size="lg" icon={<LightningIcon weight="fill" />} loading={busy}>
              Review
            </Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}

/** who's signed in, and the way out */
const Account = ({ user }: { user: User }) => (
  <>
    <Tooltip content={user.email || user.name} render={<span className="inline-flex" />}>
      {user.image ? (
        <img src={user.image} alt={user.name || user.email} className="ml-1 size-7 rounded-full" referrerPolicy="no-referrer" />
      ) : (
        <span className="ml-1 flex size-7 items-center justify-center rounded-full bg-kumo-tint text-sm font-medium uppercase">
          {(user.name || user.email).slice(0, 1)}
        </span>
      )}
    </Tooltip>
    <Tooltip content="Sign out on this browser" render={<span className="inline-flex" />}>
      <Button variant="ghost" shape="square" icon={<SignOutIcon />} aria-label="Sign out" onClick={signOut} />
    </Tooltip>
  </>
)

/** signing in is on and nobody is: github and the company's sso, whichever the server offers */
export const SignIn = () => {
  const [offered, setOffered] = useState<Methods | undefined>()
  const [busy, setBusy] = useState<"github" | "sso" | undefined>()
  // read once: the provider's ?error=… is taken off the url
  const [error, setError] = useState<string | null>(() => takeSignInError())

  useEffect(() => {
    methods()
      .then(setOffered)
      .catch(() => setError("couldn't reach glance"))
  }, [])

  const go = async (provider: "github" | "sso") => {
    setBusy(provider)
    setError(null)
    const refused = await signInWith(provider).catch(() => "couldn't reach glance")
    // on success the browser is already leaving for the provider
    if (refused) {
      setBusy(undefined)
      setError(refused)
    }
  }

  return (
    <LayerCard className="mx-auto w-full max-w-md">
      <LayerCard.Primary>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">
              Sign in
            </Text>
            <Text variant="secondary" size="sm">
              This glance is for its team only. Sign in with the account it knows you by.
            </Text>
          </div>
          {offered?.sso && (
            <Button variant="primary" icon={<IdentificationCardIcon />} loading={busy === "sso"} disabled={busy !== undefined} onClick={() => go("sso")}>
              Continue with {offered.sso.name}
            </Button>
          )}
          {offered?.github && (
            <Button
              variant={offered.sso ? "secondary" : "primary"}
              icon={<GithubLogoIcon />}
              loading={busy === "github"}
              disabled={busy !== undefined}
              onClick={() => go("github")}
            >
              Continue with GitHub
            </Button>
          )}
          {error && (
            <Text variant="error" size="sm">
              {error}
            </Text>
          )}
        </div>
      </LayerCard.Primary>
    </LayerCard>
  )
}
