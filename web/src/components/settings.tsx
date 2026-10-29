import { Autocomplete } from "@cloudflare/kumo/components/autocomplete"
import { Button } from "@cloudflare/kumo/components/button"
import { Collapsible } from "@cloudflare/kumo/components/collapsible"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Input, InputArea } from "@cloudflare/kumo/components/input"
import { Loader } from "@cloudflare/kumo/components/loader"
import { Select } from "@cloudflare/kumo/components/select"
import { Switch } from "@cloudflare/kumo/components/switch"
import { TagInput } from "@cloudflare/kumo/components/tag-input"
import { Tabs } from "@cloudflare/kumo/components/tabs"
import { Text } from "@cloudflare/kumo/components/text"
import { CaretDownIcon, GearIcon, TrashIcon, XIcon } from "@phosphor-icons/react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { type KeyboardEvent, useEffect, useState } from "react"
import {
  deleteRepoSettings,
  type Failure,
  isLogin,
  isRepo,
  repoIn,
  LIST_MAX,
  modelsAtom,
  type RepoSettings,
  repoSettings,
  repoSettingsAtom,
  reposAtom,
  RULES_MAX,
  saveRepoSettings,
  saveSettings,
  type Settings,
  settingsAtom,
  useValue,
} from "../lib/glance.ts"
import { DEPTHS, DepthPicker, depthLabel, report } from "./ui.tsx"

const DEFAULT = "default"
/** a repository's select set to this has no mode or depth of its own */
const GLOBAL = "global"

const webhookUrl = new URL("/api/webhooks/github", window.location.origin).href

type Tab = "reviews" | "rules" | "repos"

interface Draft {
  readonly settings: Settings
  readonly repos: ReadonlyArray<RepoSettings>
}

const MODES = { ask: "Ask: post Light / Medium / High checkboxes", auto: "Review right away at the default depth" }

export const SettingsDialog = ({ webhook }: { webhook: boolean }) => {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>("reviews")
  const [draft, setDraft] = useState<Draft | undefined>()
  const [saving, setSaving] = useState(false)
  const settings = useValue(settingsAtom)
  const repos = useValue(repoSettingsAtom)
  const persist = useAtomSet(saveSettings, { mode: "promiseExit" })
  const persistRepo = useAtomSet(saveRepoSettings, { mode: "promiseExit" })
  const removeRepo = useAtomSet(deleteRepoSettings, { mode: "promiseExit" })

  // each opening starts from the saved settings
  useEffect(() => {
    if (!open) setDraft(undefined)
    else if (!draft && settings && repos) setDraft({ settings, repos })
  }, [open, draft, settings, repos])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, [key]: value } } : d))
  const setRepos = (f: (repos: ReadonlyArray<RepoSettings>) => ReadonlyArray<RepoSettings>) => setDraft((d) => (d ? { ...d, repos: f(d.repos) } : d))

  // one call for the global settings, then one for each repository that changed or went
  const save = async () => {
    if (!draft) return
    setSaving(true)
    const saved = repos ?? []
    const changed = draft.repos.filter((r) => JSON.stringify(r) !== JSON.stringify(saved.find((s) => s.repo === r.repo)))
    const removed = saved.filter((s) => !draft.repos.some((r) => r.repo === s.repo))
    const calls: Array<() => Promise<Exit.Exit<unknown, Failure>>> = [
      () => persist({ payload: draft.settings, reactivityKeys: ["settings"] }),
      ...changed.map((repo) => () => persistRepo({ payload: repo, reactivityKeys: ["settings"] })),
      ...removed.map(
        ({ repo }) =>
          () =>
            removeRepo({ payload: { repo }, reactivityKeys: ["settings"] }),
      ),
    ]
    let exit: Exit.Exit<unknown, Failure> = Exit.void
    for (const call of calls) {
      exit = await call()
      if (Exit.isFailure(exit)) break
    }
    report(exit, "Settings saved")
    setSaving(false)
    if (Exit.isSuccess(exit)) setOpen(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={(p) => <Button {...p} variant="secondary" shape="square" icon={<GearIcon />} aria-label="Settings" />} />
      <Dialog className="flex max-h-[90vh] w-[min(92vw,560px)] flex-col gap-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Dialog.Title className="text-lg font-semibold">Settings</Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">Applies to the next review.</Dialog.Description>
          </div>
          <Dialog.Close render={(p) => <Button {...p} variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />} />
        </div>
        {!draft ? (
          <div className="flex justify-center py-8">
            <Loader />
          </div>
        ) : (
          <>
            <Tabs
              variant="segmented"
              value={tab}
              onValueChange={(v) => setTab(v as Tab)}
              tabs={[
                { value: "reviews", label: "Reviews" },
                { value: "rules", label: "Rules" },
                { value: "repos", label: "Repositories" },
              ]}
            />
            <div className="-mx-1 flex min-h-0 flex-col gap-5 overflow-y-auto px-1">
              {tab === "reviews" && <ReviewSettings draft={draft.settings} set={set} webhook={webhook} />}
              {tab === "rules" && (
                <RulesFields value={draft.settings} onChange={(patch) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d))} />
              )}
              {tab === "repos" && <RepoList global={draft.settings} repos={draft.repos} setRepos={setRepos} />}
            </div>
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={(p) => (
                  <Button {...p} variant="secondary">
                    Cancel
                  </Button>
                )}
              />
              <Button variant="primary" loading={saving} onClick={save}>
                Save
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  )
}

