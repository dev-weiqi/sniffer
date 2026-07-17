import { inflateSync } from 'node:zlib'
import { makePng } from './png.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

function chunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const out: Array<{ type: string; data: Buffer }> = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    out.push({ type, data })
    offset += 12 + length
  }
  return out
}

const png = makePng(2, 2, 10, 20, 30)
assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature')

const parsed = chunks(png)
assertEqual(parsed.map(c => c.type).join(','), 'IHDR,IDAT,IEND', 'PNG chunks')
assertEqual(parsed[0].data.readUInt32BE(0), 2, 'PNG width')
assertEqual(parsed[0].data.readUInt32BE(4), 2, 'PNG height')
assertEqual(parsed[0].data[8], 8, 'PNG bit depth')
assertEqual(parsed[0].data[9], 2, 'PNG color type')

const raw = inflateSync(parsed[1].data)
assertEqual(raw.length, 14, 'inflated RGB row data length')
assertEqual(raw[0], 0, 'first row filter byte')
assertEqual(raw[1], 10, 'first pixel red')
assertEqual(raw[2], 20, 'first pixel green')
assertEqual(raw[3], 30, 'first pixel blue')
assertEqual(raw[7], 0, 'second row filter byte')
assertEqual(parsed[2].data.length, 0, 'IEND has no data')

console.log('png.test: all assertions passed')
