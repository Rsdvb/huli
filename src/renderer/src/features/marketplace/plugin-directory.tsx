// Huli: the Plugins tab's directory, read from GitHub by the host: a row for each plugin with
// what it is written for, who wrote it and the repository it comes from, its Install, and the
// line over the tab that says when the lists were read, with Refresh.

import { useContext, useState } from 'react'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ListedPlugin, PluginCatalogSource, PluginLink } from '@shared/plugin-catalog'
import { pluginText } from '@shared/plugins'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { DialogClose } from '@renderer/components/ui/dialog'
import { SetButton } from '@renderer/features/settings/controls'
import {
  DIALOG_FIELD,
  SettingsDialogBody,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from '@renderer/features/settings/settings-dialog'
import { mediumAgo } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { setMarketplaceTab, type MarketplaceTab } from '@renderer/stores/view'
import { openPlugin, useInstalledPlugins, useSourceReading } from './plugin-hooks'
import type { PluginInstall } from './plugin-install'
import { AddControl, InstalledCheck, ItemRow, KindTag, Publisher, QuietNote } from './rows'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  HARNESS_NAMES,
  PluginInstallContext,
  listedMatches,
  listedSubject,
  listedTitle,
  sourceTitle,
} from './plugin-directory-model'

/** What a plugin is written for: Kettu's own format, or a harness's, which converts on install. */
function FormatTag({ plugin }: { plugin: ListedPlugin }) {
  const { t } = useTranslation('marketplace')
  if (plugin.format === 'kettu') return <KindTag kind="plugin" />
  return (
    <span className="k-mkt-kind" data-kind="plugin" title={t('directory.convertsHint')}>
      <AgentMark agent={plugin.format} size={11} dot={null} />
      {t('directory.harnessPlugin', { harness: HARNESS_NAMES[plugin.format] })}
    </span>
  )
}

/** A plugin of the directory: Install, which shows the consent card first, or its check. */
export function ListedPluginRow({
  plugin,
  source,
  tab,
  fresh,
  card,
}: {
  plugin: ListedPlugin
  source: PluginCatalogSource
  tab: MarketplaceTab
  fresh?: boolean
  card?: boolean
}) {
  const { t } = useTranslation('marketplace')
  const install = useContext(PluginInstallContext)
  const installed = useInstalledPlugins()?.some((item) => item.id === plugin.pluginId) ?? false
  const github = { kind: 'github', url: plugin.url } as const
  const reading = useSourceReading(github)
  const locale = currentLocale()
  const title = listedTitle(plugin, locale)
  const line = pluginText(plugin.descriptions, plugin.description, locale)
  const open = () => openPlugin(plugin.pluginId, tab)
  return (
    <ItemRow
      title={title}
      subject={listedSubject(plugin, source)}
      meta={
        <>
          <FormatTag plugin={plugin} />
          {plugin.author && <Publisher name={plugin.author} />}
          <a
            className="k-mkt-link"
            href={`https://github.com/${plugin.repository}`}
            target="_blank"
            rel="noreferrer"
            title={plugin.url}
          >
            <span>{plugin.repository}</span>
          </a>
        </>
      }
      line={line || null}
      fresh={fresh}
      card={card}
      end={
        installed ? (
          <InstalledCheck name={title} onOpen={open} />
        ) : (
          <AddControl
            name={title}
            label={t('row.install')}
            state={reading ? 'busy' : 'off'}
            onOpen={open}
            onAdd={() =>
              void install?.start(github, {
                catalog: { source: plugin.source, name: plugin.name },
                meta: {
                  publisher: plugin.author ?? plugin.repository.split('/')[0],
                  official: source.trust === 'official' && plugin.format === 'kettu',
                },
                onInstalled: () => setMarketplaceTab('installed'),
              })
            }
          />
        )
      }
    />
  )
}

