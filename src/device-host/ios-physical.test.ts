// Huli: Kite pins agent-device 0.21.41 (its batch steps), to which Kettu's patch of 0.21.36 that
// replaces the removed `xcdevice wait` probe does not apply, so only the discovery's own parsing is
// checked here; the patched control's cases went with the patch.
import { describe, expect, it } from 'vitest'
import { parseDevicectl } from './discovery'

const IPAD_UDID = '00008112-0011223344556677'

describe('parseDevicectl', () => {
  it('accepts physical devices reporting iOS or iPadOS platform and ignores simulators', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            identifier: 'A1',
            hardwareProperties: {
              udid: '00008150-000125C03AE2401C',
              reality: 'physical',
              platform: 'iOS',
              marketingName: 'iPhone Air',
              productType: 'iPhone18,4',
            },
            connectionProperties: {
              transportType: 'wired',
              pairingState: 'paired',
            },
            deviceProperties: {
              name: 'My iPhone',
              osVersionNumber: '26.3.1',
              developerModeStatus: 'enabled',
              ddiServicesAvailable: true,
            },
          },
          {
            identifier: 'A2',
            hardwareProperties: {
              udid: IPAD_UDID,
              reality: 'physical',
              platform: 'iPadOS',
              marketingName: 'iPad Pro',
              productType: 'iPad16,3',
            },
            connectionProperties: {
              transportType: 'wired',
              pairingState: 'paired',
            },
            deviceProperties: {
              name: 'Lab iPad',
              osVersionNumber: '26.3.1',
              developerModeStatus: 'enabled',
              ddiServicesAvailable: true,
            },
          },
          {
            identifier: 'SIM1',
            hardwareProperties: {
              udid: '5B16E000-67EA-488C-BF12-895F1D400139',
              reality: 'simulated',
              platform: 'iOS',
            },
            deviceProperties: { name: 'Simulator' },
          },
          {
            identifier: 'WATCH1',
            hardwareProperties: {
              udid: 'WATCH-UDID',
              reality: 'physical',
              platform: 'watchOS',
            },
            deviceProperties: { name: 'Apple Watch' },
          },
        ],
      },
    })

    const devices = parseDevicectl(json)
    expect(devices).toHaveLength(2)
    expect(devices[0]).toMatchObject({
      id: 'ios:00008150-000125C03AE2401C',
      platform: 'ios',
      kind: 'physical',
      name: 'My iPhone',
      connection: 'usb',
      problems: [],
    })
    expect(devices[1]).toMatchObject({
      id: `ios:${IPAD_UDID}`,
      platform: 'ios',
      kind: 'physical',
      name: 'Lab iPad',
      osVersion: '26.3.1',
      model: 'iPad Pro',
      state: 'connected',
      connection: 'usb',
      problems: [],
      target: IPAD_UDID,
    })
  })
})
