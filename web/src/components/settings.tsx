import { Autocomplete } from "@cloudflare/kumo/components/autocomplete"
import { Button } from "@cloudflare/kumo/components/button"
import { Collapsible } from "@cloudflare/kumo/components/collapsible"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Input, InputArea } from "@cloudflare/kumo/components/input"
import { Loader } from "@cloudflare/kumo/components/loader"
import { Select } from "@cloudflare/kumo/components/select"
import { Switch } from "@cloudflare/kumo/components/switch"
import { TagInput } from "@cloudflare/kumo/components/tag-input"
import { Text } from "@cloudflare/kumo/components/text"
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Comment01Icon,
  Delete02Icon,
  FileBlockIcon,
  GitBranchIcon,
  LegalDocument01Icon,
  Robot01Icon,
  Settings02Icon,
  SlidersHorizontalIcon,
  UserMultiple02Icon,
  WebhookIcon,
} from "@hugeicons/core-free-icons"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react"
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
import { type Glyph, Icon } from "./icon.tsx"
import { DEPTHS, DepthPicker, depthLabel, report } from "./ui.tsx"

/** what the agent select offers */
const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", api: "API key" } satisfies Record<Settings["agent"], string>

const DEFAULT = "default"
/** a repository's select set to this has no mode or depth of its own */
const GLOBAL = "global"

const webhookUrl = new URL("/api/webhooks/github", window.location.origin).href

/** the dialog is one page: these are its sections, in order, and what the list on the left jumps to */
const SECTIONS = [
  { id: "reviews", label: "Reviews", icon: SlidersHorizontalIcon, hint: "When glance reviews, and how hard it looks." },
  { id: "agent", label: "Agent", icon: Robot01Icon, hint: "Who reviews, on which model: a CLI on its subscription, or a model on an API key." },
  { id: "comments", label: "Comments", icon: Comment01Icon, hint: "How much glance says on a pull request." },
  { id: "rules", label: "Team rules", icon: LegalDocument01Icon, hint: "What your team cares about, in plain language." },
  { id: "authors", label: "Authors", icon: UserMultiple02Icon, hint: "Whose pull requests are reviewed on their own." },
  { id: "files", label: "Files", icon: FileBlockIcon, hint: "What's never reviewed." },
  { id: "repos", label: "Repositories", icon: GitBranchIcon, hint: "A repository's own mode and depth, and rules and lists added to the global ones." },
  { id: "github", label: "GitHub", icon: WebhookIcon, hint: "Where GitHub sends its events." },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: Glyph; hint: string }>
type SectionId = (typeof SECTIONS)[number]["id"]

interface Draft {
  readonly settings: Settings
  readonly repos: ReadonlyArray<RepoSettings>
}

const MODES = { ask: "Ask with checkboxes", auto: "Review right away" }

