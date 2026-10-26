import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAssistantText, HarnessBridge, type DelegateResult, type VoiceContextSetter } from '../src/client/harness-delegate.ts'
import type {
  ISessions, SessionBinding, SessionEventChange, SessionEventLike, SessionEventLikeEntry,
  SessionEventWindow, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'

function fixture() {
  const eventListeners = new Set<() => void>()
  const inboxListeners = new Set<() => void>()
  let window: SessionEventWindow = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  let running = false
  let inbox: { 'next-turn': unknown[]; 'next-step': unknown[] } = { 'next-turn': [], 'next-step': [] }
  let requestId = ''
  let retainCount = 0
  let releaseCount = 0
  let cancelCount = 0
  const prompts: unknown[] = []
  const removals: string[] = []
  let ready = Promise.resolve()
  let promptStarted!: () => void
  const started = new Promise<void>(resolve => { promptStarted = resolve })
  let admission: () => Promise<{ ok: true; value: { accepted: true } } | { ok: false; error: { code: string; message: string } }> = async () => ({ ok: true, value: { accepted: true } })
  let remove: () => Promise<{ ok: true; value: { accepted: true } } | { ok: false; error: { code: string; message: string } }> = async () => ({ ok: true, value: { accepted: true } })
  const binding = {
    sessionId: 's1',
    eventSource: {
      getSnapshot: () => window,
      subscribe: (listener: () => void) => { eventListeners.add(listener); return () => { eventListeners.delete(listener) } },
    },
    session: {
      getSnapshot: () => ({ running, pendingSubmissions: [], awaitingFirstTurn: false }),
      projections: { faceOf: () => ({
        getSnapshot: () => inbox,
        subscribe: (listener: () => void) => { inboxListeners.add(listener); return () => { inboxListeners.delete(listener) } },
      }) },
      beginSubmission: () => { requestId = 'voice-request'; return { requestId, abandon() {} } },
      prompt: async (content: unknown, mode: string, _signal: AbortSignal, id: string) => {
        prompts.push({ content, mode, requestId: id })
        promptStarted()
        return await admission()
      },
      cancel: async () => { cancelCount++; return { ok: true, value: { accepted: true } } },
      updateQueue: async (id: string) => { removals.push(id); return await remove() },
    },
  } as unknown as SessionBinding
  const sessions = {
    binding: () => binding,
    retain: () => {
      retainCount++
      let released = false
      return {
        sessionId: 's1', binding,
        ready: ready.then(() => binding),
        release: () => { if (!released) { released = true; releaseCount++ } },
      } as unknown as SessionReference
    },
  } as Pick<ISessions, 'retain' | 'binding'>
  const publish = (change: SessionEventChange) => {
    const entries = change.kind === 'append' ? [...window.entries, ...change.entries]
      : change.kind === 'replace' ? change.entries : window.entries
    window = { ...window, entries, change, revision: window.revision + 1 }
    eventListeners.forEach(listener => listener())
  }
  const append = (type: string, data: object) => {
    if (type === 'turn/start') running = true
    if (type === 'turn/end') running = false
    const event = { type, data, seq: window.revision + 1, time: Date.now() } as SessionEventLike
    publish({ kind: 'append', entries: [{ type: type === 'assistant/live-chunk' ? 'transient' : 'event', event } as SessionEventLikeEntry] })
  }
  return {
    sessions, append, publish, prompts, removals, started,
    get requestId() { return requestId },
    get retained() { return retainCount - releaseCount },
    get cancelled() { return cancelCount },
    get subscribed() { return eventListeners.size },
    setReady(value: Promise<void>) { ready = value },
    setAdmission(value: typeof admission) { admission = value },
    setRemove(value: typeof remove) { remove = value },
    queue(items: unknown[]) { inbox = { 'next-turn': items, 'next-step': [] }; inboxListeners.forEach(listener => listener()) },
    user(id = requestId) { append('user/message', { id: 'm1', role: 'user', content: [], source: { kind: 'user', rpcId: id } }) },
    chunk(text: string, attemptId = 'a1', type = 'text-delta') {
      append('assistant/live-chunk', { turn: 1, step: 1, attemptId, chunk: { type, text } })
    },
    end(kind = 'completed') { append('turn/end', { turn: 1, reason: { kind } }) },
  }
}

test('observes native live chunks and durable settlement without speaking reasoning or replaying history', () => {
  const f = fixture()
  f.append('turn/start', { turn: 0 })
  f.append('assistant/message', { turn: 0, message: { content: [{ type: 'text', text: '历史回答。' }] } })
  f.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  const bridge = new HarnessBridge(f.sessions)
  const spoken: string[] = []
  const started: string[] = []
  const ended: DelegateResult[] = []
  const off = bridge.observeSession('s1', {
    onTurnStart: turn => { started.push(turn) },
    onTextDelta: (_turn, text) => { spoken.push(text) },
    onTurnEnd: (_turn, result) => { ended.push(result) },
  })
  f.append('turn/start', { turn: 1 })
  f.user('manual-input')
  f.chunk('私有推理', 'a1', 'reasoning-delta')
  f.chunk('主模型回答。')
  f.publish({ kind: 'settle-assistant', attemptId: 'a1' as never, entry: {
    type: 'event', event: { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '主模型回答。' }] } } },
  } as never })
  f.end()
  assert.deepEqual(started, ['1'])
  assert.deepEqual(spoken, ['主模型回答。'])
  assert.deepEqual(ended, [{ ok: true, text: '主模型回答。' }])
  off()
  assert.equal(f.retained, 0)
  assert.equal(f.subscribed, 0)
})

