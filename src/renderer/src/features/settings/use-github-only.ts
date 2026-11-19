import { useSettingsStore } from '@renderer/stores/settings'
import { CHANNEL_ONLY } from '@shared/updates'
import { useCloudOffHere } from './use-cloud-off-here'

/** Whether updates come from GitHub only, as chosen or because Kettu's services are off here. */
export function useGitHubOnly(): boolean {
  const chosen = useSettingsStore((s) => s.settings.updates.source === 'github')
  // Huli: Kite's one channel stands where GitHub only would, so its failure reads as the channel's.
  return useCloudOffHere() || chosen || CHANNEL_ONLY
}
