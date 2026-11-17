// Renders Kite's icons and pictures from the SVG masters beside this script. Its two dependencies
// are installed beside it only when the artwork changes, never into the project:
//
//   npm i --no-save --no-package-lock --prefix tools/huli/brand @resvg/resvg-js sharp
//   node tools/huli/brand/render.mjs [preview.png]
//
// The phone app's files (mobile/assets) are its own and written in place. The desktop app's are
// upstream Kettu's files, so they go to assets/desktop/, mirroring the repository, and the rebrand
// (tools/huli/rebrand.mjs) copies them over Kettu's before a build: merging Kettu's own icon changes
// then never conflicts. Every output is committed. An optional path writes a sheet of them all.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..', '..')
const require = createRequire(path.join(here, 'package.json'))
const { Resvg } = require('@resvg/resvg-js')
const sharp = require('sharp')

const OUT = path.join(here, 'assets')
const DESKTOP = path.join(OUT, 'desktop')
const CANVAS = 1024

const master = (name) => readFileSync(path.join(here, `${name}.svg`), 'utf8')
const light = master('kite-light')
const dark = master('kite-dark')
const tinted = master('kite-tinted')
const glyph = master('kite-glyph')
const tray = master('kite-tray')

const n = (v) => +v.toFixed(3)

/** The SVG with the groups `ids` left out. */
function without(svg, ...ids) {
  return ids.reduce(
    (text, id) => text.replace(`<g id="${id}"`, `<g id="${id}" display="none"`),
    svg,
  )
}

/** The SVG with every color in `colors` (`#RRGGBB` to another) swapped. */
function recolor(svg, colors) {
  const map = new Map(Object.entries(colors).map(([from, to]) => [from.toUpperCase(), to]))
  return svg.replace(/#[0-9A-Fa-f]{6}\b/g, (c) => map.get(c.toUpperCase()) ?? c)
}

/** The body of an SVG, without its root element, its ids prefixed so several can share a page. */
function body(svg, prefix) {
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
  return inner
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\bid="([^"]+)"/g, `id="${prefix}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`)
}

/** `svg` (on the 1024 grid) drawn at x, y, `size` wide, inside another drawing. */
function place(svg, prefix, x, y, size, viewBox = `0 0 ${CANVAS} ${CANVAS}`) {
  return `<svg x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}" viewBox="${viewBox}">${body(svg, prefix)}</svg>`
}

const page = (width, height, content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`

/**
 * A squircle, the superellipse |x|^5 + |y|^5 = 1, `size` wide at x, y: the continuous corners of
 * Apple's tiles, which Kite's desktop tile and the in-app icon share.
 */
function squircle(x, y, size) {
  const r = size / 2
  const points = []
  for (let i = 0; i < 256; i++) {
    const t = (i / 256) * 2 * Math.PI
    const c = Math.cos(t)
    const s = Math.sin(t)
    points.push([
      x + r + r * Math.sign(c) * Math.abs(c) ** 0.4,
      y + r + r * Math.sign(s) * Math.abs(s) ** 0.4,
    ])
  }
  return `M${points.map(([px, py]) => `${n(px)} ${n(py)}`).join('L')}Z`
}

/** The light icon on its squircle tile, `tile` wide and centred on a `canvas` square. */
function tileSvg(canvas, tile, { shadow = false, art = light } = {}) {
  const at = (canvas - tile) / 2
  const k = canvas / CANVAS
  const filter = shadow
    ? `<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${n(10 * k)}" stdDeviation="${n(12 * k)}" flood-color="#000" flood-opacity="0.3"/></filter>`
    : ''
  return page(
    canvas,
    canvas,
    `<defs><clipPath id="tile"><path d="${squircle(at, at, tile)}"/></clipPath>${filter}</defs>` +
      `<g${shadow ? ' filter="url(#s)"' : ''}><g clip-path="url(#tile)">${place(art, 'k', at, at, tile)}</g></g>`,
  )
}

/**
 * The icon for a few pixels (Windows' 16 to 32 px sizes): the kite larger, the string thicker and
 * the spars gone, so it still reads as a kite on a string.
 */
const small = light
  .replace('<g fill="none" stroke="#E2541F"', '<g display="none" fill="none" stroke="#E2541F"')
  .replace('stroke-width="20" stroke-linecap="round"', 'stroke-width="46" stroke-linecap="round"')
  .replace('r="30" fill="#FFFFFF"', 'r="54" fill="#FFFFFF"')
  .replace('translate(575 340) rotate(12)', 'translate(575 340) rotate(12) scale(1.12)')

