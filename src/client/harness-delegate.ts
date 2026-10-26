import type {
  ISessions, SessionBinding, SessionEventLike, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type TextResetReason = 'tool' | 'retry'
export type DelegateResult =
  | { ok: true; text: string }
  | { ok: false; cancelled?: boolean; error: string }

export interface SessionTurnCallbacks {
  onTurnStart(turn: string): void
  onTextDelta(turn: string, delta: string): void
  onTextReset?(turn: string, reason: TextResetReason): void
  onTurnEnd(turn: string, result: DelegateResult): void
}

export interface VoiceContext {
  heardText?: string
  interrupted?: boolean
  interject?: boolean
}

export type VoiceContextSetter = (sessionId: string, active: boolean, signal?: AbortSignal, context?: VoiceContext) => Promise<void>

interface Operation {
  requestId?: string
  turn?: string
  cancelRequested: boolean
  settle(result: DelegateResult): void
  cleanup(): void
}

interface SessionVoice {
  reference: SessionReference
  binding: SessionBinding
  observer?: SessionTurnCallbacks
  operation?: Operation
  openTurn?: string
  activeTurn?: string
  attemptId?: string
  text: string
  revision: number
  cancelPending?: Promise<boolean>
  dispose(): void
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The voice transport observes this exact Session generation. */
    realtimeVoice: unknown
  }
}

/** Owns voice observation and addressed cancellation over the native Session API. */
export class HarnessBridge {
  private readonly voices = new Map<string, SessionVoice>()
  private readonly lifetime = new AbortController()

  constructor(
    private readonly sessions: Pick<ISessions, 'retain' | 'binding'>,
    private readonly promptTimeoutMs = 30_000,
    private readonly setVoiceContext: VoiceContextSetter = updateVoiceContext,
  ) {}

  isBusy(sessionId: string): boolean {
    const voice = this.voices.get(sessionId)
    const snapshot = (voice?.binding ?? this.sessions.binding(sessionId as SessionId))?.session.getSnapshot()
    return voice?.operation !== undefined || snapshot?.running === true
      || snapshot?.awaitingFirstTurn === true || (snapshot?.pendingSubmissions.length ?? 0) > 0
  }

  async setVoiceMode(sessionId: string, active: boolean, signal?: AbortSignal, context?: VoiceContext): Promise<void> {
    if (active) await this.voices.get(sessionId)?.reference.ready
    signal?.throwIfAborted()
    await this.setVoiceContext(sessionId, active, signal, context)
  }

  observeSession(sessionId: string, callbacks: SessionTurnCallbacks): () => void {
    const voice = this.retain(sessionId)
    voice.observer = callbacks
    return () => {
      if (voice.observer !== callbacks) return
      voice.observer = undefined
      this.releaseUnused(sessionId, voice)
    }
  }

