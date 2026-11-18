// Adds Huli's widget extension to the generated iOS project: the sessions widget and the Live
// Activity (widgets/*.swift, with the activity's type from modules/huli-live, which the app's own
// HuliLive module compiles too, so both sides agree on it). The extension reads the widget's
// snapshot from the App Group and opens the computer's sealed Live Activity content with the keys
// in the Keychain access group <bundle id>.shared, both of which the app holds too. The app gets
// NSSupportsLiveActivities and the App Group's name in its Info.plist. It signs automatically with
// the app's team.

const fs = require('node:fs')
const path = require('node:path')
const { APP_NAME } = require('./appName')
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins')

const TARGET = 'HuliWidgets'
const INFO = `${TARGET}-Info.plist`
const ENTITLEMENTS = `${TARGET}.entitlements`
const SOURCES = path.join(__dirname, 'widgets')
const SHARED = path.join('modules', 'huli-live', 'ios', 'HuliActivityAttributes.swift')
const EMBED = 'Embed Foundation Extensions'
/** ActivityKit's content API, which the extension uses throughout. */
const MIN_IOS = '16.2'

const swiftFiles = () => [
  ...fs
    .readdirSync(SOURCES)
    .filter((name) => name.endsWith('.swift'))
    .sort(),
  path.basename(SHARED),
]

function settingsOf(config) {
  const ios = config.ios ?? {}
  const bundle = ios.bundleIdentifier
  const team = ios.appleTeamId
  const appGroups = ios.entitlements?.['com.apple.security.application-groups'] ?? []
  if (!bundle || !team || appGroups.length === 0) {
    throw new Error('withWidgets needs ios.bundleIdentifier, ios.appleTeamId and an App Group')
  }
  return {
    bundle,
    team,
    extension: `${bundle}.widgets`,
    appGroups,
    keychainGroup: `$(AppIdentifierPrefix)${bundle}.shared`,
    version: config.version ?? '1.0.0',
    build: ios.buildNumber ?? '1',
  }
}

const escape = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function plistValue(value, indent) {
  const pad = '\t'.repeat(indent)
  if (Array.isArray(value)) {
    const items = value.map((item) => `${pad}\t${plistValue(item, indent + 1)}`).join('\n')
    return `<array>\n${items}\n${pad}</array>`
  }
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(
        ([key, item]) =>
          `${pad}\t<key>${escape(key)}</key>\n${pad}\t${plistValue(item, indent + 1)}`,
      )
      .join('\n')
    return `<dict>\n${entries}\n${pad}</dict>`
  }
  return `<string>${escape(value)}</string>`
}

function plist(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(value, 0),
    '</plist>',
    '',
  ].join('\n')
}

/** The app allows Live Activities and tells its HuliLive module where the widget's data goes. */
const withAppInfo = (config) =>
  withInfoPlist(config, (config) => {
    const { appGroups } = settingsOf(config)
    config.modResults.NSSupportsLiveActivities = true
    config.modResults.HuliAppGroup = appGroups[0]
    return config
  })

/** The app's default access group first, so its other Keychain items stay its own. */
const withAppKeychainGroup = (config) =>
  withEntitlementsPlist(config, (config) => {
    const { bundle, keychainGroup } = settingsOf(config)
    const groups = config.modResults['keychain-access-groups'] ?? []
    for (const group of [`$(AppIdentifierPrefix)${bundle}`, keychainGroup]) {
      if (!groups.includes(group)) groups.push(group)
    }
    config.modResults['keychain-access-groups'] = groups
    return config
  })

const withExtensionFiles = (config) =>
  withDangerousMod(config, [
    'ios',
    async (config) => {
      const settings = settingsOf(config)
      const dir = path.join(config.modRequest.platformProjectRoot, TARGET)
      await fs.promises.mkdir(dir, { recursive: true })
      for (const name of swiftFiles()) {
        const from =
          name === path.basename(SHARED)
            ? path.join(config.modRequest.projectRoot, SHARED)
            : path.join(SOURCES, name)
        await fs.promises.copyFile(from, path.join(dir, name))
      }
      const info = {
        CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
        CFBundleDisplayName: APP_NAME,
        CFBundleExecutable: '$(EXECUTABLE_NAME)',
        CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
        CFBundleInfoDictionaryVersion: '6.0',
        CFBundleName: '$(PRODUCT_NAME)',
        CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
        // App Store Connect refuses an extension whose version differs from its app's.
        CFBundleShortVersionString: settings.version,
        CFBundleVersion: settings.build,
        HuliAppGroup: settings.appGroups[0],
        NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' },
      }
      const entitlements = {
        'com.apple.security.application-groups': settings.appGroups,
        'keychain-access-groups': [settings.keychainGroup],
      }
      await fs.promises.writeFile(path.join(dir, INFO), plist(info))
      await fs.promises.writeFile(path.join(dir, ENTITLEMENTS), plist(entitlements))
      return config
    },
  ])

const quote = (value) => (/^[A-Za-z0-9_.]+$/.test(value) ? value : `"${value}"`)

const unquote = (value) => (typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : value)

