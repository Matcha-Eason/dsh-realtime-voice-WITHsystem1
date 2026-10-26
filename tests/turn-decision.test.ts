import assert from 'node:assert/strict'
import test from 'node:test'
import { decideTurn, parseTurnDecisionState, TURN_DECISION_ENDPOINT } from '../src/host/turn-decision.ts'
import { type TurnDecisionState } from '../src/turn-decision.ts'

const state: TurnDecisionState = {
  transcript: '帮我解释这段代码', stableText: '帮我解释这段代码', revision: 7,
  isFinal: true, userSpeaking: false, assistantSpeaking: false, mainBusy: false,
  recentAssistantText: '',
}

function respond(action: unknown): typeof fetch {
  return async () => new Response(JSON.stringify({ answers: { action: { type: 'choice', choice: action } } }))
}

test('decision request uses the Token Plan System One protocol and returns only action plus input revision', async () => {
  const decision = await decideTurn(state, 'test-key', new AbortController().signal, {
    fetch: async (url, init) => {
      assert.equal(url, TURN_DECISION_ENDPOINT)
      assert.equal(init?.method, 'POST')
      const request = JSON.parse(String(init?.body))
      assert.equal(request.model, 'decision-model-preview')
      assert.deepEqual(request.state, state)
      assert.equal(request.questions.action.type, 'choice')
      assert.deepEqual(Object.keys(request.questions.action.criteria), ['wait', 'submit', 'backchannel', 'interrupt', 'interject', 'cancel'])
      assert.match(request.questions.action.instructions, /所有可播出的内容始终由主大模型生成/)
      assert.equal(request.messages, undefined)
      return new Response(JSON.stringify({ answers: { action: { choice: 'submit', probabilities: { submit: 1 }, confidence: 1 } }, text: 'must never be spoken' }))
    },
  })
  assert.deepEqual(decision, { action: 'submit', revision: 7 })
})

test('host validates state before sending and does not transmit unrelated fields', async () => {
  for (const invalid of [null, [], { ...state, revision: -1 }, { ...state, isFinal: 'yes' }, { ...state, transcript: 'x'.repeat(8_001) }]) {
    assert.throws(() => parseTurnDecisionState(invalid), /invalid turn decision state/)
  }
  assert.deepEqual(parseTurnDecisionState({ ...state, unrelated: 'not model input' }), state)
  let calls = 0
  await assert.rejects(decideTurn({ ...state, revision: NaN }, 'key', new AbortController().signal, { fetch: async () => { calls++; return new Response() } }), /invalid turn decision state/)
  assert.equal(calls, 0)
})

test('incomplete or busy snapshots cannot submit even if the model requests it', async () => {
  for (const change of [{ isFinal: false }, { userSpeaking: true }, { assistantSpeaking: true }, { mainBusy: true }]) {
    assert.equal((await decideTurn({ ...state, ...change }, 'key', new AbortController().signal, { fetch: respond('submit') })).action, 'wait')
  }
})

test('interjection requires stable speech and an idle main model', async () => {
  const speaking = { ...state, isFinal: false, userSpeaking: true }
  assert.equal((await decideTurn(speaking, 'key', new AbortController().signal, { fetch: respond('interject') })).action, 'interject')
  assert.equal((await decideTurn({ ...speaking, userSpeaking: false }, 'key', new AbortController().signal, { fetch: respond('interject') })).action, 'interject')
  for (const change of [{ stableText: '' }, { mainBusy: true }, { assistantSpeaking: true }]) {
    assert.equal((await decideTurn({ ...speaking, ...change }, 'key', new AbortController().signal, { fetch: respond('interject') })).action, 'wait')
  }
})

test('user acknowledgement and interruption are separate from cancelling work', async () => {
  for (const action of ['backchannel', 'interrupt', 'cancel']) {
    const decision = await decideTurn({ ...state, assistantSpeaking: true }, 'key', new AbortController().signal, { fetch: respond(action) })
    assert.equal(decision.action, action)
  }
  assert.equal((await decideTurn(state, 'key', new AbortController().signal, { fetch: respond('backchannel') })).action, 'wait')
})

test('invalid responses and HTTP failures surface without leaking provider bodies', async () => {
  for (const action of ['speak', { text: 'hello' }, null]) {
    await assert.rejects(decideTurn(state, 'key', new AbortController().signal, { fetch: respond(action) }), /invalid action/)
  }
  await assert.rejects(decideTurn(state, 'key', new AbortController().signal, { fetch: async () => new Response('sensitive provider payload', { status: 401 }) }), /^Error: turn decision provider rejected request \(401\)$/)
  await assert.rejects(decideTurn(state, 'key', new AbortController().signal, { fetch: async () => new Response('sensitive malformed response') }), /^Error: turn decision provider returned invalid JSON$/)
})

test('caller abort and decision deadline cancel the actual request without retries', async () => {
  let calls = 0
  const pending: typeof fetch = async (_url, init) => {
    calls++
    const signal = init!.signal!
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const controller = new AbortController()
  const interrupted = decideTurn(state, 'key', controller.signal, { fetch: pending })
  controller.abort()
  await assert.rejects(interrupted, { name: 'AbortError' })
  const keepAlive = setTimeout(() => {}, 100)
  try {
    await assert.rejects(decideTurn(state, 'key', new AbortController().signal, { timeoutMs: 10, fetch: pending }), { name: 'TimeoutError' })
  } finally { clearTimeout(keepAlive) }
  assert.equal(calls, 2)
})

test('empty speech needs no model call and pre-aborted calls never reach the provider', async () => {
  let calls = 0
  const fetch: typeof globalThis.fetch = async () => { calls++; return new Response() }
  assert.deepEqual(await decideTurn({ ...state, transcript: ' ' }, 'key', new AbortController().signal, { fetch }), { action: 'wait', revision: 7 })
  await assert.rejects(decideTurn(state, 'key', AbortSignal.abort(), { fetch }), { name: 'AbortError' })
  assert.equal(calls, 0)
})
