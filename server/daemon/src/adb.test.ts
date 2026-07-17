import { runAdbReverse } from './adb.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

const calls: Array<{ cmd: string; args: string[] }> = []
runAdbReverse({
  port: 9091,
  execFile: ((cmd: string, args: readonly string[], callback: (err: Error | null, stdout: string) => void) => {
    calls.push({ cmd, args: [...args] })
    if (args[0] === 'devices') {
      callback(null, [
        'List of devices attached',
        'emulator-5554\tdevice',
        'offline-1\toffline',
        'unauthorized-1\tunauthorized',
        '',
      ].join('\n'))
      return {} as never
    }
    callback(null, '')
    return {} as never
  }) as never,
})

assertEqual(calls.length, 2, 'runAdbReverse calls adb devices and one reverse')
assertEqual(calls[0].cmd, 'adb', 'devices command')
assertEqual(calls[0].args[0], 'devices', 'devices args')
assertEqual(calls[1].args.join(' '), '-s emulator-5554 reverse tcp:9091 tcp:9091', 'reverse args')

const errorCalls: Array<{ cmd: string; args: string[] }> = []
runAdbReverse({
  port: 9092,
  execFile: ((cmd: string, args: readonly string[], callback: (err: Error | null, stdout: string) => void) => {
    errorCalls.push({ cmd, args: [...args] })
    callback(new Error('adb missing'), '')
    return {} as never
  }) as never,
})

assertEqual(errorCalls.length, 1, 'adb errors skip reverse')
assert(errorCalls[0].args[0] === 'devices', 'error path only checks devices')

console.log('adb.test: all assertions passed')
