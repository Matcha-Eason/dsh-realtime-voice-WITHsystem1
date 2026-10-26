import { randomUUID } from 'node:crypto'

type Event = Record<string, unknown>

export const TOKEN_PLAN_ASR_ENDPOINT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

type Recognition = { id: string; pcm: Buffer; final: boolean }

/** Token Plan's ASR model accepts complete audio, not a realtime input stream.
 * This adapter produces explicitly provisional rolling-window transcriptions.
 * Local energy VAD controls pauses independently of the HTTP round trip.
 * https://help.aliyun.com/en/model-studio/fun-asr-flash-recorded-speech-recognition-http-api
 */
export class QwenHttpAsr {
  private readonly abort = new AbortController()
  private configured = false
  private closed = false
  private silenceSamples = 9_600
  private preRoll = Buffer.alloc(0)
  private onsetSamples = 0
  private quietSamples = 0
  private current: { id: string; frames: Buffer[]; samples: number; requestedSamples: number } | undefined
  private pending = new Map<string, Recognition>()
  private inFlight = false

  constructor(
    private readonly model: string,
    private readonly key: string,
    private readonly emit: (event: Event) => void,
    private readonly request: typeof fetch = fetch,
  ) {}

  client(event: Event): void {
    if (this.closed) return
    if (event.type === 'session.finish') return this.close()
    if (event.type === 'session.update') {
      const session = event.session as Record<string, unknown> | undefined
      const vad = session?.turn_detection as Record<string, unknown> | undefined
      const silenceMs = vad?.silence_duration_ms
      if (session?.input_audio_format !== 'pcm' || session.sample_rate !== 16000
        || typeof silenceMs !== 'number' || !Number.isFinite(silenceMs) || silenceMs < 200 || silenceMs > 6000) {
        return this.fail('Invalid Qwen ASR session settings')
      }
      this.silenceSamples = Math.round(silenceMs * 16)
      this.configured = true
      this.emit({ type: 'session.updated', session: { transcription_mode: 'rolling-window' } })
      return
    }
    if (event.type !== 'input_audio_buffer.append') return
    if (!this.configured || typeof event.audio !== 'string' || event.audio.length > 180_000
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.audio)) return this.fail('Invalid Qwen ASR audio input')
    const pcm = Buffer.from(event.audio, 'base64')
    if (pcm.length === 0 || pcm.length % 2 !== 0) return this.fail('Invalid Qwen ASR audio input')
    const samples = pcm.length / 2
    let energy = 0
    for (let offset = 0; offset < pcm.length; offset += 2) energy += (pcm.readInt16LE(offset) / 32768) ** 2
    const voiced = Math.sqrt(energy / samples) >= 0.015
    let started = false
    if (!this.current) {
      this.preRoll = Buffer.concat([this.preRoll, pcm]).subarray(-6_400)
      this.onsetSamples = voiced ? this.onsetSamples + samples : 0
      if (this.onsetSamples < 1_280) return
      this.current = { id: randomUUID(), frames: [this.preRoll], samples: this.preRoll.length / 2, requestedSamples: 0 }
      this.preRoll = Buffer.alloc(0)
      this.quietSamples = 0
      started = true
      this.emit({ type: 'input_audio_buffer.speech_started', item_id: this.current.id })
    }
    if (!started) {
      this.current.frames.push(pcm)
      this.current.samples += samples
    }
    this.quietSamples = voiced ? 0 : this.quietSamples + samples
    if (this.quietSamples >= this.silenceSamples || this.current.samples >= 240_000) {
      const utterance = this.current
      this.current = undefined
      this.onsetSamples = 0
      this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: utterance.id })
      this.enqueue({ id: utterance.id, pcm: Buffer.concat(utterance.frames), final: true })
    } else if (this.current.samples - this.current.requestedSamples >= 16_000) {
      this.current.requestedSamples = this.current.samples
      this.enqueue({ id: this.current.id, pcm: Buffer.concat(this.current.frames), final: false })
    }
  }

  close(): void {
    this.closed = true
    this.abort.abort()
    this.pending.clear()
    this.current = undefined
    this.preRoll = Buffer.alloc(0)
  }

  private enqueue(recognition: Recognition): void {
    // Revisions replace pending previews; completed segments remain ordered.
    this.pending.set(recognition.id, recognition)
    if (this.pending.size > 8) return this.fail('Qwen ASR cannot keep up with incoming speech')
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.closed || this.inFlight || this.pending.size === 0) return
    const next = [...this.pending.values()].find(item => item.final) ?? this.pending.values().next().value!
    this.pending.delete(next.id)
    this.inFlight = true
    try {
      const wav = Buffer.alloc(44 + next.pcm.length)
      wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
      wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
      wav.write('data', 36); wav.writeUInt32LE(next.pcm.length, 40); next.pcm.copy(wav, 44)
      const response = await this.request(TOKEN_PLAN_ASR_ENDPOINT, {
        method: 'POST', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]),
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' },
        body: JSON.stringify({
          model: this.model,
          input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } }] }] },
          parameters: { format: 'wav', sample_rate: '16000' },
        }),
      })
      const result = await response.json() as { text?: unknown; output?: { text?: unknown } } | null
      // Live Token Plan returns exactly HTTP 400 + {} for audio with no speech.
      // Keep that narrow compatibility case separate from invalid requests.
      const noSpeech = response.status === 400 && result !== null && typeof result === 'object'
        && !Array.isArray(result) && Object.keys(result).length === 0
      if (!response.ok && !noSpeech) throw new Error('ASR request rejected')
      const transcript = noSpeech ? '' : typeof result?.output?.text === 'string' ? result.output.text : result?.text
      if (typeof transcript !== 'string') throw new Error('Invalid ASR result')
      if (!this.closed && (next.final || !this.pending.get(next.id)?.final)) {
        this.emit(next.final
          ? { type: 'conversation.item.input_audio_transcription.completed', item_id: next.id, transcript }
          : { type: 'conversation.item.input_audio_transcription.text', item_id: next.id, text: transcript, provisional: true })
      }
    } catch {
      if (!this.closed) this.fail('Qwen ASR recognition failed')
    } finally {
      this.inFlight = false
      void this.drain()
    }
  }

  private fail(message: string): void {
    this.emit({ type: 'error', error: { message } })
    this.close()
  }
}

