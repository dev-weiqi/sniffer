import type { execFile as execFileFn } from 'node:child_process'

type ExecFile = typeof execFileFn

export function runAdbReverse({ port, execFile }: { port: number; execFile: ExecFile }) {
  execFile('adb', ['devices'], (err, stdout) => {
    if (err) return
    for (const line of stdout.split('\n').slice(1)) {
      const [serial, state] = line.trim().split('\t')
      if (state === 'device') {
        execFile('adb', ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], () => {})
      }
    }
  })
}
