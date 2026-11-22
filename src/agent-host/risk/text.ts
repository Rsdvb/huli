// A verdict's reason as the card says it, in the host's language: the reason, then what it names.

import { t } from '../i18n'
import type { Verdict } from './verdict'

export function riskReason(verdict: Pick<Verdict, 'reason' | 'detail'>): string {
  const reason = t(`risk.reason.${verdict.reason}`)
  return verdict.detail ? t('risk.detail', { reason, detail: verdict.detail }) : reason
}
