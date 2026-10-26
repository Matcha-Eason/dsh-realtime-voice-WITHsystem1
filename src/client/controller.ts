import { HarnessBridge, type DelegateResult } from './harness-delegate.ts'
import { loadPrefs, type VoicePrefs } from './prefs.ts'
import type { RealtimeCallbacks, TranscriptMeta } from './realtime.ts'
import { QwenPipelineConnection } from './qwen-pipeline.ts'
import type { TurnPhase } from './turn-coordinator.ts'
import { VoiceSummaryStream } from './voice-summary.ts'
import { TURN_ACTIONS, type TurnDecision, type TurnDecisionState } from '../turn-decision.ts'

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'working' | 'error'
export interface VoiceSnapshot {
  state: VoiceState
  detail: string
  provider: 'qwen'
  userSpeaking: boolean
  mainBusy: boolean
  playback: 'idle' | 'playing' | 'paused'
  transcript: string
}
export interface VoiceConnection {
  connect(): Promise<void>
  disconnect(): void
  speak?(text: string): Promise<void>
  waitForSpeechIdle?(): Promise<void>
  pauseSpeech?(): void
  resumeSpeech?(): void
  cancelSpeech?(): void
  setInputPhase?(phase: TurnPhase): void
}
export type VoiceConnectionFactory = (prefs: VoicePrefs, callbacks: RealtimeCallbacks) => VoiceConnection
export interface VoiceDraftTarget {
  getDraft(): string
  getDraftRev?(): number
  getPhase?(): 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  setDraft(text: string): void
  submit?(): void
}
export type DecideTurn = (state: TurnDecisionState, signal: AbortSignal) => Promise<TurnDecision>

interface SpeechOutput {
  turn: string
  source: VoiceConnection
  stream: VoiceSummaryStream
  pending: string[]
  draining: boolean
  speechRevision: number
  muted: boolean
  done: boolean
}
interface Interjection {
  text: string
  utteranceId?: string
  abort: AbortController
  delivered: boolean
}

/** Owns turn decisions and draft ownership; capture, generation and playback may overlap. */
export class VoiceController {
  private connection?: VoiceConnection
  private epoch = 0
  private readonly listeners = new Set<() => void>()
  private snapshot: VoiceSnapshot = { state: 'idle', detail: '', provider: 'qwen', userSpeaking: false, mainBusy: false, playback: 'idle', transcript: '' }
  private stopObserving?: () => void
  private contextTimer?: ReturnType<typeof setInterval>
  private draft?: VoiceDraftTarget
  private boundDraft = ''
  private draftRev?: number
  private writingDraft = false
  private ownsDraft = false
  private finals: string[] = []
  private partial = ''
  private stablePartial = ''
  private partialId?: string
  private consumedPrefix?: { id?: string; text: string }
  private readonly finalIds = new Set<string>()
  private readonly pendingFinals = new Set<string | undefined>()
  private revision = 0
  private speechActive = false
  private output?: SpeechOutput
  private heardText = ''
  private interrupted = false
  private playback: VoiceSnapshot['playback'] = 'idle'
  private nativePending = false
  private submitTimer?: ReturnType<typeof setTimeout>
  private decisionTimer?: ReturnType<typeof setTimeout>
  private decisionAbort?: AbortController
  private decisionDirty = false
  private interjection?: Interjection
  private lastInterjectionAt = -Infinity
  private voiceprint: TranscriptMeta['voiceprint']

