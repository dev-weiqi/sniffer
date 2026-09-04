import { connect, type Socket } from 'node:net'
import { WebSocket } from 'ws'

/**
 * iOS has no adb reverse: usbmuxd (Apple's USB multiplexer, always running on a Mac with an
 * iPhone plugged in) only lets us open a TCP connection *into* a device port. So the SDK listens
 * on the device (127.0.0.1:9092) and we dial in, then run the normal /device WebSocket protocol
 * with the roles flipped: the daemon is the WebSocket client.
 *
 * Protocol: plist messages framed by a 16-byte little-endian header
 * (length incl. header, version=1, type=8 (plist), tag). `Connect` turns the socket into the tunnel.
 */
const USBMUXD = process.platform === 'win32' ? { host: '127.0.0.1', port: 27015 } : { path: '/var/run/usbmuxd' }
const CLIENT = { ClientVersionString: 'sniffer', ProgName: 'sniffer' }

export interface UsbDevice { id: number; serial: string }

export function encodePlist(dict: Record<string, string | number>): string {
  const entries = Object.entries(dict).map(([k, v]) =>
    `<key>${k}</key>${typeof v === 'number' ? `<integer>${v}</integer>` : `<string>${v}</string>`}`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${entries.join('')}</dict></plist>`
}

/** The subset of XML plist usbmuxd replies with: dict / array / string / integer / real / true / false / data. */
export function parsePlist(xml: string): unknown {
  const tokens = [...xml.matchAll(/<(\/?)([a-zA-Z]+)([^>]*)>|([^<]+)/g)]
  let i = 0
  const next = () => tokens[i++]
  function value(): unknown {
    const t = next()
    if (!t) throw new Error('plist: unexpected end')
    if (t[4] !== undefined) return value() // whitespace between tags
    const [, close, name, attrs] = t
    if (close) throw new Error(`plist: unexpected </${name}>`)
    const selfClosing = attrs.trim().endsWith('/')
    if (name === 'plist') return value()
    if (name === 'true') return true
    if (name === 'false') return false
    if (name === 'dict') {
      const out: Record<string, unknown> = {}
      if (selfClosing) return out
      for (;;) {
        const k = next()
        if (!k) throw new Error('plist: unterminated dict')
        if (k[4] !== undefined) continue
        if (k[1] === '/') return out
        out[text()] = value()
      }
    }
    if (name === 'array') {
      const out: unknown[] = []
      if (selfClosing) return out
      for (;;) {
        const t2 = tokens[i]
        if (!t2) throw new Error('plist: unterminated array')
        if (t2[4] !== undefined) { i++; continue }
        if (t2[1] === '/') { i++; return out }
        out.push(value())
      }
    }
    const raw = selfClosing ? '' : text()
    return name === 'integer' || name === 'real' ? Number(raw) : raw
  }
  // text content of the element whose opening tag was just consumed, then its closing tag
  function text(): string {
    let s = ''
    for (;;) {
      const t = next()
      if (!t) throw new Error('plist: unterminated text')
      if (t[4] !== undefined) { s += t[4]; continue }
      if (t[1] === '/') return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      throw new Error(`plist: unexpected <${t[2]}>`)
    }
  }
  while (tokens[i] && (tokens[i][4] !== undefined || /^(\?|!)/.test(tokens[i][3] ?? '') || tokens[i][2] === 'xml')) i++
  return value()
}

export function frame(payload: string, tag = 1): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(16)
  header.writeUInt32LE(16 + body.length, 0)
  header.writeUInt32LE(1, 4)
  header.writeUInt32LE(8, 8)
  header.writeUInt32LE(tag, 12)
  return Buffer.concat([header, body])
}

/** Splits off one complete reply, if present. */
export function readFrame(buf: Buffer): { payload: string; rest: Buffer } | null {
  if (buf.length < 16) return null
  const length = buf.readUInt32LE(0)
  if (buf.length < length) return null
  return { payload: buf.subarray(16, length).toString('utf8'), rest: buf.subarray(length) }
}

/** One request/reply over a fresh usbmuxd socket; the socket is handed back (a Connect turns it into the tunnel). */
function request(msg: Record<string, string | number>): Promise<{ socket: Socket; reply: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(USBMUXD)
    let buf = Buffer.alloc(0)
    const fail = (e: Error) => { socket.destroy(); reject(e) }
    socket.once('error', fail)
    socket.once('close', () => reject(new Error('usbmuxd closed')))
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      const f = readFrame(buf)
      if (!f) return
      socket.removeAllListeners('data')
      socket.removeAllListeners('close')
      socket.off('error', fail)
      // anything after the reply already belongs to the tunnel
      if (f.rest.length) socket.unshift(f.rest)
      try { resolve({ socket, reply: parsePlist(f.payload) as Record<string, unknown> }) } catch (e) { fail(e as Error) }
    })
    socket.write(frame(encodePlist({ ...CLIENT, ...msg })))
  })
}

export async function listDevices(): Promise<UsbDevice[]> {
  const { socket, reply } = await request({ MessageType: 'ListDevices' })
  socket.destroy()
  const list = (reply.DeviceList ?? []) as Array<{ DeviceID: number; Properties: { ConnectionType: string; SerialNumber: string } }>
  return list.filter(d => d.Properties?.ConnectionType === 'USB').map(d => ({ id: d.DeviceID, serial: d.Properties.SerialNumber }))
}

export async function connectToDevice(id: number, port: number): Promise<Socket> {
  // PortNumber travels in network byte order inside a 16-bit field
  const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff)
  const { socket, reply } = await request({ MessageType: 'Connect', DeviceID: id, PortNumber: swapped })
  if (reply.Number !== 0) {
    socket.destroy()
    throw new Error(`usbmuxd connect failed: ${String(reply.Number)}`) // 3 = nothing listening (app not in foreground / no SDK)
  }
  return socket
}

/**
 * Polls usbmuxd and dials every plugged-in iOS device the SDK listens on. Each successful dial
 * becomes an ordinary /device WebSocket, delivered through [onConnection] once open.
 */
export function startUsbBridge({ port, onConnection, intervalMs = 5000 }: {
  port: number
  onConnection: (ws: WebSocket, device: UsbDevice) => void
  intervalMs?: number
}) {
  const active = new Set<string>()
  async function tick() {
    let devices: UsbDevice[]
    try { devices = await listDevices() } catch { return } // no usbmuxd on this machine: nothing to do
    for (const d of devices) {
      if (active.has(d.serial)) continue
      active.add(d.serial)
      let socket: Socket
      try { socket = await connectToDevice(d.id, port) } catch { active.delete(d.serial); continue }
      const ws = new WebSocket('ws://usb/device', { createConnection: () => socket, handshakeTimeout: 5000 })
      ws.on('open', () => onConnection(ws, d))
      ws.on('error', () => {}) // surfaced via 'close'; an unhandled 'error' would crash the daemon
      ws.on('close', () => active.delete(d.serial))
    }
  }
  setInterval(tick, intervalMs)
  void tick()
}
