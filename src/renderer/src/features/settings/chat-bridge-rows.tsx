// Huli: the controls of Settings > Chat apps: a platform's connection with its switch and
// credentials, and the accounts bound to its bot with the one-time code that binds another. The
// page sends credentials and never reads them back. See tools/huli/README.md (Chat apps).

import { useState, type FormEvent } from 'react'
import { Delete02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  CREDENTIAL_FIELDS,
  type ChatAccount,
  type ChatPlatform,
  type ChatPlatformView,
} from '@shared/chat-bridge'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { mediumAgo } from '@renderer/lib/format'
import { keepView, useChatBridgeStore } from '@renderer/stores/chat-bridge'
import { ControlError, IconAction, Pill, SetButton, SettingSwitch } from './controls'
import { RowLine, RowText } from './rows'
import { statusLine } from './chat-bridge-text'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

function api() {
  return window.kettu.chatBridge!
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // Electron prefixes what the handler threw with where it came from.
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

/** The switch, the state and the button that opens the credentials. */
export function ConnectionControl({ platform }: { platform: ChatPlatform }) {
  const { t } = useTranslation('settings')
  const view = useChatBridgeStore((s) => s.view?.platforms[platform] ?? null)
  const unavailable = useChatBridgeStore((s) => s.view?.unavailable ?? null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!view) return null
  const line = statusLine(view, t)
  return (
    <>
      <ControlError error={error} />
      {view.ready && view.enabled && <Pill tone={line.tone}>{line.text}</Pill>}
      <SetButton onClick={() => setEditing(true)} disabled={unavailable !== null}>
        {t(view.ready ? 'chatBridge.credentials.edit' : 'chatBridge.credentials.add')}
      </SetButton>
      <SettingSwitch
        label={t('chatBridge.enabled', { platform: t(`chatBridge.platforms.${platform}`) })}
        checked={view.enabled}
        disabled={!view.ready || unavailable !== null}
        onChange={(on) => {
          setError(null)
          api()
            .save(platform, { enabled: on })
            .then(keepView, (e: unknown) => setError(message(e)))
        }}
      />
      {editing && (
        <CredentialsDialog platform={platform} view={view} onClose={() => setEditing(false)} />
      )}
    </>
  )
}

function CredentialsDialog({
  platform,
  view,
  onClose,
}: {
  platform: ChatPlatform
  view: ChatPlatformView
  onClose: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const fields = CREDENTIAL_FIELDS[platform]
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((field) => {
        const shown = view.credentials[field.key]
        return [field.key, !field.secret && shown?.set ? shown.shown : '']
      }),
    ),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A secret left empty keeps the one set; every field must end up set.
  const complete = fields.every(
    (field) => values[field.key]!.trim() !== '' || view.credentials[field.key]?.set,
  )
  const changes = Object.fromEntries(
    fields.flatMap((field) => {
      const value = values[field.key]!.trim()
      const shown = view.credentials[field.key]
      if (value === '' || (!field.secret && shown?.set && shown.shown === value)) return []
      return [[field.key, value]]
    }),
  )
  const run = (task: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    task()
      .then(onClose, (e: unknown) => setError(message(e)))
      .finally(() => setBusy(false))
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!complete || busy) return
    run(async () => {
      keepView(
        await api().save(platform, {
          credentials: changes,
          ...(view.ready ? {} : { enabled: true }),
        }),
      )
    })
  }
  const clear = () =>
    run(async () => {
      keepView(
        await api().save(platform, {
          enabled: false,
          credentials: Object.fromEntries(fields.map((field) => [field.key, null])),
        }),
      )
    })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <SettingsDialogContent className="sm:max-w-120">
        <form className="contents" onSubmit={submit}>
          <SettingsDialogHeader
            title={t('chatBridge.credentials.title', {
              platform: t(`chatBridge.platforms.${platform}`),
            })}
          >
            {t(`chatBridge.credentials.where.${platform}`)}
          </SettingsDialogHeader>
          <SettingsDialogBody>
            {fields.map((field, i) => {
              const id = `chat-bridge-${platform}-${field.key}`
              const shown = view.credentials[field.key]
              return (
                <SettingsField
                  key={field.key}
                  label={t(
                    `chatBridge.fields.${platform}.${field.key}` as 'chatBridge.fields.qq.appId',
                  )}
                  htmlFor={id}
                  hint={
                    field.secret && shown?.set
                      ? t('chatBridge.credentials.keep', { shown: shown.shown })
                      : undefined
                  }
                >
                  <input
                    id={id}
                    type={field.secret ? 'password' : 'text'}
                    value={values[field.key]}
                    autoFocus={i === 0}
                    autoComplete="off"
                    spellCheck={false}
                    className={DIALOG_MONO_FIELD}
                    onChange={(event) =>
                      setValues((before) => ({ ...before, [field.key]: event.target.value }))
                    }
                  />
                </SettingsField>
              )
            })}
            {error && <span className="kettu-sd__error">{error}</span>}
          </SettingsDialogBody>
          <SettingsDialogFooter
            start={
              view.ready ? (
                <SetButton type="button" variant="ghost" onClick={clear} disabled={busy}>
                  {t('chatBridge.credentials.clear')}
                </SetButton>
              ) : undefined
            }
          >
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <SetButton
              size="md"
              variant="primary"
              type="submit"
              loading={busy}
              disabled={!complete}
            >
              {t(view.ready ? 'chatBridge.credentials.save' : 'chatBridge.credentials.saveOn')}
            </SetButton>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}

