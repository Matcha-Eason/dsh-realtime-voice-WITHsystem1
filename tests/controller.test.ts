import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { VoiceController, type VoiceConnection, type VoiceDraftTarget, type DecideTurn } from '../src/client/controller.ts'
import type { HarnessBridge, DelegateResult, SessionTurnCallbacks, VoiceContext } from '../src/client/harness-delegate.ts'
import type { RealtimeCallbacks } from '../src/client/realtime.ts'
import { updatePrefs } from '../src/client/prefs.ts'
import type { TurnAction, TurnDecisionState } from '../src/turn-decision.ts'

function setup(t: TestContext, options: {
  decide?: DecideTurn
  action?: TurnAction
  connect?: () => Promise<void>
  autoAudio?: boolean
  speak?: (text: string) => Promise<void>
  cancelSpeech?: () => void
  delegate?: (text: string, signal: AbortSignal) => Promise<DelegateResult>
} = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } })
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }))
  updatePrefs({
    decisionEnabled: true, proactiveEnabled: true, decisionTimeoutMs: 2000, qwenMergeMs: 100,
    voiceDraftDwellMs: 500, voiceDraftAutoSend: true, voiceDraftAllowWithoutVoiceprint: true,
    voiceDraftSensitiveDeny: true, voiceprintEnabled: false,
  })
  let callbacks!: RealtimeCallbacks
  const observers: SessionTurnCallbacks[] = []
  const contexts: Array<{ active: boolean; context?: VoiceContext }> = []
  const decisions: TurnDecisionState[] = []
  const submitted: string[] = []
  const spoken: string[] = []
  const delegated: Array<{ text: string; signal: AbortSignal }> = []
  let draft = ''
  let draftRev = 0
  let busy = false
  let pauses = 0
  let resumes = 0
  let audioCancels = 0
  let taskCancels = 0
  let disconnects = 0
  let queued: string[] = []
  const idle: Array<() => void> = []
  const source: VoiceConnection = {
    connect: options.connect ?? (async () => {}),
    disconnect: () => { disconnects++; queued = []; idle.splice(0).forEach(resolve => resolve()) },
    speak: async text => {
      spoken.push(text)
      queued.push(text)
      if (options.autoAudio !== false) callbacks.onState('speaking')
      await options.speak?.(text)
    },
    waitForSpeechIdle: async () => { if (queued.length) await new Promise<void>(resolve => idle.push(resolve)) },
    pauseSpeech: () => { pauses++ },
    resumeSpeech: () => { resumes++ },
    cancelSpeech: () => { audioCancels++; queued = []; idle.splice(0).forEach(resolve => resolve()); options.cancelSpeech?.() },
  }
  const bridge = {
    observeSession: (_id: string, observer: SessionTurnCallbacks) => { observers.push(observer); return () => {} },
    setVoiceMode: async (_id: string, active: boolean, _signal?: AbortSignal, context?: VoiceContext) => { contexts.push({ active, context }) },
    isBusy: () => busy,
    cancel: async () => { taskCancels++; return true },
    delegate: async (_id: string, text: string, signal: AbortSignal) => {
      delegated.push({ text, signal })
      if (options.delegate) return await options.delegate(text, signal)
      return await new Promise<DelegateResult>(resolve => signal.addEventListener('abort', () => resolve({ ok: false, cancelled: true, error: 'cancelled' }), { once: true }))
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('session', bridge, (_prefs, value) => { callbacks = value; return source }, async (state, signal) => {
    decisions.push({ ...state })
    return options.decide ? await options.decide(state, signal) : { action: options.action ?? 'submit', revision: state.revision }
  })
  const start = (turn: string) => { busy = true; observers.at(-1)!.onTurnStart(turn) }
  const target: VoiceDraftTarget = {
    getDraft: () => draft, getDraftRev: () => draftRev, getPhase: () => 'plain',
    setDraft: text => { draft = text; draftRev++; controller.bindDraft(target) },
    submit: () => { submitted.push(draft); draft = ''; draftRev++; controller.bindDraft(target); start(`native-${submitted.length}`) },
  }
  controller.bindDraft(target)
  t.after(() => {
    controller.dispose()
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  return {
    controller, contexts, decisions, submitted, spoken, delegated, observers, source,
    get callbacks() { return callbacks },
    draft: () => draft,
    edit(text: string) { draft = text; draftRev++; controller.bindDraft(target) },
    sameTextEdit() { draftRev++; controller.bindDraft(target) },
    counts: () => ({ pauses, resumes, audioCancels, taskCancels, disconnects }),
    start,
    text(turn: string, text: string) { observers.at(-1)!.onTextDelta(turn, text) },
    end(turn: string, text: string) { busy = false; observers.at(-1)!.onTurnEnd(turn, { ok: true, text }) },
    finishAudio() { const completed = queued; queued = []; completed.forEach(text => callbacks.onPlaybackProgress?.(text)); idle.splice(0).forEach(resolve => resolve()) },
  }
}

async function advance(t: TestContext, ms = 0): Promise<void> {
  t.mock.timers.tick(ms)
  for (let step = 0; step < 12; step++) await Promise.resolve()
}

async function final(fx: ReturnType<typeof setup>, text: string, utteranceId: string): Promise<void> {
  fx.callbacks.onSpeechStart?.({ utteranceId })
  fx.callbacks.onSpeechEnd?.({ utteranceId })
  await fx.callbacks.onTranscript?.(text, { utteranceId })
}

test('incomplete final waits and later complete speech combines into exactly one native submission', async t => {
  const fx = setup(t, { decide: async state => ({ action: state.transcript.includes('上海') ? 'submit' : 'wait', revision: state.revision }) })
  await fx.controller.toggle()
  await final(fx, '我想问一下', 'one')
  await advance(t, 100)
  assert.deepEqual(fx.submitted, [])
  await final(fx, '明天上海会下雨吗？', 'two')
  await advance(t, 100)
  assert.deepEqual(fx.submitted, ['我想问一下\n明天上海会下雨吗？'])
  await advance(t, 1000)
  assert.equal(fx.submitted.length, 1)
  assert.equal(fx.delegated.length, 0)
})

test('an active speaker blocks submission even when ASR marks a fragment final', async t => {
  const fx = setup(t)
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'one' })
  await fx.callbacks.onTranscript?.('我已经说完这部分', { utteranceId: 'one' })
  await advance(t, 100)
  assert.equal(fx.submitted.length, 0)
  fx.callbacks.onSpeechEnd?.({ utteranceId: 'one' })
  await advance(t, 100)
  assert.equal(fx.submitted.length, 1)
})

test('keyboard text or draft revision changes revoke automatic submission', async t => {
  const fx = setup(t)
  await fx.controller.toggle()
  await final(fx, '查询天气', 'one')
  fx.sameTextEdit()
  await advance(t, 100)
  assert.equal(fx.submitted.length, 0)
  await final(fx, '补充上海', 'two')
  fx.edit('我用键盘改成北京')
  await advance(t, 100)
  assert.deepEqual(fx.submitted, [])
  assert.equal(fx.draft(), '我用键盘改成北京')
})

test('duplicate finals and late partials cannot duplicate a submitted utterance', async t => {
  const fx = setup(t)
  await fx.controller.toggle()
  await final(fx, '查询天气', 'same')
  await fx.callbacks.onTranscript?.('查询天气', { utteranceId: 'same' })
  fx.callbacks.onPartialTranscript?.('过时的内容', { utteranceId: 'same' })
  await advance(t, 100)
  assert.deepEqual(fx.submitted, ['查询天气'])
  await fx.callbacks.onTranscript?.('查询天气', { utteranceId: 'same' })
  await advance(t, 1000)
  assert.equal(fx.submitted.length, 1)
})

test('acknowledgement soft pause resumes the same audio without replay or task cancellation', async t => {
  const fx = setup(t, { action: 'backchannel' })
  await fx.controller.toggle()
  fx.start('manual')
  fx.text('manual', '这是当前主模型的第一句话。')
  await advance(t)
  await final(fx, '嗯，对', 'ack')
  await advance(t, 100)
  assert.equal(fx.counts().pauses, 1)
  assert.equal(fx.counts().resumes, 1)
  assert.equal(fx.counts().audioCancels, 0)
  assert.equal(fx.counts().taskCancels, 0)
  assert.deepEqual(fx.spoken, ['这是当前主模型的第一句话。'])
  assert.equal(fx.draft(), '')
  fx.end('manual', '这是当前主模型的第一句话。')
  fx.finishAudio()
  await advance(t)
  assert.equal(fx.controller.getSnapshot().playback, 'idle')
  assert.deepEqual(fx.spoken, ['这是当前主模型的第一句话。'])
})

test('true barge-in cancels speech only, keeps the task running, and submits after its end', async t => {
  const fx = setup(t, { decide: async state => ({ action: state.mainBusy || state.assistantSpeaking ? 'interrupt' : 'submit', revision: state.revision }) })
  await fx.controller.toggle()
  fx.start('manual')
  fx.text('manual', '这是将被打断的回答。')
  await advance(t)
  await final(fx, '换成查询北京天气', 'new-question')
  await advance(t, 100)
  assert.equal(fx.counts().audioCancels, 1)
  assert.equal(fx.counts().taskCancels, 0)
  assert.equal(fx.submitted.length, 0)
  fx.text('manual', '不应再次播出的后续。')
  fx.end('manual', '这是将被打断的回答。不应再次播出的后续。')
  await advance(t, 500)
  assert.deepEqual(fx.submitted, ['换成查询北京天气'])
  assert.deepEqual(fx.spoken, ['这是将被打断的回答。'])
})

test('explicit task cancellation stops audio and asks Harness to cancel', async t => {
  const fx = setup(t)
  await fx.controller.toggle()
  fx.start('manual')
  fx.text('manual', '原有回答。')
  await advance(t)
  await final(fx, '取消这次任务', 'cancel')
  await advance(t)
  assert.equal(fx.counts().audioCancels, 1)
  assert.equal(fx.counts().taskCancels, 1)
  assert.equal(fx.draft(), '')
  assert.deepEqual(fx.submitted, [])
})

test('stale decisions are discarded and only the latest pending snapshot is evaluated', async t => {
  const resolvers: Array<(action: TurnAction) => void> = []
  const fx = setup(t, { decide: (state, _signal) => new Promise(resolve => resolvers.push(action => resolve({ action, revision: state.revision }))) })
  await fx.controller.toggle()
  await final(fx, '第一段', 'one')
  await advance(t, 100)
  await final(fx, '第二段', 'two')
  await final(fx, '第三段', 'three')
  await advance(t, 100)
  assert.equal(fx.decisions.length, 1)
  resolvers[0]!('submit')
  await advance(t)
  assert.deepEqual(fx.submitted, [])
  await advance(t)
  assert.equal(fx.decisions.length, 2)
  assert.equal(fx.decisions[1]?.transcript, '第一段\n第二段\n第三段')
  resolvers[1]!('submit')
  await advance(t)
  assert.deepEqual(fx.submitted, ['第一段\n第二段\n第三段'])
})

test('approved proactive interjection uses only the main model and can start during ongoing speech', async t => {
  const fx = setup(t, { action: 'interject' })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'speaking' })
  fx.callbacks.onPartialTranscript?.('那个服务', { utteranceId: 'speaking' })
  fx.callbacks.onPartialTranscript?.('那个服务部署时', { utteranceId: 'speaking' })
  await advance(t, 200)
  assert.equal(fx.delegated.length, 1)
  assert.equal(fx.delegated[0]?.text, '那个服务部署时')
  assert.equal(fx.contexts.at(-1)?.context?.interject, true)
  fx.start('clarification')
  fx.text('clarification', '你指的是哪个服务？')
  await advance(t)
  assert.deepEqual(fx.spoken, ['你指的是哪个服务？'])
  assert.equal(fx.controller.getSnapshot().userSpeaking, true)
  assert.equal(fx.controller.getSnapshot().playback, 'playing')
})

