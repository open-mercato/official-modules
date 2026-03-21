import test from 'node:test'
import assert from 'node:assert/strict'

import {
  chooseAncestorChannel,
  formatJson,
  inferChannel,
  normalizeChannel,
  parseArgs,
  rewriteManifest,
  toChannelHint,
} from './platform-sync.mjs'

test('parseArgs reads check mode and explicit channel', () => {
  const parsed = parseArgs(['--check', '--channel', 'develop'])

  assert.deepEqual(parsed, {
    check: true,
    channel: 'develop',
    help: false,
  })
})

test('normalizeChannel rejects unsupported values', () => {
  assert.throws(() => normalizeChannel('preview'), /Unsupported channel/)
})

test('toChannelHint maps branch names and channel names', () => {
  assert.equal(toChannelHint('develop'), 'develop')
  assert.equal(toChannelHint('latest'), 'latest')
  assert.equal(toChannelHint('main'), 'latest')
  assert.equal(toChannelHint('origin/develop'), 'develop')
  assert.equal(toChannelHint('feature/x'), null)
})

test('chooseAncestorChannel prefers the newer ancestor branch', () => {
  const channel = chooseAncestorChannel([
    { channel: 'latest', timestamp: 100 },
    { channel: 'develop', timestamp: 200 },
  ])

  assert.equal(channel, 'develop')
})

test('chooseAncestorChannel returns null for tied branch timestamps', () => {
  const channel = chooseAncestorChannel([
    { channel: 'latest', timestamp: 200 },
    { channel: 'develop', timestamp: 200 },
  ])

  assert.equal(channel, null)
})

test('inferChannel prefers explicit channel over git hints', () => {
  const channel = inferChannel({
    explicitChannel: 'latest',
    envChannel: null,
    baseBranch: 'develop',
    currentBranch: 'feature/platform-sync',
    upstreamBranch: 'origin/develop',
    ancestorCandidates: [{ channel: 'develop', timestamp: 200 }],
  })

  assert.equal(channel, 'latest')
})

test('rewriteManifest updates sandbox platform pins without touching peerDependencies', () => {
  const manifest = {
    dependencies: {
      '@open-mercato/core': '0.4.8',
      '@open-mercato/shared': '0.4.8',
      react: '19.2.1',
    },
    optionalDependencies: {
      '@open-mercato/ui': '0.4.8',
    },
    peerDependencies: {
      '@open-mercato/core': '>=0.4.8 <0.5.0',
    },
  }

  const { changed, manifest: nextManifest } = rewriteManifest(manifest, {
    kind: 'sandbox',
    exactVersions: new Map([
      ['@open-mercato/core', '0.4.9-develop.1013.aa3a9dea92'],
      ['@open-mercato/shared', '0.4.9-develop.1013.aa3a9dea92'],
      ['@open-mercato/ui', '0.4.9-develop.1013.aa3a9dea92'],
    ]),
  })

  assert.equal(changed, true)
  assert.equal(
    nextManifest.dependencies['@open-mercato/core'],
    '0.4.9-develop.1013.aa3a9dea92'
  )
  assert.equal(
    nextManifest.optionalDependencies['@open-mercato/ui'],
    '0.4.9-develop.1013.aa3a9dea92'
  )
  assert.equal(nextManifest.peerDependencies['@open-mercato/core'], '>=0.4.8 <0.5.0')
})

test('rewriteManifest updates only workspace devDependencies', () => {
  const manifest = {
    dependencies: {
      '@open-mercato/ui': '0.4.8',
    },
    devDependencies: {
      '@open-mercato/shared': '0.4.8',
      '@open-mercato/ui': '0.4.8',
    },
    peerDependencies: {
      '@open-mercato/shared': '>=0.4.8 <0.5.0',
    },
  }

  const { manifest: nextManifest } = rewriteManifest(manifest, {
    kind: 'workspace',
    exactVersions: new Map([
      ['@open-mercato/shared', '0.4.9-develop.1013.aa3a9dea92'],
      ['@open-mercato/ui', '0.4.9-develop.1013.aa3a9dea92'],
    ]),
  })

  assert.equal(nextManifest.dependencies['@open-mercato/ui'], '0.4.8')
  assert.equal(
    nextManifest.devDependencies['@open-mercato/shared'],
    '0.4.9-develop.1013.aa3a9dea92'
  )
  assert.equal(nextManifest.peerDependencies['@open-mercato/shared'], '>=0.4.8 <0.5.0')
})

test('formatJson preserves package.json trailing newline', () => {
  assert.equal(formatJson({ name: 'official-modules' }), '{\n  "name": "official-modules"\n}\n')
})