const ReviewSettings = ({
  draft,
  set,
  webhook,
}: {
  draft: Settings
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  webhook: boolean
}) => (
  <>
    <div className="flex flex-col gap-1.5">
      <Text bold size="sm" as="span">
        Depth
      </Text>
      <DepthPicker value={draft.depth} onChange={(d) => set("depth", d)} />
      <Text variant="secondary" size="xs">
        {DEPTHS.find((d) => d.value === draft.depth)?.hint}. On a pull request, tick a depth in glance's comment, comment <code>/glance high</code> or add a{" "}
        <code>glance:high</code> label.
      </Text>
    </div>
    <Select
      className="w-full"
      label="Agent"
      value={draft.agent}
      // each cli has its own models: start the new one on its default
      onValueChange={(v) => {
        if (v && v !== draft.agent) {
          set("agent", v as Settings["agent"])
          set("model", "")
        }
      }}
      items={{ claude: "Claude Code", codex: "Codex" }}
    />
    <ModelSelect draft={draft} onChange={(model) => set("model", model)} />
    <div className="grid grid-cols-2 gap-4">
      <Input
        label="Max comments"
        type="number"
        min={1}
        max={50}
        value={String(draft.maxFindings)}
        onChange={(e) => set("maxFindings", Math.max(1, Number(e.target.value) || 1))}
      />
      <Input
        label="Min confidence"
        type="number"
        min={0}
        max={1}
        step={0.05}
        value={String(draft.minConfidence)}
        onChange={(e) => set("minConfidence", Math.min(1, Math.max(0, Number(e.target.value) || 0)))}
      />
    </div>
    <Select
      className="w-full"
      label="When a pull request opens"
      value={draft.mode}
      onValueChange={(v) => v && set("mode", v as Settings["mode"])}
      items={MODES}
    />
    <Switch label="Post to GitHub" checked={draft.postComments} onCheckedChange={(v) => set("postComments", v)} />
    <div className="flex flex-col gap-1 rounded-lg bg-kumo-recessed p-3">
      <Text size="xs" variant="secondary">
        Webhook{webhook ? "" : " (set GITHUB_WEBHOOK_SECRET to enable)"}: events <code>pull_request</code>, <code>issue_comment</code>
      </Text>
      <span className="font-mono text-sm break-all text-kumo-default">{webhookUrl}</span>
    </div>
  </>
)

type Lists = Pick<Settings, "rules" | "blockedAuthors" | "allowedAuthors" | "exclude">