test('changing speech during main-model preparation cancels the unheard interjection', async t => {
  const fx = setup(t, { action: 'interject' })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'speaking' })
  fx.callbacks.onPartialTranscript?.('那个服务', { utteranceId: 'speaking' })
  fx.callbacks.onPartialTranscript?.('那个服务部署时', { utteranceId: 'speaking' })
  await advance(t, 200)
  fx.start('clarification')
  fx.callbacks.onPartialTranscript?.('那个服务部署时，就是订单服务', { utteranceId: 'speaking' })
  fx.text('clarification', '你指的是哪个服务？')
  await advance(t)
  assert.equal(fx.delegated[0]?.signal.aborted, true)
  assert.deepEqual(fx.spoken, [])
  assert.equal(fx.contexts.at(-1)?.context?.interject, undefined)
})

test('a prepared TTS chunk is still cancellable until the first audible audio arrives', async t => {
  const fx = setup(t, { action: 'interject', autoAudio: false })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'speaking' })
  fx.callbacks.onPartialTranscript?.('那个服务', { utteranceId: 'speaking' })
  fx.callbacks.onPartialTranscript?.('那个服务部署时', { utteranceId: 'speaking' })
  await advance(t, 200)
  fx.start('clarification')
  fx.text('clarification', '你指的是哪个服务？')
  await advance(t)
  assert.deepEqual(fx.spoken, ['你指的是哪个服务？'])
  fx.callbacks.onPartialTranscript?.('那个服务部署时，就是订单服务', { utteranceId: 'speaking' })
  await advance(t)
  assert.equal(fx.delegated[0]?.signal.aborted, true)
  assert.equal(fx.counts().audioCancels, 1)
  fx.callbacks.onState('speaking') // stale transport notification must not resurrect a muted output
  assert.equal(fx.controller.getSnapshot().playback, 'idle')
})