/** The higher of two iOS versions such as 16.4. */
function laterVersion(a, b) {
  const parts = (v) => String(unquote(v)).split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff > 0 ? unquote(a) : unquote(b)
  }
  return unquote(a)
}

/**
 * The xcode package writes the attributes it does not know as `undefined`, and adds build files
 * for every file of a group; the plists belong to no build phase.
 */
function tidy(project, group, sources) {
  const references = project.pbxFileReferenceSection()
  const ids = group.pbxGroup.children.map((child) => child.value)
  for (const reference of Object.values(references)) {
    if (typeof reference !== 'object') continue
    const name = unquote(reference.path)
    if (![...sources, INFO, ENTITLEMENTS, `${TARGET}.appex`].includes(name)) continue
    for (const [key, value] of Object.entries(reference)) {
      if (value === undefined || value === 'undefined' || value === 'unknown') delete reference[key]
    }
    if (name === ENTITLEMENTS) reference.lastKnownFileType = 'text.plist.entitlements'
  }
  const buildFiles = project.pbxBuildFileSection()
  for (const [key, file] of Object.entries(buildFiles)) {
    if (typeof file !== 'object' || !ids.includes(file.fileRef)) continue
    const name = unquote(references[file.fileRef]?.path)
    if (name === INFO || name === ENTITLEMENTS) {
      delete buildFiles[key]
      delete buildFiles[`${key}_comment`]
    }
  }
}

function buildSettingsOf(project, target) {
  const list = project.pbxXCConfigurationList()[target.buildConfigurationList]
  const section = project.pbxXCBuildConfigurationSection()
  return list.buildConfigurations.map(({ value }) => section[value])
}

/**
 * Embeds the extension with the app's other extensions: in their phase when another plugin made
 * one, or in its own, renamed and moved right after the app's resources, ahead of its script
 * phases (an extension embedded after a script phase makes Xcode report a dependency cycle).
 */
function embed(project, app) {
  const objects = project.hash.project.objects
  const copyPhases = objects.PBXCopyFilesBuildPhase
  const phases = app.firstTarget.buildPhases
  const mine = phases.findIndex((phase) => phase.comment === 'Copy Files')
  if (mine < 0) return
  const mineId = phases[mine].value
  const other = phases.find(
    (phase) => phase.comment === EMBED && Number(copyPhases[phase.value]?.dstSubfolderSpec) === 13,
  )
  if (other) {
    copyPhases[other.value].files.push(...copyPhases[mineId].files)
    phases.splice(mine, 1)
    delete copyPhases[mineId]
    delete copyPhases[`${mineId}_comment`]
    return
  }
  copyPhases[mineId].name = `"${EMBED}"`
  copyPhases[`${mineId}_comment`] = EMBED
  phases[mine].comment = EMBED
  const resources = phases.findIndex((phase) => phase.comment === 'Resources')
  if (resources >= 0 && mine > resources) {
    const [phase] = phases.splice(mine, 1)
    phases.splice(resources + 1, 0, phase)
  }
}

const withExtensionTarget = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults
    if (project.pbxTargetByName(TARGET)) return config
    const settings = settingsOf(config)
    const sources = swiftFiles()
    const objects = project.hash.project.objects
    objects.PBXTargetDependency = objects.PBXTargetDependency ?? {}
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {}

    const group = project.addPbxGroup([...sources, INFO, ENTITLEMENTS], TARGET, TARGET)
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup)

    const app = project.getFirstTarget()
    const target = project.addTarget(TARGET, 'app_extension', TARGET, settings.extension)
    project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid)
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)
    tidy(project, group, sources)

    const appSettings = buildSettingsOf(project, app.firstTarget)
    for (const configuration of buildSettingsOf(project, target.pbxNativeTarget)) {
      const fromApp = appSettings.find((c) => c.name === configuration.name)?.buildSettings ?? {}
      const deployment = fromApp.IPHONEOS_DEPLOYMENT_TARGET
        ? laterVersion(fromApp.IPHONEOS_DEPLOYMENT_TARGET, MIN_IOS)
        : MIN_IOS
      Object.assign(configuration.buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: 'YES',
        CLANG_ENABLE_MODULES: 'YES',
        CODE_SIGN_ENTITLEMENTS: quote(`${TARGET}/${ENTITLEMENTS}`),
        CODE_SIGN_STYLE: 'Automatic',
        DEVELOPMENT_TEAM: settings.team,
        GENERATE_INFOPLIST_FILE: 'NO',
        IPHONEOS_DEPLOYMENT_TARGET: deployment,
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: fromApp.TARGETED_DEVICE_FAMILY ?? quote('1,2'),
        ...(configuration.name === 'Debug'
          ? {
              SWIFT_OPTIMIZATION_LEVEL: quote('-Onone'),
              SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG',
            }
          : { SWIFT_OPTIMIZATION_LEVEL: quote('-O'), SWIFT_COMPILATION_MODE: 'wholemodule' }),
      })
    }
    project.addTargetAttribute('DevelopmentTeam', settings.team, target)
    project.addTargetAttribute('ProvisioningStyle', 'Automatic', target)
    embed(project, app)
    return config
  })

module.exports = (config) =>
  withExtensionTarget(withExtensionFiles(withAppKeychainGroup(withAppInfo(config))))
