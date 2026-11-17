// Huli Mobile shares Kettu's protocol code in ../src/shared, as `@shared/...`. Metro watches that
// folder, and the packages that code imports (the noble libraries) resolve as if this app imported
// them, from its own node_modules, never from the desktop's pnpm tree beside it.

const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const shared = path.resolve(projectRoot, '../src/shared')
const appEntry = path.join(projectRoot, 'index.ts')
// The artifact page runtime, which Vite builds for the desktop; here, the committed build of it.
const pageRuntime = path.join(projectRoot, 'src/artifact-view/page-runtime.generated.ts')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [shared]
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')]
config.resolver.blockList = [/src[\\/]shared[\\/]node_modules[\\/].*/]

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest
  if (moduleName === 'virtual:kettu-page-runtime') return resolve(context, pageRuntime, platform)
  if (moduleName.startsWith('@shared/')) {
    const target = path.join(shared, moduleName.slice('@shared/'.length))
    return resolve(context, target, platform)
  }
  const fromShared = context.originModulePath.startsWith(shared + path.sep)
  if (fromShared && !moduleName.startsWith('.') && !path.isAbsolute(moduleName)) {
    return resolve({ ...context, originModulePath: appEntry }, moduleName, platform)
  }
  return resolve(context, moduleName, platform)
}

module.exports = config