test('an already running native turn can be explicitly cancelled without replaying its text', async () => {
  const f = fixture()
  f.append('turn/start', { turn: 1 })
  f.user('manual-input')
  const bridge = new HarnessBridge(f.sessions)
  const spoken: string[] = []
  bridge.observeSession('s1', { onTurnStart() {}, onTextDelta: (_turn, text) => { spoken.push(text) }, onTurnEnd() {} })
  assert.equal(bridge.isBusy('s1'), true)
  assert.equal(await bridge.cancel('s1'), true)
  assert.equal(f.cancelled, 1)
  assert.deepEqual(spoken, [])
  bridge.dispose()
})

test('delegates through native prompt with a known request id and settles only the matching turn', async () => {
  const f = fixture()
  const bridge = new HarnessBridge(f.sessions)
  const answer = bridge.delegate('s1', '需要澄清的问题')
  await f.started
  assert.deepEqual(f.prompts, [{ content: [{ type: 'text', text: '需要澄清的问题' }], mode: 'queue', requestId: 'voice-request' }])
  f.append('turn/start', { turn: 1 })
  f.user()
  f.chunk('你指的是哪个项目？')
  f.end()
  assert.deepEqual(await answer, { ok: true, text: '你指的是哪个项目？' })
  assert.equal(f.retained, 0)
})

test('an empty main-model answer stays empty instead of generating a completion phrase', async () => {
  const f = fixture()
  const bridge = new HarnessBridge(f.sessions)
  const answer = bridge.delegate('s1', '测试')
  await f.started
  f.append('turn/start', { turn: 1 })
  f.user()
  f.end()
  assert.deepEqual(await answer, { ok: true, text: '' })
})

test('cancels only its queued occurrence when another native turn is active', async () => {
  const f = fixture()
  const bridge = new HarnessBridge(f.sessions)
  const answer = bridge.delegate('s1', '后续问题')
  await f.started
  f.append('turn/start', { turn: 1 })
  f.user('someone-else')
  f.queue([{ id: 'own-queue-id', source: { kind: 'user', rpcId: f.requestId } }])
  assert.equal(await bridge.cancel('s1'), true)
  assert.deepEqual(f.removals, ['own-queue-id'])
  assert.equal(f.cancelled, 0)
  assert.deepEqual(await answer, { ok: false, cancelled: true, error: '已取消' })
})

test('queue removal losing to admission cancels the newly identified turn', async () => {
  const f = fixture()
  const bridge = new HarnessBridge(f.sessions)
  const answer = bridge.delegate('s1', '准备插话')
  await f.started
  f.queue([{ id: 'own-queue-id', source: { kind: 'user', rpcId: f.requestId } }])
  f.setRemove(async () => {
    f.append('turn/start', { turn: 1 })
    f.user()
    return { ok: false, error: { code: 'session/queue-item-not-found', message: 'already claimed' } }
  })
  assert.equal(await bridge.cancel('s1'), true)
  assert.equal(f.cancelled, 1)
  f.end('aborted')
  assert.deepEqual(await answer, { ok: false, cancelled: true, error: '已取消' })
})

test('an abort during admission waits for the matching message before cancelling', async () => {
  const f = fixture()
  let admit!: () => void
  f.setAdmission(() => new Promise(resolve => { admit = () => { resolve({ ok: true, value: { accepted: true } }) } }))
  const bridge = new HarnessBridge(f.sessions)
  const abort = new AbortController()
  const answer = bridge.delegate('s1', '准备插话', abort.signal)
  await f.started
  abort.abort()
  assert.equal(f.cancelled, 0)
  f.append('turn/start', { turn: 1 })
  f.user()
  admit()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.cancelled, 1)
  f.end('aborted')
  assert.equal((await answer).ok, false)
})

test('rejects a busy native session and disposes subscriptions during plugin unload', async () => {
  const f = fixture()
  const bridge = new HarnessBridge(f.sessions)
  bridge.observeSession('s1', { onTurnStart() {}, onTextDelta() {}, onTurnEnd() {} })
  f.append('turn/start', { turn: 1 })
  assert.equal((await bridge.delegate('s1', '不能抢开第二轮')).ok, false)
  assert.deepEqual(f.prompts, [])
  bridge.dispose()
  assert.equal(f.subscribed, 0)
  assert.equal(f.retained, 0)
})

test('passes playback facts and interjection intent to the host context unchanged', async () => {
  const f = fixture()
  const calls: unknown[] = []
  const setter: VoiceContextSetter = async (...args) => { calls.push(args) }
  const bridge = new HarnessBridge(f.sessions, 100, setter)
  await bridge.setVoiceMode('s1', true, undefined, { heardText: '已听到这句话。', interrupted: true, interject: true })
  assert.deepEqual(calls, [['s1', true, undefined, { heardText: '已听到这句话。', interrupted: true, interject: true }]])
})

test('extracts only main-model text blocks', () => {
  assert.equal(extractAssistantText({ content: [{ type: 'reasoning', text: '不能播' }, { type: 'text', text: '可以播。' }, { type: 'tool-call', name: 'tool' }] }), '可以播。')
})