test('keyboard submitted main-model output is spoken once, including sentences after tools', async t => {
  const fx = setup(t)
  await fx.controller.toggle()
  fx.start('keyboard')
  fx.text('keyboard', '正在查找。')
  await advance(t)
  fx.observers.at(-1)!.onTextReset?.('keyboard', 'tool')
  fx.text('keyboard', '查到了，这是结果。')
  fx.end('keyboard', '查到了，这是结果。')
  fx.finishAudio()
  await advance(t)
  fx.finishAudio()
  await advance(t)
  assert.deepEqual(fx.spoken, ['正在查找。', '查到了，这是结果。'])
  assert.deepEqual(fx.delegated, [])
  assert.deepEqual(fx.submitted, [])
})

test('stop during connect and late transport callbacks cannot replace idle state', async t => {
  let rejectConnect!: (reason: Error) => void
  const fx = setup(t, { connect: () => new Promise((_resolve, reject) => { rejectConnect = reject }) })
  const pending = fx.controller.toggle()
  await advance(t)
  fx.controller.stop()
  rejectConnect(new Error('late connection failure'))
  await pending
  fx.callbacks.onState('error', 'late error')
  await fx.callbacks.onTranscript?.('不应发送', { utteranceId: 'late' })
  await advance(t, 1000)
  assert.equal(fx.controller.getSnapshot().state, 'idle')
  assert.deepEqual(fx.submitted, [])
  assert.equal(fx.counts().disconnects >= 1, true)
})