/** The art (the kite and its string) alone, scaled about its centre to fit Android's safe zone. */
function adaptive(svg, scale) {
  // The art's bounds on the grid: the kite's top to the string's dot.
  const cx = 502
  const cy = 535
  return page(
    CANVAS,
    CANVAS,
    `<g transform="translate(512 512) scale(${scale}) translate(${-cx} ${-cy})">${body(svg, 'a')}</g>`,
  )
}

function png(svg, width, height = width) {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render()
  if (image.height !== height) throw new Error(`Rendered ${image.width}x${image.height}`)
  return image.asPng()
}

/** An .ico holding each size as a PNG, which Windows reads from Vista on. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, at)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map((i) => i.data)])
}

/** An .icns of PNG entries, for a build that cannot compile the Icon Composer document. */
function icns(svgFor) {
  const types = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ]
  const entries = types.map(([type, size]) => {
    const data = png(svgFor(size), size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + entries.reduce((sum, e) => sum + e.length, 0), 4)
  return Buffer.concat([head, ...entries])
}

const written = []
function out(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
  written.push(path.relative(root, file).replaceAll('\\', '/'))
}

/**
 * The icon as an Icon Composer document, which iOS 26 and macOS 26 draw in Liquid Glass and actool
 * compiles for older versions. The system draws the tile, so the canvas is the tile: the ground,
 * then the kite and its string on a glass group above it, each with its dark appearance. The
 * system makes the tinted and clear appearances from these.
 */
function iconComposer(dir) {
  rmSync(dir, { recursive: true, force: true })
  const layer = (svg, ...hide) => png(without(svg, ...hide), CANVAS)
  const parts = {
    'ground.png': layer(light, 'string', 'kite'),
    'ground-dark.png': layer(dark, 'string', 'kite'),
    'kite.png': layer(light, 'ground', 'string'),
    'kite-dark.png': layer(dark, 'ground', 'string'),
    'string.png': layer(light, 'ground', 'kite'),
    'string-dark.png': layer(dark, 'ground', 'kite'),
  }
  for (const [name, data] of Object.entries(parts)) out(path.join(dir, 'Assets', name), data)
  const image = (name) => [
    { value: `${name}.png` },
    { appearance: 'dark', value: `${name}-dark.png` },
  ]
  // Groups and their layers run from front to back.
  const document = {
    groups: [
      {
        layers: [
          { glass: true, 'image-name-specializations': image('kite'), name: 'kite' },
          { glass: true, 'image-name-specializations': image('string'), name: 'string' },
        ],
        shadow: { kind: 'neutral', opacity: 0.5 },
        translucency: { enabled: true, value: 0.4 },
      },
      {
        layers: [{ glass: false, 'image-name-specializations': image('ground'), name: 'ground' }],
        shadow: { kind: 'none', opacity: 0.5 },
      },
    ],
    'supported-platforms': { squares: 'shared' },
  }
  out(path.join(dir, 'icon.json'), `${JSON.stringify(document, null, 2)}\n`)
}

// The tray's status dots, as tools/brand/build.mjs draws Kettu's: the waiting dot at the bottom
// right with a gap cut around it, the running one smaller and breathing, the waiting dot in Kite's
// orange where the image is no template.
const DOT = { cx: 14.5, cy: 14, r: 3, gap: 1.5 }
const RUNNING_DOT_R = 2.5
const TRAY_BREATH = [1, 0.85, 0.69, 0.53, 0.38, 0.25]
const TRAY_ATTENTION = '#F0652A'

/** The tray glyph in `color`, on the 18 pt canvas (`menubar`) or cut to its 16 px square. */
function traySvg({
  framing = 'menubar',
  size,
  color = '#000',
  opacity = 1,
  dot = false,
  dotOpacity = 1,
  dotColor = null,
}) {
  const m = framing === 'tray' ? 1 : 0
  const side = 18 - 2 * m
  const r = dot === 'running' ? RUNNING_DOT_R : DOT.r
  const circle = (radius, fill, extra = '') =>
    `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${radius}" fill="${fill}"${extra}/>`
  const gap = dot ? circle(r + DOT.gap, '#000') : ''
  const badge =
    dot && !dotColor ? circle(r, '#fff', dotOpacity < 1 ? ` fill-opacity="${dotOpacity}"` : '') : ''
  const colored = dot && dotColor ? circle(r, dotColor) : ''
  // The glyph is drawn in black; as a mask, white shows, so it is inverted.
  const glyphBody = body(recolor(tray, { '#000000': '#FFFFFF' }), 't')
  const px = size ?? side
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${m} ${m} ${side} ${side}">` +
    `<mask id="glyph" maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">${glyphBody}${gap}${badge}</mask>` +
    `<rect width="18" height="18" fill="${color}"${opacity < 1 ? ` opacity="${opacity}"` : ''} mask="url(#glyph)"/>${colored}</svg>\n`
  )
}

