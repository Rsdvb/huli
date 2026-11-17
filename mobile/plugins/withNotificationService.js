// Adds Huli's Notification Service Extension to the generated iOS project, which opens the
// notifications computers seal to this phone (notification-service/NotificationService.swift).
// The app and the extension share a Keychain access group, <bundle id>.shared, where the app keeps
// the keys the extension opens them with. Both targets sign automatically with the app's team.

const fs = require('node:fs')
const path = require('node:path')
const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('expo/config-plugins')

const TARGET = 'HuliNotificationService'
const SWIFT = 'NotificationService.swift'
const INFO = `${TARGET}-Info.plist`
const ENTITLEMENTS = `${TARGET}.entitlements`

function settingsOf(config) {
  const ios = config.ios ?? {}
  const bundle = ios.bundleIdentifier
  const team = ios.appleTeamId
  if (!bundle || !team) {
    throw new Error('withNotificationService needs ios.bundleIdentifier and ios.appleTeamId')
  }
  return {
    bundle,
    team,
    extension: `${bundle}.notifications`,
    appGroups: ios.entitlements?.['com.apple.security.application-groups'] ?? [],
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

/** The app's own default access group first, so its other Keychain items stay its own. */
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
      await fs.promises.copyFile(
        path.join(__dirname, 'notification-service', SWIFT),
        path.join(dir, SWIFT),
      )
      const info = {
        CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
        CFBundleDisplayName: config.name,
        CFBundleExecutable: '$(EXECUTABLE_NAME)',
        CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
        CFBundleInfoDictionaryVersion: '6.0',
        CFBundleName: '$(PRODUCT_NAME)',
        CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
        // App Store Connect refuses an extension whose version differs from its app's.
        CFBundleShortVersionString: settings.version,
        CFBundleVersion: settings.build,
        NSExtension: {
          NSExtensionPointIdentifier: 'com.apple.usernotifications.service',
          NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).NotificationService',
        },
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

/**
 * The xcode package writes the attributes it does not know as `undefined`, and adds build files
 * for every file of a group; the plists belong to no build phase.
 */
function tidy(project, group) {
  const references = project.pbxFileReferenceSection()
  const ids = group.pbxGroup.children.map((child) => child.value)
  for (const reference of Object.values(references)) {
    if (typeof reference !== 'object') continue
    const name = unquote(reference.path)
    if (![SWIFT, INFO, ENTITLEMENTS, `${TARGET}.appex`].includes(name)) continue
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

const withExtensionTarget = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults
    if (project.pbxTargetByName(TARGET)) return config
    const settings = settingsOf(config)
    const objects = project.hash.project.objects
    objects.PBXTargetDependency = objects.PBXTargetDependency ?? {}
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {}

    const group = project.addPbxGroup([SWIFT, INFO, ENTITLEMENTS], TARGET, TARGET)
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup)

    const app = project.getFirstTarget()
    const target = project.addTarget(TARGET, 'app_extension', TARGET, settings.extension)
    project.addBuildPhase([SWIFT], 'PBXSourcesBuildPhase', 'Sources', target.uuid)
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)
    tidy(project, group)

    const appSettings = buildSettingsOf(project, app.firstTarget)
    for (const configuration of buildSettingsOf(project, target.pbxNativeTarget)) {
      const fromApp = appSettings.find((c) => c.name === configuration.name)?.buildSettings ?? {}
      Object.assign(configuration.buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: 'YES',
        CLANG_ENABLE_MODULES: 'YES',
        CODE_SIGN_ENTITLEMENTS: quote(`${TARGET}/${ENTITLEMENTS}`),
        CODE_SIGN_STYLE: 'Automatic',
        DEVELOPMENT_TEAM: settings.team,
        GENERATE_INFOPLIST_FILE: 'NO',
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: fromApp.TARGETED_DEVICE_FAMILY ?? quote('1,2'),
        ...(fromApp.IPHONEOS_DEPLOYMENT_TARGET
          ? { IPHONEOS_DEPLOYMENT_TARGET: fromApp.IPHONEOS_DEPLOYMENT_TARGET }
          : {}),
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

    // Embedded right after the app's resources, ahead of its script phases: an extension embedded
    // after a script phase makes Xcode report a dependency cycle. Another extension's plugin may
    // have made that phase already, and then this one joins it.
    const phases = app.firstTarget.buildPhases
    const embed = phases.findIndex((phase) => phase.comment === 'Copy Files')
    const resources = phases.findIndex((phase) => phase.comment === 'Resources')
    const existing = phases.find((phase) => phase.comment === 'Embed Foundation Extensions')
    if (embed >= 0 && existing) {
      const copyPhases = objects.PBXCopyFilesBuildPhase
      const id = phases[embed].value
      copyPhases[existing.value].files.push(...copyPhases[id].files)
      delete copyPhases[id]
      delete copyPhases[`${id}_comment`]
      phases.splice(embed, 1)
    } else if (embed >= 0) {
      const copyPhases = objects.PBXCopyFilesBuildPhase
      const id = phases[embed].value
      copyPhases[id].name = '"Embed Foundation Extensions"'
      copyPhases[`${id}_comment`] = 'Embed Foundation Extensions'
      phases[embed].comment = 'Embed Foundation Extensions'
      if (resources >= 0 && embed > resources) {
        const [phase] = phases.splice(embed, 1)
        phases.splice(resources + 1, 0, phase)
      }
    }
    return config
  })

module.exports = (config) => withExtensionTarget(withExtensionFiles(withAppKeychainGroup(config)))