/** Over the Plugins tab: where the lists come from and when they were read, with Refresh. */
export function DirectoryNote() {
  const { t } = useTranslation('marketplace')
  const { useMarketplaceStore } = useHostScope()
  const catalog = useMarketplaceStore((s) => s.pluginCatalog)
  const loading = useMarketplaceStore((s) => s.pluginCatalogLoading)
  const error = useMarketplaceStore((s) => s.pluginCatalogError)
  const [asked, setAsked] = useState(false)
  const times = (catalog?.sources ?? []).flatMap((source) =>
    source.fetchedAt === null ? [] : [source.fetchedAt],
  )
  const oldest = times.length > 0 ? Math.min(...times) : null
  const text = error
    ? t('directory.failedAll', { error })
    : oldest === null
      ? t('directory.reading')
      : t('directory.readAt', { ago: mediumAgo(oldest) })
  return (
    <QuietNote
      action={
        <Button
          size="md"
          variant="ghost"
          loading={loading && asked}
          disabled={loading}
          icon={<Icon icon={RefreshIcon} size={14} />}
          onClick={() => {
            setAsked(true)
            void useMarketplaceStore
              .getState()
              .loadPluginCatalog(true)
              .finally(() => setAsked(false))
          }}
        >
          {t('directory.refresh')}
        </Button>
      }
    >
      {text}
    </QuietNote>
  )
}

/** The most rows the Add dialog lists of a marketplace at once; a search narrows the rest. */
const PICK_ROWS = 60

/**
 * Huli: the Add dialog's list of a marketplace's plugins, which a github.com link named instead
 * of one plugin. Install reads the one picked and shows its consent card.
 */
export function MarketplacePick({
  market,
  install,
  onBack,
  onDone,
}: {
  market: Extract<PluginLink, { kind: 'marketplace' }>
  install: PluginInstall
  onBack: () => void
  onDone: () => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const locale = currentLocale()
  const [query, setQuery] = useState('')
  const found = market.plugins.filter((plugin) => listedMatches(plugin, query, locale))
  const shown = found.slice(0, PICK_ROWS)
  return (
    <>
      <SettingsDialogHeader
        title={t('plugin.add.marketTitle', { name: sourceTitle(market.source, locale) })}
      >
        {market.plugins.length > 0
          ? t('plugin.add.marketLine', { count: market.plugins.length })
          : t('plugin.add.marketEmpty')}
      </SettingsDialogHeader>
      <SettingsDialogBody className="k-plug-pick">
        {market.plugins.length > 12 && (
          <input
            className={DIALOG_FIELD}
            autoFocus
            spellCheck={false}
            placeholder={t('plugin.add.marketSearch')}
            aria-label={t('plugin.add.marketSearch')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <div className="ui-as-int-grid">
          {shown.map((plugin) => (
            <PickRow
              key={plugin.id}
              plugin={plugin}
              source={market.source}
              install={install}
              onDone={onDone}
            />
          ))}
        </div>
        {found.length > shown.length && (
          <p className="k-plug-quiet">
            {t('plugin.add.marketMore', { count: found.length - shown.length })}
          </p>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <SetButton size="md" variant="ghost" onClick={onBack}>
          {t('plugin.add.back')}
        </SetButton>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
      </SettingsDialogFooter>
    </>
  )
}

function PickRow({
  plugin,
  source,
  install,
  onDone,
}: {
  plugin: ListedPlugin
  source: PluginCatalogSource
  install: PluginInstall
  onDone: () => void
}) {
  const { t } = useTranslation('marketplace')
  const [busy, setBusy] = useState(false)
  const locale = currentLocale()
  const title = listedTitle(plugin, locale)
  return (
    <ItemRow
      title={title}
      subject={listedSubject(plugin, source)}
      meta={
        <>
          <FormatTag plugin={plugin} />
          {plugin.author && <Publisher name={plugin.author} />}
          <span>{plugin.repository}</span>
        </>
      }
      line={pluginText(plugin.descriptions, plugin.description, locale) || null}
      end={
        <Button
          size="md"
          variant="secondary"
          loading={busy}
          aria-label={t('row.action', { action: t('row.install'), name: title })}
          onClick={() => {
            setBusy(true)
            void install
              .start(
                { kind: 'github', url: plugin.url },
                {
                  catalog: { source: plugin.source, name: plugin.name },
                  meta: { publisher: plugin.author ?? plugin.repository.split('/')[0] },
                  onInstalled: () => setMarketplaceTab('installed'),
                },
              )
              .then((shown) => {
                setBusy(false)
                if (shown) onDone()
              })
          }}
        >
          {t('row.install')}
        </Button>
      }
    />
  )
}
