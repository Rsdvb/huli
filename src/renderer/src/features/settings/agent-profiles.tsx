// Settings > Agents: an agent's API provider profiles, each a provider's address, models and key a
// session can run with instead of the agent's own sign-in, and the one new sessions start with.
// The keys go to the host once and never come back: a row shows a key's last four characters.

import { useState, type FormEvent } from 'react'
import { Add01Icon, Delete02Icon, Edit02Icon, RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import {
  PROVIDER_PRESET_IDS,
  presetOf,
  profileProblem,
  type ProfileBalance,
  type ProviderPresetId,
  type ProviderProfileView,
} from '@shared/provider-profiles'
import { useRefresh } from '@renderer/components/refresh'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { planBalance } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import {
  CONFIRM,
  ControlError,
  IconAction,
  Pill,
  SetButton,
  SettingSelect,
  SettingSwitch,
} from './controls'
import {
  DIALOG_FIELD,
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'
import { GroupLabel, RowFrame, RowGroup, RowText } from './rows'

/** What a profile row says under its name: the provider, its model, the key's end and balance. */
function profileLine(profile: ProviderProfileView, balance: ProfileBalance | undefined): string {
  const parts = [i18n.t(`agents:profiles.preset.${profile.preset}`)]
  if (profile.model) parts.push(profile.model)
  else if (profile.preset === 'custom') parts.push(hostOf(profile.baseUrl))
  if (profile.keyEnd) parts.push(i18n.t('settings:agents.profiles.keyEnd', { end: profile.keyEnd }))
  if (balance?.balances.length) {
    const amount = balance.balances.map((b) => planBalance(b.amount, b.currency)).join(' · ')
    parts.push(i18n.t('settings:agents.profiles.balance', { amount }))
  } else if (balance?.error) {
    parts.push(i18n.t('settings:agents.profiles.balanceFailed'))
  }
  return parts.join(' · ')
}

function hostOf(url: string): string {
  return URL.parse(url)?.host ?? url
}

export function ProfilesGroup({ status }: { status: AgentStatus }) {
  const { api, request } = useHostScope()
  const { t } = useTranslation(['settings', 'agents', 'common'])
  const [act, busy, error] = useAction()
  const refresh = useRefresh()
  const [editing, setEditing] = useState<ProviderProfileView | 'new' | null>(null)
  const [removing, setRemoving] = useState<ProviderProfileView | null>(null)
  const profiles = status.profiles
  if (!profiles) return null
  const defaultId = profiles.defaultId
  const balances = status.profileBalances ?? []
  const readsBalances = profiles.items.some((p) => presetOf(p.preset)?.balance !== undefined)
  const setDefault = (profileId: string | null): void =>
    act(() => api.profiles.setDefault(status.id, profileId))
  const actions = (
    <>
      {readsBalances && (
        <IconAction
          label={t('agents.profiles.balancesRefresh')}
          icon={RefreshIcon}
          busy={refresh.phase === 'turning'}
          onClick={() =>
            void refresh
              .run(() => request('agents.refreshLimits', { agentId: status.id, force: true }))
              .catch(() => {})
          }
        />
      )}
      <IconAction
        label={t('agents.profiles.add')}
        icon={Add01Icon}
        onClick={() => setEditing('new')}
      />
    </>
  )
  return (
    <section className="k-group" aria-label={t('agents.profiles.group')}>
      <GroupLabel group={{ id: 'profiles', label: t('agents.profiles.group'), actions }} />
      <p className="ui-sg-hint" data-wrap="">
        {t('agents.profiles.hint')}
      </p>
      <ControlError error={error} />
      <RowGroup>
        <RowFrame
          id="profiles"
          text={
            <RowText
              name={t('agents:profiles.own', { name: status.harnessName })}
              description={t('agents.profiles.ownHint')}
            />
          }
        >
          {defaultId === null ? (
            <Pill>{t('agents:profiles.default')}</Pill>
          ) : (
            <SetButton variant="ghost" disabled={busy} onClick={() => setDefault(null)}>
              {t('agents.profiles.makeDefault')}
            </SetButton>
          )}
        </RowFrame>
        {profiles.items.map((profile) => (
          <RowFrame
            key={profile.id}
            text={
              <RowText
                name={profile.name}
                description={profileLine(
                  profile,
                  balances.find((b) => b.profileId === profile.id),
                )}
              />
            }
          >
            {defaultId === profile.id ? (
              <Pill>{t('agents:profiles.default')}</Pill>
            ) : (
              <SetButton variant="ghost" disabled={busy} onClick={() => setDefault(profile.id)}>
                {t('agents.profiles.makeDefault')}
              </SetButton>
            )}
            <IconAction
              label={t('agents.profiles.edit', { name: profile.name })}
              icon={Edit02Icon}
              onClick={() => setEditing(profile)}
            />
            <IconAction
              label={t('agents.profiles.remove', { name: profile.name })}
              icon={Delete02Icon}
              danger
              disabled={busy}
              onClick={() => setRemoving(profile)}
            />
          </RowFrame>
        ))}
      </RowGroup>
      <ProfileDialog
        status={status}
        editing={editing}
        isDefault={editing !== null && editing !== 'new' && editing.id === defaultId}
        onClose={() => setEditing(null)}
      />
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('agents.profiles.removeConfirm.title', { name: removing?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('agents.profiles.removeConfirm.body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const profile = removing
                setRemoving(null)
                if (profile) act(() => api.profiles.remove(status.id, profile.id))
              }}
            >
              {t('agents.profiles.removeConfirm.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

interface Draft {
  preset: ProviderPresetId
  name: string
  /** The user typed the name, so another provider no longer renames it. */
  named: boolean
  key: string
  baseUrl: string
  model: string
  fastModel: string
  makeDefault: boolean
}

function draftOf(
  editing: ProviderProfileView | 'new',
  isDefault: boolean,
  label: (preset: ProviderPresetId) => string,
  first: boolean,
): Draft {
  if (editing !== 'new') {
    return {
      preset: editing.preset,
      name: editing.name,
      named: true,
      key: '',
      baseUrl: editing.baseUrl,
      model: editing.model ?? '',
      fastModel: editing.fastModel ?? '',
      makeDefault: isDefault,
    }
  }
  return { ...presetDraft('zhipu', label), key: '', named: false, makeDefault: first }
}

function presetDraft(
  preset: ProviderPresetId,
  label: (preset: ProviderPresetId) => string,
): Pick<Draft, 'preset' | 'name' | 'baseUrl' | 'model' | 'fastModel'> {
  const filled = presetOf(preset)
  return {
    preset,
    name: label(preset),
    baseUrl: filled?.baseUrl ?? '',
    model: filled?.model ?? '',
    fastModel: filled?.fastModel ?? '',
  }
}

/** Adding a profile, or changing one: a preset fills the address and models, the user the key. */
function ProfileDialog({
  status,
  editing,
  isDefault,
  onClose,
}: {
  status: AgentStatus
  editing: ProviderProfileView | 'new' | null
  isDefault: boolean
  onClose: () => void
}) {
  const { api } = useHostScope()
  const { t } = useTranslation(['settings', 'agents', 'common'])
  const label = (preset: ProviderPresetId): string => t(`agents:profiles.preset.${preset}`)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = editing !== null
  // The dialog opens on what it edits; the fields keep what is typed until it closes.
  const value =
    draft ??
    (editing
      ? draftOf(editing, isDefault, label, (status.profiles?.items.length ?? 0) === 0)
      : null)
  const close = (): void => {
    onClose()
    setDraft(null)
    setError(null)
    setBusy(false)
  }
  if (!value) return null
  const update = (change: Partial<Draft>): void => setDraft({ ...value, ...change })
  const existing = editing !== null && editing !== 'new' ? editing : null
  const keyUrl = presetOf(value.preset)?.keyUrl
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const key = value.key.trim()
    const draftToSave = {
      agentId: status.id,
      ...(existing ? { id: existing.id } : {}),
      name: value.name.trim(),
      preset: value.preset,
      baseUrl: value.baseUrl.trim(),
      ...(value.model.trim() ? { model: value.model.trim() } : {}),
      ...(value.fastModel.trim() ? { fastModel: value.fastModel.trim() } : {}),
      ...(key ? { key } : {}),
      ...(value.makeDefault && !isDefault ? { makeDefault: true } : {}),
    }
    const problem = profileProblem(draftToSave)
    if (problem) return setError(t(`agents.profiles.problem.${problem}`))
    setBusy(true)
    setError(null)
    try {
      await api.profiles.save(draftToSave)
      close()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <SettingsDialogContent className="sm:max-w-135">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader
            title={
              existing
                ? t('agents.profiles.dialog.editTitle', { name: existing.name })
                : t('agents.profiles.dialog.addTitle')
            }
          >
            {t('agents.profiles.dialog.description')}
          </SettingsDialogHeader>
          <SettingsDialogBody>
            <SettingsField label={t('agents.profiles.dialog.provider')}>
              <SettingSelect
                label={t('agents.profiles.dialog.provider')}
                className="k-select--full"
                value={value.preset}
                options={PROVIDER_PRESET_IDS.map((preset) => ({
                  value: preset,
                  label: label(preset),
                }))}
                onChange={(preset) => {
                  const filled = presetDraft(preset, label)
                  update({ ...filled, ...(value.named ? { name: value.name } : {}) })
                }}
              />
            </SettingsField>
            <SettingsField label={t('agents.profiles.dialog.name')} htmlFor="profile-name">
              <input
                id="profile-name"
                value={value.name}
                autoComplete="off"
                spellCheck={false}
                className={DIALOG_FIELD}
                onChange={(event) => update({ name: event.target.value, named: true })}
              />
            </SettingsField>
            <SettingsField
              label={t('agents.profiles.dialog.key')}
              htmlFor="profile-key"
              hint={
                keyUrl && (
                  <a href={keyUrl} target="_blank" rel="noreferrer" className="k-link">
                    {t('agents.profiles.dialog.getKey')}
                  </a>
                )
              }
            >
              <input
                id="profile-key"
                type="password"
                value={value.key}
                autoFocus={!existing}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  existing
                    ? existing.keyEnd
                      ? t('agents.profiles.dialog.keyKeep', { end: existing.keyEnd })
                      : t('agents.profiles.dialog.keyKeepNoEnd')
                    : t('agents.profiles.dialog.key')
                }
                className={DIALOG_MONO_FIELD}
                onChange={(event) => update({ key: event.target.value })}
              />
            </SettingsField>
            <SettingsField label={t('agents.profiles.dialog.baseUrl')} htmlFor="profile-url">
              <input
                id="profile-url"
                value={value.baseUrl}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://"
                className={DIALOG_MONO_FIELD}
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
            </SettingsField>
            <SettingsField
              label={t('agents.profiles.dialog.model')}
              htmlFor="profile-model"
              hint={t('agents.profiles.dialog.modelHint')}
            >
              <input
                id="profile-model"
                value={value.model}
                autoComplete="off"
                spellCheck={false}
                className={DIALOG_MONO_FIELD}
                onChange={(event) => update({ model: event.target.value })}
              />
            </SettingsField>
            <SettingsField
              label={t('agents.profiles.dialog.fastModel')}
              htmlFor="profile-fast-model"
              hint={t('agents.profiles.dialog.fastModelHint')}
            >
              <input
                id="profile-fast-model"
                value={value.fastModel}
                autoComplete="off"
                spellCheck={false}
                className={DIALOG_MONO_FIELD}
                onChange={(event) => update({ fastModel: event.target.value })}
              />
            </SettingsField>
            {!isDefault && (
              <div className="flex items-center justify-between gap-3">
                <span>{t('agents.profiles.dialog.makeDefault')}</span>
                <SettingSwitch
                  label={t('agents.profiles.dialog.makeDefault')}
                  checked={value.makeDefault}
                  onChange={(makeDefault) => update({ makeDefault })}
                />
              </div>
            )}
            {error && <p className="kettu-sd__error">{error}</p>}
          </SettingsDialogBody>
          <SettingsDialogFooter>
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <SetButton size="md" variant="primary" type="submit" loading={busy}>
              {t('agents.profiles.dialog.save')}
            </SetButton>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}
