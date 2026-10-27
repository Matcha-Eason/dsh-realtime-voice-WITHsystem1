import { randomUUID } from 'node:crypto'

type Event = Record<string, unknown>
type Recognition = { id: string; pcm: Buffer; final: boolean }

/** Owns VAD, provisional windows, final priority and cancellation for batch ASR. */
export class WindowedAsr {
  private readonly abort = new AbortController()
  private configured = false
  private closed = false
  private silenceSamples = 9_600
  private preRoll = Buffer.alloc(0)
  private onsetSamples = 0
  private quietSamples = 0
  private current: { id: string; frames: Buffer[]; samples: number; requestedSamples: number } | undefined
  private pending = new Map<string, Recognition>()
  private inFlight?: { request: Recognition; abort: AbortController }

  constructor(
    private readonly recognize: (pcm: Buffer, signal: AbortSignal) => Promise<string>,
    private readonly emit: (event: Event) => void,
    private readonly previewMs = 1000,
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
        return this.fail('Invalid ASR session settings')
      }
      this.silenceSamples = Math.round(silenceMs * 16)
      this.configured = true
      this.emit({ type: 'session.updated', session: { transcription_mode: 'rolling-window' } })
      return
    }
    if (event.type !== 'input_audio_buffer.append') return
    if (!this.configured || typeof event.audio !== 'string' || event.audio.length > 180_000
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.audio)) return this.fail('Invalid ASR audio input')
    const pcm = Buffer.from(event.audio, 'base64')
    if (pcm.length === 0 || pcm.length % 2 !== 0) return this.fail('Invalid ASR audio input')
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
      this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: utterance.id, silence_ms: this.quietSamples / 16 })
      this.enqueue({ id: utterance.id, pcm: Buffer.concat(utterance.frames), final: true })
    } else if (this.current.samples - this.current.requestedSamples >= this.previewMs * 16) {
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
    // A final must not queue behind a preview the user has already outgrown.
    if (recognition.final && this.inFlight && !this.inFlight.request.final) this.inFlight.abort.abort()
    if (this.pending.size > 8) return this.fail('ASR cannot keep up with incoming speech')
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.closed || this.inFlight || this.pending.size === 0) return
    const next = [...this.pending.values()].find(item => item.final) ?? this.pending.values().next().value!
    this.pending.delete(next.id)
    const active = { request: next, abort: new AbortController() }
    this.inFlight = active
    try {
      const transcript = await this.recognize(next.pcm, AbortSignal.any([this.abort.signal, active.abort.signal]))
      if (active.abort.signal.aborted) return
      if (!this.closed && (next.final || !this.pending.get(next.id)?.final)) {
        this.emit(next.final
          ? { type: 'conversation.item.input_audio_transcription.completed', item_id: next.id, transcript }
          : { type: 'conversation.item.input_audio_transcription.text', item_id: next.id, text: transcript, provisional: true })
      }
    } catch {
      if (!this.closed && !active.abort.signal.aborted) this.fail('ASR recognition failed')
    } finally {
      this.inFlight = undefined
      void this.drain()
    }
  }

  private fail(message: string): void {
    this.emit({ type: 'error', error: { message } })
    this.close()
  }
}

