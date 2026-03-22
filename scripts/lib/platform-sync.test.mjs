import test from 'node:test'
import assert from 'node:assert/strict'

import {
  chooseAncestorChannel,
  formatJson,
  inferChannel,
  normalizeChannel,
  parseArgs,
  rewriteManifest,
  selectSyncTargets,
  toChannelHint,
} from './platform-sync.mjs'

test('parseArgs reads check mode and explicit channel', () => {
  const parsed = parseArgs(['--check', '--channel', 'develop'])

  assert.deepEqual(parsed, {
    check: true,
    channel: 'develop',
    help: false,
    packages: [],
  })
})

test('normalizeChannel rejects unsupported values', () => {
  assert.throws(() => normalizeChannel('preview'), /Unsupported channel/)
})

test('parseArgs collects package filters from repeated and whitespace-separated values', () => {
  const parsed = parseArgs([
    '--package',
    '@open-mercato/test-package sandbox',
    '--package=@open-mercato/other-package',
    '--channel',
    'latest',
  ])

  assert.deepEqual(parsed, {
    check: false,
    channel: 'latest',
    help: false,
    packages: [
      '@open-mercato/test-package',
      'sandbox',
      '@open-mercato/other-package',
    ],
  })
})

test('parseArgs rejects --package without at least one workspace name', () => {
  assert.throws(() => parseArgs(['--package']), /Missing value for --package/)
  assert.throws(() => parseArgs(['--package', '--check']), /Missing value for --package/)
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

test('selectSyncTargets returns all targets when no package filter is provided', () => {
  const targets = [
    {
      kind: 'sandbox',
      manifestPath: '/repo/apps/sandbox/package.json',
      workspaceName: 'sandbox',
    },
    {
      kind: 'workspace',
      manifestPath: '/repo/packages/test-package/package.json',
      workspaceName: '@open-mercato/test-package',
    },
  ]

  assert.deepEqual(selectSyncTargets(targets, []), targets)
})

test('selectSyncTargets keeps only requested workspace names', () => {
  const targets = [
    {
      kind: 'sandbox',
      manifestPath: '/repo/apps/sandbox/package.json',
      workspaceName: 'sandbox',
    },
    {
      kind: 'workspace',
      manifestPath: '/repo/packages/test-package/package.json',
      workspaceName: '@open-mercato/test-package',
    },
  ]

  assert.deepEqual(selectSyncTargets(targets, ['sandbox']), [targets[0]])
})

test('selectSyncTargets rejects unknown workspace names', () => {
  const targets = [
    {
      kind: 'sandbox',
      manifestPath: '/repo/apps/sandbox/package.json',
      workspaceName: 'sandbox',
    },
  ]

  assert.throws(
    () => selectSyncTargets(targets, ['@open-mercato/missing-package']),
    /Unknown workspace package name\(s\) for --package/
  )
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