function renderTray(dir) {
  rmSync(dir, { recursive: true, force: true })
  const menubar = {
    '': {},
    '-off': { opacity: 0.45 },
    ...Object.fromEntries(
      TRAY_BREATH.map((dotOpacity, i) => [`-running-${i}`, { dot: 'running', dotOpacity }]),
    ),
  }
  for (const ground of ['dark', 'light']) {
    const variants = {
      ...menubar,
      '-attention': {
        color: ground === 'dark' ? '#fff' : '#000',
        opacity: 0.85,
        dot: true,
        dotColor: TRAY_ATTENTION,
      },
    }
    for (const [variant, options] of Object.entries(variants)) {
      for (const [scale, suffix] of [
        [1, ''],
        [2, '@2x'],
      ]) {
        const size = 18 * scale
        const file = `tray-menubar-on-${ground}${variant}${suffix}.png`
        out(path.join(dir, file), png(traySvg({ size, ...options }), size))
      }
    }
  }
  for (const dot of [false, true]) {
    for (const [name, color] of [
      ['black', '#000'],
      ['white', '#fff'],
    ]) {
      const file = `tray-${name}${dot ? '-dot' : ''}`
      const sizes = [16, 20, 24, 32, 40, 48].map((size) => ({
        size,
        data: png(traySvg({ framing: 'tray', size, color, dot }), size),
      }))
      out(path.join(dir, `${file}.ico`), ico(sizes))
      out(path.join(dir, `${file}.png`), sizes.find((s) => s.size === 24).data)
      out(path.join(dir, `${file}@2x.png`), sizes.find((s) => s.size === 48).data)
    }
  }
}

/** The kite and its string in orange without a tile, cropped to a square around them. */
const markSvg = () =>
  without(dark, 'ground')
    .replace(/viewBox="0 0 1024 1024"/, 'viewBox="137 170 730 730"')
    .replace(/width="1024" height="1024"/, 'width="730" height="730"')

/** The glyph in white on the tray's square, for masks the renderer fills itself. */
const whiteGlyphSvg = () => traySvg({ framing: 'tray', color: '#fff' })

async function webp(svg, width, height) {
  return sharp(png(svg, width, height))
    .webp({ quality: 90, alphaQuality: 100, effort: 6 })
    .toBuffer()
}

