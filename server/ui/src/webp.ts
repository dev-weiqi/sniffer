export interface WebpAnimationInfo {
  animated: boolean
  frames: number
  durationMs: number
  loopCount: number
  canvasWidth?: number
  canvasHeight?: number
}

export function parseWebpAnimation(base64: string): WebpAnimationInfo | null {
  const bytes = base64ToBytes(base64)
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null
  let loopCount = 0
  let frames = 0
  let durationMs = 0
  let canvasWidth: number | undefined
  let canvasHeight: number | undefined

  for (let offset = 12; offset + 8 <= bytes.length;) {
    const fourcc = ascii(bytes, offset, 4)
    const size = readUint32LE(bytes, offset + 4)
    const payload = offset + 8
    if (payload + size > bytes.length) break

    if (fourcc === 'VP8X' && size >= 10) {
      canvasWidth = readUint24LE(bytes, payload + 4) + 1
      canvasHeight = readUint24LE(bytes, payload + 7) + 1
    } else if (fourcc === 'ANIM' && size >= 6) {
      loopCount = bytes[payload + 4] | (bytes[payload + 5] << 8)
    } else if (fourcc === 'ANMF' && size >= 16) {
      frames += 1
      durationMs += readUint24LE(bytes, payload + 12)
    }

    offset = payload + size + (size % 2)
  }

  return frames > 0
    ? { animated: true, frames, durationMs, loopCount, canvasWidth, canvasHeight }
    : { animated: false, frames: 1, durationMs: 0, loopCount: 0, canvasWidth, canvasHeight }
}

export function formatWebpSummary(info: WebpAnimationInfo): string {
  const size = info.canvasWidth && info.canvasHeight ? ` · ${info.canvasWidth} × ${info.canvasHeight}` : ''
  const loops = info.loopCount === 0 ? ' · loops ∞' : ` · loops ${info.loopCount}×`
  return `${info.frames} frames · ${formatDuration(info.durationMs)}${loops}${size}`
}

export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function formatDuration(ms: number): string {
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}
