import * as esbuild from 'esbuild'
import { glob } from 'glob'
import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, basename } from 'node:path'
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
          }
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
          }
        )
        writeFileSync(file, content)
      }
    })
  }
}

await esbuild.build({
  entryPoints,
  outdir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  jsx: 'automatic',
  loader: { '.ttf': 'dataurl', '.otf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  plugins: [addJsExtension],
})

const assetFiles = await glob('src/**/*.{ttf,otf,woff,woff2,png,jpg,svg}', {
  cwd: __dirname,
  absolute: true,
})

for (const file of assetFiles) {
  const rel = relative(join(__dirname, 'src'), file)
  const dest = join(__dirname, 'dist', rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(file, dest)
}

console.log(`Copied ${assetFiles.length} asset files`)

const fontsDir = join(__dirname, 'src/modules/pdf_generators/templates/shared/fonts')
const fontFiles = await glob('*.ttf', { cwd: fontsDir, absolute: true })

for (const file of fontFiles) {
  const name = basename(file, '.ttf')
  const base64 = readFileSync(file).toString('base64')
  const output = `const src = "data:font/truetype;base64,${base64}"\nexport default src\n`
  writeFileSync(join(fontsDir, `${name}.generated.ts`), output)
}

console.log(`Generated ${fontFiles.length} font files`)

console.log('pdf-generators built successfully')
