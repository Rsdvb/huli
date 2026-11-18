// Adds Huli's App Intents to the app target: Siri, the Shortcuts app, Spotlight's App Shortcuts and
// the Action button (system/*.swift), with the intent the Control Center controls run
// (widgets/HuliOpenIntents.swift, which withWidgets.js gives the widget extension too: an intent that
// opens the app must be in both). Siri matches the phrases in Chinese only from a zh-Hans
// localization, so they also go into zh-Hans.lproj/AppShortcuts.strings, read from the Swift so the
// two never differ. The app's Info.plist gets the open session's activity type (Handoff and Siri
// suggestions, modules/huli-system) and the other names Siri knows the app by (SPOKEN_NAMES): its
// names, the everyday Chinese word for a kite, and its old names, so phrases learned then still work.

const fs = require('node:fs')
const path = require('node:path')
const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins')

const SOURCES = path.join(__dirname, 'system')
const SHARED = path.join(__dirname, 'widgets', 'HuliOpenIntents.swift')
const PHRASES = path.join(SOURCES, 'HuliAppIntents.swift')
const SPOKEN_NAMES = ['纸鸢', 'Kite', '风筝', '狐狸', 'Huli']

const sourceFiles = () => [
  ...fs
    .readdirSync(SOURCES)
    .filter((name) => name.endsWith('.swift'))
    .sort()
    .map((name) => path.join(SOURCES, name)),
  SHARED,
]

/** The App Shortcuts phrases in the Swift, as AppShortcuts.strings keys them. */
function phrases() {
  const swift = fs.readFileSync(PHRASES, 'utf8')
  const found = new Set()
  for (const match of swift.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    const text = match[1]
    if (!text.includes('\\(.applicationName)')) continue
    found.add(text.replace('\\(.applicationName)', '${applicationName}'))
  }
  if (found.size === 0) throw new Error('withSystem found no App Shortcuts phrases')
  return [...found]
}

const withSystemInfo = (config) =>
  withInfoPlist(config, (config) => {
    const bundle = config.ios?.bundleIdentifier
    if (!bundle) throw new Error('withSystem needs ios.bundleIdentifier')
    const plist = config.modResults
    const types = plist.NSUserActivityTypes ?? []
    const activity = `${bundle}.session`
    if (!types.includes(activity)) types.push(activity)
    plist.NSUserActivityTypes = types
    const names = plist.INAlternativeAppNames ?? []
    for (const name of SPOKEN_NAMES) {
      if (!names.some((entry) => entry.INAlternativeAppName === name)) {
        names.push({ INAlternativeAppName: name })
      }
    }
    plist.INAlternativeAppNames = names
    return config
  })

const withSystemFiles = (config) =>
  withDangerousMod(config, [
    'ios',
    async (config) => {
      const { platformProjectRoot, projectName } = config.modRequest
      const dir = path.join(platformProjectRoot, projectName)
      for (const file of sourceFiles()) {
        await fs.promises.copyFile(file, path.join(dir, path.basename(file)))
      }
      return config
    },
  ])

const withSystemTarget = (config) =>
  withXcodeProject(config, async (config) => {
    const { platformProjectRoot, projectName } = config.modRequest
    let project = config.modResults
    for (const file of sourceFiles()) {
      project = IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: `${projectName}/${path.basename(file)}`,
        groupName: projectName,
        project,
      })
    }
    const strings = Object.fromEntries(phrases().map((phrase) => [phrase, phrase]))
    project = await IOSConfig.Locales.writeStringsFile({
      localesMap: { 'zh-Hans': strings },
      supportingDirectory: path.join(platformProjectRoot, projectName, 'Supporting'),
      fileName: 'AppShortcuts.strings',
      projectName,
      project,
    })
    tidy(project, [
      ...sourceFiles().map((file) => `${projectName}/${path.basename(file)}`),
      'zh-Hans.lproj/AppShortcuts.strings',
    ])
    config.modResults = project
    return config
  })

const unquote = (value) => (typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : value)

/** The xcode package writes the attributes it does not know as `undefined`; Xcode reads them. */
function tidy(project, paths) {
  for (const reference of Object.values(project.pbxFileReferenceSection())) {
    if (typeof reference !== 'object' || !paths.includes(unquote(reference.path))) continue
    for (const [key, value] of Object.entries(reference)) {
      if (value === undefined || value === 'undefined') delete reference[key]
    }
  }
}

module.exports = (config) => withSystemTarget(withSystemFiles(withSystemInfo(config)))
