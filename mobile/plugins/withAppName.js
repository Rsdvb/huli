// Names the app Kite on iOS and Android (plugins/appName.js), where Expo would use expo.name.

const { AndroidConfig, withInfoPlist, withStringsXml } = require('expo/config-plugins')
const { APP_NAME } = require('./appName')

const withIosName = (config) =>
  withInfoPlist(config, (config) => {
    config.modResults.CFBundleDisplayName = APP_NAME
    return config
  })

const withAndroidName = (config) =>
  withStringsXml(config, (config) => {
    config.modResults = AndroidConfig.Strings.setStringItem(
      [{ $: { name: 'app_name' }, _: APP_NAME }],
      config.modResults,
    )
    return config
  })

module.exports = (config) => withAndroidName(withIosName(config))