async function main() {
  rmSync(DESKTOP, { recursive: true, force: true })

  // The desktop app. Linux's icon on Apple's grid before Liquid Glass: an 824 px tile with a soft
  // shadow; Windows' tile fills its square; macOS draws the Icon Composer document.
  out(path.join(DESKTOP, 'build', 'icon.png'), png(tileSvg(1024, 824, { shadow: true }), 1024))
  const windows = [16, 24, 32, 48, 64, 128, 256].map((size) => ({
    size,
    data: png(tileSvg(size, size, { art: size <= 32 ? small : light }), size),
  }))
  out(path.join(DESKTOP, 'build', 'icon.ico'), ico(windows))
  iconComposer(path.join(DESKTOP, 'build', 'icon.icon'))
  out(
    path.join(OUT, 'icon.icns'),
    icns((size) => tileSvg(size, Math.round(size * 0.805), { art: size <= 32 ? small : light })),
  )
  renderTray(path.join(DESKTOP, 'resources', 'tray'))

  // The renderer's brand files, in vector: the icon on its tile, the mark without one, and the
  // glyph the launch cover masks.
  const assets = path.join(DESKTOP, 'src', 'renderer', 'src', 'assets')
  out(path.join(assets, 'kettu-icon.svg'), tileSvg(1024, 960))
  out(path.join(assets, 'kettu-fox.svg'), markSvg())
  for (const ground of ['dark', 'light']) {
    out(path.join(assets, `kettu-glyph-on-${ground}.svg`), whiteGlyphSvg())
  }
  // The first run's pictures, which stand on the stage's paper snow drift.
  out(
    path.join(assets, 'onboarding', 'fox-waving.webp'),
    await webp(master('scene-flying'), 860, 920),
  )
  out(
    path.join(assets, 'onboarding', 'fox-looking-up.webp'),
    await webp(master('scene-resting'), 660),
  )

  // The phone app. iOS draws the Icon Composer document; the PNGs are its light, dark and tinted
  // appearances flat, should a build need them (ios.icon as { light, dark, tinted }).
  const mobile = path.join(root, 'mobile', 'assets')
  iconComposer(path.join(mobile, 'kite.icon'))
  out(path.join(mobile, 'icon.png'), png(light, 1024))
  out(path.join(mobile, 'ios', 'icon-light.png'), png(light, 1024))
  out(path.join(mobile, 'ios', 'icon-dark.png'), png(dark, 1024))
  out(path.join(mobile, 'ios', 'icon-tinted.png'), png(tinted, 1024))
  out(path.join(mobile, 'splash-icon.png'), png(tileSvg(1024, 824), 1024))
  out(path.join(mobile, 'favicon.png'), png(tileSvg(48, 48, { art: small }), 48))
  // Android's adaptive icon: the art inside the 66 dp safe circle of the 108 dp square.
  out(
    path.join(mobile, 'android-icon-foreground.png'),
    png(adaptive(without(light, 'ground'), 0.62), 1024),
  )
  out(path.join(mobile, 'android-icon-background.png'), png(without(light, 'string', 'kite'), 1024))
  out(path.join(mobile, 'android-icon-monochrome.png'), png(adaptive(glyph, 0.62), 1024))

  for (const file of written) console.log(`brand: ${file}`)
  const sheet = process.argv[2]
  if (sheet) {
    writeFileSync(path.resolve(sheet), preview())
    console.log(`preview: ${sheet}`)
  }
}

