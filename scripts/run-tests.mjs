import { spawnSync } from 'node:child_process'

const commands = [
  [process.execPath, ['--test', 'scripts/lib/platform-sync.test.mjs']],
  ['yarn', ['test:packages']],
]

for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
