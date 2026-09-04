import { encodePlist, parsePlist, frame, readFrame } from './usbmux.js'

function assertEqual<T>(actual: T, expected: T, message: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}: expected ${e} but got ${a}`)
}

// a real ListDevices reply (keys sorted, whitespace/indentation as usbmuxd emits it)
const reply = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>DeviceList</key>
\t<array>
\t\t<dict>
\t\t\t<key>DeviceID</key>
\t\t\t<integer>7</integer>
\t\t\t<key>MessageType</key>
\t\t\t<string>Attached</string>
\t\t\t<key>Properties</key>
\t\t\t<dict>
\t\t\t\t<key>ConnectionSpeed</key>
\t\t\t\t<integer>480000000</integer>
\t\t\t\t<key>ConnectionType</key>
\t\t\t\t<string>USB</string>
\t\t\t\t<key>DeviceID</key>
\t\t\t\t<integer>7</integer>
\t\t\t\t<key>SerialNumber</key>
\t\t\t\t<string>00008110-000A1B2C3D4E5F6G</string>
\t\t\t\t<key>Paired</key>
\t\t\t\t<true/>
\t\t\t</dict>
\t\t</dict>
\t\t<dict>
\t\t\t<key>DeviceID</key>
\t\t\t<integer>9</integer>
\t\t\t<key>Properties</key>
\t\t\t<dict>
\t\t\t\t<key>ConnectionType</key>
\t\t\t\t<string>Network</string>
\t\t\t\t<key>EscapedFullServiceName</key>
\t\t\t\t<string>a&amp;b</string>
\t\t\t\t<key>Empty</key>
\t\t\t\t<string></string>
\t\t\t</dict>
\t\t</dict>
\t</array>
\t<key>Nothing</key>
\t<array/>
</dict>
</plist>
`
const parsed = parsePlist(reply) as { DeviceList: Array<Record<string, unknown>>; Nothing: unknown[] }
assertEqual(parsed.DeviceList.length, 2, 'two devices')
assertEqual(parsed.DeviceList[0].DeviceID, 7, 'integer')
assertEqual((parsed.DeviceList[0].Properties as Record<string, unknown>).SerialNumber, '00008110-000A1B2C3D4E5F6G', 'nested string')
assertEqual((parsed.DeviceList[0].Properties as Record<string, unknown>).Paired, true, 'true/')
assertEqual((parsed.DeviceList[1].Properties as Record<string, unknown>).EscapedFullServiceName, 'a&b', 'entity')
assertEqual((parsed.DeviceList[1].Properties as Record<string, unknown>).Empty, '', 'empty string')
assertEqual(parsed.Nothing, [], 'self-closing array')

assertEqual(parsePlist('<plist version="1.0"><dict><key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer></dict></plist>'),
  { MessageType: 'Result', Number: 0 }, 'compact Result reply')

// our own encoding round-trips through the parser
const msg = { ClientVersionString: 'sniffer', ProgName: 'sniffer', MessageType: 'Connect', DeviceID: 7, PortNumber: 0x8423 }
assertEqual(parsePlist(encodePlist(msg)), msg, 'encode/parse round trip')

// framing: header + payload, and a reply split across chunks is only returned once complete
const f = frame('hello', 3)
assertEqual(f.length, 21, 'frame length')
assertEqual([f.readUInt32LE(0), f.readUInt32LE(4), f.readUInt32LE(8), f.readUInt32LE(12)], [21, 1, 8, 3], 'header fields')
assertEqual(readFrame(f.subarray(0, 10)), null, 'partial frame')
const two = Buffer.concat([f, frame('x')])
const first = readFrame(two)
assertEqual(first?.payload, 'hello', 'first payload')
assertEqual(readFrame(first!.rest)?.payload, 'x', 'remaining bytes carry the next frame')

console.log('usbmux.test: all assertions passed')
