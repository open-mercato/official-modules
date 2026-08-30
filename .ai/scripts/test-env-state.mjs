import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const [command, ...args] = process.argv.slice(2)

if (command === 'field') {
  const [path, dottedPath] = args
  const value = dottedPath.split('.').reduce((current, key) => current?.[key], readJson(path))
  if (value === undefined || value === null) process.exit(1)
  process.stdout.write(String(value))
} else if (command === 'reusable') {
  const [path, sourceFingerprint, ttlRaw] = args
  try {
    const descriptor = readJson(path)
    const ageSeconds = (Date.now() - Date.parse(descriptor.startedAt)) / 1000
    const ttlSeconds = Number(ttlRaw)
    const valid = descriptor.status === 'running'
      && descriptor.startedByThisRepo === true
      && processIsAlive(descriptor.app?.pid)
      && Number.isFinite(ageSeconds)
      && ageSeconds >= 0
      && ageSeconds <= ttlSeconds
      && descriptor.sourceFingerprint === sourceFingerprint
    process.exit(valid ? 0 : 1)
  } catch {
    process.exit(1)
  }
} else if (command === 'owner-alive') {
  const [path] = args
  try {
    process.exit(processIsAlive(readJson(path).pid) ? 0 : 1)
  } catch {
    process.exit(1)
  }
} else if (command === 'write-owner') {
  const [path, pid, source] = args
  writeJson(path, { pid: Number(pid), source, acquiredAt: new Date().toISOString() })
} else if (command === 'write-descriptor') {
  const [path] = args
  const port = Number(process.env.TEST_ENV_APP_PORT)
  const baseUrl = process.env.TEST_ENV_BASE_URL
  const descriptor = {
    version: 1,
    runId: process.env.TEST_ENV_RUN_ID,
    status: 'running',
    mode: 'dev',
    baseUrl,
    startedByThisRepo: true,
    startScript: '.ai/scripts/test-env-up.sh',
    stopScript: '.ai/scripts/test-env-down.sh',
    app: {
      startCommand: 'corepack yarn workspace sandbox dev',
      port,
      healthPath: '/login',
      pid: Number(process.env.TEST_ENV_APP_PID),
      session: process.env.TEST_ENV_APP_SESSION ?? '',
      launcher: process.env.TEST_ENV_APP_LAUNCHER ?? 'nohup',
    },
    services: [
      { type: 'postgres', host: '127.0.0.1', port: Number(process.env.TEST_ENV_DB_PORT), container: 'mercato-postgres-module', url: '', env: {} },
      { type: 'redis', host: '127.0.0.1', port: Number(process.env.TEST_ENV_REDIS_PORT), container: 'mercato-redis-module', url: '', env: {} },
      { type: 'meilisearch', host: '127.0.0.1', port: Number(process.env.TEST_ENV_MEILI_PORT), container: 'mercato-meilisearch-module', url: '', env: {} },
    ],
    credentials: [
      { role: 'superadmin', username: 'superadmin@acme.com', password: 'secret' },
      { role: 'admin', username: 'admin@acme.com', password: 'secret' },
    ],
    browser: {
      provider: 'playwright',
      installed: process.env.TEST_ENV_BROWSER_INSTALLED === '1',
      command: 'corepack yarn exec playwright',
      version: process.env.TEST_ENV_BROWSER_VERSION ?? '',
      descriptor: '',
      notes: 'Repository-local Playwright with Chromium; verified by a live launch during harness generation.',
    },
    playwright: {
      runner: 'playwright',
      installed: process.env.TEST_ENV_BROWSER_INSTALLED === '1',
      config: '.ai/qa/tests/playwright.config.ts',
      browsers: ['chromium'],
    },
    testRunner: { name: 'playwright', config: '.ai/qa/tests/playwright.config.ts' },
    platform: process.platform,
    startedAt: new Date().toISOString(),
    sourceFingerprint: process.env.TEST_ENV_SOURCE_FINGERPRINT,
    notes: process.env.TEST_ENV_NOTES ?? 'Reusable isolated sandbox. Docker volumes are preserved by the down script; KSeF secrets belong in .ai/qa/secrets and are never written here.',
  }
  writeJson(path, descriptor)
} else if (command === 'mark-stopped') {
  const [path] = args
  try {
    const descriptor = readJson(path)
    descriptor.status = 'stopped'
    descriptor.stoppedAt = new Date().toISOString()
    writeJson(path, descriptor)
  } catch {
    // Idempotent teardown: an absent or malformed descriptor is already stopped.
  }
} else if (command === 'append-note') {
  const [path, note] = args
  const descriptor = readJson(path)
  descriptor.notes = `${descriptor.notes ?? ''} ${note}`.trim()
  writeJson(path, descriptor)
} else if (command === 'root') {
  process.stdout.write(resolve(import.meta.dirname, '../..'))
} else {
  process.stderr.write(`Unknown test-env state command: ${command ?? '(missing)'}\n`)
  process.exit(2)
}
