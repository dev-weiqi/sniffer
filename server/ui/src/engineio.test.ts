import { decodeEngineIoFrame, frameLabel } from './engineio.js'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// EVENT with named namespace + JSON args
const ev = decodeEngineIoFrame('42/chat,["chat:new",{"msg":"hi"}]')
assert(ev !== null, 'event should decode')
assert(ev!.socketLabel === 'EVENT', `EVENT label, got ${ev!.socketLabel}`)
assert(ev!.namespace === '/chat', `namespace, got ${ev!.namespace}`)
assert(ev!.eventName === 'chat:new', `eventName, got ${ev!.eventName}`)
assert(ev!.data === '["chat:new",{"msg":"hi"}]', `data, got ${ev!.data}`)
assert(frameLabel(ev!) === 'EVENT /chat', `label, got ${frameLabel(ev!)}`)

// EVENT on default namespace (no /ns, prefix), with an ack id
const ack = decodeEngineIoFrame('42/chat,17["ack",{}]')
assert(ack!.ackId === '17', `ackId, got ${ack!.ackId}`)
assert(ack!.eventName === 'ack', `ack eventName, got ${ack!.eventName}`)

const defaultNs = decodeEngineIoFrame('42["ping",1]')
assert(defaultNs!.namespace === undefined, `default ns omitted, got ${defaultNs!.namespace}`)
assert(defaultNs!.eventName === 'ping', `default ns event, got ${defaultNs!.eventName}`)

const binaryEvent = decodeEngineIoFrame('452-/files,["upload",{"_placeholder":true,"num":0}]')
assert(binaryEvent!.socketLabel === 'BINARY_EVENT', `binary label, got ${binaryEvent!.socketLabel}`)
assert(binaryEvent!.namespace === '/files', `binary namespace, got ${binaryEvent!.namespace}`)
assert(binaryEvent!.eventName === 'upload', `binary eventName, got ${binaryEvent!.eventName}`)

// CONNECT with handshake object
const connect = decodeEngineIoFrame('40/chat,{"sid":"abc"}')
assert(connect!.socketLabel === 'CONNECT', `CONNECT label, got ${connect!.socketLabel}`)
assert(connect!.namespace === '/chat', `connect ns, got ${connect!.namespace}`)
assert(connect!.data === '{"sid":"abc"}', `connect data, got ${connect!.data}`)

// Engine.IO open handshake (not a socket.io message)
const open = decodeEngineIoFrame('0{"sid":"x","pingInterval":25000}')
assert(open!.engineLabel === 'open', `open label, got ${open!.engineLabel}`)
assert(open!.socketLabel === undefined, 'open has no socket label')
assert(open!.data === '{"sid":"x","pingInterval":25000}', `open data, got ${open!.data}`)

// ping / pong control frames
assert(decodeEngineIoFrame('2')!.engineLabel === 'ping', 'ping')
assert(decodeEngineIoFrame('3')!.engineLabel === 'pong', 'pong')

// CONNECT_ERROR (e.g. token rejected)
assert(decodeEngineIoFrame('44/chat,{"message":"nope"}')!.socketLabel === 'CONNECT_ERROR', 'connect_error')

// Non-frames fall back to null so callers show raw text
assert(decodeEngineIoFrame('hello world') === null, 'plain text -> null')
assert(decodeEngineIoFrame('9x') === null, 'unknown engine type -> null')
assert(decodeEngineIoFrame('4x') === null, 'unknown socket type -> null')
assert(decodeEngineIoFrame('') === null, 'empty -> null')

console.log('engineio.test: all assertions passed')
