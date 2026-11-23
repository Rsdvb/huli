// Huli: a Codex agent's memories, workspace sandbox, permission profile and features in beta on
// its page, read and written through its app-server's config API on the agent's host, one key at
// a time. A part this Codex does not offer is left out; a key a managed layer pins shows locked.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, CodexSettingChange, CodexSettings } from '@shared/agent-host'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import { SettingSelect, SettingSwitch, Skel } from './controls'
import { BlockLine, RowLine, RowShell, RowText } from './rows'

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: CodexSettings }

const CODEX_DEFAULT = ''

export function CodexSettingsRows({ status }: { status: AgentStatus }) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  const [read, setRead] = useState<Read>({ state: 'loading' })
  const [save, busy, saveError] = useAction()
  const load = useCallback(
    () =>
      request('agents.codexSettings', { agentId: status.id }).then(
        (settings) => setRead({ state: 'ready', settings }),
        (error: unknown) => setRead({ state: 'failed', error: errorMessage(error) }),
      ),
    [request, status.id],
  )
  useEffect(() => {
    void load()
  }, [load])

  const write = (change: CodexSettingChange) =>
    save(async () => {
      await request('agents.setCodexSetting', { agentId: status.id, change })
      await load()
    })

  if (read.state === 'loading') {
    return (
      <RowShell>
        <RowLine text={<RowText name={t('agents.codexSettings.memories.name')} />}>
          <Skel width={36} />
        </RowLine>
      </RowShell>
    )
  }
  if (read.state === 'failed') {
    return (
      <RowShell>
        <RowLine text={<RowText name={t('agents.codexSettings.name')} />}>{null}</RowLine>
        <p role="status" className="k-row-note k-error" data-wrap="">
          {t('agents.codexSettings.readFailed', { error: read.error })}
        </p>
      </RowShell>
    )
  }
  const { settings } = read
  const locked = (key: string) => settings.locked.includes(key)
  const lockedNote = t('agents.codexSettings.locked')
  const memoriesName = t('agents.codexSettings.memories.name')
  const networkName = t('agents.codexSettings.network.name')
  const profileName = t('agents.codexSettings.profile.name')
  const profiles = settings.profiles ?? []
  const profileOptions = [
    { value: CODEX_DEFAULT, label: t('agents.codexSettings.profile.default') },
    ...profiles
      .filter((profile) => profile.allowed || profile.id === settings.permissionProfile)
      .map((profile) => ({
        value: profile.id,
        label: profile.description ? `${profile.id} · ${profile.description}` : profile.id,
      })),
    ...(settings.permissionProfile !== null &&
    !profiles.some((profile) => profile.id === settings.permissionProfile)
      ? [{ value: settings.permissionProfile, label: settings.permissionProfile }]
      : []),
  ]
  const roots = settings.workspace?.writableRoots ?? []

  return (
    <>
      {settings.memories !== null && (
        <RowShell>
          <RowLine
            text={
              <RowText
                name={memoriesName}
                description={t('agents.codexSettings.memories.description')}
              />
            }
          >
            <SettingSwitch
              label={memoriesName}
              checked={settings.memories}
              disabled={busy || locked('features.memories')}
              onChange={(value) => write({ setting: 'memories', value })}
            />
          </RowLine>
          {locked('features.memories') && <p className="k-row-note">{lockedNote}</p>}
        </RowShell>
      )}
      {settings.workspace && (
        <RowShell>
          <RowLine
            text={
              <RowText
                name={networkName}
                description={t('agents.codexSettings.network.description')}
              />
            }
          >
            <SettingSwitch
              label={networkName}
              checked={settings.workspace.networkAccess}
              disabled={busy || locked('sandbox_workspace_write.network_access')}
              onChange={(value) => write({ setting: 'networkAccess', value })}
            />
          </RowLine>
          {roots.length > 0 && (
            <p className="k-row-note" data-wrap="">
              {t('agents.codexSettings.network.roots', { roots: roots.join(', ') })}
            </p>
          )}
          {locked('sandbox_workspace_write.network_access') && (
            <p className="k-row-note">{lockedNote}</p>
          )}
        </RowShell>
      )}
      {settings.profiles && (
        <RowShell>
          <RowLine
            text={
              <RowText
                name={profileName}
                description={t('agents.codexSettings.profile.description')}
              />
            }
          >
            <SettingSelect
              label={profileName}
              value={settings.permissionProfile ?? CODEX_DEFAULT}
              disabled={busy || locked('default_permissions')}
              options={profileOptions}
              onChange={(next) =>
                write({ setting: 'permissionProfile', value: next === CODEX_DEFAULT ? null : next })
              }
            />
          </RowLine>
          {locked('default_permissions') && <p className="k-row-note">{lockedNote}</p>}
        </RowShell>
      )}
      {settings.features && settings.features.length > 0 && (
        <RowShell>
          <div className="k-block">
            <RowText
              name={t('agents.codexSettings.features.name')}
              description={t('agents.codexSettings.features.description')}
            />
            {settings.features.map((feature) => {
              const key = `features.${feature.name}`
              return (
                <BlockLine
                  key={feature.name}
                  text={
                    <RowText
                      name={feature.displayName}
                      description={feature.description ?? undefined}
                    />
                  }
                >
                  <SettingSwitch
                    label={feature.displayName}
                    checked={feature.enabled}
                    disabled={busy || locked(key)}
                    onChange={(value) => write({ setting: 'feature', name: feature.name, value })}
                  />
                </BlockLine>
              )
            })}
          </div>
        </RowShell>
      )}
      {saveError && (
        <RowShell>
          <p role="status" className="k-row-note k-error" data-wrap="">
            {saveError}
          </p>
        </RowShell>
      )}
    </>
  )
}
