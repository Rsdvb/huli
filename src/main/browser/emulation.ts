// Huli: what a tab emulates (browser_emulate), applied over its debugger. A device's size is the
// tab's viewport, which views.ts lays the page out at; the rest are the DevTools protocol's own
// overrides, which stay with the page across its navigations until changed. Nothing is sent for a
// tab that emulates nothing.

import type { BrowserEmulation, EmulatedDevice } from '@shared/browser-args'

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** A mobile browser's user agent for a device, with this Chromium's version where it shows one. */
export function deviceUserAgent(
  agent: EmulatedDevice['agent'],
  chrome = process.versions.chrome ?? '130.0.0.0',
): string | null {
  const major = chrome.split('.')[0] ?? '130'
  switch (agent) {
    case 'ios':
      return 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
    case 'ipad':
      return 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
    case 'android':
      return `Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
    default:
      return null
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Sends the overrides that differ between `before` and `after`, or all of `after` with `all`, as
 * when a tab's page was made again. `userAgent` is the partition's own, which a locale keeps while
 * it changes only the languages the page is sent. Throws the first command that fails.
 */
export async function applyEmulation(
  send: Send,
  before: BrowserEmulation,
  after: BrowserEmulation,
  userAgent: string,
  all = false,
): Promise<void> {
  const changed = (key: keyof BrowserEmulation): boolean => all || !same(before[key], after[key])
  if (changed('device') || changed('locale')) {
    const agent = deviceUserAgent(after.device?.agent ?? null)
    if (agent === null && after.locale === null) {
      // An empty agent takes the override off.
      await send('Emulation.setUserAgentOverride', { userAgent: '' })
    } else {
      await send('Emulation.setUserAgentOverride', {
        userAgent: agent ?? userAgent,
        ...(after.locale ? { acceptLanguage: after.locale } : {}),
      })
    }
  }
  if (changed('device')) {
    const touch = after.device?.touch ?? false
    await send('Emulation.setTouchEmulationEnabled', {
      enabled: touch,
      ...(touch ? { maxTouchPoints: 5 } : {}),
    })
    await send('Emulation.setEmitTouchEventsForMouse', {
      enabled: touch,
      ...(touch ? { configuration: after.device?.mobile ? 'mobile' : 'desktop' } : {}),
    })
  }
  if (changed('colorScheme') || changed('reducedMotion')) {
    const features: { name: string; value: string }[] = []
    if (after.colorScheme) features.push({ name: 'prefers-color-scheme', value: after.colorScheme })
    if (after.reducedMotion) {
      features.push({ name: 'prefers-reduced-motion', value: after.reducedMotion })
    }
    await send('Emulation.setEmulatedMedia', { media: '', features })
  }
  if (changed('locale')) {
    await send('Emulation.setLocaleOverride', after.locale ? { locale: after.locale } : {})
  }
  if (changed('timezone')) {
    await send('Emulation.setTimezoneOverride', { timezoneId: after.timezone ?? '' })
  }
  if (changed('geolocation')) {
    // Turned off, the override stays as "position unavailable" rather than being cleared: a page
    // that watched the position while it was granted must never get the computer's own.
    const at = after.geolocation
    await send(
      'Emulation.setGeolocationOverride',
      at ? { latitude: at.latitude, longitude: at.longitude, accuracy: at.accuracy } : {},
    )
  }
  if (changed('network')) {
    const net = after.network
    await send(
      'Network.emulateNetworkConditions',
      net
        ? {
            offline: net.offline,
            latency: net.latencyMs,
            downloadThroughput: net.offline ? 0 : (net.downloadKbps * 1000) / 8,
            uploadThroughput: net.offline ? 0 : (net.uploadKbps * 1000) / 8,
          }
        : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    )
  }
}

/** The emulation in a line, as the agent reads it. */
export function emulationText(emulation: BrowserEmulation): string {
  const parts: string[] = []
  const { device, network, geolocation } = emulation
  if (device) {
    parts.push(
      `${device.label ?? 'a custom viewport'} at ${device.width}x${device.height}` +
        `${device.scale === 1 ? '' : ` @${device.scale}x`}${device.touch ? ' with touch' : ''}`,
    )
  }
  if (emulation.colorScheme) parts.push(`${emulation.colorScheme} color scheme`)
  if (emulation.reducedMotion === 'reduce') parts.push('reduced motion')
  if (emulation.reducedMotion === 'no-preference') parts.push('no motion preference')
  if (emulation.locale) parts.push(`locale ${emulation.locale}`)
  if (emulation.timezone) parts.push(`time zone ${emulation.timezone}`)
  if (geolocation) parts.push(`location ${geolocation.latitude}, ${geolocation.longitude}`)
  if (network) {
    parts.push(
      network.offline
        ? 'offline'
        : network.preset
          ? `${network.preset} network`
          : `a network of ${network.downloadKbps} kbps down, ${network.uploadKbps} up, ${network.latencyMs} ms`,
    )
  }
  return parts.length === 0 ? 'nothing' : parts.join(', ')
}

/** The emulation as `browser_emulate` answers it, in the tool's own argument names. */
export function emulationValue(emulation: BrowserEmulation): Record<string, unknown> {
  const { device, network, geolocation } = emulation
  return {
    device: device
      ? {
          name: device.label,
          width: device.width,
          height: device.height,
          device_scale_factor: device.scale,
          mobile: device.mobile,
          touch: device.touch,
        }
      : null,
    color_scheme: emulation.colorScheme,
    reduced_motion: emulation.reducedMotion,
    locale: emulation.locale,
    timezone: emulation.timezone,
    geolocation,
    network: network
      ? (network.preset ?? {
          latency_ms: network.latencyMs,
          download_kbps: network.downloadKbps,
          upload_kbps: network.uploadKbps,
        })
      : null,
  }
}
