import { Button } from "@cloudflare/kumo/components/button"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Input } from "@cloudflare/kumo/components/input"
import { Loader } from "@cloudflare/kumo/components/loader"
import { Select } from "@cloudflare/kumo/components/select"
import { Switch } from "@cloudflare/kumo/components/switch"
import { Text } from "@cloudflare/kumo/components/text"
import { GearIcon, XIcon } from "@phosphor-icons/react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { useEffect, useState } from "react"
import { modelsAtom, saveSettings, type Settings, settingsAtom, useValue } from "../lib/glance.ts"
import { DEPTHS, DepthPicker, report } from "./ui.tsx"

const DEFAULT = "default"

const webhookUrl = new URL("/api/webhooks/github", window.location.origin).href

export const SettingsDialog = ({ webhook }: { webhook: boolean }) => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Settings | undefined>()
  const [saving, setSaving] = useState(false)
  const settings = useValue(settingsAtom)
  const persist = useAtomSet(saveSettings, { mode: "promiseExit" })

  // each opening starts from the saved settings
  useEffect(() => {
    if (!open) setDraft(undefined)
    else if (!draft && settings) setDraft(settings)
  }, [open, draft, settings])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d))

  const save = async () => {
    if (!draft) return
    setSaving(true)
    const exit = report(await persist({ payload: draft, reactivityKeys: ["settings"] }), "Settings saved")
    setSaving(false)
    if (Exit.isSuccess(exit)) setOpen(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={(p) => <Button {...p} variant="secondary" shape="square" icon={<GearIcon />} aria-label="Settings" />} />
      <Dialog className="flex w-[min(92vw,520px)] flex-col gap-5 p-6">
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
            <div className="flex flex-col gap-1.5">
              <Text bold size="sm" as="span">
                Depth
              </Text>
              <DepthPicker value={draft.depth} onChange={(d) => set("depth", d)} />
              <Text variant="secondary" size="xs">
                {DEPTHS.find((d) => d.value === draft.depth)?.hint}. On a pull request, tick a depth in glance's comment, comment <code>/glance high</code> or
                add a <code>glance:high</code> label.
              </Text>
            </div>
            <Select
              className="w-full"
              label="Agent"
              value={draft.agent}
              // each cli has its own models: start the new one on its default
              onValueChange={(v) => v && v !== draft.agent && setDraft({ ...draft, agent: v as Settings["agent"], model: "" })}
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
              items={{ ask: "Ask: post Light / Medium / High checkboxes", auto: "Review right away at the default depth" }}
            />
            <Switch label="Post to GitHub" checked={draft.postComments} onCheckedChange={(v) => set("postComments", v)} />
            <div className="flex flex-col gap-1 rounded-lg bg-kumo-recessed p-3">
              <Text size="xs" variant="secondary">
                Webhook{webhook ? "" : " (set GITHUB_WEBHOOK_SECRET to enable)"}: events <code>pull_request</code>, <code>issue_comment</code>
              </Text>
              <span className="font-mono text-sm break-all text-kumo-default">{webhookUrl}</span>
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