test('an old observer cannot inject text or end a new connection with the same turn label', async t => {
  const fx = setup(t)
  await fx.controller.toggle()
  const old = fx.observers[0]!
  fx.controller.stop()
  await fx.controller.toggle()
  fx.start('same-turn')
  old.onTextDelta('same-turn', '过时内容。')
  old.onTurnEnd('same-turn', { ok: true, text: '过时内容。' })
  fx.text('same-turn', '当前内容。')
  await advance(t)
  assert.deepEqual(fx.spoken, ['当前内容。'])
})


test('manually sending or clearing a staged draft removes its old speech from later acknowledgement decisions', async t => {
  const fx = setup(t, { decide: async state => ({ action: state.assistantSpeaking ? 'backchannel' : 'wait', revision: state.revision }) })
  await fx.controller.toggle()
  await final(fx, '这是通过键盘手动发送的问题', 'question')
  await advance(t, 100)
  fx.edit('') // native submit clears the composer
  fx.start('manual-send')
  fx.text('manual-send', '这是主模型的回答。')
  await advance(t)
  await final(fx, '嗯', 'ack')
  await advance(t, 100)
  assert.equal(fx.decisions.at(-1)?.transcript, '嗯')
  assert.equal(fx.counts().resumes, 1)
  assert.equal(fx.counts().audioCancels, 0)
})

