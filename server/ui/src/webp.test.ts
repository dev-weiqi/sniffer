import { formatWebpSummary, parseWebpAnimation } from './webp.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function chunk(type: string, payload: number[]): number[] {
  const size = payload.length
  const header = [
    type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3),
    size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff,
  ]
  return [...header, ...payload, ...(size % 2 ? [0] : [])]
}

function u24(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]
}

function animatedWebpBase64(loopCount: number): string {
  const vp8x = chunk('VP8X', [0x02, 0, 0, 0, ...u24(399), ...u24(399)])
  const anim = chunk('ANIM', [0, 0, 0, 0, loopCount & 0xff, (loopCount >> 8) & 0xff])
  const frame = (durationMs: number) => chunk('ANMF', [
    ...u24(0), ...u24(0), ...u24(399), ...u24(399), ...u24(durationMs), 0,
  ])
  const payload = [...vp8x, ...anim, ...frame(70), ...frame(70)]
  const size = 4 + payload.length
  const bytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46,
    size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff,
    0x57, 0x45, 0x42, 0x50,
    ...payload,
  ])
  return btoa(String.fromCharCode(...bytes))
}

const infinite = parseWebpAnimation(animatedWebpBase64(0))
assert(infinite !== null && infinite.animated === true, 'animated WebP should parse')
assert(infinite.frames === 2, `frames, got ${infinite.frames}`)
assert(infinite.durationMs === 140, `duration, got ${infinite.durationMs}`)
assert(infinite.loopCount === 0, `loop count, got ${infinite.loopCount}`)
assert(infinite.canvasWidth === 400 && infinite.canvasHeight === 400, 'canvas size')
assert(formatWebpSummary(infinite) === '2 frames · 140 ms · loops ∞ · 400 × 400',
  `infinite summary, got ${formatWebpSummary(infinite)}`)

const finite = parseWebpAnimation(animatedWebpBase64(3))
assert(finite !== null && finite.loopCount === 3, `finite loop count, got ${finite?.loopCount}`)
assert(formatWebpSummary(finite) === '2 frames · 140 ms · loops 3× · 400 × 400',
  `finite summary, got ${formatWebpSummary(finite)}`)

console.log('webp.test: all assertions passed')
