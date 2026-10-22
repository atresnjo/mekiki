// granular imports throughout: the kumo barrel would pull its maps and globe into the bundle
import { useAtomSet } from "@effect/atom-react"
import { Badge } from "@cloudflare/kumo/components/badge"
import { Button } from "@cloudflare/kumo/components/button"
import { Input } from "@cloudflare/kumo/components/input"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Switch } from "@cloudflare/kumo/components/switch"
import { Text } from "@cloudflare/kumo/components/text"
import { Tooltip } from "@cloudflare/kumo/components/tooltip"
import { KeyIcon, LightningIcon, SignOutIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { type FormEvent, useEffect, useState } from "react"
import { type Depth, type Review, signIn, signOut, startReview, type Status } from "../lib/glance.ts"
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
      {status?.auth && (
        <Tooltip content="Sign out on this browser" render={<span className="inline-flex" />}>
          <Button variant="ghost" shape="square" icon={<SignOutIcon />} aria-label="Sign out" onClick={signOut} />
        </Tooltip>
      )}
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
  const [awaiting, setAwaiting] = useState<string | undefined>()
  useEffect(() => {
    if (!awaiting) return
    const found = reviews.find((r) => r.status === "running" && r.url.toLowerCase().startsWith(awaiting))
    if (found) {
      setAwaiting(undefined)
      navigate({ to: "/reviews/$id", params: { id: String(found.id) } })
    }
  }, [reviews, awaiting, navigate])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim()) return
    setBusy(true)
    const exit = report(await start({ payload: { url: url.trim(), dryRun, depth } }))
    setBusy(false)
    if (Exit.isFailure(exit)) return
    const m = url.trim().match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i)
    if (m) setAwaiting(`https://${m[0].toLowerCase()}`)
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

/** the server has GLANCE_TOKEN set: ask for it once, keep it in this browser */
export const TokenForm = () => {
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!token.trim()) return
    setBusy(true)
    const refused = await signIn(token.trim()).catch(() => "couldn't reach glance")
    setBusy(false)
    if (refused) return setError(refused)
    // every query starts over, signed in
    window.location.reload()
  }

  return (
    <LayerCard className="mx-auto w-full max-w-md">
      <LayerCard.Primary>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">
              Access token
            </Text>
            <Text variant="secondary" size="sm">
              This glance is protected. Enter its access token (<code>GLANCE_TOKEN</code>) to sign in on this browser.
            </Text>
          </div>
          <Input aria-label="Access token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
          {error && (
            <Text variant="error" size="sm">
              {error}
            </Text>
          )}
          <Button type="submit" variant="primary" icon={<KeyIcon />} loading={busy}>
            Sign in
          </Button>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}
