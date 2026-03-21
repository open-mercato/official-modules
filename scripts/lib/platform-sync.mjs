import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const validChannels = new Set(['develop', 'latest'])

const manifestScopes = ['dependencies', 'devDependencies', 'optionalDependencies']
const trackedChannelEnvKeys = ['OFFICIAL_MODULES_PLATFORM_CHANNEL', 'PLATFORM_SYNC_CHANNEL']
const trackedBaseRefEnvKeys = ['GITHUB_BASE_REF', 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME']

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function parseArgs(argv) {
  const result = {
    check: false,
    channel: null,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === '--check') {
      result.check = true
      continue
    }

    if (argument === '--help' || argument === '-h') {
      result.help = true
      continue
    }

    if (argument === '--channel') {
      const nextValue = argv[index + 1]

      if (!nextValue) {
        throw new Error('Missing value for --channel. Expected develop or latest.')
      }

      result.channel = normalizeChannel(nextValue)
      index += 1
      continue
    }

    if (argument.startsWith('--channel=')) {
      result.channel = normalizeChannel(argument.slice('--channel='.length))
      continue
    }

    throw new Error(`Unknown argument: ${argument}`)
  }

  return result
}

export function normalizeChannel(value) {
  if (!validChannels.has(value)) {
    throw new Error(`Unsupported channel "${value}". Expected develop or latest.`)
  }

  return value
}

export function normalizeBranchName(value) {
  if (!value) {
    return null
  }

  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^origin\//, '')
}

export function toChannelHint(value) {
  if (!value) {
    return null
  }

  if (validChannels.has(value)) {
    return value
  }

  const normalizedBranchName = normalizeBranchName(value)

  if (normalizedBranchName === 'develop') {
    return 'develop'
  }

  if (normalizedBranchName === 'main') {
    return 'latest'
  }

  return null
}

export function chooseAncestorChannel(candidates) {
  const sortedCandidates = [...candidates].sort((left, right) => {
    if (right.timestamp !== left.timestamp) {
      return right.timestamp - left.timestamp
    }

    return left.channel.localeCompare(right.channel)
  })

  if (sortedCandidates.length === 0) {
    return null
  }

  if (sortedCandidates.length === 1) {
    return sortedCandidates[0].channel
  }

  if (sortedCandidates[0].timestamp > sortedCandidates[1].timestamp) {
    return sortedCandidates[0].channel
  }

  return null
}

export function inferChannel({
  explicitChannel,
  envChannel,
  baseBranch,
  currentBranch,
  upstreamBranch,
  ancestorCandidates,
}) {
  for (const candidate of [
    explicitChannel,
    envChannel,
    baseBranch,
    currentBranch,
    upstreamBranch,
  ]) {
    const resolved = toChannelHint(candidate)

    if (resolved) {
      return resolved
    }
  }

  return chooseAncestorChannel(ancestorCandidates)
}