test('an older empty draft snapshot cannot erase newly captured input after a native submission', async t => {
  const fx = setup(t, { action: 'wait' })
  await fx.controller.toggle()
  await final(fx, '新捕获的下一句话', 'next')
  fx.controller.bindDraft({ getDraft: () => '', getDraftRev: () => 0, setDraft() {} })
  await advance(t, 100)
  assert.equal(fx.controller.getSnapshot().transcript, '新捕获的下一句话')
  assert.equal(fx.draft(), '新捕获的下一句话')
})

test('a delayed final for an earlier utterance preserves the newer utterance partial', async t => {
  const fx = setup(t, { action: 'wait' })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'one' })
  fx.callbacks.onPartialTranscript?.('第一段', { utteranceId: 'one' })
  fx.callbacks.onSpeechEnd?.({ utteranceId: 'one' })
  fx.callbacks.onSpeechStart?.({ utteranceId: 'two' })
  fx.callbacks.onPartialTranscript?.('第二段还在说', { utteranceId: 'two' })
  await fx.callbacks.onTranscript?.('第一段完成', { utteranceId: 'one' })
  await advance(t, 100)
  assert.equal(fx.controller.getSnapshot().transcript, '第一段完成\n第二段还在说')
  assert.equal(fx.decisions.at(-1)?.isFinal, false)
})


test('a model retry replaces an in-flight speech request without muting replacement audio', async t => {
  let rejectFirst!: (error: Error) => void
  const fx = setup(t, {
    speak: async text => {
      if (text === '被模型重试替换的内容。') await new Promise<void>((_resolve, reject) => { rejectFirst = reject })
    },
    cancelSpeech: () => { rejectFirst?.(new Error('语音已被替换')) },
  })
  await fx.controller.toggle()
  fx.start('retry-turn')
  fx.text('retry-turn', '被模型重试替换的内容。')
  await advance(t)
  fx.observers.at(-1)!.onTextReset?.('retry-turn', 'retry')
  fx.text('retry-turn', '新的正确回答。')
  fx.end('retry-turn', '新的正确回答。')
  await advance(t)
  assert.deepEqual(fx.spoken, ['被模型重试替换的内容。', '新的正确回答。'])
  assert.equal(fx.counts().audioCancels, 1)
  assert.doesNotMatch(fx.controller.getSnapshot().detail, /播报失败/)
  fx.finishAudio()
  await advance(t)
  assert.equal(fx.controller.getSnapshot().playback, 'idle')
  assert.equal(fx.controller.getSnapshot().mainBusy, false)
})

