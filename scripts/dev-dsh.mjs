import { spawn } from 'node:child_process'
import { access, lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(root, '.env.local')
const hasEnvFile = await access(envFile).then(() => true, () => false)
if (hasEnvFile) loadEnvFile(envFile)
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? join(root, '../deepseek-harness'))
const bin = join(sourceRoot, 'apps/cli/lib/bin.js')
const mainModel = process.env.DSH_VOICE_MAIN_MODEL ?? 'deepseek-v4.1-flash'
for (const file of [bin, join(root, 'lib/index.js'), join(root, 'lib/client.js')]) {
  await access(file).catch(() => { throw new Error(`Missing ${file}; build the checkout first.`) })
}

// This profile belongs only to this checkout. The installed DSH profile and
// OS home are never involved; DSH_HOME is the native Harness data-root option.
const dshHome = join(root, '.local/dsh')
const profile = join(dshHome, 'profiles/voice-dev')
const modules = join(profile, 'node_modules')
await mkdir(modules, { recursive: true })
const pluginLink = join(modules, 'dsh-realtime-voice')
const existing = await lstat(pluginLink).catch(error => {
  if (error.code !== 'ENOENT') throw error
})
if (existing === undefined) {
  await symlink(root, pluginLink, 'dir')
} else if (!existing.isSymbolicLink() || await realpath(pluginLink) !== await realpath(root)) {
  throw new Error(`The development profile already has a different plugin at ${pluginLink}`)
}
// Initialize once, so subsequent launches preserve edits made in DSH's UI.
await writeFile(join(profile, 'package.json'), JSON.stringify({
  private: true,
  dependencies: { 'dsh-realtime-voice': `file:${root}` },
  dsh: { profile: { bundles: [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-realtime-voice',
  ] } },
}, null, 2) + '\n', { flag: 'wx' }).catch(error => {
  if (error.code !== 'EEXIST') throw error
})
const patch = join(dshHome, 'voice-dev.patch.json')
await writeFile(patch, JSON.stringify([
  { id: 'hmr', disabled: true },
  { id: 'agent-default-model', config: { provider: 'token-plan', model: mainModel } },
  { id: 'llm-pi-ai', config: { providers: { 'token-plan': {
    displayName: 'Bailian Token Plan',
    apiKeyEnv: 'BAILIAN_TOKEN_PLAN_API_KEY',
    api: 'openai-completions',
    baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    reasoning: 'off',
    // Bailian uses enable_thinking even for DeepSeek. Declaring no reasoning
    // support would omit the field and leave the provider's thinking enabled.
    compat: { thinkingFormat: 'qwen' },
    models: [...new Set([mainModel, 'deepseek-v4.1-flash', 'qwen3.8-flash'])].map(id => ({ id, reasoningEfforts: { off: null, high: 'high' } })),
  } } } },
], null, 2) + '\n')

const child = spawn(process.execPath, [
  bin, '--profile', 'voice-dev', '--patch', patch,
  '--no-open', '--port', process.env.DSH_VOICE_PORT ?? '3081',
  ...process.argv.slice(2),
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: join(root, '.local/agents'),
    DSH_TELEMETRY_DISABLED: '1',
  },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
