import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(electronRoot, '../..')
const sourceSvg = join(repoRoot, 'server', 'ui', 'public', 'sniffer.svg')
const outDir = join(electronRoot, 'build', 'icon')
const iconset = join(outDir, 'sniffer.iconset')
const icns = join(outDir, 'sniffer.icns')

if (!existsSync(sourceSvg)) {
  throw new Error(`Missing Sniffer icon source: ${sourceSvg}`)
}

rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })

// macOS icons keep a transparent margin: the rounded square fills 824 of a 1024 canvas
// (Apple's icon grid). Rendering the artwork full-bleed makes the Dock icon visibly larger
// than every neighbour on macOS 15 and earlier — 26 (Tahoe) normalizes icons itself, which
// is why the oversize only shows on older systems. The margin is baked here so the icns is
// right everywhere, leaving the source svg untouched for the web UI favicon.
const ART = 824 / 1024
const inner = readFileSync(sourceSvg, 'utf8').replace(/^<\?xml[^>]*\?>\s*/, '')
const inset = (1 - ART) / 2 * 1024
const paddedSvg = join(outDir, 'sniffer-padded.svg')
writeFileSync(paddedSvg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
  `<svg x="${inset}" y="${inset}" width="${ART * 1024}" height="${ART * 1024}">${inner}</svg></svg>`)

const variants = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

for (const [name, size] of variants) {
  execFileSync('rsvg-convert', [
    '--width', String(size),
    '--height', String(size),
    '--output', join(iconset, name),
    paddedSvg,
  ])
}

execFileSync('iconutil', ['--convert', 'icns', '--output', icns, iconset])

if (!existsSync(icns)) {
  throw new Error(`Failed to create ${icns}`)
}
