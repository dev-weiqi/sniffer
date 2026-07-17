import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readBody } from './http.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

function reqFrom(chunks: Buffer[]): IncomingMessage {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as IncomingMessage
}

assertEqual(await readBody(reqFrom([Buffer.from('hello'), Buffer.from(' world')])), 'hello world', 'readBody joins chunks')

let threw = false
try {
  await readBody(reqFrom([Buffer.from('too-large')]), 3)
} catch (e) {
  threw = e instanceof Error && e.message === 'body too large'
}
assert(threw, 'readBody rejects bodies over limit')

let statusCode = 0
let headers: Record<string, string> = {}
let ended = ''
const res = {
  writeHead: (status: number, h: Record<string, string>) => {
    statusCode = status
    headers = h
  },
  end: (text: string) => {
    ended = text
  },
} as unknown as ServerResponse

json(res, 201, { ok: true })
assertEqual(statusCode, 201, 'json status')
assertEqual(headers['content-type'], 'application/json; charset=utf-8', 'json content type')
assertEqual(ended, '{"ok":true}', 'json body')

console.log('http.test: all assertions passed')