export const SettingsDialog = ({ webhook }: { webhook: boolean }) => {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<SectionId>("reviews")
  const page = useRef<HTMLDivElement>(null)
  /** a section picked in the list: it stays marked while the page scrolls there, even if it can't reach the top */
  const picked = useRef<SectionId | undefined>(undefined)
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

  // the section being read: the last one whose heading is in the top third of the page, or the last one at the bottom
  const follow = () => {
    const el = page.current
    if (!el || picked.current) return
    const top = el.getBoundingClientRect().top + el.clientHeight / 3
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    const reached = SECTIONS.filter(({ id }) => (el.querySelector(`#settings-${id}`)?.getBoundingClientRect().top ?? Infinity) <= top)
    setActive(atEnd ? "github" : (reached.at(-1)?.id ?? "reviews"))
  }
  const jump = (id: SectionId) => {
    const el = page.current
    const target = el?.querySelector(`#settings-${id}`)
    if (!el || !target) return
    picked.current = id
    setActive(id)
    // the scroll's end lets the page lead again: scrollend where there is one, a moment later where there isn't
    const release = () => {
      picked.current = undefined
      el.removeEventListener("scrollend", release)
    }
    el.addEventListener("scrollend", release)
    setTimeout(release, 1000)
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" })
  }
  const patch = (next: Partial<Settings>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, ...next } } : d))

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
      <Dialog.Trigger render={(p) => <Button {...p} variant="ghost" size="sm" shape="square" icon={<Icon icon={Settings02Icon} />} aria-label="Settings" />} />
      <Dialog className="flex h-[min(88vh,780px)] w-[94vw] max-w-none flex-col overflow-hidden p-0 sm:w-[min(94vw,1040px)]">
        <div className="flex items-center justify-between gap-4 border-b border-kumo-hairline px-6 py-4">
          <div className="flex items-baseline gap-3">
            <Dialog.Title className="text-lg font-semibold">Settings</Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">Applies to the next review.</Dialog.Description>
          </div>
          <Dialog.Close render={(p) => <Button {...p} variant="ghost" shape="square" icon={<Icon icon={Cancel01Icon} />} aria-label="Close" />} />
        </div>
        {!draft ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader />
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              <nav aria-label="Settings sections" className="hidden w-52 shrink-0 flex-col gap-px border-r border-kumo-hairline p-3 md:flex">
                {SECTIONS.map(({ id, label, icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => jump(id)}
                    aria-current={active === id ? "true" : undefined}
                    className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                      active === id ? "bg-kumo-tint font-medium text-kumo-default" : "text-kumo-subtle hover:bg-kumo-tint/60 hover:text-kumo-default"
                    }`}
                  >
                    <Icon icon={icon} className="shrink-0" strokeWidth={active === id ? 2 : 1.6} />
                    {label}
                  </button>
                ))}
              </nav>
              <div ref={page} onScroll={follow} className="min-w-0 flex-1 overflow-y-auto px-6 pb-16 md:px-10">
                <Section id="reviews">
                  <Row
                    label="Depth"
                    description={`${DEPTHS.find((d) => d.value === draft.settings.depth)?.hint ?? ""}. Pick another per pull request in glance's comment.`}
                  >
                    <DepthPicker value={draft.settings.depth} onChange={(d) => set("depth", d)} />
                  </Row>
                  <Row label="When a pull request opens" description="Ask waits for a ticked box; auto reviews every push. A repository can pick its own.">
                    <Select
                      className="w-full"
                      aria-label="When a pull request opens"
                      value={draft.settings.mode}
                      onValueChange={(v) => v && set("mode", v as Settings["mode"])}
                      items={MODES}
                    />
                  </Row>
                  <Row label="Post to GitHub" description="Off: reviews show here only, nothing is written to the pull request." end>
                    <Switch aria-label="Post to GitHub" checked={draft.settings.postComments} onCheckedChange={(v) => set("postComments", v)} />
                  </Row>
                  <Row
                    label="Other ways to start one"
                    description={
                      <>
                        Comment <code>/glance high</code> or add a <code>glance:high</code> label. Needs write access to the repository.
                      </>
                    }
                  />
                </Section>
                <Section id="agent">
                  <Row
                    label="Agent"
                    description={
                      draft.settings.agent === "api"
                        ? "A model on the server's API key, billed per token: what a team or company should use."
                        : "The logged-in CLI that reads the code, on its subscription: for your own use."
                    }
                  >
                    <Select
                      className="w-full"
                      aria-label="Agent"
                      value={draft.settings.agent}
                      // each agent has its own models: start the new one on its default
                      onValueChange={(v) => v && v !== draft.settings.agent && patch({ agent: v as Settings["agent"], model: "" })}
                      items={AGENT_NAMES}
                    />
                  </Row>
                  <Row
                    label="Model"
                    description={
                      draft.settings.agent === "api" ? "Default is GLANCE_API_MODEL; GLANCE_API_MODELS adds more." : "Default is whatever the CLI picks."
                    }
                  >
                    <ModelSelect draft={draft.settings} onChange={(model) => set("model", model)} />
                  </Row>
                </Section>
                <Section id="comments">
                  <Row label="Max comments" description="The most inline comments one review posts. The surest problems go first." end>
                    <Input
                      className="w-28"
                      aria-label="Max comments"
                      type="number"
                      min={1}
                      max={50}
                      value={String(draft.settings.maxFindings)}
                      onChange={(e) => set("maxFindings", Math.max(1, Number(e.target.value) || 1))}
                    />
                  </Row>
                  <Row label="Min confidence" description="Findings the agent is less sure of than this, from 0 to 1, aren't posted." end>
                    <Input
                      className="w-28"
                      aria-label="Min confidence"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={String(draft.settings.minConfidence)}
                      onChange={(e) => set("minConfidence", Math.min(1, Math.max(0, Number(e.target.value) || 0)))}
                    />
                  </Row>
                </Section>
                <Section id="rules">
                  <RulesField value={draft.settings} onChange={patch} />
                </Section>
                <Section id="authors">
                  <AuthorFields value={draft.settings} onChange={patch} row />
                </Section>
                <Section id="files">
                  <ExcludeField value={draft.settings} onChange={patch} row />
                </Section>
                <Section id="repos">
                  <RepoList global={draft.settings} repos={draft.repos} setRepos={setRepos} />
                </Section>
                <Section id="github">
                  <Row
                    label="Webhook"
                    description={
                      webhook ? (
                        <>
                          Events <code>pull_request</code> and <code>issue_comment</code>.
                        </>
                      ) : (
                        <>
                          Off: set <code>GITHUB_WEBHOOK_SECRET</code> to turn it on.
                        </>
                      )
                    }
                  >
                    <span className="font-mono text-xs break-all text-kumo-default select-all">{webhookUrl}</span>
                  </Row>
                </Section>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-kumo-hairline px-6 py-3">
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

/** a section of the page: its heading, what it's for, and its rows */
const Section = ({ id, children }: { id: SectionId; children: ReactNode }) => {
  const { label, hint } = SECTIONS.find((s) => s.id === id)!
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="scroll-mt-6 pt-8">
      <h3 id={`settings-${id}-title`} className="text-lg font-semibold text-kumo-default">
        {label}
      </h3>
      <Text variant="secondary" size="sm">
        {hint}
      </Text>
      <div className="mt-3 flex flex-col divide-y divide-kumo-hairline">{children}</div>
    </section>
  )
}

/** one setting: what it is on the left, its control on the right. `wide` puts the control under it */
const Row = ({
  label,
  description,
  children,
  wide,
  end,
}: {
  label: string
  description?: ReactNode
  children?: ReactNode
  wide?: boolean
  /** a small control (a switch, a number): at the end of the row, not stretched across it */
  end?: boolean
}) => (
  <div className={`grid gap-x-8 gap-y-2 py-4 ${wide || !children ? "" : "md:grid-cols-[minmax(0,1fr)_minmax(0,320px)] md:items-center"}`}>
    <div className="min-w-0">
      <Text bold size="sm" as="span">
        {label}
      </Text>
      {description && (
        <Text variant="secondary" size="xs" as="p">
          {description}
        </Text>
      )}
    </div>
    {children && <div className={`min-w-0 ${end ? "md:justify-self-end" : "md:justify-self-stretch"}`}>{children}</div>}
  </div>
)

type Lists = Pick<Settings, "rules" | "blockedAuthors" | "allowedAuthors" | "exclude">
interface FieldProps {
  readonly value: Lists
  readonly onChange: (patch: Partial<Lists>) => void
  /** for one repository: what it adds to the global settings */
  readonly repo?: string
  /** laid out as a row of the page, not a field of a repository's panel */
  readonly row?: boolean
}

const added = (repo: string | undefined) => (repo ? " Added to the global ones." : "")

const RulesField = ({ value, onChange, repo }: FieldProps) => {
  const description = `Sent to the agent with every review.${added(repo)} Only these count: the repository's CLAUDE.md and AGENTS.md are ignored, since a pull request can change them. ${value.rules.length}/${RULES_MAX}`
  const area = (
    <InputArea
      label={repo ? "Rules for this repository" : undefined}
      aria-label={repo ? undefined : "Team rules"}
      placeholder={"We use Effect: never throw, fail with a tagged error.\nMigrations must be reversible."}
      autoResize
      minRows={repo ? 3 : 5}
      maxRows={14}
      value={value.rules}
      onValueChange={(rules) => onChange({ rules })}
      variant={value.rules.length > RULES_MAX ? "error" : "default"}
      description={repo ? description : undefined}
    />
  )
  return repo ? (
    area
  ) : (
    <Row label="Rules" description={description} wide>
      {area}
    </Row>
  )
}

const AuthorFields = ({ value, onChange, repo, row }: FieldProps) => {
  const blocked = `Their pull requests are never reviewed on their own and get no comment. /glance, a label or the dashboard still review them.${added(repo)}`
  const allowed = `In auto mode, only these authors are reviewed right away; the rest get the checkboxes. Empty: everyone.${added(repo)}`
  const tags = (label: string, key: "blockedAuthors" | "allowedAuthors", placeholder: string, description: string) => (
    <TagInput
      label={row ? undefined : label}
      aria-label={row ? label : undefined}
      placeholder={value[key].length === 0 ? placeholder : undefined}
      autoComplete="off"
      maxValues={LIST_MAX}
      value={[...value[key]]}
      onValueChange={(list) => onChange({ [key]: list })}
      validateValue={isLogin}
      description={row ? undefined : description}
    />
  )
  return row ? (
    <>
      <Row label="Blocked authors" description={blocked}>
        {tags("Blocked authors", "blockedAuthors", "dependabot[bot]", blocked)}
      </Row>
      <Row label="Allowed authors" description={allowed}>
        {tags("Allowed authors", "allowedAuthors", "Everyone", allowed)}
      </Row>
    </>
  ) : (
    <>
      {tags("Blocked authors", "blockedAuthors", "dependabot[bot]", blocked)}
      {tags("Allowed authors", "allowedAuthors", "Everyone", allowed)}
    </>
  )
}

const ExcludeField = ({ value, onChange, repo, row }: FieldProps) => {
  const description = (
    <>
      Like lockfiles, which are always skipped: <code>*.snap</code> anywhere, <code>fixtures/</code> directories, <code>/docs/**</code> from the root.
      {added(repo)}
    </>
  )
  const tags = (
    <TagInput
      label={row ? undefined : "Exclude"}
      aria-label={row ? "Exclude" : undefined}
      placeholder={value.exclude.length === 0 ? "docs/**" : undefined}
      autoComplete="off"
      maxValues={LIST_MAX}
      value={[...value.exclude]}
      onValueChange={(exclude) => onChange({ exclude })}
      description={row ? undefined : description}
    />
  )
  return row ? (
    <Row label="Exclude" description={description}>
      {tags}
    </Row>
  ) : (
    tags
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
      <div className="flex items-end gap-2 py-4">
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
        <Text variant="secondary" size="sm" as="p">
          No repository has settings of its own yet: every one uses the settings above.
        </Text>
      ) : (
        <div className="flex flex-col gap-2 pb-4">
          {repos.map((repo) => (
            <Collapsible.Root
              key={repo.repo}
              open={expanded === repo.repo}
              onOpenChange={(open) => setExpanded(open ? repo.repo : undefined)}
              className="rounded-lg border border-kumo-hairline"
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <Collapsible.Trigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <Icon icon={ArrowDown01Icon} className={`shrink-0 transition-transform ${expanded === repo.repo ? "" : "-rotate-90"}`} />
                  <span className="truncate font-mono text-sm text-kumo-default">{repo.repo}</span>
                  <Text variant="secondary" size="xs" truncate>
                    {summary(repo)}
                  </Text>
                </Collapsible.Trigger>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  icon={<Icon icon={Delete02Icon} />}
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
                <RulesField repo={repo.repo} value={repo} onChange={(patch) => update(repo.repo, patch)} />
                <AuthorFields repo={repo.repo} value={repo} onChange={(patch) => update(repo.repo, patch)} />
                <ExcludeField repo={repo.repo} value={repo} onChange={(patch) => update(repo.repo, patch)} />
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
      aria-label="Model"
      disabled={!models}
      // "" is the cli's default model; a select can't hold an empty value, so it stands in as DEFAULT
      value={draft.model || DEFAULT}
      onValueChange={(v) => onChange(!v || v === DEFAULT ? "" : v)}
      items={Object.fromEntries((models?.[draft.agent] ?? [{ id: draft.model, label: draft.model || "Default" }]).map((m) => [m.id || DEFAULT, m.label]))}
    />
  )
}
