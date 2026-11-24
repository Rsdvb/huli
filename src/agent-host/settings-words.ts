// The words of the settings rows the settings tools list and change, apart from the host's own
// catalog: main and the usage worker share code that writes the host's text, and never need these.
// Huli's account and import rows take their words from catalogs of their own.

import i18next from 'i18next'
import enAgentHistory from '@shared/locales/en/agentHistory.json'
import enHuliAccount from '@shared/locales/en/huliAccount.json'
import enSettings from '@shared/locales/en/settings.json'
import enUsage from '@shared/locales/en/usage.json'
import zhCNAgentHistory from '@shared/locales/zh-CN/agentHistory.json'
import zhCNHuliAccount from '@shared/locales/zh-CN/huliAccount.json'
import zhCNSettings from '@shared/locales/zh-CN/settings.json'
import zhCNUsage from '@shared/locales/zh-CN/usage.json'
import './i18n'

const CATALOGS = {
  en: {
    settings: enSettings,
    usage: enUsage,
    huliAccount: enHuliAccount,
    agentHistory: enAgentHistory,
  },
  'zh-CN': {
    settings: zhCNSettings,
    usage: zhCNUsage,
    huliAccount: zhCNHuliAccount,
    agentHistory: zhCNAgentHistory,
  },
}

for (const [locale, catalogs] of Object.entries(CATALOGS)) {
  for (const [ns, words] of Object.entries(catalogs)) i18next.addResourceBundle(locale, ns, words)
}

type Loose = (key: string, params?: Record<string, string | number>) => string

/** A settings row's words in the user's language, from `settings` or as `usage:key`. */
export const tSettings = i18next.getFixedT(null, 'settings') as unknown as Loose

/** The same words in English, for the English name agents also get. */
export const tSettingsEnglish = i18next.getFixedT('en', 'settings') as unknown as Loose
