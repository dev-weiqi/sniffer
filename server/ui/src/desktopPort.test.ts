import { parsePortInput } from './desktopPort.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(parsePortInput('9091') === 9091, 'valid port')
assert(parsePortInput(' 9092 ') === 9092, 'trims port input')
assert(parsePortInput('1023') === null, 'rejects privileged port')
assert(parsePortInput('65536') === null, 'rejects port above range')
assert(parsePortInput('abc') === null, 'rejects non-numeric port')
assert(parsePortInput('9091.5') === null, 'rejects decimal port')

console.log('desktopPort.test: all assertions passed')
