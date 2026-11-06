// granular imports throughout: the kumo barrel would pull its maps and globe into the bundle
import { useAtomSet } from "@effect/atom-react"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { Button } from "@cloudflare/kumo/components/button"
import { Input } from "@cloudflare/kumo/components/input"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Popover } from "@cloudflare/kumo/components/popover"
import { Switch } from "@cloudflare/kumo/components/switch"
import { Text } from "@cloudflare/kumo/components/text"
import { Tooltip } from "@cloudflare/kumo/components/tooltip"
import { ArrowDown01Icon, FlashIcon, GithubIcon, IdCardIcon, Logout03Icon } from "@hugeicons/core-free-icons"
import { Link, useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { type FormEvent, useEffect, useState } from "react"
import { type Methods, methods, signInWith, signOut, takeSignInError } from "../lib/auth.ts"
import { type Depth, type Review, startReview, type Status, type User } from "../lib/mekiki.ts"
import { Icon, menuIcon } from "./icon.tsx"
import { SettingsDialog } from "./settings.tsx"
import { UsageMenu } from "./usage.tsx"
import { DepthPicker, report } from "./ui.tsx"

const AGENTS = [
  { key: "claude", name: "Claude Code", ready: "Logged in", down: "Not installed or logged out", fix: ["Run ", "claude", " where mekiki runs."] },
  { key: "codex", name: "Codex", ready: "Logged in", down: "Not installed or logged out", fix: ["Run ", "codex login", " where mekiki runs."] },
  // opt in: one not set up isn't a problem, only a choice not made
  {
    key: "api",
    name: "API key",
    ready: "Key set",
    down: "Not set up",
    fix: ["Set ", "MEKIKI_API_PROVIDER", ", its model and key on the server."],
    optional: true,
  },
] as const

/** a status light: ready, or something to look at (pulsing while it's still trying) */
const Dot = ({ ok, pulse }: { ok: boolean; pulse?: boolean }) => (
  <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${ok ? "bg-kumo-success" : "bg-kumo-warning"} ${pulse ? "animate-pulse" : ""}`} />
)

/**
 * the agents and the live feed in one line: it only has something to say when something is wrong,
 * and the detail is a click away
 */
const Health = ({ status, live }: { status: Status | undefined; live: boolean }) => {
  // the clis can be off on the server: then they're not there to be logged out of
  const agents = status ? AGENTS.filter((a) => status.offered.includes(a.key)) : AGENTS
  const down = status ? agents.filter((a) => !status.agents[a.key] && !("optional" in a)) : []
  const problems = [...down.map((a) => `${a.name} logged out`), ...(live ? [] : ["Reconnecting…"])]
  const ok = problems.length === 0
  const ready = status ? agents.filter((a) => status.agents[a.key]).length : 0
  const long = !status ? "Checking…" : ok ? `${ready} agent${ready === 1 ? "" : "s"} ready` : problems.join(" · ")
  const short = ok ? "Ready" : `${problems.length} issue${problems.length === 1 ? "" : "s"}`
  return (
    <Popover>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={`Status: ${long}`}
            className="inline-flex h-7 items-center gap-2 rounded-md px-2.5 text-[13px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
          />
        }
      >
        <Dot ok={ok && status !== undefined} pulse={!live} />
        <span className="hidden sm:inline">{long}</span>
        <span className="sm:hidden">{short}</span>
        <Icon icon={ArrowDown01Icon} size={12} />
      </Popover.Trigger>
      <Popover.Content align="end" className="w-72 p-1 text-[13px]">
        <div className="px-2.5 pt-2 pb-1.5 text-[11px] font-medium text-kumo-inactive">Agents</div>
        {agents.map((agent) => {
          const version = status?.agents[agent.key]
          return (
            <div key={agent.key}>
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <Dot ok={Boolean(version)} />
                <span className="text-kumo-default">{agent.name}</span>
                <span className="ml-auto truncate pl-2 text-xs text-kumo-subtle" title={version ?? undefined}>
                  {version ? agent.ready : agent.down}
                </span>
              </div>
              {status && !version && (
                <p className="mx-2.5 mb-1.5 ml-[25px] text-xs text-kumo-subtle">
                  {agent.fix[0]}
                  <code className="rounded bg-kumo-recessed px-1 font-mono text-[11.5px] text-kumo-default">{agent.fix[1]}</code>
                  {agent.fix[2]}
                </p>
              )}
            </div>
          )
        })}
        <div className="my-1 border-t border-kumo-hairline" />
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <Dot ok={live} pulse={!live} />
          <span className="text-kumo-default">Live updates</span>
          <span className={`ml-auto text-xs ${live ? "text-kumo-subtle" : "text-kumo-warning"}`}>{live ? "Connected" : "Reconnecting…"}</span>
        </div>
      </Popover.Content>
    </Popover>
  )
}

/** where you are on the left (mekiki / Reviews); on the right, how things stand, then settings and you. signed out: just the name */
export const Header = ({ status, live, signedOut }: { status: Status | undefined; live: boolean; signedOut?: boolean }) => (
  <header className="flex h-10 items-center justify-between gap-3">
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
      <Link to="/" className="flex items-center gap-1.5">
        <img src="/logo-mark.png" alt="" width={22} height={22} />
        <span className="text-[15px] font-semibold tracking-tight text-kumo-strong">mekiki</span>
      </Link>
      <span aria-hidden className="hidden text-lg font-light text-kumo-inactive sm:inline">
        /
      </span>
      <Link to="/" className="hidden text-sm text-kumo-subtle hover:text-kumo-default sm:inline">
        Reviews
      </Link>
    </nav>
    {!signedOut && (
      <div className="flex items-center gap-1">
        {/* the subscriptions are the clis': nothing to show when the server has them off */}
        {status?.offered.some((agent) => agent !== "api") && <UsageMenu />}
        <Health status={status} live={live} />
        <span aria-hidden className="mx-1 h-4 w-px bg-kumo-hairline" />
        <SettingsDialog webhook={status?.webhook ?? false} offered={status?.offered} />
        {status?.auth && <Account user={status.user} />}
      </div>
    )}
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
            <Button type="submit" variant="primary" size="lg" icon={<Icon icon={FlashIcon} strokeWidth={2} />} loading={busy}>
              Review
            </Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}

/** who's signed in, and the way out: one menu behind the avatar */
const Account = ({ user }: { user: User }) => (
  <DropdownMenu>
    <DropdownMenu.Trigger
      render={
        <button
          type="button"
          aria-label="Account"
          className="ml-1 grid size-7 place-items-center rounded-full transition-shadow hover:ring-2 hover:ring-kumo-fill"
        />
      }
    >
      {user.image ? (
        <img src={user.image} alt="" className="size-[22px] rounded-full ring-1 ring-kumo-line" referrerPolicy="no-referrer" />
      ) : (
        <span className="flex size-[22px] items-center justify-center rounded-full bg-kumo-tint text-xs font-medium uppercase">
          {(user.name || user.email).slice(0, 1)}
        </span>
      )}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      <div className="flex flex-col px-2 py-1.5">
        <span className="text-sm font-medium text-kumo-strong">{user.name || user.email}</span>
        {user.name && user.email && <span className="text-xs text-kumo-subtle">{user.email}</span>}
      </div>
      <DropdownMenu.Separator />
      <DropdownMenu.Item icon={menuIcon(Logout03Icon)} onClick={signOut}>
        Sign out on this browser
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu>
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
      .catch(() => setError("couldn't reach mekiki"))
  }, [])

  const go = async (provider: "github" | "sso") => {
    setBusy(provider)
    setError(null)
    const refused = await signInWith(provider).catch(() => "couldn't reach mekiki")
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
          <img src="/icon-192.png" alt="" width={64} height={64} />
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">
              Sign in
            </Text>
            <Text variant="secondary" size="sm">
              This mekiki is for its team only. Sign in with the account it knows you by.
            </Text>
          </div>
          {offered?.sso && (
            <Button variant="primary" icon={<Icon icon={IdCardIcon} />} loading={busy === "sso"} disabled={busy !== undefined} onClick={() => go("sso")}>
              Continue with {offered.sso.name}
            </Button>
          )}
          {offered?.github && (
            <Button
              variant={offered.sso ? "secondary" : "primary"}
              icon={<Icon icon={GithubIcon} />}
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
