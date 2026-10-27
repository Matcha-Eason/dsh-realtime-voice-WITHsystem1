import { access, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parent = join(root, '.local/models')
const name = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const modelDir = join(parent, name)
const installed = await Promise.all(['model.int8.onnx', 'tokens.txt'].map(file => access(join(modelDir, file)).then(() => true, () => false)))
if (installed.every(Boolean)) {
  console.log(`Local ASR model ready: ${modelDir}`)
} else {
  // Explicit setup only: normal plugin startup never downloads model weights.
  await mkdir(parent, { recursive: true })
  const archive = join(parent, 'sensevoice.tar.bz2')
  for (const [command, args] of [
    ['curl', ['--fail', '--location', '--continue-at', '-', '--retry', '2', '--connect-timeout', '15', '--speed-time', '30', '--speed-limit', '1024', `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${name}.tar.bz2`, '--output', archive]],
    ['tar', ['-xjf', archive, '-C', parent]],
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'inherit' })
      child.on('error', reject)
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}; run setup again to resume the download`)))
    })
  }
  for (const file of ['model.int8.onnx', 'tokens.txt']) await access(join(modelDir, file))
  console.log(`Local ASR model ready: ${modelDir}`)
}
