import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_ASR_MODEL_DIR = fileURLToPath(new URL('../../.local/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17', import.meta.url))
interface OfflineStream { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
interface OfflineRecognizer {
  createStream(): OfflineStream
  decodeAsync(stream: OfflineStream): Promise<{ text: string }>
}

/** One Host-owned model. Native async loading/decoding never blocks DSH's event loop. */
export class LocalSenseVoice {
  private model?: Promise<OfflineRecognizer>

  constructor(private readonly directory = process.env.DSH_VOICE_ASR_MODEL_DIR ?? DEFAULT_ASR_MODEL_DIR) {}

  async prepare(): Promise<void> {
    if (!this.model) {
      this.model = (async () => {
        await Promise.all([access(join(this.directory, 'model.int8.onnx')), access(join(this.directory, 'tokens.txt'))])
        const { OfflineRecognizer } = createRequire(import.meta.url)('sherpa-onnx-node') as {
          OfflineRecognizer: { createAsync(config: object): Promise<OfflineRecognizer> }
        }
        return await OfflineRecognizer.createAsync({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: {
            senseVoice: { model: join(this.directory, 'model.int8.onnx'), useInverseTextNormalization: 1 },
            tokens: join(this.directory, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0,
          },
        })
      })().catch(() => { this.model = undefined; throw new Error('本地 ASR 未就绪，请在插件目录运行 npm run setup:asr，或配置 DSH_VOICE_ASR_MODEL_DIR') })
    }
    await this.model
  }

  recognize = async (pcm: Buffer, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    await this.prepare()
    const recognizer = await this.model!
    signal.throwIfAborted()
    const stream = recognizer.createStream()
    const samples = new Float32Array(pcm.length / 2)
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768
    stream.acceptWaveform({ sampleRate: 16000, samples })
    const result = await recognizer.decodeAsync(stream)
    // Native decode cannot be preempted. Cancellation discards its result;
    // WindowedAsr starts the next window only after this call has settled.
    signal.throwIfAborted()
    return result.text.replace(/<\|[^|]*\|>/gu, '').trim()
  }
}