function readText(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function tryReadText(command, args, options = {}) {
  try {
    return readText(command, args, options)
  } catch {
    return null
  }
}

function commandSucceeds(command, args, options = {}) {
  try {
    execFileSync(command, args, {
      cwd: options.cwd,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, formatJson(value))
}

function listPathsFromSingleStarPattern(repoRoot, pattern) {
  if (!pattern.includes('*')) {
    const absolutePath = path.join(repoRoot, pattern)
    return existsSync(absolutePath) ? [absolutePath] : []
  }

  const [prefix, suffixWithStar] = pattern.split('*')
  const suffix = suffixWithStar.replace(/^\/+/, '')
  const parentDir = path.join(repoRoot, prefix)

  if (!existsSync(parentDir)) {
    return []
  }

  return readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDir, entry.name, suffix))
    .filter((candidatePath) => existsSync(candidatePath))
    .sort()
}

function collectWorkspaceManifestPaths(repoRoot) {
  const rootManifest = readJson(path.join(repoRoot, 'package.json'))
  const workspacePatterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : []
  const manifests = new Set()

  for (const workspacePattern of workspacePatterns) {
    const manifestPattern = `${workspacePattern.replace(/\/+$/, '')}/package.json`

    for (const manifestPath of listPathsFromSingleStarPattern(repoRoot, manifestPattern)) {
      manifests.add(manifestPath)
    }
  }

  return [...manifests].sort()
}

function loadPolicy(repoRoot) {
  return readJson(path.join(repoRoot, 'config/platform-channel-policy.json'))
}

function resolvePolicyChannel(policy, channel) {
  if (channel === 'develop') {
    return policy.channels?.develop ?? null
  }

  if (channel === 'latest') {
    return policy.channels?.main ?? null
  }

  return null
}

function resolveGitAncestorCandidates(repoRoot) {
  const branches = [
    { branch: 'develop', channel: 'develop' },
    { branch: 'main', channel: 'latest' },
  ]

  return branches
    .map(({ branch, channel }) => {
      const ref = [branch, `origin/${branch}`].find((candidate) =>
        commandSucceeds('git', ['rev-parse', '--verify', candidate], { cwd: repoRoot })
      )

      if (!ref) {
        return null
      }

      if (!commandSucceeds('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: repoRoot })) {
        return null
      }

      const timestampText = tryReadText('git', ['show', '-s', '--format=%ct', ref], { cwd: repoRoot })

      if (!timestampText) {
        return null
      }

      return {
        channel,
        timestamp: Number.parseInt(timestampText, 10) || 0,
      }
    })
    .filter(Boolean)
}

export function resolveChannel({ repoRoot, explicitChannel, env = process.env }) {
  const envChannel = trackedChannelEnvKeys.map((key) => env[key]).find(Boolean) ?? null
  const baseBranch = trackedBaseRefEnvKeys.map((key) => env[key]).find(Boolean) ?? null
  const currentBranch = tryReadText('git', ['branch', '--show-current'], { cwd: repoRoot })
  const upstreamBranch = tryReadText(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { cwd: repoRoot }
  )
  const ancestorCandidates = resolveGitAncestorCandidates(repoRoot)

  const channel = inferChannel({
    explicitChannel,
    envChannel,
    baseBranch,
    currentBranch,
    upstreamBranch,
    ancestorCandidates,
  })

  if (!channel) {
    const branchLabel = currentBranch || '(unknown branch)'
    throw new Error(
      `Could not resolve platform channel from ${branchLabel}. Pass --channel develop|latest or set OFFICIAL_MODULES_PLATFORM_CHANNEL.`
    )
  }

  return channel
}

function resolveExactVersion(packageName, distTag) {
  const output = readText('npm', ['view', `${packageName}@${distTag}`, 'version', '--json'])
  const parsed = JSON.parse(output)

  if (typeof parsed !== 'string' || parsed.length === 0) {
    throw new Error(`Could not resolve an exact version for ${packageName}@${distTag}.`)
  }

  return parsed
}

function resolveExactVersions(packageNames, distTag) {
  return new Map(
    [...packageNames]
      .sort()
      .map((packageName) => [packageName, resolveExactVersion(packageName, distTag)])
  )
}

export function rewriteManifest(manifest, { kind, exactVersions }) {
  const nextManifest = JSON.parse(JSON.stringify(manifest))
  let changed = false

  if (kind === 'sandbox') {
    for (const scope of manifestScopes) {
      const dependencies = nextManifest[scope]

      if (!dependencies) {
        continue
      }

      for (const dependencyName of Object.keys(dependencies)) {
        const exactVersion = exactVersions.get(dependencyName)

        if (!exactVersion || dependencies[dependencyName] === exactVersion) {
          continue
        }

        dependencies[dependencyName] = exactVersion
        changed = true
      }
    }
  }

  if (kind === 'workspace') {
    const dependencies = nextManifest.devDependencies

    if (dependencies) {
      for (const dependencyName of Object.keys(dependencies)) {
        const exactVersion = exactVersions.get(dependencyName)

        if (!exactVersion || dependencies[dependencyName] === exactVersion) {
          continue
        }

        dependencies[dependencyName] = exactVersion
        changed = true
      }
    }
  }

  return {
    changed,
    manifest: nextManifest,
  }
}

function buildExpectedManifestMap(repoRoot, policy, exactVersions) {
  const sandboxManifestPath = path.join(repoRoot, policy.sandboxManifest)
  const workspaceManifestPaths = listPathsFromSingleStarPattern(repoRoot, policy.workspaceGlob)
  const expectedManifestMap = new Map()

  for (const manifestPath of [sandboxManifestPath, ...workspaceManifestPaths]) {
    const kind = manifestPath === sandboxManifestPath ? 'sandbox' : 'workspace'
    const currentManifest = readJson(manifestPath)
    const { manifest } = rewriteManifest(currentManifest, { kind, exactVersions })
    expectedManifestMap.set(manifestPath, manifest)
  }

  return expectedManifestMap
}

function stageWorkspaceManifests(tempRepoRoot, repoRoot, expectedManifestMap) {
  const workspaceManifestPaths = collectWorkspaceManifestPaths(repoRoot)

  for (const workspaceManifestPath of workspaceManifestPaths) {
    const relativePath = path.relative(repoRoot, workspaceManifestPath)
    const tempManifestPath = path.join(tempRepoRoot, relativePath)
    const expectedManifest = expectedManifestMap.get(workspaceManifestPath)

    mkdirSync(path.dirname(tempManifestPath), { recursive: true })

    if (expectedManifest) {
      writeJson(tempManifestPath, expectedManifest)
      continue
    }

    copyFileSync(workspaceManifestPath, tempManifestPath)
  }
}

function createExpectedTempRepo(repoRoot, expectedManifestMap) {
  const tempRepoRoot = mkdtempSync(path.join(os.tmpdir(), 'official-modules-platform-sync-'))

  copyFileSync(path.join(repoRoot, 'package.json'), path.join(tempRepoRoot, 'package.json'))
  copyFileSync(path.join(repoRoot, 'yarn.lock'), path.join(tempRepoRoot, 'yarn.lock'))

  const yarnRcPath = path.join(repoRoot, '.yarnrc.yml')

  if (existsSync(yarnRcPath)) {
    copyFileSync(yarnRcPath, path.join(tempRepoRoot, '.yarnrc.yml'))
  }

  stageWorkspaceManifests(tempRepoRoot, repoRoot, expectedManifestMap)

  execFileSync('yarn', ['install', '--mode=update-lockfile'], {
    cwd: tempRepoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return tempRepoRoot
}

function compareState(repoRoot, expectedManifestMap, expectedLockfilePath) {
  const changedPaths = []

  for (const [manifestPath, expectedManifest] of expectedManifestMap.entries()) {
    const actualText = readFileSync(manifestPath, 'utf8')
    const expectedText = formatJson(expectedManifest)

    if (actualText !== expectedText) {
      changedPaths.push(path.relative(repoRoot, manifestPath))
    }
  }

  const actualLockfileText = readFileSync(path.join(repoRoot, 'yarn.lock'), 'utf8')
  const expectedLockfileText = readFileSync(expectedLockfilePath, 'utf8')

  if (actualLockfileText !== expectedLockfileText) {
    changedPaths.push('yarn.lock')
  }

  return changedPaths.sort()
}

function applyExpectedState(repoRoot, expectedManifestMap, expectedLockfilePath) {
  for (const [manifestPath, expectedManifest] of expectedManifestMap.entries()) {
    writeJson(manifestPath, expectedManifest)
  }

  copyFileSync(expectedLockfilePath, path.join(repoRoot, 'yarn.lock'))
}

function buildHelpText() {
  return [
    'Usage: yarn platform:sync [--check] [--channel develop|latest]',
    '',
    'Options:',
    '  --check                 Verify manifests and yarn.lock without writing files',
    '  --channel <channel>     Override channel detection with develop or latest',
    '  --help                  Show this message',
  ].join('\n')
}

export function main(argv, options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd()
  const parsedArgs = parseArgs(argv)

  if (parsedArgs.help) {
    process.stdout.write(`${buildHelpText()}\n`)
    return 0
  }

  const policy = loadPolicy(repoRoot)
  const channel = resolveChannel({
    repoRoot,
    explicitChannel: parsedArgs.channel,
    env: options.env ?? process.env,
  })
  const policyChannel = resolvePolicyChannel(policy, channel)

  if (!policyChannel) {
    throw new Error(`No policy entry found for channel ${channel}.`)
  }

  const exactVersions = resolveExactVersions(policy.platformPackages ?? [], policyChannel.distTag)
  const expectedManifestMap = buildExpectedManifestMap(repoRoot, policy, exactVersions)
  const tempRepoRoot = createExpectedTempRepo(repoRoot, expectedManifestMap)

  try {
    const changedPaths = compareState(
      repoRoot,
      expectedManifestMap,
      path.join(tempRepoRoot, 'yarn.lock')
    )

    if (parsedArgs.check) {
      if (changedPaths.length > 0) {
        process.stderr.write(
          [
            `Repository is out of sync for channel ${channel} (${policyChannel.distTag}).`,
            ...changedPaths.map((changedPath) => `- ${changedPath}`),
            '',
            `Run: yarn platform:sync --channel ${channel}`,
            '',
          ].join('\n')
        )
        return 1
      }

      process.stdout.write(
        `Repository is in sync for channel ${channel} (${policyChannel.distTag}).\n`
      )
      return 0
    }

    if (changedPaths.length === 0) {
      process.stdout.write(
        `Repository already matches channel ${channel} (${policyChannel.distTag}).\n`
      )
      return 0
    }

    applyExpectedState(repoRoot, expectedManifestMap, path.join(tempRepoRoot, 'yarn.lock'))

    process.stdout.write(
      [
        `Synchronized repository to channel ${channel} (${policyChannel.distTag}).`,
        ...changedPaths.map((changedPath) => `- ${changedPath}`),
        '',
      ].join('\n')
    )

    return 0
  } finally {
    rmSync(tempRepoRoot, { force: true, recursive: true })
  }
}