test('a new utterance onset cancels unheard proactive TTS before any transcript update', async t => {
  const fx = setup(t, { action: 'interject', autoAudio: false })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'original' })
  fx.callbacks.onPartialTranscript?.('那个服务', { utteranceId: 'original' })
  fx.callbacks.onPartialTranscript?.('那个服务部署时', { utteranceId: 'original' })
  await advance(t, 200)
  fx.start('clarification')
  fx.text('clarification', '你指的是哪个服务？')
  await advance(t)
  fx.callbacks.onSpeechStart?.({ utteranceId: 'new-utterance' })
  assert.equal(fx.delegated[0]?.signal.aborted, true)
  assert.equal(fx.counts().audioCancels, 1)
  assert.equal(fx.controller.getSnapshot().transcript, '那个服务部署时')
  fx.callbacks.onState('speaking')
  assert.equal(fx.controller.getSnapshot().playback, 'idle')
  assert.equal(fx.controller.getSnapshot().transcript, '那个服务部署时')
})

test('the same approved utterance may continue overlapping its proactive question', async t => {
  const fx = setup(t, { action: 'interject', autoAudio: false })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'same' })
  fx.callbacks.onPartialTranscript?.('那个服务', { utteranceId: 'same' })
  fx.callbacks.onPartialTranscript?.('那个服务部署时', { utteranceId: 'same' })
  await advance(t, 200)
  fx.start('clarification')
  fx.text('clarification', '你指的是哪个服务？')
  await advance(t)
  fx.callbacks.onSpeechStart?.({ utteranceId: 'same' })
  assert.equal(fx.delegated[0]?.signal.aborted, false)
  assert.equal(fx.counts().audioCancels, 0)
  assert.equal(fx.counts().pauses, 0)
  fx.callbacks.onState('speaking')
  assert.equal(fx.controller.getSnapshot().playback, 'playing')
  assert.equal(fx.controller.getSnapshot().transcript, '')
})


test('a short correction awaiting its HTTP final cannot submit older completed speech', async t => {
  const fx = setup(t)
  await fx.controller.toggle()
  await final(fx, '帮我查询上海天气', 'first')
  fx.callbacks.onSpeechStart?.({ utteranceId: 'correction' })
  fx.callbacks.onSpeechEnd?.({ utteranceId: 'correction' })
  // No partial exists for this short utterance. Its final arrives after the
  // semantic-end timer, as happens with the HTTP ASR path.
  await advance(t, 100)
  assert.equal(fx.decisions.length, 0, 'do not call the model while final is pending')
  assert.deepEqual(fx.submitted, [])
  await advance(t, 500)
  assert.deepEqual(fx.submitted, [])
  await fx.callbacks.onTranscript?.('不对，是北京', { utteranceId: 'correction' })
  await advance(t, 100)
  assert.deepEqual(fx.submitted, ['帮我查询上海天气\n不对，是北京'])
})

test('an utterance awaiting its final can still interrupt playback from a partial', async t => {
  const fx = setup(t, { action: 'interrupt' })
  await fx.controller.toggle()
  fx.start('manual')
  fx.text('manual', '这是原来的回答。')
  await advance(t)
  fx.callbacks.onSpeechStart?.({ utteranceId: 'new' })
  fx.callbacks.onPartialTranscript?.('不对，我想说的是', { utteranceId: 'new' })
  await advance(t, 200)
  assert.equal(fx.decisions.at(-1)?.isFinal, false)
  assert.equal(fx.counts().audioCancels, 1)
  assert.equal(fx.counts().taskCancels, 0)
  assert.deepEqual(fx.submitted, [])
})

test('endpoint silence and ASR time count toward the continuation window only once', async t => {
  const fx = setup(t)
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'one' })
  await advance(t, 400)
  fx.callbacks.onSpeechEnd?.({ utteranceId: 'one', silenceMs: 400 })
  await advance(t, 150)
  await fx.callbacks.onTranscript?.('请推荐一种室内活动。', { utteranceId: 'one' })
  await advance(t)
  assert.deepEqual(fx.submitted, ['请推荐一种室内活动。'])
})