/** An id too long to show whole, by its start and end. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

function AccountLine({ platform, account }: { platform: ChatPlatform; account: ChatAccount }) {
  const { t } = useTranslation('settings')
  const [error, setError] = useState<string | null>(null)
  return (
    <RowLine
      text={
        <RowText
          name={account.name || shortId(account.id)}
          description={t('chatBridge.accounts.bound', {
            id: shortId(account.id),
            time: mediumAgo(account.boundAt),
          })}
        />
      }
    >
      <ControlError error={error} />
      <IconAction
        label={t('chatBridge.accounts.remove')}
        icon={Delete02Icon}
        onClick={() => {
          setError(null)
          api()
            .unbind(platform, account.id)
            .then(keepView, (e: unknown) => setError(message(e)))
        }}
      />
    </RowLine>
  )
}

/** The bound accounts, and binding another with a one-time code. */
export function AccountsControl({ platform }: { platform: ChatPlatform }) {
  const { t } = useTranslation('settings')
  const view = useChatBridgeStore((s) => s.view?.platforms[platform] ?? null)
  const binding = useChatBridgeStore((s) =>
    s.view?.binding?.platform === platform ? s.view.binding : null,
  )
  const [error, setError] = useState<string | null>(null)
  if (!view) return null
  const canBind = view.enabled && view.ready
  const bind = () => {
    setError(null)
    api()
      .startBinding(platform)
      .then(keepView, (e: unknown) => setError(message(e)))
  }
  const bot = view.status.botName
  const deepLink =
    platform === 'telegram' && binding && bot?.startsWith('@')
      ? `https://t.me/${bot.slice(1)}?start=${binding.code}`
      : null
  const until = binding
    ? new Date(binding.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''
  return (
    <div className="flex min-w-0 flex-col">
      {view.accounts.map((account) => (
        <AccountLine key={account.id} platform={platform} account={account} />
      ))}
      {binding ? (
        <RowLine
          text={
            <RowText
              name={
                <span
                  className="font-mono text-base tracking-widest"
                  aria-label={binding.code.split('').join(' ')}
                >
                  {binding.code.slice(0, 3)} {binding.code.slice(3)}
                </span>
              }
              description={
                <>
                  {t(`chatBridge.binding.send.${platform}`, { until })}
                  {deepLink && (
                    <>
                      {' '}
                      <a href={deepLink} target="_blank" rel="noreferrer">
                        {t('chatBridge.binding.openTelegram')}
                      </a>
                    </>
                  )}
                </>
              }
            />
          }
        >
          <ControlError error={error} />
          <SetButton
            variant="ghost"
            onClick={() =>
              void api()
                .cancelBinding()
                .then(keepView, (e: unknown) => setError(message(e)))
            }
          >
            {t('chatBridge.binding.cancel')}
          </SetButton>
        </RowLine>
      ) : (
        <RowLine
          text={
            <RowText
              name={
                view.accounts.length === 0
                  ? t('chatBridge.accounts.none')
                  : t('chatBridge.accounts.another')
              }
              description={
                canBind ? t('chatBridge.accounts.hint') : t('chatBridge.accounts.turnOnFirst')
              }
            />
          }
        >
          <ControlError error={error} />
          <SetButton onClick={bind} disabled={!canBind}>
            {t('chatBridge.accounts.bind')}
          </SetButton>
        </RowLine>
      )}
    </div>
  )
}

/** A platform's line: its name, what its connection says, and its controls. */
export function PlatformRow({ platform, name }: { platform: ChatPlatform; name: string }) {
  const { t } = useTranslation('settings')
  const view = useChatBridgeStore((s) => s.view?.platforms[platform] ?? null)
  const line = view ? statusLine(view, t) : null
  return (
    <RowLine
      text={
        <RowText
          name={name}
          description={
            line && (
              <>
                {view?.ready && view.enabled ? t(`chatBridge.about.${platform}`) : line.text}
                {line.problem && (
                  <>
                    <br />
                    <span className="text-danger">{line.problem}</span>
                  </>
                )}
              </>
            )
          }
        />
      }
    >
      <ConnectionControl platform={platform} />
    </RowLine>
  )
}
