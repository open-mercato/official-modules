import { main } from './lib/platform-sync.mjs'

try {
  const exitCode = main(process.argv.slice(2))
  process.exit(exitCode)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
