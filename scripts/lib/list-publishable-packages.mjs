import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..')
const packagesRoot = path.join(repoRoot, 'packages')

const cliFilters = process.argv.slice(2)
const envFilters = (process.env.PUBLISH_PACKAGE_FILTER ?? '')
  .split(/[,\s]+/)
  .map((value) => value.trim())
  .filter(Boolean)

const filters = [...new Set([...envFilters, ...cliFilters])]

const slugifyPackageName = (packageName) => packageName.replace(/^@/, '').replace(/\//g, '-')

const packageDirs = await readdir(packagesRoot, { withFileTypes: true }).catch((error) => {
  console.error(`Error: Unable to read ${packagesRoot}: ${error.message}`)
  process.exit(1)
})

const publishablePackages = []

for (const entry of packageDirs) {
  if (!entry.isDirectory()) {
    continue
  }

  const packageDir = path.join(packagesRoot, entry.name)
  const manifestPath = path.join(packageDir, 'package.json')

  try {
    await access(manifestPath)
  } catch {
    continue
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  if (manifest.private === true) {
    continue
  }

  if (manifest.publishConfig?.access !== 'public') {
    continue
  }

  if (!manifest.name || !manifest.version) {
    console.error(`Error: ${path.relative(repoRoot, manifestPath)} is missing required publish metadata.`)
    process.exit(1)
  }

  publishablePackages.push({
    archiveFile: `${slugifyPackageName(manifest.name)}-${manifest.version}.tgz`,
    dir: packageDir,
    folderName: entry.name,
    name: manifest.name,
    version: manifest.version,
  })
}

if (publishablePackages.length === 0) {
  console.error('Error: No publishable packages were found under packages/.')
  process.exit(1)
}

let selectedPackages = publishablePackages

if (filters.length > 0) {
  const matchedFilters = new Set()

  selectedPackages = publishablePackages.filter((pkg) => {
    const isMatch = filters.some((filter) => filter === pkg.folderName || filter === pkg.name)

    if (isMatch) {
      filters
        .filter((filter) => filter === pkg.folderName || filter === pkg.name)
        .forEach((filter) => matchedFilters.add(filter))
    }

    return isMatch
  })

  const unknownFilters = filters.filter((filter) => !matchedFilters.has(filter))

  if (unknownFilters.length > 0) {
    console.error(`Error: Unknown publish package filter(s): ${unknownFilters.join(', ')}`)
    console.error(
      `Available publishable packages: ${publishablePackages
        .map((pkg) => `${pkg.folderName} (${pkg.name})`)
        .join(', ')}`
    )
    process.exit(1)
  }
}

if (selectedPackages.length === 0) {
  console.error('Error: No publishable packages matched the requested filter set.')
  process.exit(1)
}

selectedPackages.sort((left, right) => left.name.localeCompare(right.name))

for (const pkg of selectedPackages) {
  process.stdout.write(`${pkg.dir}\t${pkg.name}\t${pkg.version}\t${pkg.archiveFile}\n`)
}
