// Lets the Android app open ws:// to a computer on the local network or Tailscale. A release build
// refuses cleartext by default, which left it only the relay. The link is end-to-end encrypted by
// its own channel (Noise) either way, so the socket's transport adds nothing to hide.

const { withAndroidManifest } = require('expo/config-plugins')

module.exports = (config) =>
  withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0]
    if (application) application.$['android:usesCleartextTraffic'] = 'true'
    return config
  })
