// Huli: Kite's name and artwork in `pnpm dev`, which runs the tree as it is. Before a build the
// rebrand writes its swaps into the files; this makes the same ones (brand-text.mjs) as the dev
// build loads each file, so a dev run's window, tray, menus and copy say Kite while the tree stays
// as committed. It never fills in the update channel's path. See tools/huli/README.md.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { ARTWORK, CODE, brandCode, brandLocale } from './brand-text.mjs'

/**
 * Artwork an unpackaged run reads from the tree at run time, which a build has the rebrand copy
 * over: the window's and Dock's icon (Kettu's app icon picker, whose default Kite's mirror holds)
 * and the tray's images, pointed at Kite's in ARTWORK instead.
 */
const RUNTIME_ARTWORK = {
  'src/main/app-icon.ts': [
    [
      "join(paths?.appPath ?? app.getAppPath(), 'resources', 'app-icons')",
      `join(paths?.appPath ?? app.getAppPath(), '${ARTWORK}/resources', 'app-icons')`,
    ],
  ],
  'src/main/tray.ts': [
    [
      "join(app.getAppPath(), 'resources', 'tray')",
      `join(app.getAppPath(), '${ARTWORK}/resources', 'tray')`,
    ],
  ],
}

const LOCALE = /^src\/shared\/locales\/([^/]+)\/([^/]+\.json)$/
const PICTURE = /\.(svg|webp|png|ico)(\?.*)?$/

/** The plugin for electron-vite's builds; `root` is the repository's. */
export function devBrand(root) {
  const relative = (file) => path.relative(root, file.split('?')[0]).replaceAll('\\', '/')
  const warned = new Set()
  return {
    name: 'huli:dev-brand',
    enforce: 'pre',
    // `electron-vite dev` builds in development mode; a release build runs the rebrand instead.
    apply: (_config, env) => env.mode === 'development',

    // An import of Kettu's artwork that Kite has its own of, such as the renderer's mark.
    async resolveId(source, importer, options) {
      if (!importer || !PICTURE.test(source)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved || resolved.external) return null
      const file = relative(resolved.id)
      if (file.startsWith('..') || path.isAbsolute(file)) return null
      const kite = path.join(root, ARTWORK, file)
      if (!existsSync(kite)) return null
      const query = resolved.id.indexOf('?')
      return query === -1 ? kite : kite + resolved.id.slice(query)
    },

    transform(code, id) {
      const file = relative(id)
      const locale = LOCALE.exec(file)
      if (locale) {
        const catalog = brandLocale(JSON.parse(code), locale[2], locale[1])
        return { code: JSON.stringify(catalog), map: null }
      }
      const swaps = [...(CODE[file] ?? []), ...(RUNTIME_ARTWORK[file] ?? [])]
      if (swaps.length === 0) return null
      const { text, missing } = brandCode(code, swaps)
      for (const swap of missing) {
        if (warned.has(`${file} ${swap}`)) continue
        warned.add(`${file} ${swap}`)
        this.warn(`${file} no longer holds ${swap}; Kite's name is missing there in dev`)
      }
      return { code: text, map: null }
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const swaps = CODE[relative(context.filename)]
        return swaps ? brandCode(html, swaps).text : html
      },
    },
  }
}