test('new transcript aborts the stale decision request instead of waiting for its timeout', async t => {
  let staleSignal: AbortSignal | undefined
  const fx = setup(t, { decide: async (state, signal) => {
    if (!state.isFinal) {
      staleSignal = signal
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return { action: 'submit', revision: state.revision }
  } })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'one' })
  fx.callbacks.onPartialTranscript?.('请推荐', { utteranceId: 'one' })
  fx.callbacks.onPartialTranscript?.('请推荐活动', { utteranceId: 'one' })
  await advance(t, 200)
  assert.equal(staleSignal?.aborted, false)
  fx.callbacks.onSpeechEnd?.({ utteranceId: 'one', silenceMs: 400 })
  await fx.callbacks.onTranscript?.('请推荐一种室内活动。', { utteranceId: 'one' })
  await advance(t)
  await advance(t)
  assert.equal(staleSignal?.aborted, true)
  assert.deepEqual(fx.submitted, ['请推荐一种室内活动。'])
})

test('idle partials wait for stable text before requesting a proactive decision', async t => {
  const fx = setup(t, { action: 'wait' })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'one' })
  fx.callbacks.onPartialTranscript?.('那个服务', { utteranceId: 'one' })
  await advance(t, 200)
  assert.equal(fx.decisions.length, 0)
  fx.callbacks.onPartialTranscript?.('那个服务部署时', { utteranceId: 'one' })
  await advance(t, 200)
  assert.equal(fx.decisions.length, 1)
  assert.equal(fx.decisions[0]?.stableText, '那个服务')
})

test('latency stages cover endpoint through first audio without counting silence twice', async t => {
  const fx = setup(t, { autoAudio: false, decide: async state => {
    await new Promise(resolve => setTimeout(resolve, 100))
    return { action: 'submit', revision: state.revision }
  } })
  updatePrefs({ qwenMergeMs: 600 })
  await fx.controller.toggle()
  fx.callbacks.onSpeechStart?.({ utteranceId: 'one' })
  await advance(t, 400)
  fx.callbacks.onSpeechEnd?.({ utteranceId: 'one', silenceMs: 400 })
  await advance(t, 80)
  await fx.callbacks.onTranscript?.('推荐一项活动。', { utteranceId: 'one' })
  await advance(t, 120)
  await advance(t, 100)
  await advance(t, 700)
  fx.text('native-1', '可以读书')
  await advance(t, 200)
  fx.text('native-1', '。')
  await advance(t, 400)
  fx.callbacks.onState('speaking')
  assert.deepEqual(fx.controller.getSnapshot().latency, { totalMs: 2000, stages: [
    { name: '尾静音', ms: 400 }, { name: 'ASR', ms: 80 }, { name: '轮次等待', ms: 120 },
    { name: '决策', ms: 100 }, { name: '主模型首字', ms: 700 }, { name: '分句等待', ms: 200 }, { name: 'TTS 首音频', ms: 400 },
  ] })
})

test('playback echo partials cannot trigger interjection and echo final resumes the answer', async t => {
  const fx = setup(t, { action: 'interrupt' })
  await fx.controller.toggle()
  fx.start('manual'); fx.text('manual', '今天适合在家休息。')
  fx.callbacks.onSpeechStart?.({ utteranceId: 'echo' })
  fx.callbacks.onPartialTranscript?.('今天适合在家休息', { utteranceId: 'echo', likelyEcho: true })
  await advance(t, 200)
  assert.equal(fx.decisions.length, 0)
  fx.callbacks.onSpeechEnd?.({ utteranceId: 'echo' })
  await fx.callbacks.onTranscript?.('今天适合在家休息', { utteranceId: 'echo', likelyEcho: true })
  assert.equal(fx.counts().audioCancels, 0)
  assert.equal(fx.counts().resumes, 1)
  assert.equal(fx.draft(), '')
})
