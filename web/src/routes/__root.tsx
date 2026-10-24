import { useAtomSet } from "@effect/atom-react"
import { Banner } from "@cloudflare/kumo/components/banner"
import { Loader } from "@cloudflare/kumo/components/loader"
import { createRootRoute, Outlet } from "@tanstack/react-router"
import { Header, SignIn, StartForm } from "../components/shell.tsx"
import { report } from "../components/ui.tsx"
import { type Depth, feedAtom, saveSettings, settingsAtom, statusAtom, useValue } from "../lib/glance.ts"

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

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <Header status={status} live={feed?._tag === "Live"} />
      {feed?._tag === "Locked" ? (
        <SignIn />
      ) : (
        <>
          <StartForm reviews={feed?.reviews ?? []} depth={settings?.depth} onDepth={changeDepth} />
          {status && !status.agents.claude && !status.agents.codex && (
            <Banner
              variant="alert"
              title="No agent CLI found"
              description="Install and log in to Claude Code (claude) or Codex (codex) on this machine: glance runs reviews through them on your subscription."
            />
          )}
          {feed ? (
            <Outlet />
          ) : (
            <div className="flex justify-center py-24">
              <Loader size="lg" />
            </div>
          )}
        </>
      )}
    </div>
  )
}
