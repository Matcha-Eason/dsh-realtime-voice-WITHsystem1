import { lstat, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const names = Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/'))
const explicitRoot = process.argv[2] ?? process.env.DSH_SOURCE_ROOT
const sibling = resolve(root, '../deepseek-harness')
const sourceRoot = explicitRoot === undefined
  ? await lstat(join(sibling, 'package.json')).then(() => sibling, () => undefined)
  : resolve(explicitRoot)
const sources = new Map()

if (sourceRoot !== undefined) {
  // Discover the checkout's own package names instead of assuming npm names
  // match its domain/directory layout. This does not build or modify Harness.
  const pending = [join(sourceRoot, 'vendor'), join(sourceRoot, 'packages')]
  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.some(entry => entry.name === 'package.json')) {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      sources.set(pkg.name, directory)
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        pending.push(join(directory, entry.name))
      }
    }
  }
} else {
  const appModules = '/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules'
  for (const name of names) sources.set(name, join(appModules, ...name.split('/')))
}

// Resolve everything before changing links so an incompatible SDK fails as one
// actionable setup error, without leaving a partially switched dependency set.
for (const name of names) {
  const source = sources.get(name)
  if (source === undefined) throw new Error(`DSH checkout does not contain ${name}`)
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await lstat(join(source, pkg.types)).catch(() => {
    throw new Error(`${name} has no built declarations. Build the selected DSH checkout first.`)
  })
}
for (const name of names) {
  const target = join(root, 'node_modules', ...name.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await rm(target, { recursive: true, force: true })
  await symlink(sources.get(name), target, 'dir')
}
process.stdout.write(`Linked ${names.length} DSH packages from ${sourceRoot ?? 'the installed desktop app'}.\n`)
