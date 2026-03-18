import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const [inputDirArg, outputDirArg] = process.argv.slice(2)

if (!inputDirArg || !outputDirArg) {
  console.error('Usage: node scripts/lib/prepare-preview-tarballs.mjs <input-dir> <output-dir>')
  process.exit(1)
}

const inputDir = path.resolve(inputDirArg)
const outputDir = path.resolve(outputDirArg)

const previewId =
  process.env.PREVIEW_VERSION_ID ??
  `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.${process.pid}`

const versionLabel = process.env.VERSION_PRERELEASE_LABEL ?? 'preview'

const dependencyScopes = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

const slugifyPackageName = (packageName) => packageName.replace(/^@/, '').replace(/\//g, '-')

const toPreviewVersion = (version) => {
  const [baseVersion] = version.split('+', 1)
  return baseVersion.includes('-')
    ? `${baseVersion}.${versionLabel}.${previewId}`
    : `${baseVersion}-${versionLabel}.${previewId}`
}

const tarballs = (await readdir(inputDir))
  .filter((entry) => entry.endsWith('.tgz'))
  .map((entry) => path.join(inputDir, entry))
  .sort()

if (tarballs.length === 0) {
  console.error(`Error: No tarballs were found in ${inputDir}.`)
  process.exit(1)
}

await rm(outputDir, { force: true, recursive: true })
await mkdir(outputDir, { recursive: true })

const packages = tarballs.map((tarballPath) => {
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], { encoding: 'utf8' })
  )

  return {
    manifest,
    previewVersion: toPreviewVersion(manifest.version),
    tarballPath,
  }
})

const previewVersionByName = new Map(
  packages.map(({ manifest, previewVersion }) => [manifest.name, previewVersion])
)

for (const { manifest, previewVersion, tarballPath } of packages) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'official-modules-preview-'))

  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', tempDir])

    const manifestPath = path.join(tempDir, 'package', 'package.json')
    const mutableManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    mutableManifest.version = previewVersion

    for (const scope of dependencyScopes) {
      if (!mutableManifest[scope]) {
        continue
      }

      for (const dependencyName of Object.keys(mutableManifest[scope])) {
        const replacementVersion = previewVersionByName.get(dependencyName)

        if (replacementVersion) {
          mutableManifest[scope][dependencyName] = replacementVersion
        }
      }
    }

    await writeFile(manifestPath, `${JSON.stringify(mutableManifest, null, 2)}\n`)

    const outputTarball = path.join(
      outputDir,
      `${slugifyPackageName(mutableManifest.name)}-${previewVersion}.tgz`
    )

    execFileSync('tar', ['-czf', outputTarball, '-C', tempDir, 'package'])

    process.stdout.write(`${mutableManifest.name}\t${previewVersion}\t${outputTarball}\n`)
  } finally {
    await rm(tempDir, { force: true, recursive: true })
  }
}