/** A sheet of the icons as each place shows them, for review; not part of the app. */
function preview() {
  const W = 1440
  const items = []
  let y = 0
  const uri = (data) => `data:image/png;base64,${data.toString('base64')}`
  const label = (x, ly, text, color = '#55524C') =>
    `<text x="${x}" y="${ly}" font-family="Segoe UI, PingFang SC, Microsoft YaHei, sans-serif" font-size="15" fill="${color}">${text}</text>`
  const image = (data, x, iy, w, h = w, pixelated = false) =>
    `<image x="${x}" y="${iy}" width="${w}" height="${h}" href="${uri(data)}"${pixelated ? ' image-rendering="optimizeSpeed"' : ''}/>`
  const heading = (text) => {
    y += 56
    items.push(
      `<text x="40" y="${y}" font-family="Segoe UI, PingFang SC, Microsoft YaHei, sans-serif" font-size="22" font-weight="600" fill="#1C1B18">${text}</text>`,
    )
    y += 20
  }
  const masked = (svg, size) =>
    png(
      page(
        CANVAS,
        CANVAS,
        `<defs><clipPath id="m"><path d="${squircle(0, 0, CANVAS)}"/></clipPath></defs><g clip-path="url(#m)">${place(svg, 'p', 0, 0, CANVAS)}</g>`,
      ),
      size,
    )

  heading('iPhone · iOS 26 (light / dark / tinted), home screen and 29 pt Settings')
  const wall = (x, w, h, fill) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${fill}"/>`
  items.push(wall(40, 700, 230, '#DCE6F2'), wall(760, 640, 230, '#1A1A1D'))
  items.push(image(masked(light, 360), 70, y + 25, 180))
  items.push(image(masked(tinted, 360), 280, y + 25, 180))
  items.push(
    image(masked(light, 120), 500, y + 25, 60),
    image(masked(light, 87), 580, y + 25, 29 * 1.5),
  )
  items.push(label(500, y + 120, '60 pt / 29 pt'))
  items.push(image(masked(dark, 360), 790, y + 25, 180), image(masked(dark, 120), 1000, y + 25, 60))
  items.push(image(masked(dark, 87), 1080, y + 25, 29 * 1.5))
  items.push(
    label(70, y + 222, 'light', '#33302C'),
    label(280, y + 222, 'tinted (system tints it)', '#33302C'),
  )
  items.push(label(790, y + 222, 'dark', '#C9C6C0'))
  y += 240

  heading('Desktop · macOS / Linux tile, Windows .ico at real size')
  items.push(wall(40, 1360, 200, '#F4F3EE'))
  items.push(image(png(tileSvg(1024, 824, { shadow: true }), 360), 60, y + 10, 180))
  let x = 280
  for (const size of [256, 128, 64, 48, 32, 24, 16]) {
    const data = png(tileSvg(size, size, { art: size <= 32 ? small : light }), size)
    const shown = Math.min(size, 128)
    items.push(image(data, x, y + 30, shown), label(x, y + 185, `${size}px`))
    x += shown + 40
  }
  y += 210

  heading('Android · adaptive (circle mask), themed monochrome')
  items.push(wall(40, 1360, 220, '#E9E4DA'))
  const adaptiveImage = (fg, bg) =>
    png(
      page(
        CANVAS,
        CANVAS,
        `<defs><clipPath id="c"><circle cx="512" cy="512" r="512"/></clipPath></defs><g clip-path="url(#c)">${bg}${body(fg, 'f')}</g>`,
      ),
      360,
    )
  const ground = body(without(light, 'string', 'kite'), 'g')
  items.push(
    image(adaptiveImage(adaptive(without(light, 'ground'), 0.62), ground), 70, y + 20, 180),
  )
  const themed = recolor(adaptive(glyph, 0.62), { '#000000': '#3D2A20' })
  items.push(
    image(
      adaptiveImage(themed, '<rect width="1024" height="1024" fill="#FFDCC8"/>'),
      290,
      y + 20,
      180,
    ),
  )
  items.push(label(70, y + 215, 'adaptive'), label(290, y + 215, 'themed (monochrome)'))
  y += 230

  heading(
    'Tray · macOS menu bar (18 pt @2x, idle / running / waiting / off), Windows 16 px and zoomed',
  )
  items.push(wall(40, 660, 120, '#ECECEC'), wall(720, 680, 120, '#2B2B2E'))
  x = 70
  for (const [ground, bar] of [
    ['light', '#ECECEC'],
    ['dark', '#2B2B2E'],
  ]) {
    const ink = ground === 'dark' ? '#fff' : '#000'
    for (const options of [
      {},
      { dot: 'running', dotOpacity: 1 },
      { color: ink, opacity: 0.85, dot: true, dotColor: TRAY_ATTENTION },
      { opacity: 0.45 },
    ]) {
      const data = png(traySvg({ size: 36, color: ink, ...options }), 36)
      items.push(image(data, x, y + 20, 36), image(data, x + 46, y + 20, 72, 72, true))
      x += 150
    }
    x = 750
    void bar
  }
  y += 130
  items.push(wall(40, 660, 90, '#F3F3F3'), wall(720, 680, 90, '#202020'))
  x = 70
  for (const [color, start] of [
    ['#000', 70],
    ['#fff', 750],
  ]) {
    x = start
    for (const dot of [false, true]) {
      const data = png(traySvg({ framing: 'tray', size: 16, color, dot }), 16)
      items.push(image(data, x, y + 37, 16), image(data, x + 30, y + 13, 64, 64, true))
      x += 130
    }
  }
  y += 100

  heading('In the app · mark on light and dark, first-run pictures')
  items.push(wall(40, 420, 220, '#FFFFFF'), wall(480, 420, 220, '#1C1B18'))
  const mark = png(markSvg(), 320)
  items.push(image(mark, 60, y + 20, 160), image(png(tileSvg(1024, 960), 192), 240, y + 40, 96))
  items.push(image(mark, 500, y + 20, 160), image(png(tileSvg(1024, 960), 192), 680, y + 40, 96))
  items.push(wall(920, 480, 220, '#F1EEE8'))
  items.push(image(png(master('scene-flying'), 430, 460), 940, y + 10, 190, 203))
  items.push(image(png(master('scene-resting'), 330), 1170, y + 10, 200))
  y += 240

  const H = y + 30
  return png(page(W, H, `<rect width="${W}" height="${H}" fill="#FAF9F6"/>${items.join('')}`), W, H)
}

await main()
