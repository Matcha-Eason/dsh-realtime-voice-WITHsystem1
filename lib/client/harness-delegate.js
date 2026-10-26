/** Owns voice observation and addressed cancellation over the native Session API. */
export class HarnessBridge {
    sessions;
    promptTimeoutMs;
    setVoiceContext;
    voices = new Map();
    lifetime = new AbortController();
    constructor(sessions, promptTimeoutMs = 30_000, setVoiceContext = updateVoiceContext) {
        this.sessions = sessions;
        this.promptTimeoutMs = promptTimeoutMs;
        this.setVoiceContext = setVoiceContext;
    }
    isBusy(sessionId) {
        const voice = this.voices.get(sessionId);
        const snapshot = (voice?.binding ?? this.sessions.binding(sessionId))?.session.getSnapshot();
        return voice?.operation !== undefined || snapshot?.running === true
            || snapshot?.awaitingFirstTurn === true || (snapshot?.pendingSubmissions.length ?? 0) > 0;
    }
    async setVoiceMode(sessionId, active, signal, context) {
        if (active)
            await this.voices.get(sessionId)?.reference.ready;
        signal?.throwIfAborted();
        await this.setVoiceContext(sessionId, active, signal, context);
    }
    observeSession(sessionId, callbacks) {
        const voice = this.retain(sessionId);
        voice.observer = callbacks;
        return () => {
            if (voice.observer !== callbacks)
                return;
            voice.observer = undefined;
            this.releaseUnused(sessionId, voice);
        };
    }
    async delegate(sessionId, task, signal) {
        if (signal?.aborted || this.lifetime.signal.aborted)
            return { ok: false, cancelled: true, error: '已取消' };
        if (this.isBusy(sessionId))
            return { ok: false, error: '当前会话正在执行，请等待本轮完成' };
        const voice = this.retain(sessionId);
        let settle;
        const result = new Promise(resolve => { settle = resolve; });
        const requestCancel = () => {
            operation.cancelRequested = true;
            void this.cancel(sessionId).catch(error => {
                this.finish(sessionId, voice, { ok: false, error: String(error) });
            });
        };
        const timer = setTimeout(() => {
            this.finish(sessionId, voice, { ok: false, error: 'Harness 任务等待超时' });
        }, 10 * 60_000);
        const operation = {
            cancelRequested: false,
            settle,
            cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', requestCancel); },
        };
        voice.operation = operation;
        signal?.addEventListener('abort', requestCancel, { once: true });
        let submission;
        try {
            await voice.reference.ready;
            if (operation.cancelRequested || this.lifetime.signal.aborted) {
                this.finish(sessionId, voice, { ok: false, cancelled: true, error: '已取消' });
                return await result;
            }
            const snapshot = voice.binding.session.getSnapshot();
            if (snapshot.running || snapshot.pendingSubmissions.length > 0) {
                this.finish(sessionId, voice, { ok: false, error: '当前会话正在执行，请等待本轮完成' });
                return await result;
            }
            submission = voice.binding.session.beginSubmission({ mode: 'queue', text: task, attachments: [] });
            operation.requestId = submission.requestId;
            // The caller's abort marks intent. Wait for admission or its own deadline
            // before removing an identified queue occurrence / cancelling its turn.
            const admissionSignal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.promptTimeoutMs)]);
            const admitted = await voice.binding.session.prompt([{ type: 'text', text: task }], 'queue', admissionSignal, submission.requestId);
            if (!admitted.ok && operation.turn === undefined) {
                submission.abandon();
                this.finish(sessionId, voice, { ok: false, error: `${admitted.error.code}: ${admitted.error.message}` });
            }
            else if (operation.cancelRequested) {
                await this.cancel(sessionId);
            }
        }
        catch (error) {
            submission?.abandon();
            this.finish(sessionId, voice, {
                ok: false,
                ...(signal?.aborted || this.lifetime.signal.aborted ? { cancelled: true } : {}),
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return await result;
    }
    async cancel(sessionId) {
        const voice = this.voices.get(sessionId);
        if (voice === undefined)
            return false;
        if (voice.cancelPending !== undefined)
            return await voice.cancelPending;
        const operation = voice.operation;
        if (operation !== undefined)
            operation.cancelRequested = true;
        const turnBeforeCancel = operation?.turn;
        const pending = Promise.resolve().then(() => this.cancelOwned(voice));
        voice.cancelPending = pending;
        let cancelled;
        try {
            cancelled = await pending;
        }
        finally {
            if (voice.cancelPending === pending)
                voice.cancelPending = undefined;
        }
        // Admission can publish its user/message while a queue lookup is awaiting.
        // Recheck that newly owned turn after releasing the in-flight cancel slot.
        if (operation !== undefined && voice.operation === operation && turnBeforeCancel === undefined && operation.turn !== undefined) {
            return await this.cancel(sessionId);
        }
        return cancelled;
    }
    dispose() {
        this.lifetime.abort();
        for (const [sessionId, voice] of this.voices) {
            voice.observer = undefined;
            if (voice.operation !== undefined)
                this.finish(sessionId, voice, { ok: false, cancelled: true, error: '插件已卸载' });
            else
                this.releaseUnused(sessionId, voice);
        }
        this.voices.clear();
    }
    retain(sessionId) {
        const previous = this.voices.get(sessionId);
        if (previous !== undefined)
            return previous;
        const reference = this.sessions.retain(sessionId, { source: 'realtimeVoice', signal: this.lifetime.signal });
        const binding = reference.binding;
        const events = binding.eventSource;
        const inbox = binding.session.projections.faceOf('inbox');
        const voice = {
            reference, binding, text: '', revision: events.getSnapshot().revision,
            dispose: () => { offEvents(); offInbox(); reference.release(); },
        };
        const baseline = events.getSnapshot();
        for (const entry of baseline.entries) {
            if (entry.event.type === 'turn/start')
                voice.openTurn = String(entry.event.data.turn);
            if (entry.event.type === 'turn/end')
                voice.openTurn = undefined;
        }
        // A native turn may already be running when the mic is enabled. Track its
        // identity for an explicit stop, but never replay its old answer aloud.
        voice.activeTurn = voice.openTurn;
        const offEvents = events.subscribe(() => {
            const snapshot = events.getSnapshot();
            if (snapshot.revision === voice.revision)
                return;
            voice.revision = snapshot.revision;
            const change = snapshot.change;
            if (change.kind === 'append') {
                for (const entry of change.entries)
                    this.handleEvent(sessionId, voice, entry.event);
            }
            else if (change.kind === 'settle-assistant') {
                if (change.entry !== undefined)
                    this.handleEvent(sessionId, voice, change.entry.event);
                else if (voice.attemptId === change.attemptId)
                    this.resetText(voice, 'retry');
            }
            else if (change.kind === 'replace') {
                // Opening/reconnect baselines are history, not new speech.
                voice.openTurn = undefined;
                for (const entry of change.entries) {
                    if (entry.event.type === 'turn/start')
                        voice.openTurn = String(entry.event.data.turn);
                    if (entry.event.type === 'turn/end')
                        voice.openTurn = undefined;
                }
                voice.activeTurn = voice.openTurn;
            }
        });
        const offInbox = inbox.subscribe(() => {
            if (voice.operation?.cancelRequested)
                void this.cancel(sessionId).catch(error => {
                    this.finish(sessionId, voice, { ok: false, error: String(error) });
                });
        });
        this.voices.set(sessionId, voice);
        void reference.ready.catch(error => {
            this.finish(sessionId, voice, { ok: false, error: `会话打开失败：${String(error)}` });
        });
        return voice;
    }
    async cancelOwned(voice) {
        const operation = voice.operation;
        const session = voice.binding.session;
        if (operation !== undefined && operation.turn === undefined) {
            const inbox = session.projections.faceOf('inbox').getSnapshot();
            const item = [...(inbox?.['next-turn'] ?? []), ...(inbox?.['next-step'] ?? [])]
                .find(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === operation.requestId);
            if (item === undefined)
                return true; // admission is still in flight
            const removed = await session.updateQueue(item.id, { kind: 'remove' });
            if (removed.ok) {
                this.finish(voice.binding.sessionId, voice, { ok: false, cancelled: true, error: '已取消' });
            }
            else if (removed.error.code !== 'session/queue-item-not-found') {
                throw new Error(`${removed.error.code}: ${removed.error.message}`);
            }
            return true;
        }
        const ownedTurn = operation?.turn ?? (voice.observer === undefined ? undefined : voice.activeTurn);
        if (ownedTurn === undefined || ownedTurn !== voice.openTurn || !session.getSnapshot().running)
            return false;
        const cancelled = await session.cancel();
        if (!cancelled.ok)
            throw new Error(`${cancelled.error.code}: ${cancelled.error.message}`);
        return true;
    }
    handleEvent(sessionId, voice, event) {
        const operation = voice.operation;
        if (event.type === 'turn/start') {
            voice.openTurn = String(event.data.turn);
            return;
        }
        if (event.type === 'user/message') {
            const source = event.data.source;
            if (source.kind !== 'user' || voice.openTurn === undefined)
                return;
            if (operation !== undefined && 'rpcId' in source && source.rpcId === operation.requestId) {
                operation.turn = voice.openTurn;
                if (operation.cancelRequested)
                    void this.cancel(sessionId).catch(error => {
                        this.finish(sessionId, voice, { ok: false, error: String(error) });
                    });
            }
            if (voice.activeTurn !== voice.openTurn) {
                voice.activeTurn = voice.openTurn;
                voice.text = '';
                voice.attemptId = undefined;
                voice.observer?.onTurnStart(voice.openTurn);
            }
            return;
        }
        const turn = 'turn' in event.data ? String(event.data.turn) : undefined;
        if (turn === undefined || turn !== voice.activeTurn)
            return;
        if (event.type === 'assistant/live-chunk') {
            if (voice.attemptId !== undefined && voice.attemptId !== event.data.attemptId)
                this.resetText(voice, 'retry');
            voice.attemptId = event.data.attemptId;
            const chunk = event.data.chunk;
            if (chunk.type === 'text-delta') {
                voice.text += chunk.text;
                voice.observer?.onTextDelta(turn, chunk.text);
            }
            else if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
                this.resetText(voice, 'tool');
            }
        }
        else if (event.type === 'assistant/message') {
            voice.text = extractAssistantText(event.data.message);
        }
        else if (event.type === 'assistant/attempt') {
            this.resetText(voice, 'retry');
        }
        else if (event.type === 'tool/call') {
            this.resetText(voice, 'tool');
        }
        else if (event.type === 'turn/end') {
            const reason = event.data.reason.kind;
            const result = reason === 'completed'
                ? { ok: true, text: voice.text }
                : reason === 'aborted' || reason === 'interrupted'
                    ? { ok: false, cancelled: true, error: '已取消' }
                    : { ok: false, error: `Harness 任务结束：${reason}` };
            voice.openTurn = undefined;
            voice.activeTurn = undefined;
            voice.attemptId = undefined;
            voice.text = '';
            voice.observer?.onTurnEnd(turn, result);
            if (operation?.turn === turn)
                this.finish(sessionId, voice, result);
        }
    }
    resetText(voice, reason) {
        voice.text = '';
        if (voice.activeTurn !== undefined)
            voice.observer?.onTextReset?.(voice.activeTurn, reason);
    }
    finish(sessionId, voice, result) {
        const operation = voice.operation;
        if (operation === undefined)
            return;
        voice.operation = undefined;
        operation.cleanup();
        operation.settle(result);
        this.releaseUnused(sessionId, voice);
    }
    releaseUnused(sessionId, voice) {
        if (voice.observer !== undefined || voice.operation !== undefined)
            return;
        voice.dispose();
        this.voices.delete(sessionId);
    }
}
async function updateVoiceContext(sessionId, active, signal, context) {
    const response = await fetch('/dsh-realtime-voice/context', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, active, ...context }),
        signal,
    });
    if (!response.ok)
        throw new Error(await response.text() || `HTTP ${response.status}`);
}
export function extractAssistantText(message) {
    if (typeof message !== 'object' || message === null)
        return '';
    const record = message;
    if (!Array.isArray(record.content))
        return '';
    return record.content.map(part => {
        if (typeof part !== 'object' || part === null)
            return '';
        const block = part;
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    }).join('\n').trim();
}
