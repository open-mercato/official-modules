import * as esbuild from 'esbuild'
import { glob } from 'glob'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const entryPoints = await glob('src/**/*.{ts,tsx}', {
  cwd: __dirname,
  ignore: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'],
  absolute: true,
})

if (entryPoints.length === 0) {
  console.error('No entry points found!')
  process.exit(1)
}

console.log(`Found ${entryPoints.length} entry points`)

const addJsExtension = {
  name: 'add-js-extension',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return
      const outputFiles = await glob('dist/**/*.js', { cwd: __dirname, absolute: true })
      for (const file of outputFiles) {
        const fileDir = dirname(file)
        let content = readFileSync(file, 'utf-8')
        content = content.replace(
          /from\s+["'](\.[^"']+)["']/g,
          (match, path) => {
            if (path.endsWith('.js') || path.endsWith('.json')) return match
            const resolvedPath = join(fileDir, path)
            if (existsSync(resolvedPath) && existsSync(join(resolvedPath, 'index.js'))) {
              return `from "${path}/index.js"`
            }
            return `from "${path}.js"`
          },
        )
        content = content.replace(
          /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
          (match, path) => {
            if (path.endsWith('.js') || path.endsWith('.json')) return match
            const resolvedPath = join(fileDir, path)
            if (existsSync(resolvedPath) && existsSync(join(resolvedPath, 'index.js'))) {
              return `import("${path}/index.js")`
            }
            return `import("${path}.js")`
          },
        )
        content = content.replace(
          /(^|\n)\s*import\s+["'](\.[^"']+)["']/g,
          (match, lead, path) => {
            if (path.endsWith('.js') || path.endsWith('.json')) return match
            const resolvedPath = join(fileDir, path)
            if (existsSync(resolvedPath) && existsSync(join(resolvedPath, 'index.js'))) {
              return `${lead}import "${path}/index.js"`
            }
            return `${lead}import "${path}.js"`
          },
        )
        writeFileSync(file, content)
      }
    })
  },
}

await esbuild.build({
  entryPoints,
  outdir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  jsx: 'automatic',
  plugins: [addJsExtension],
})

// Pack-time guard: the exports map points the runtime `default` condition at
// dist/*.js while the `types` condition resolves against src/*.ts, so tsc can
// pass even when dist is empty/stale. Refuse to ship unless the build actually
// mirrored the source tree — otherwise consumers hit ERR_MODULE_NOT_FOUND on
// every deep import the Open Mercato bootstrap generates.
const builtFiles = await glob('dist/**/*.js', { cwd: __dirname, absolute: true })
const canonicalDeepPath = join(__dirname, 'dist/modules/forms/data/entities.js')
if (!existsSync(canonicalDeepPath)) {
  console.error('[forms] build incomplete — missing dist/modules/forms/data/entities.js; refusing to publish')
  process.exit(1)
}
if (builtFiles.length < entryPoints.length) {
  console.error(
    `[forms] build incomplete — emitted ${builtFiles.length} JS files for ${entryPoints.length} source entry points; refusing to publish`,
  )
  process.exit(1)
}

console.log(`forms built successfully (${builtFiles.length} files)`)