/** Converts the browser's TTS buffer events to Qwen-Audio's task protocol.
 * Each committed chunk owns one task; only the caller's text is synthesized.
 * https://help.aliyun.com/zh/model-studio/qwen-audio-tts-client-events
 */
export class QwenInferenceTts {
  private voice = 'longanlingxin'
  private configured = false
  private text = ''
  private task: { id: string; text: string; started: boolean } | undefined

  constructor(
    private readonly model: string,
    private readonly send: (event: Event) => void,
    private readonly emit: (event: Event) => void,
  ) {}

  open(): void { this.emit({ type: 'session.created' }) }

  client(event: Event): void {
    if (event.type === 'session.finish') {
      if (this.task?.started) this.send({
        header: { action: 'finish-task', task_id: this.task.id, streaming: 'duplex' },
        payload: { input: { directive: 'cancel' } },
      })
      this.task = undefined
      this.text = ''
      return
    }
    if (event.type === 'session.update') {
      const session = event.session as Record<string, unknown> | undefined
      if (!session || session.response_format !== 'pcm' || session.sample_rate !== 24000
        || session.mode !== 'commit' || typeof session.voice !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(session.voice) || this.task) {
        this.fail('Invalid Qwen TTS session settings')
        return
      }
      this.voice = session.voice
      this.configured = true
      this.emit({ type: 'session.updated' })
      return
    }
    if (!this.configured) return this.fail('Qwen TTS session is not configured')
    if (event.type === 'input_text_buffer.append') {
      if (typeof event.text !== 'string' || this.text.length + event.text.length > 20_000 || this.task) {
        return this.fail('Invalid Qwen TTS text buffer')
      }
      this.text += event.text
      return
    }
    if (event.type !== 'input_text_buffer.commit') return
    if (this.task || !this.text.trim()) return this.fail('Qwen TTS has no committable text')
    this.task = { id: randomUUID(), text: this.text, started: false }
    this.text = ''
    this.send({
      header: { action: 'run-task', task_id: this.task.id, streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: this.model,
        parameters: { text_type: 'PlainText', voice: this.voice, format: 'pcm', sample_rate: 24000, enable_ssml: false },
        input: {},
      },
    })
  }

  upstream(data: Buffer, binary: boolean): void {
    if (binary) {
      if (this.task?.started) this.emit({ type: 'response.audio.delta', delta: data.toString('base64') })
      return
    }
    let event: { header?: { event?: string; task_id?: string } } | null
    try { event = JSON.parse(data.toString()) as typeof event }
    catch { return this.fail('Qwen TTS returned an invalid event') }
    if (!this.task || event?.header?.task_id !== this.task.id) return
    if (event.header.event === 'task-started' && !this.task.started) {
      this.task.started = true
      this.send({
        header: { action: 'continue-task', task_id: this.task.id, streaming: 'duplex' },
        payload: { input: { text: this.task.text } },
      })
      this.send({ header: { action: 'finish-task', task_id: this.task.id, streaming: 'duplex' }, payload: { input: {} } })
    } else if (event.header.event === 'task-finished') {
      this.task = undefined
      this.emit({ type: 'response.done' })
    } else if (event.header.event === 'task-failed') {
      this.task = undefined
      this.fail('Qwen TTS synthesis failed')
    }
  }

  private fail(message: string): void { this.emit({ type: 'error', error: { message } }) }
}
