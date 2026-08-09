// Generic MikroORM migration generator for an official-modules package.
//
// Runs the same Migrator the @open-mercato/cli `db generate` command uses, but
// scoped to a single workspace package and writing to the package SOURCE tree
// (`src/modules/<moduleId>/migrations/`). The built-in `mercato db generate`
// only targets `@app` modules and, in a standalone consumer repo, would write
// package migrations to `dist/`. This keeps the migration + snapshot committed
// with the package; the package build globs `src/**` into `dist/`, and
// `mercato db migrate` applies it in standalone apps.
//
// Runs through `tsx` (the repo's TS-script runner), importing entity source
// directly — no build/`dist` required. MikroORM entities here declare an
// explicit `type` on every decorator, so no `emitDecoratorMetadata` is needed.
//
// Usage (from the repo root):
//   yarn module:db:generate <package> [moduleId]
//   e.g. yarn module:db:generate pdf-generators
// <package> is the folder under packages/ (or a path). Run without a <package>
// arg from inside a package dir to target the current working directory.
// (The root script passes `--tsconfig tsconfig.base.json` so entity decorators
// transform as legacy `experimentalDecorators`.)
//
// Requires a reachable Postgres via DATABASE_URL (read from apps/sandbox/.env).
// Run with Node 24.

import 'reflect-metadata'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql'
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy'
import { Migrator } from '@mikro-orm/migrations'

const SNAPSHOT_NAME = '.snapshot-open-mercato'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// Resolve the target package. This is a repo-level dev tool run from the root
// with the package name/dir as the first arg (so the shippable module package
// carries no dev-only script). Falls back to the current directory when invoked
// from inside a package. Optional second arg restricts to one module id.
const packageArg = process.argv[2] || null
const onlyModule = process.argv[3] || null

function resolvePackageRoot(): string {
  if (!packageArg) return process.cwd()
  for (const candidate of [path.join(repoRoot, 'packages', packageArg), path.resolve(packageArg)]) {
    if (fs.existsSync(path.join(candidate, 'src/modules'))) return candidate
  }
  console.error(`Package not found: '${packageArg}' (looked in packages/${packageArg} and ${path.resolve(packageArg)}).`)
  process.exit(1)
}

const packageRoot = resolvePackageRoot()

// Load the dev database env (sandbox), then any package-local override.
for (const envPath of [
  path.join(repoRoot, 'apps/sandbox/.env'),
  path.join(packageRoot, '.env'),
]) {
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath })
}

const clientUrl = process.env.DATABASE_URL
if (!clientUrl) {
  console.error('DATABASE_URL is not set (looked in apps/sandbox/.env). Is the dev database running?')
  process.exit(1)
}

const srcModulesDir = path.join(packageRoot, 'src/modules')
if (!fs.existsSync(srcModulesDir)) {
  console.error(`No src/modules in ${packageRoot}. Run this from a module package directory.`)
  process.exit(1)
}

// Discover modules that ship an entities source file.
const resolveEntitiesFile = (moduleId: string): string | null => {
  for (const ext of ['ts', 'tsx']) {
    const p = path.join(srcModulesDir, moduleId, 'data', `entities.${ext}`)
    if (fs.existsSync(p)) return p
  }
  return null
}

const moduleIds = fs
  .readdirSync(srcModulesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((id) => (onlyModule ? id === onlyModule : true))
  .filter((id) => resolveEntitiesFile(id) !== null)

if (moduleIds.length === 0) {
  console.log(onlyModule ? `Module '${onlyModule}' has no data/entities file.` : 'No modules with entities found.')
  process.exit(0)
}

async function run() {
for (const moduleId of moduleIds) {
  const entitiesFile = resolveEntitiesFile(moduleId)!
  const entitiesModule = await import(pathToFileURL(entitiesFile).href)
  const entities = Object.values(entitiesModule).filter((v) => typeof v === 'function')
  if (entities.length === 0) {
    console.log(`[${moduleId}] no exported entity classes — skipped.`)
    continue
  }

  const migrationsPath = path.join(srcModulesDir, moduleId, 'migrations')
  fs.mkdirSync(migrationsPath, { recursive: true })
  const initial = !fs.existsSync(path.join(migrationsPath, `${SNAPSHOT_NAME}.json`))

  const orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl,
    entities,
    metadataProvider: ReflectMetadataProvider,
    extensions: [Migrator],
    migrations: {
      path: migrationsPath,
      glob: '!(*.d).{ts,js}',
      tableName: `mikro_orm_migrations_${moduleId}`,
      snapshotName: SNAPSHOT_NAME,
      dropTables: false,
      emit: 'ts',
    },
    schemaGenerator: { disableForeignKeys: true },
  })

  try {
    const diff = await orm.migrator.create(undefined, false, initial)
    if (!diff || !diff.fileName) {
      console.log(`[${moduleId}] no schema changes.`)
      continue
    }
    // Match the CLI: suffix class + file with the module id (keeps each module's
    // migration-table registration unique) and make constraint drops idempotent.
    const orig = path.isAbsolute(diff.fileName) ? diff.fileName : path.join(migrationsPath, diff.fileName)
    const ext = path.extname(orig)
    const stem = path.basename(orig, ext)
    const suffix = `_${moduleId}`
    const newPath = path.join(path.dirname(orig), stem.endsWith(suffix) ? `${stem}${ext}` : `${stem}${suffix}${ext}`)

    let content = fs.readFileSync(orig, 'utf8')
    content = content.replace(/drop constraint "/g, 'drop constraint if exists "')
    content = content.replace(/export class (Migration\d+)/, `export class $1_${moduleId}`)
    fs.writeFileSync(newPath, content, 'utf8')
    if (newPath !== orig) fs.unlinkSync(orig)
    console.log(`[${moduleId}] generated ${path.relative(packageRoot, newPath)}`)
  } finally {
    await orm.close(true)
  }
}
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
