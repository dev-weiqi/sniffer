import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
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
    sourceSvg,
  ])
}

execFileSync('iconutil', ['--convert', 'icns', '--output', icns, iconset])

if (!existsSync(icns)) {
  throw new Error(`Failed to create ${icns}`)
}