  async delegate(sessionId: string, task: string, signal?: AbortSignal): Promise<DelegateResult> {
    if (signal?.aborted || this.lifetime.signal.aborted) return { ok: false, cancelled: true, error: '已取消' }
    if (this.isBusy(sessionId)) return { ok: false, error: '当前会话正在执行，请等待本轮完成' }
    const voice = this.retain(sessionId)
    let settle!: (result: DelegateResult) => void
    const result = new Promise<DelegateResult>(resolve => { settle = resolve })
    const requestCancel = () => {
      operation.cancelRequested = true
      void this.cancel(sessionId).catch(error => {
        this.finish(sessionId, voice, { ok: false, error: String(error) })
      })
    }
    const timer = setTimeout(() => {
      this.finish(sessionId, voice, { ok: false, error: 'Harness 任务等待超时' })
    }, 10 * 60_000)
    const operation: Operation = {
      cancelRequested: false,
      settle,
      cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', requestCancel) },
    }
    voice.operation = operation
    signal?.addEventListener('abort', requestCancel, { once: true })
    let submission: ReturnType<SessionBinding['session']['beginSubmission']> | undefined
    try {
      await voice.reference.ready
      if (operation.cancelRequested || this.lifetime.signal.aborted) {
        this.finish(sessionId, voice, { ok: false, cancelled: true, error: '已取消' })
        return await result
      }
      const snapshot = voice.binding.session.getSnapshot()
      if (snapshot.running || snapshot.pendingSubmissions.length > 0) {
        this.finish(sessionId, voice, { ok: false, error: '当前会话正在执行，请等待本轮完成' })
        return await result
      }
      submission = voice.binding.session.beginSubmission({ mode: 'queue', text: task, attachments: [] })
      operation.requestId = submission.requestId
      // The caller's abort marks intent. Wait for admission or its own deadline
      // before removing an identified queue occurrence / cancelling its turn.
      const admissionSignal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.promptTimeoutMs)])
      const admitted = await voice.binding.session.prompt([{ type: 'text', text: task }], 'queue', admissionSignal, submission.requestId)
      if (!admitted.ok && operation.turn === undefined) {
        submission.abandon()
        this.finish(sessionId, voice, { ok: false, error: `${admitted.error.code}: ${admitted.error.message}` })
      } else if (operation.cancelRequested) {
        await this.cancel(sessionId)
      }
    } catch (error) {
      submission?.abandon()
      this.finish(sessionId, voice, {
        ok: false,
        ...(signal?.aborted || this.lifetime.signal.aborted ? { cancelled: true } : {}),
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return await result
  }

  async cancel(sessionId: string): Promise<boolean> {
    const voice = this.voices.get(sessionId)
    if (voice === undefined) return false
    if (voice.cancelPending !== undefined) return await voice.cancelPending
    const operation = voice.operation
    if (operation !== undefined) operation.cancelRequested = true
    const turnBeforeCancel = operation?.turn
    const pending = Promise.resolve().then(() => this.cancelOwned(voice))
    voice.cancelPending = pending
    let cancelled: boolean
    try { cancelled = await pending }
    finally { if (voice.cancelPending === pending) voice.cancelPending = undefined }
    // Admission can publish its user/message while a queue lookup is awaiting.
    // Recheck that newly owned turn after releasing the in-flight cancel slot.
    if (operation !== undefined && voice.operation === operation && turnBeforeCancel === undefined && operation.turn !== undefined) {
      return await this.cancel(sessionId)
    }
    return cancelled
  }

  dispose(): void {
    this.lifetime.abort()
    for (const [sessionId, voice] of this.voices) {
      voice.observer = undefined
      if (voice.operation !== undefined) this.finish(sessionId, voice, { ok: false, cancelled: true, error: '插件已卸载' })
      else this.releaseUnused(sessionId, voice)
    }
    this.voices.clear()
  }

  private retain(sessionId: string): SessionVoice {
    const previous = this.voices.get(sessionId)
    if (previous !== undefined) return previous
    const reference = this.sessions.retain(sessionId as SessionId, { source: 'realtimeVoice', signal: this.lifetime.signal })
    const binding = reference.binding
    const events = binding.eventSource
    const inbox = binding.session.projections.faceOf('inbox')
    const voice: SessionVoice = {
      reference, binding, text: '', revision: events.getSnapshot().revision,
      dispose: () => { offEvents(); offInbox(); reference.release() },
    }
    const baseline = events.getSnapshot()
    for (const entry of baseline.entries) {
      if (entry.event.type === 'turn/start') voice.openTurn = String(entry.event.data.turn)
      if (entry.event.type === 'turn/end') voice.openTurn = undefined
    }
    // A native turn may already be running when the mic is enabled. Track its
    // identity for an explicit stop, but never replay its old answer aloud.
    voice.activeTurn = voice.openTurn
    const offEvents = events.subscribe(() => {
      const snapshot = events.getSnapshot()
      if (snapshot.revision === voice.revision) return
      voice.revision = snapshot.revision
      const change = snapshot.change
      if (change.kind === 'append') {
        for (const entry of change.entries) this.handleEvent(sessionId, voice, entry.event)
      } else if (change.kind === 'settle-assistant') {
        if (change.entry !== undefined) this.handleEvent(sessionId, voice, change.entry.event)
        else if (voice.attemptId === change.attemptId) this.resetText(voice, 'retry')
      } else if (change.kind === 'replace') {
        // Opening/reconnect baselines are history, not new speech.
        voice.openTurn = undefined
        for (const entry of change.entries) {
          if (entry.event.type === 'turn/start') voice.openTurn = String(entry.event.data.turn)
          if (entry.event.type === 'turn/end') voice.openTurn = undefined
        }
        voice.activeTurn = voice.openTurn
      }
    })
    const offInbox = inbox.subscribe(() => {
      if (voice.operation?.cancelRequested) void this.cancel(sessionId).catch(error => {
        this.finish(sessionId, voice, { ok: false, error: String(error) })
      })
    })
    this.voices.set(sessionId, voice)
    void reference.ready.catch(error => {
      this.finish(sessionId, voice, { ok: false, error: `会话打开失败：${String(error)}` })
    })
    return voice
  }

  private async cancelOwned(voice: SessionVoice): Promise<boolean> {
    const operation = voice.operation
    const session = voice.binding.session
    if (operation !== undefined && operation.turn === undefined) {
      const inbox = session.projections.faceOf('inbox').getSnapshot() as InboxState | undefined
      const item = [...(inbox?.['next-turn'] ?? []), ...(inbox?.['next-step'] ?? [])]
        .find(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === operation.requestId)
      if (item === undefined) return true // admission is still in flight
      const removed = await session.updateQueue(item.id, { kind: 'remove' })
      if (removed.ok) {
        this.finish(voice.binding.sessionId, voice, { ok: false, cancelled: true, error: '已取消' })
      } else if (removed.error.code !== 'session/queue-item-not-found') {
        throw new Error(`${removed.error.code}: ${removed.error.message}`)
      }
      return true
    }
    const ownedTurn = operation?.turn ?? (voice.observer === undefined ? undefined : voice.activeTurn)
    if (ownedTurn === undefined || ownedTurn !== voice.openTurn || !session.getSnapshot().running) return false
    const cancelled = await session.cancel()
    if (!cancelled.ok) throw new Error(`${cancelled.error.code}: ${cancelled.error.message}`)
    return true
  }

  private handleEvent(sessionId: string, voice: SessionVoice, event: SessionEventLike): void {
    const operation = voice.operation
    if (event.type === 'turn/start') {
      voice.openTurn = String(event.data.turn)
      return
    }
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind !== 'user' || voice.openTurn === undefined) return
      if (operation !== undefined && 'rpcId' in source && source.rpcId === operation.requestId) {
        operation.turn = voice.openTurn
        if (operation.cancelRequested) void this.cancel(sessionId).catch(error => {
          this.finish(sessionId, voice, { ok: false, error: String(error) })
        })
      }
      if (voice.activeTurn !== voice.openTurn) {
        voice.activeTurn = voice.openTurn
        voice.text = ''
        voice.attemptId = undefined
        voice.observer?.onTurnStart(voice.openTurn)
      }
      return
    }
    const turn = 'turn' in event.data ? String(event.data.turn) : undefined
    if (turn === undefined || turn !== voice.activeTurn) return
    if (event.type === 'assistant/live-chunk') {
      if (voice.attemptId !== undefined && voice.attemptId !== event.data.attemptId) this.resetText(voice, 'retry')
      voice.attemptId = event.data.attemptId
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        voice.text += chunk.text
        voice.observer?.onTextDelta(turn, chunk.text)
      } else if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
        this.resetText(voice, 'tool')
      }
    } else if (event.type === 'assistant/message') {
      voice.text = extractAssistantText(event.data.message)
    } else if (event.type === 'assistant/attempt') {
      this.resetText(voice, 'retry')
    } else if (event.type === 'tool/call') {
      this.resetText(voice, 'tool')
    } else if (event.type === 'turn/end') {
      const reason = event.data.reason.kind
      const result: DelegateResult = reason === 'completed'
        ? { ok: true, text: voice.text }
        : reason === 'aborted' || reason === 'interrupted'
          ? { ok: false, cancelled: true, error: '已取消' }
          : { ok: false, error: `Harness 任务结束：${reason}` }
      voice.openTurn = undefined
      voice.activeTurn = undefined
      voice.attemptId = undefined
      voice.text = ''
      voice.observer?.onTurnEnd(turn, result)
      if (operation?.turn === turn) this.finish(sessionId, voice, result)
    }
  }

  private resetText(voice: SessionVoice, reason: TextResetReason): void {
    voice.text = ''
    if (voice.activeTurn !== undefined) voice.observer?.onTextReset?.(voice.activeTurn, reason)
  }

  private finish(sessionId: string, voice: SessionVoice, result: DelegateResult): void {
    const operation = voice.operation
    if (operation === undefined) return
    voice.operation = undefined
    operation.cleanup()
    operation.settle(result)
    this.releaseUnused(sessionId, voice)
  }

  private releaseUnused(sessionId: string, voice: SessionVoice): void {
    if (voice.observer !== undefined || voice.operation !== undefined) return
    voice.dispose()
    this.voices.delete(sessionId)
  }
}

async function updateVoiceContext(sessionId: string, active: boolean, signal?: AbortSignal, context?: VoiceContext): Promise<void> {
  const response = await fetch('/dsh-realtime-voice/context', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, active, ...context }),
    signal,
  })
  if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`)
}

export function extractAssistantText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const record = message as Record<string, unknown>
  if (!Array.isArray(record.content)) return ''
  return record.content.map(part => {
    if (typeof part !== 'object' || part === null) return ''
    const block = part as Record<string, unknown>
    return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
  }).join('\n').trim()
}