  constructor(
    readonly sessionId: string,
    private readonly bridge: HarnessBridge,
    private readonly createConnection: VoiceConnectionFactory = (prefs, callbacks) => new QwenPipelineConnection(prefs, callbacks),
    private readonly decide: DecideTurn = requestTurnDecision,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = (): VoiceSnapshot => this.snapshot

  bindDraft(target: VoiceDraftTarget): () => void {
    const value = target.getDraft()
    const rev = target.getDraftRev?.()
    // A delayed React snapshot cannot revoke a newer voice write or restore
    // the empty draft from the preceding native submission.
    if (rev !== undefined && this.draftRev !== undefined && rev < this.draftRev) return () => {}
    const ownWrite = this.writingDraft && value === this.boundDraft
    if (ownWrite) {
      this.writingDraft = false
    } else if (value !== this.boundDraft || (rev !== undefined && this.draftRev !== undefined && rev !== this.draftRev)) {
      this.ownsDraft = false
      this.writingDraft = false
      this.invalidateDecision()
      this.cancelUnheardInterjection()
      if (value === '' && this.boundDraft !== '') {
        this.finals = []
        this.partial = ''
        this.stablePartial = ''
        this.partialId = undefined
        this.consumedPrefix = undefined
        this.voiceprint = undefined
      }
    }
    this.boundDraft = value
    this.draftRev = rev
    this.draft = target
    return () => { if (this.draft === target) this.draft = undefined }
  }

  async toggle(): Promise<void> {
    if (this.connection) return this.stop()
    const epoch = ++this.epoch
    this.publish('connecting', '正在连接语音服务')
    let source!: VoiceConnection
    source = this.createConnection(loadPrefs(), {
      onState: (state, detail) => {
        if (this.connection !== source || this.epoch !== epoch) return
        if (state === 'error') { this.publish('error', detail ?? '语音连接失败'); return }
        if (state === 'speaking') {
          if (!this.output || this.output.muted || this.output.source !== source) return
          const candidate = this.interjection
          if (candidate && !candidate.delivered) {
            if (candidate.abort.signal.aborted || this.transcript() !== candidate.text) { this.cancelUnheardInterjection(); return }
            candidate.delivered = true
            if (this.partial) this.consumedPrefix = { id: this.partialId, text: this.partial }
            this.discardOwnedInput()
            this.playback = 'playing'
          } else {
            this.playback = this.speechActive ? 'paused' : 'playing'
            if (this.speechActive) source.pauseSpeech?.()
          }
        }
        this.publish(state === 'connecting' ? 'connecting' : undefined, detail)
      },
      onSpeechStart: meta => {
        if (this.connection !== source || this.epoch !== epoch) return
        this.pendingFinals.add(meta?.utteranceId)
        this.speechActive = true
        const candidate = this.interjection
        const continuingInterjection = candidate !== undefined && !candidate.delivered
          && meta?.utteranceId !== undefined && meta.utteranceId === candidate.utteranceId
        if (candidate && !candidate.delivered && !continuingInterjection) this.cancelUnheardInterjection()
        if (continuingInterjection) {
          source.resumeSpeech?.()
        } else if (this.output && !this.output.muted) {
          source.pauseSpeech?.()
          this.playback = 'paused'
        }
        this.invalidateDecision()
        this.publish(undefined, '正在听你说')
      },
      onSpeechEnd: () => {
        if (this.connection !== source || this.epoch !== epoch) return
        this.speechActive = false
        this.invalidateDecision()
        this.scheduleDecision(loadPrefs().qwenMergeMs)
        this.publish()
      },
      onPartialTranscript: (text, meta) => {
        if (this.epoch === epoch) this.receivePartial(source, text, meta)
      },
      onTranscript: async (text, meta) => {
        if (this.epoch === epoch) this.receiveFinal(source, text, meta)
      },
      onPlaybackProgress: text => {
        if (this.connection !== source || this.epoch !== epoch) return
        this.heardText = `${this.heardText}${text}`.slice(-2000)
      },
    })
    this.connection = source
    try {
      this.stopObserving = this.bridge.observeSession(this.sessionId, {
        onTurnStart: turn => { if (this.epoch === epoch) this.beginOutput(source, turn) },
        onTextDelta: (turn, delta) => {
          if (this.connection !== source || this.epoch !== epoch) return
          if (this.output?.turn === turn && !this.output.muted) this.output.stream.push(delta)
        },
        onTextReset: (turn, reason) => {
          if (this.connection !== source || this.epoch !== epoch) return
          const output = this.output
          if (!output || output.turn !== turn || output.muted) return
          if (reason === 'retry') {
            output.speechRevision++
            output.pending = []
            source.cancelSpeech?.()
            if (this.playback !== 'paused') this.playback = 'idle'
          }
          output.stream = this.createSpeechStream(output)
        },
        onTurnEnd: (turn, result) => {
          if (this.connection === source && this.epoch === epoch) this.finishOutput(turn, result)
        },
      })
      await this.bridge.setVoiceMode(this.sessionId, true)
      if (this.connection !== source || this.epoch !== epoch) return
      await source.connect()
      if (this.connection !== source || this.epoch !== epoch) { source.disconnect(); return }
      this.contextTimer = setInterval(() => {
        void this.bridge.setVoiceMode(this.sessionId, true, undefined, { heardText: this.heardText, interrupted: this.interrupted, interject: !!this.interjection }).catch(() => {
          if (this.connection === source) this.publish(undefined, '语音上下文更新失败，请检查 Harness 连接')
        })
      }, 10 * 60_000)
      this.publish(undefined, '开始说话，完整表达后自动发送')
    } catch (error) {
      if (this.connection !== source || this.epoch !== epoch) return
      this.stop()
      this.publish('error', error instanceof Error ? error.message : '语音连接失败')
    }
  }

  stop(): void {
    this.epoch++
    this.invalidateDecision()
    this.decisionAbort?.abort()
    this.decisionAbort = undefined
    this.interjection?.abort.abort()
    this.interjection = undefined
    this.clearSubmitTimer()
    this.stopObserving?.()
    this.stopObserving = undefined
    if (this.contextTimer) clearInterval(this.contextTimer)
    this.contextTimer = undefined
    this.output = undefined
    const source = this.connection
    this.connection = undefined
    source?.disconnect()
    if (source) void this.bridge.setVoiceMode(this.sessionId, false).catch(() => {})
    this.speechActive = false
    this.playback = 'idle'
    this.nativePending = false
    this.finals = []
    this.partial = ''
    this.stablePartial = ''
    this.partialId = undefined
    this.consumedPrefix = undefined
    this.finalIds.clear()
    this.pendingFinals.clear()
    this.ownsDraft = false
    this.publish('idle', '')
  }
  dispose(): void { this.stop(); this.listeners.clear() }

  private receivePartial(source: VoiceConnection, text: string, meta: TranscriptMeta = {}): void {
    if (this.connection !== source || (meta.utteranceId && this.finalIds.has(meta.utteranceId))) return
    text = this.unconsumed(text.trim(), meta.utteranceId)
    if (this.partial === text && this.partialId === meta.utteranceId) return
    this.stablePartial = this.partialId === meta.utteranceId ? commonPrefix(this.partial, text) : ''
    this.partial = text
    this.partialId = meta.utteranceId
    this.invalidateDecision()
    if (this.interjection && !this.interjection.delivered && this.transcript() !== this.interjection.text) this.cancelUnheardInterjection()
    this.publish()
    if (this.output || loadPrefs().proactiveEnabled) this.scheduleDecision(200)
  }

  private receiveFinal(source: VoiceConnection, text: string, meta: TranscriptMeta = {}): void {
    if (this.connection !== source) return
    this.pendingFinals.delete(meta.utteranceId)
    if (meta.utteranceId) {
      if (this.finalIds.has(meta.utteranceId)) return
      this.finalIds.add(meta.utteranceId)
      if (this.finalIds.size > 128) this.finalIds.delete(this.finalIds.values().next().value!)
    }
    text = this.unconsumed(text.trim(), meta.utteranceId)
    if (!this.partialId || !meta.utteranceId || this.partialId === meta.utteranceId) {
      this.partial = ''
      this.stablePartial = ''
      this.partialId = undefined
    }
    this.voiceprint = meta.voiceprint
    if (meta.likelyEcho || !text) {
      this.invalidateDecision()
      if (!this.speechActive) this.resumeOutput()
      this.publish()
      return
    }
    this.finals.push(text)
    this.stageDraft(text)
    this.invalidateDecision()
    if (this.interjection && !this.interjection.delivered && this.transcript() !== this.interjection.text) this.cancelUnheardInterjection()
    if (isExplicitCancel(text)) { void this.cancelTask(); return }
    this.scheduleDecision(loadPrefs().qwenMergeMs)
    this.publish(undefined, '正在判断是否说完；继续说会合并')
  }

  private transcript(): string { return [...this.finals, this.partial].filter(Boolean).join('\n') }

  private unconsumed(text: string, id?: string): string {
    const prefix = this.consumedPrefix
    if (prefix && prefix.id === id && text.startsWith(prefix.text)) return text.slice(prefix.text.length).trim()
    return text
  }

  private stageDraft(text: string): void {
    const draft = this.draft
    if (!draft || (draft.getPhase?.() ?? 'plain') !== 'plain') { this.ownsDraft = false; return }
    const existing = this.writingDraft ? this.boundDraft : draft.getDraft()
    const canOwn = existing.trim() === '' || (this.ownsDraft && existing === this.boundDraft)
    this.boundDraft = existing.trimEnd() ? `${existing.trimEnd()}\n${text}` : text
    this.ownsDraft = canOwn
    this.writingDraft = true
    draft.setDraft(this.boundDraft)
  }

  private invalidateDecision(): void {
    this.revision++
    if (this.decisionTimer) clearTimeout(this.decisionTimer)
    this.decisionTimer = undefined
    this.decisionDirty = false
  }

  private scheduleDecision(delay: number): void {
    if (!this.connection) return
    if (this.decisionTimer) clearTimeout(this.decisionTimer)
    this.decisionTimer = setTimeout(() => {
      this.decisionTimer = undefined
      void this.evaluateTurn()
    }, delay)
  }

  private async evaluateTurn(): Promise<void> {
    const source = this.connection
    if (!source) return
    if (this.decisionAbort) { this.decisionDirty = true; return }
    const transcript = this.transcript()
    if (!transcript) {
      if (!this.speechActive) this.resumeOutput()
      return
    }
    const state: TurnDecisionState = {
      transcript: transcript.slice(-8000),
      stableText: [...this.finals, this.stablePartial].filter(Boolean).join('\n').slice(-8000),
      revision: this.revision,
      isFinal: !this.partial && this.finals.length > 0 && this.pendingFinals.size === 0,
      userSpeaking: this.speechActive,
      assistantSpeaking: !!this.output && !this.output.muted,
      mainBusy: this.isMainBusy(),
      recentAssistantText: this.heardText,
    }
    const prefs = loadPrefs()
    if (!prefs.decisionEnabled) {
      if (state.isFinal && !state.userSpeaking && !state.mainBusy && !state.assistantSpeaking) await this.submitDraft(source, state.revision)
      return
    }
    const controller = new AbortController()
    this.decisionAbort = controller
    try {
      const decision = await this.decide(state, controller.signal)
      if (this.connection !== source || controller.signal.aborted || decision.revision !== this.revision) return
      switch (decision.action) {
        case 'cancel': await this.cancelTask(); break
        case 'backchannel':
          if (state.isFinal && !this.speechActive) { this.discardOwnedInput(); this.resumeOutput() }
          break
        case 'interrupt':
          this.muteOutput()
          if (state.isFinal && !this.speechActive && !this.isMainBusy()) this.scheduleDecision(0)
          break
        case 'submit':
          if (state.isFinal && !this.speechActive && !this.isMainBusy() && !this.output) await this.submitDraft(source, state.revision)
          break
        case 'interject':
          if (prefs.proactiveEnabled && state.stableText && !this.output && !this.isMainBusy()) void this.startInterjection(source, state)
          break
        case 'wait':
          this.publish(undefined, '继续听；已识别文字保留在输入框')
          break
      }
    } catch (error) {
      if (this.connection === source && !controller.signal.aborted && state.revision === this.revision) {
        this.publish(undefined, `轮次判断暂不可用，文字保留待手动发送：${error instanceof Error ? error.message : '请求失败'}`)
      }
    } finally {
      if (this.decisionAbort === controller) this.decisionAbort = undefined
      if (this.decisionDirty && this.connection === source) { this.decisionDirty = false; this.scheduleDecision(0) }
    }
  }

  private draftIsOwned(): boolean {
    const draft = this.draft
    if (!draft || !this.ownsDraft || draft.getDraft() !== this.boundDraft || (draft.getPhase?.() ?? 'plain') !== 'plain') return false
    if (this.writingDraft) {
      this.writingDraft = false
      this.draftRev = draft.getDraftRev?.()
    }
    return this.draftRev === undefined || draft.getDraftRev?.() === this.draftRev
  }

  private async submitDraft(source: VoiceConnection, revision: number): Promise<void> {
    const prefs = loadPrefs()
    const voiceAllowed = prefs.voiceprintEnabled ? this.voiceprint === 'approved' : prefs.voiceDraftAllowWithoutVoiceprint
    if (!prefs.voiceDraftAutoSend || !voiceAllowed || this.voiceprint === 'rejected' || this.voiceprint === 'unavailable'
      || !this.draftIsOwned() || !this.draft?.submit || this.nativePending || this.speechActive || this.pendingFinals.size > 0 || this.isMainBusy()
      || (prefs.voiceDraftSensitiveDeny && isSensitiveDraft(this.boundDraft))) return
    this.nativePending = true
    try {
      await this.bridge.setVoiceMode(this.sessionId, true, undefined, { heardText: this.heardText, interrupted: this.interrupted })
      if (this.connection !== source || revision !== this.revision || !this.draftIsOwned() || this.speechActive || this.pendingFinals.size > 0) return
      // The native submit owns command handling, attachments and queue admission.
      this.draft!.submit!()
      this.finals = []
      this.partial = ''
      this.stablePartial = ''
      this.ownsDraft = false
      this.invalidateDecision()
      this.publish('working', '已发送给当前主模型')
      if (this.nativePending) this.submitTimer = setTimeout(() => {
        this.nativePending = false
        this.submitTimer = undefined
        this.publish(undefined, 'Harness 尚未确认发送，请检查输入框')
      }, 10_000)
    } catch (error) {
      this.publish(undefined, `发送失败，文字已保留：${error instanceof Error ? error.message : 'Harness 不可用'}`)
    } finally {
      if (!this.submitTimer) this.nativePending = false
    }
  }

  private async startInterjection(source: VoiceConnection, state: TurnDecisionState): Promise<void> {
    if (this.interjection || Date.now() - this.lastInterjectionAt < 8000 || !this.draftIsOwned() && this.boundDraft.trim()) return
    const candidate: Interjection = { text: this.transcript(), utteranceId: this.partialId, abort: new AbortController(), delivered: false }
    this.interjection = candidate
    this.lastInterjectionAt = Date.now()
    try {
      await this.bridge.setVoiceMode(this.sessionId, true, candidate.abort.signal, { heardText: this.heardText, interrupted: this.interrupted, interject: true })
      if (candidate.abort.signal.aborted || this.connection !== source || this.transcript() !== candidate.text || this.isMainBusy()) return
      this.publish('working', '主模型正在准备简短澄清')
      const result = await this.bridge.delegate(this.sessionId, state.transcript, candidate.abort.signal)
      if (!result.ok && !candidate.abort.signal.aborted && this.connection === source) this.publish(undefined, result.error)
    } catch (error) {
      if (!candidate.abort.signal.aborted && this.connection === source) this.publish(undefined, `插话准备失败：${error instanceof Error ? error.message : 'Harness 不可用'}`)
    } finally {
      if (this.interjection === candidate && (!this.output || this.output.muted)) this.clearInterjectionContext()
    }
  }

  private cancelUnheardInterjection(): void {
    const candidate = this.interjection
    if (!candidate || candidate.delivered) return
    candidate.abort.abort()
    this.clearInterjectionContext()
    this.muteOutput()
  }

  private clearInterjectionContext(): void {
    if (!this.interjection) return
    this.interjection = undefined
    const source = this.connection
    const epoch = this.epoch
    if (!source) return
    void this.bridge.setVoiceMode(this.sessionId, true, undefined, { heardText: this.heardText, interrupted: this.interrupted }).catch(() => {
      if (this.connection === source && this.epoch === epoch) this.publish(undefined, '插话上下文恢复失败，请检查 Harness 连接')
    })
  }

  private beginOutput(source: VoiceConnection, turn: string): void {
    if (this.connection !== source) return
    this.clearSubmitTimer()
    this.nativePending = false
    if (this.output) source.cancelSpeech?.()
    const output: SpeechOutput = { turn, source, stream: undefined!, pending: [], draining: false, speechRevision: 0, muted: false, done: false }
    output.stream = this.createSpeechStream(output)
    this.output = output
    this.heardText = ''
    this.interrupted = false
    this.playback = 'idle'
    this.invalidateDecision()
    source.setInputPhase?.('harness')
    this.publish('working', '当前主模型正在回答')
  }

  private createSpeechStream(output: SpeechOutput): VoiceSummaryStream {
    return new VoiceSummaryStream(sentence => {
      if (this.output !== output || output.muted) return
      output.pending.push(sentence)
      void this.drainOutput(output)
    })
  }

  private async drainOutput(output: SpeechOutput): Promise<void> {
    const candidate = this.interjection
    const interjecting = candidate !== undefined && !candidate.abort.signal.aborted
    if (output.draining || output.muted || this.output !== output
      || (this.speechActive && !interjecting) || this.playback === 'paused') return
    if (candidate && !candidate.delivered) {
      if (this.transcript() !== candidate.text) { this.cancelUnheardInterjection(); return }
      // This approved utterance may overlap the user's current speech. Keep
      // it cancellable until the connection reports its first audio.
      output.source.resumeSpeech?.()
    }
    const speechRevision = output.speechRevision
    output.draining = true
    try {
      while (this.output === output && output.speechRevision === speechRevision && !output.muted && (this.playback as VoiceSnapshot['playback']) !== 'paused'
        && (!this.speechActive || this.interjection === candidate && interjecting) && output.pending.length) {
        const sentence = output.pending.shift()!
        output.source.setInputPhase?.('tts-pending')
        await output.source.speak?.(sentence)
      }
      if (this.output !== output || output.speechRevision !== speechRevision || output.muted) return
      if (!output.pending.length) {
        await output.source.waitForSpeechIdle?.()
        if (this.output !== output || output.speechRevision !== speechRevision || output.muted) return
        this.playback = 'idle'
        // New main-model text can arrive while the previous audio drains.
        // Recheck the queue before retiring a finished generation.
        if (output.done && !output.pending.length) this.releaseOutput(output)
      }
    } catch (error) {
      // A model retry deliberately cancels the previous TTS generation. Its
      // rejection must not mute the replacement sentences already queued.
      if (this.output === output && output.speechRevision === speechRevision && !output.muted) {
        this.muteOutput()
        this.publish(undefined, `播报失败：${error instanceof Error ? error.message : 'TTS 不可用'}`)
      }
    } finally {
      output.draining = false
      if (this.output === output && !output.muted && output.pending.length
        && (!this.speechActive || this.interjection === candidate && interjecting)) void this.drainOutput(output)
    }
  }

  private finishOutput(turn: string, result: DelegateResult): void {
    const output = this.output
    if (!output || output.turn !== turn) return
    output.done = true
    if (result.ok && !output.muted) output.stream.finish(result.text)
    else if (!result.ok) {
      this.muteOutput()
      if (!result.cancelled) this.publish(undefined, result.error)
    }
    if (output.muted || (!output.draining && !output.pending.length && this.playback === 'idle')) this.releaseOutput(output)
    else void this.drainOutput(output)
  }

  private releaseOutput(output: SpeechOutput): void {
    if (this.output !== output) return
    this.output = undefined
    this.clearInterjectionContext()
    this.playback = 'idle'
    output.source.setInputPhase?.('listening')
    this.invalidateDecision()
    this.publish(undefined, '继续说话')
    if (this.transcript()) this.scheduleDecision(loadPrefs().voiceDraftDwellMs)
  }

  private muteOutput(): void {
    const output = this.output
    if (!output || output.muted) return
    output.muted = true
    output.pending = []
    output.source.cancelSpeech?.()
    this.interrupted = true
    this.playback = 'idle'
    this.invalidateDecision()
    if (output.done) this.releaseOutput(output)
    this.publish(undefined, '已停播，继续听你说；后台任务仍由 Harness 管理')
  }

  private resumeOutput(): void {
    const output = this.output
    if (!output || output.muted || this.speechActive) return
    output.source.resumeSpeech?.()
    this.playback = 'playing'
    void this.drainOutput(output)
    this.publish()
  }

  private discardOwnedInput(): void {
    if (this.draftIsOwned()) {
      this.boundDraft = ''
      this.writingDraft = true
      this.draft!.setDraft('')
    }
    this.ownsDraft = false
    this.finals = []
    this.partial = ''
    this.stablePartial = ''
    this.invalidateDecision()
  }

  private async cancelTask(): Promise<void> {
    const source = this.connection
    this.cancelUnheardInterjection()
    this.muteOutput()
    this.discardOwnedInput()
    try {
      const cancelled = await this.bridge.cancel(this.sessionId)
      if (this.connection === source) this.publish(undefined, cancelled ? '已请求停止当前任务' : '已停止播报')
    } catch {
      if (this.connection === source) this.publish(undefined, '播报已停止；Harness 任务取消失败')
    }
  }

  private isMainBusy(): boolean { return this.nativePending || (!!this.output && !this.output.done) || this.bridge.isBusy?.(this.sessionId) === true }

  private clearSubmitTimer(): void {
    if (this.submitTimer) clearTimeout(this.submitTimer)
    this.submitTimer = undefined
  }

  private publish(state?: VoiceState, detail = this.snapshot.detail): void {
    const busy = this.isMainBusy()
    this.snapshot = {
      state: state ?? (this.playback === 'playing' ? 'speaking' : busy ? 'working' : this.connection ? 'listening' : 'idle'),
      detail, provider: 'qwen', userSpeaking: this.speechActive, mainBusy: busy, playback: this.playback, transcript: this.transcript(),
    }
    this.listeners.forEach(listener => listener())
  }
}

async function requestTurnDecision(state: TurnDecisionState, signal: AbortSignal): Promise<TurnDecision> {
  const response = await fetch('/dsh-realtime-voice/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state),
    signal: AbortSignal.any([signal, AbortSignal.timeout(loadPrefs().decisionTimeoutMs + 500)]),
  })
  if (!response.ok) throw new Error(`决策服务 HTTP ${response.status}`)
  const result = await response.json() as TurnDecision
  if (!TURN_ACTIONS.includes(result.action) || result.revision !== state.revision) throw new Error('决策响应无效')
  return result
}

function commonPrefix(left: string, right: string): string {
  let index = 0
  while (index < left.length && left[index] === right[index]) index++
  return right.slice(0, index)
}
function isExplicitCancel(text: string): boolean {
  return /^(停|停止|停下|别说了|取消|取消任务|停止任务|取消这次任务|不要了|算了)$/.test(text.replace(/[\s，。！？,.!?、]/g, ''))
}
function isSensitiveDraft(text: string): boolean {
  return /(转账|汇款|付款|支付|购买|下单|发送验证码|验证码|密码|删除|清空|卸载|格式化|关机|重启|抹掉|永久)/.test(text)
}