/** the team's rules, the author lists and the exclude patterns: globally, or for one repository (`repo`) */
const RulesFields = ({ value, onChange, repo }: { value: Lists; onChange: (patch: Partial<Lists>) => void; repo?: string }) => {
  const extra = repo ? " Added to the global ones." : ""
  return (
    <>
      <InputArea
        label={repo ? "Rules for this repository" : "Team rules"}
        placeholder={"We use Effect: never throw, fail with a tagged error.\nMigrations must be reversible."}
        autoResize
        minRows={3}
        maxRows={10}
        value={value.rules}
        onValueChange={(rules) => onChange({ rules })}
        variant={value.rules.length > RULES_MAX ? "error" : "default"}
        description={`Plain language, sent to the agent with every review.${extra} Only these count: the repository's CLAUDE.md and AGENTS.md are ignored, since a pull request can change them. ${value.rules.length}/${RULES_MAX}`}
      />
      <TagInput
        label="Blocked authors"
        placeholder={value.blockedAuthors.length === 0 ? "dependabot[bot]" : undefined}
        autoComplete="off"
        maxValues={LIST_MAX}
        value={[...value.blockedAuthors]}
        onValueChange={(blockedAuthors) => onChange({ blockedAuthors })}
        validateValue={isLogin}
        description={`GitHub logins whose pull requests are never reviewed on their own and get no comment. /glance, a label or the dashboard still review them.${extra}`}
      />
      <TagInput
        label="Allowed authors"
        placeholder={value.allowedAuthors.length === 0 ? "Everyone" : undefined}
        autoComplete="off"
        maxValues={LIST_MAX}
        value={[...value.allowedAuthors]}
        onValueChange={(allowedAuthors) => onChange({ allowedAuthors })}
        validateValue={isLogin}
        description={`In auto mode, only these authors' pull requests are reviewed right away; the rest get the checkboxes. Empty: everyone.${extra}`}
      />
      <TagInput
        label="Exclude"
        placeholder={value.exclude.length === 0 ? "docs/**" : undefined}
        autoComplete="off"
        maxValues={LIST_MAX}
        value={[...value.exclude]}
        onValueChange={(exclude) => onChange({ exclude })}
        description={
          <>
            Files never reviewed, like lockfiles: <code>*.snap</code> anywhere, <code>fixtures/</code> directories, <code>/docs/**</code> from the root.
            {extra}
          </>
        }
      />
    </>
  )
}

/** the repositories with settings of their own, and adding another */
const RepoList = ({
  global,
  repos,
  setRepos,
}: {
  global: Settings
  repos: ReadonlyArray<RepoSettings>
  setRepos: (f: (repos: ReadonlyArray<RepoSettings>) => ReadonlyArray<RepoSettings>) => void
}) => {
  const known = useValue(reposAtom) ?? []
  const [adding, setAdding] = useState("")
  const [expanded, setExpanded] = useState<string | undefined>()
  const name = repoIn(adding)
  const suggestions = known.filter((r) => !repos.some((s) => s.repo === r))
  const valid = isRepo(name) && !repos.some((r) => r.repo === name)

  const add = () => {
    if (!valid) return
    setRepos((list) => [...list, repoSettings(name)].sort((a, b) => a.repo.localeCompare(b.repo)))
    setExpanded(name)
    setAdding("")
  }
  const update = (repo: string, patch: Partial<RepoSettings>) => setRepos((list) => list.map((r) => (r.repo === repo ? { ...r, ...patch } : r)))

  return (
    <>
      <Text variant="secondary" size="sm">
        A repository's mode and depth replace the global ones; its rules and lists are added to them. The rest is global.
      </Text>
      <div className="flex items-end gap-2">
        {/* enter adds what's typed: the key bubbles up from the input */}
        <div
          className="min-w-0 flex-1"
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter" && valid) {
              e.preventDefault()
              add()
            }
          }}
        >
          <Autocomplete label="Add a repository" items={suggestions} value={adding} onValueChange={(v) => setAdding(String(v))}>
            <Autocomplete.InputGroup placeholder="owner/repo or its github link" />
            <Autocomplete.Content>
              <Autocomplete.List>
                {(item: string) => (
                  <Autocomplete.Item key={item} value={item}>
                    {item}
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Content>
          </Autocomplete>
        </div>
        <Button variant="secondary" disabled={!valid} onClick={add}>
          Add
        </Button>
      </div>
      {repos.length === 0 ? (
        <Text variant="secondary" size="sm">
          No repository has settings of its own: every one uses the global settings.
        </Text>
      ) : (
        <div className="flex flex-col gap-2">
          {repos.map((repo) => (
            <Collapsible.Root
              key={repo.repo}
              open={expanded === repo.repo}
              onOpenChange={(open) => setExpanded(open ? repo.repo : undefined)}
              className="rounded-lg border border-kumo-hairline"
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <Collapsible.Trigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <CaretDownIcon className={`shrink-0 transition-transform ${expanded === repo.repo ? "" : "-rotate-90"}`} />
                  <span className="truncate font-mono text-sm text-kumo-default">{repo.repo}</span>
                  <Text variant="secondary" size="xs" truncate>
                    {summary(repo)}
                  </Text>
                </Collapsible.Trigger>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  icon={<TrashIcon />}
                  aria-label={`Remove ${repo.repo}`}
                  onClick={() => setRepos((list) => list.filter((r) => r.repo !== repo.repo))}
                />
              </div>
              <Collapsible.Panel className="flex flex-col gap-4 border-t border-kumo-hairline p-3">
                <div className="grid grid-cols-2 gap-4">
                  <Select
                    className="w-full"
                    label="Mode"
                    value={repo.mode ?? GLOBAL}
                    onValueChange={(v) => v && update(repo.repo, { mode: v === GLOBAL ? null : (v as Settings["mode"]) })}
                    items={{ [GLOBAL]: `Global (${global.mode})`, ask: "Ask", auto: "Review right away" }}
                  />
                  <Select
                    className="w-full"
                    label="Depth"
                    value={repo.depth ?? GLOBAL}
                    onValueChange={(v) => v && update(repo.repo, { depth: v === GLOBAL ? null : (v as Settings["depth"]) })}
                    items={{ [GLOBAL]: `Global (${depthLabel(global.depth)})`, ...Object.fromEntries(DEPTHS.map((d) => [d.value, d.label])) }}
                  />
                </div>
                <RulesFields repo={repo.repo} value={repo} onChange={(patch) => update(repo.repo, patch)} />
              </Collapsible.Panel>
            </Collapsible.Root>
          ))}
        </div>
      )}
    </>
  )
}

/** what a repository changes, in a few words: "auto · high · rules · 2 blocked" */
const summary = (repo: RepoSettings) =>
  [
    repo.mode,
    repo.depth && depthLabel(repo.depth).toLowerCase(),
    repo.rules.trim() && "rules",
    repo.blockedAuthors.length > 0 && `${repo.blockedAuthors.length} blocked`,
    repo.allowedAuthors.length > 0 && `${repo.allowedAuthors.length} allowed`,
    repo.exclude.length > 0 && `${repo.exclude.length} excluded`,
  ]
    .filter(Boolean)
    .join(" · ") || "nothing of its own yet"

/** the model lists cost the server a process spawn: asked for only once the dialog is open */
const ModelSelect = ({ draft, onChange }: { draft: Settings; onChange: (model: string) => void }) => {
  const models = useValue(modelsAtom)
  return (
    <Select
      className="w-full"
      label="Model"
      disabled={!models}
      // "" is the cli's default model; a select can't hold an empty value, so it stands in as DEFAULT
      value={draft.model || DEFAULT}
      onValueChange={(v) => onChange(!v || v === DEFAULT ? "" : v)}
      items={Object.fromEntries((models?.[draft.agent] ?? [{ id: draft.model, label: draft.model || "Default" }]).map((m) => [m.id || DEFAULT, m.label]))}
    />
  )
}
