// Adds Huli's Share Extension to the generated iOS project (share-extension/ShareViewController.swift):
// 分享 → Huli from Photos, Safari, Files and other apps. It copies what is shared into the App
// Group container the app and the extension both hold, then opens the app at huli://share?id=<id>.
// The target signs automatically with the app's team.

const fs = require('node:fs')
const path = require('node:path')
const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins')
const { APP_NAME, APP_NAME_ZH } = require('./appName')

const TARGET = 'HuliShareExtension'
const SWIFT = 'ShareViewController.swift'
const INFO = `${TARGET}-Info.plist`
const ENTITLEMENTS = `${TARGET}.entitlements`
// The share sheet's name for it in Chinese, beside the English one in its Info.plist.
const ZH_STRINGS = 'zh-Hans.lproj/InfoPlist.strings'
const EMBED = 'Embed Foundation Extensions'

/** As many as one message carries: the host's ATTACHMENT_LIMIT is 20. */
const MAX_IMAGES = 10
const MAX_FILES = 10

function settingsOf(config) {
  const ios = config.ios ?? {}
  const bundle = ios.bundleIdentifier
  const team = ios.appleTeamId
  const appGroups = ios.entitlements?.['com.apple.security.application-groups'] ?? []
  const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme
  if (!bundle || !team || appGroups.length === 0 || !scheme) {
    throw new Error(
      'withShareExtension needs ios.bundleIdentifier, ios.appleTeamId, an App Group and a scheme',
    )
  }
  return {
    team,
    extension: `${bundle}.share`,
    appGroup: appGroups[0],
    scheme,
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
  if (typeof value === 'number') return `<integer>${value}</integer>`
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

const withExtensionFiles = (config) =>
  withDangerousMod(config, [
    'ios',
    async (config) => {
      const settings = settingsOf(config)
      const dir = path.join(config.modRequest.platformProjectRoot, TARGET)
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.copyFile(
        path.join(__dirname, 'share-extension', SWIFT),
        path.join(dir, SWIFT),
      )
      const info = {
        CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
        // What the share sheet names it.
        CFBundleDisplayName: APP_NAME,
        CFBundleExecutable: '$(EXECUTABLE_NAME)',
        CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
        CFBundleInfoDictionaryVersion: '6.0',
        CFBundleName: '$(PRODUCT_NAME)',
        CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
        // App Store Connect refuses an extension whose version differs from its app's.
        CFBundleShortVersionString: settings.version,
        CFBundleVersion: settings.build,
        // Read by ShareViewController.swift.
        HuliAppGroup: settings.appGroup,
        HuliURLScheme: settings.scheme,
        NSExtension: {
          NSExtensionAttributes: {
            NSExtensionActivationRule: {
              NSExtensionActivationSupportsImageWithMaxCount: MAX_IMAGES,
              NSExtensionActivationSupportsFileWithMaxCount: MAX_FILES,
              NSExtensionActivationSupportsWebURLWithMaxCount: 1,
              NSExtensionActivationSupportsText: true,
            },
          },
          NSExtensionPointIdentifier: 'com.apple.share-services',
          NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareViewController',
        },
      }
      const entitlements = { 'com.apple.security.application-groups': [settings.appGroup] }
      await fs.promises.writeFile(path.join(dir, INFO), plist(info))
      await fs.promises.writeFile(path.join(dir, ENTITLEMENTS), plist(entitlements))
      await fs.promises.mkdir(path.join(dir, path.dirname(ZH_STRINGS)), { recursive: true })
      await fs.promises.writeFile(
        path.join(dir, ZH_STRINGS),
        `"CFBundleDisplayName" = "${APP_NAME_ZH}";\n`,
      )
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

/**
 * The xcode package gives each extension target its own "Copy Files" phase in the app. The
 * extension goes into the app's one embedding phase when another extension made it already;
 * otherwise this phase becomes it, right after the app's resources and ahead of its script phases,
 * since an extension embedded after a script phase makes Xcode report a dependency cycle.
 */
function embed(project, app) {
  const phases = app.firstTarget.buildPhases
  const copyPhases = project.hash.project.objects.PBXCopyFilesBuildPhase
  const added = phases.findIndex((phase) => phase.comment === 'Copy Files')
  if (added < 0) return
  const id = phases[added].value
  const existing = phases.find((phase) => phase.comment === EMBED)
  if (existing) {
    copyPhases[existing.value].files.push(...copyPhases[id].files)
    delete copyPhases[id]
    delete copyPhases[`${id}_comment`]
    phases.splice(added, 1)
    return
  }
  copyPhases[id].name = `"${EMBED}"`
  copyPhases[`${id}_comment`] = EMBED
  phases[added].comment = EMBED
  const resources = phases.findIndex((phase) => phase.comment === 'Resources')
  if (resources >= 0 && added > resources) {
    const [phase] = phases.splice(added, 1)
    phases.splice(resources + 1, 0, phase)
  }
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
        // Xcode refuses an extension without it; ShareViewController reaches UIApplication's
        // open(_:) through the runtime instead.
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
    IOSConfig.XcodeUtils.ensureGroupRecursively(project, `${TARGET}/${path.dirname(ZH_STRINGS)}`)
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: ZH_STRINGS,
      groupName: `${TARGET}/${path.dirname(ZH_STRINGS)}`,
      project,
      isBuildFile: true,
      targetUuid: target.uuid,
    })
    project.addTargetAttribute('DevelopmentTeam', settings.team, target)
    project.addTargetAttribute('ProvisioningStyle', 'Automatic', target)
    embed(project, app)
    return config
  })

module.exports = (config) => withExtensionTarget(withExtensionFiles(config))
