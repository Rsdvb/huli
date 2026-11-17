// Renders Huli's icons from fox.svg: the desktop app's (build/icon.png, build/icon.ico) and the
// phone app's (mobile/assets). Needs @resvg/resvg-js, installed beside this script only when the
// icon changes:
//
//   npm i --no-save --prefix tools/huli/icon @resvg/resvg-js
//   node tools/huli/icon/render.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..', '..')
const { Resvg } = createRequire(path.join(here, 'package.json'))('@resvg/resvg-js')

const fox = readFileSync(path.join(here, 'fox.svg'), 'utf8')
  .replace(/^[\s\S]*?<g /, '<g ')
  .replace(/<\/svg>\s*$/, '')

const GRADIENT = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#FFA64D"/>
    <stop offset="0.55" stop-color="#F47A2C"/>
    <stop offset="1" stop-color="#D9471B"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.3" cy="0.22" r="0.75">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.28"/>
    <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>
</defs>`

/** The fox scaled by `scale` about the canvas's centre, nudged down by `dy`. */
const placed = (scale, dy = 0) =>
  `<g transform="translate(512 ${512 + dy}) scale(${scale}) translate(-512 -530)">${fox}</g>`

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${GRADIENT}${body}</svg>`

const designs = {
  // macOS-style tile with its margin, which Windows and Linux show as is.
  desktop: svg(
    `<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
     <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#glow)"/>
     ${placed(0.74)}`,
  ),
  // iOS masks the corners itself, so the square is full.
  ios: svg(
    `<rect width="1024" height="1024" fill="url(#bg)"/><rect width="1024" height="1024" fill="url(#glow)"/>${placed(0.9)}`,
  ),
  // Android's adaptive icon: the fox inside the 66% safe zone, on its own layer.
  androidForeground: svg(placed(0.6)),
  androidBackground: svg(`<rect width="1024" height="1024" fill="url(#bg)"/>`),
  androidMonochrome: svg(placed(0.6))
    .replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#000000"')
    .replace(/stroke="#[0-9A-Fa-f]{6}"/g, 'stroke="#000000"'),
}

function png(design, size) {
  return new Resvg(designs[design], { fitTo: { mode: 'width', value: size } }).render().asPng()
}

function ico(design, sizes) {
  const images = sizes.map((size) => png(design, size))
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, at)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(images[i].length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += images[i].length
  })
  return Buffer.concat([header, ...images])
}

const out = (file, data) => {
  writeFileSync(path.join(root, file), data)
  console.log(`icon: ${file}`)
}

out('build/icon.png', png('desktop', 1024))
out('build/icon.ico', ico('desktop', [256, 128, 64, 48, 32, 24, 16]))
out('mobile/assets/icon.png', png('ios', 1024))
out('mobile/assets/splash-icon.png', png('desktop', 1024))
out('mobile/assets/favicon.png', png('desktop', 48))
out('mobile/assets/android-icon-foreground.png', png('androidForeground', 1024))
out('mobile/assets/android-icon-background.png', png('androidBackground', 1024))
out('mobile/assets/android-icon-monochrome.png', png('androidMonochrome', 1024))
