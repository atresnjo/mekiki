import { useAtomSet } from "@effect/atom-react"
import { Banner } from "@cloudflare/kumo/components/banner"
import { createRootRoute, Outlet } from "@tanstack/react-router"
import { Header, SignIn, StartForm } from "../components/shell.tsx"
import { report } from "../components/ui.tsx"
import { type Depth, feedAtom, saveSettings, settingsAtom, statusAtom, useValue } from "../lib/mekiki.ts"

export const Route = createRootRoute({ component: Root })

function Root() {
  const feed = useValue(feedAtom)
  const status = useValue(statusAtom)
  const settings = useValue(settingsAtom)
  const save = useAtomSet(saveSettings, { mode: "promiseExit" })

  // one click: the depth is the saved default, so reviews from github use it too
  const changeDepth = (depth: Depth) => {
    if (!settings || settings.depth === depth) return
    save({ payload: { ...settings, depth }, reactivityKeys: ["settings"] }).then((exit) => report(exit))
  }

  const locked = feed?._tag === "Locked"
  return (
    // signed out: no header, the card alone in the middle
    <div className={`mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8 ${locked ? "justify-center" : ""}`}>
      {!locked && <Header status={status} live={feed?._tag === "Live"} />}
      {locked ? (
        <SignIn />
      ) : (
        <>
          <StartForm reviews={feed?.reviews ?? []} depth={settings?.depth} onDepth={changeDepth} />
          {/* any one agent can review: the api agent alone (the docker image) is enough */}
          {status && !status.agents.claude && !status.agents.codex && !status.agents.api && (
            <Banner
              variant="alert"
              title="No review agent available"
              description="Set an API key (MEKIKI_API_PROVIDER, MEKIKI_API_MODEL and the provider's key), or install and log in to Claude Code (claude) or Codex (codex) on this machine."
            />
          )}
          {/* each page draws its own skeleton until the feed connects */}
          <Outlet />
        </>
      )}
    </div>
  )
}
