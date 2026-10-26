import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { apply, isHostDependencies, type HostDependencies } from '../src/index.ts'

function request(body = {}, method = 'POST') {
  const req = Readable.from([JSON.stringify(body)]) as Readable & Record<string, unknown>
  req.method = method
  req.headers = {
    host: '127.0.0.1:52628',
    origin: 'http://127.0.0.1:52628',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
  }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function response() {
  const result = { status: 0, headers: {} as Record<string, string>, body: '' }
  const value = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers },
    end(body = '') { result.body = String(body); value.writableEnded = true },
  })
  return { result, value }
}

function fixture(configured: boolean, initialPrefs: Record<string, unknown> = {}, overrides: Partial<HostDependencies> = {}) {
  const routes = new Map<string, (req: never, res: never) => Promise<void> | void>()
  const upgrades = new Map<string, (req: never, socket: never, head: Buffer) => Promise<void> | void>()
  const disposers: Array<() => void> = []
  let decisions = 0
  let lastDecision: Parameters<typeof dependencies.decideTurn> | undefined
  const resolvedCredentials: unknown[] = []
  let voiceprintEnrolls = 0
  let voiceprintVerifies = 0
  let voiceprintDeletes = 0
  let storedPrefs: Record<string, unknown> = { voiceprintThreshold: 75, ...initialPrefs }
  let voiceContextProvider: ((context: { agent?: { id: string } }) => string) | undefined
  const dependencies: HostDependencies = {
    decideTurn: async (...args) => {
      decisions++
      lastDecision = args
      if (overrides.decideTurn !== undefined) return await overrides.decideTurn(...args)
      return { action: 'submit', revision: (args[0] as { revision: number }).revision }
    },
    voiceprintEnroll: async () => { voiceprintEnrolls++; return 'voiceprint-test-id' },
    voiceprintVerify: async () => { voiceprintVerifies++; return { decision: true, score: 88 } },
    voiceprintDelete: async () => { voiceprintDeletes++ },
  }
  const ctx = {
    credentials: {
      resolve: async (ref: unknown) => { resolvedCredentials.push(ref); return configured ? { value: 'fake-test-key', source: 'test' } : undefined },
      describe: async () => ({ configured, writable: false }),
    },
    webServer: {
      register(route: { path: string; handler: (req: never, res: never) => Promise<void> | void }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      registerUpgrade(route: { path: string; handler: (req: never, socket: never, head: Buffer) => Promise<void> | void }) {
        upgrades.set(route.path, route.handler)
        return () => upgrades.delete(route.path)
      },
    },
    systemPrompt: {
      context(input: { text: string | ((context: { agent?: { id: string } }) => string) }) {
        voiceContextProvider = typeof input.text === 'function' ? input.text : () => input.text
        return () => { voiceContextProvider = undefined }
      },
    },
    effect(callback: () => void | (() => void)) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    get(name: string) {
      if (name !== 'settings') return undefined
      return {
        register() {
          return {
            get: () => storedPrefs,
            update: async (patch: Record<string, unknown>) => { storedPrefs = { ...storedPrefs, ...patch } },
          }
        },
        describe: () => [{ ns: 'dsh-realtime-voice', user: storedPrefs }],
      }
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx as never, dependencies)
  return {
    routes,
    upgrades,
    disposers,
    decisionCalls: () => ({ count: decisions, args: lastDecision }),
    resolvedCredentials,
    voiceprintCalls: () => ({ enrolls: voiceprintEnrolls, verifies: voiceprintVerifies, deletes: voiceprintDeletes }),
    storedPrefs: () => storedPrefs,
    voiceContext: (sessionId: string) => voiceContextProvider?.({ agent: { id: sessionId } }) ?? '',
  }
}

test('host routes dispose cleanly and can be mounted again', () => {
  const one = fixture(false)
  assert.deepEqual([...one.routes.keys()].sort(), [
    '/dsh-realtime-voice/context',
    '/dsh-realtime-voice/decide',
    '/dsh-realtime-voice/prefs',
    '/dsh-realtime-voice/status',
    '/dsh-realtime-voice/voiceprint',
  ])
  assert.deepEqual([...one.upgrades.keys()].sort(), [
    '/dsh-realtime-voice/asr/qwen',
    '/dsh-realtime-voice/tts/qwen',
  ])
  one.disposers.forEach(dispose => dispose())
  assert.equal(one.routes.size, 0)
  assert.equal(one.upgrades.size, 0)
  const two = fixture(false)
  assert.equal(two.routes.size, 5)
  assert.equal(two.upgrades.size, 2)
})

test('draft auto-send preferences persist with safe bounds', async () => {
  const fx = fixture(false)
  const saved = response()
  await fx.routes.get('/dsh-realtime-voice/prefs')?.(
    request({
      qwenMergeMs: 1400,
      voiceDraftAutoSend: true,
      voiceDraftDwellMs: 600,
      voiceDraftAllowWithoutVoiceprint: true,
      voiceDraftSensitiveDeny: true,
    }, 'PUT') as never,
    saved.value as never,
  )
  assert.equal(saved.result.status, 200)
  assert.equal(fx.storedPrefs().voiceDraftAutoSend, true)
  assert.equal(fx.storedPrefs().voiceDraftDwellMs, 1400)
  assert.equal(fx.storedPrefs().voiceDraftAllowWithoutVoiceprint, true)
  assert.equal(fx.storedPrefs().voiceDraftSensitiveDeny, true)
})

test('voice output contract is session-scoped runtime context, not route-visible prompt text', async () => {
  const fx = fixture(false)
  assert.equal(fx.voiceContext('voice-session'), '')

  const on = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(
    request({ sessionId: 'voice-session', active: true }, 'PUT') as never,
    on.value as never,
  )
  assert.equal(on.result.status, 200)
  assert.match(fx.voiceContext('voice-session'), /实时语音对话/)
  assert.doesNotMatch(fx.voiceContext('voice-session'), /内容严格为 voice-summary/)
  assert.equal(fx.voiceContext('other-session'), '')

  const off = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(
    request({ sessionId: 'voice-session', active: false }, 'PUT') as never,
    off.value as never,
  )
  assert.equal(off.result.status, 200)
  assert.equal(fx.voiceContext('voice-session'), '')
})

test('voice context endpoint rejects cross-site activation', async () => {
  const fx = fixture(false)
  const req = request({ sessionId: 'voice-session', active: true }, 'PUT')
  ;(req.headers as Record<string, string>)['sec-fetch-site'] = 'cross-site'
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(req as never, res.value as never)
  assert.equal(res.result.status, 403)
  assert.equal(fx.voiceContext('voice-session'), '')
})

test('voiceprint enrollment, verification and deletion keep the opaque id on the host', async () => {
  const fx = fixture(true)
  const audio = Buffer.alloc(32_000).toString('base64')
  const enroll = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio }) as never,
    enroll.value as never,
  )
  assert.equal(enroll.result.status, 200)
  assert.equal(fx.storedPrefs().voiceprintId, 'voiceprint-test-id')
  assert.doesNotMatch(enroll.result.body, /voiceprint-test-id/)

  const status = response()
  await fx.routes.get('/dsh-realtime-voice/status')?.(request({}, 'GET') as never, status.value as never)
  assert.equal(status.result.status, 200)
  assert.equal(JSON.parse(status.result.body).voiceprint.enrolled, true)
  assert.doesNotMatch(status.result.body, /voiceprint-test-id/)

  const prefs = response()
  await fx.routes.get('/dsh-realtime-voice/prefs')?.(request({}, 'GET') as never, prefs.value as never)
  assert.equal(prefs.result.status, 200)
  assert.doesNotMatch(prefs.result.body, /voiceprint-test-id/)

  const verify = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'verify', audio }) as never,
    verify.value as never,
  )
  assert.equal(verify.result.status, 200)
  assert.deepEqual(JSON.parse(verify.result.body), { ok: true, approved: true, score: 88 })

  const higherThreshold = response()
  await fx.routes.get('/dsh-realtime-voice/prefs')?.(
    request({ voiceprintEnabled: true, voiceprintThreshold: 90 }, 'PUT') as never,
    higherThreshold.value as never,
  )
  assert.equal(higherThreshold.result.status, 200)
  const belowThreshold = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'verify', audio }) as never,
    belowThreshold.value as never,
  )
  assert.deepEqual(JSON.parse(belowThreshold.result.body), { ok: true, approved: false, score: 88 })

  const duplicateEnroll = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio }) as never,
    duplicateEnroll.value as never,
  )
  assert.equal(duplicateEnroll.result.status, 409)

  const remove = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({}, 'DELETE') as never,
    remove.value as never,
  )
  assert.equal(remove.result.status, 200)
  assert.equal(fx.storedPrefs().voiceprintId, '')
  assert.deepEqual(fx.voiceprintCalls(), { enrolls: 1, verifies: 2, deletes: 1 })
})

test('voiceprint fails closed when credentials or sufficient audio are missing', async () => {
  const missing = fixture(false)
  const missingResponse = response()
  await missing.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio: Buffer.alloc(32_000).toString('base64') }) as never,
    missingResponse.value as never,
  )
  assert.equal(missingResponse.result.status, 502)

  const short = fixture(true)
  const shortResponse = response()
  await short.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio: Buffer.alloc(4_000).toString('base64') }) as never,
    shortResponse.value as never,
  )
  assert.equal(shortResponse.result.status, 400)
  assert.deepEqual(short.voiceprintCalls(), { enrolls: 0, verifies: 0, deletes: 0 })

  const invalid = fixture(true)
  const invalidResponse = response()
  await invalid.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio: '!'.repeat(50_000) }) as never,
    invalidResponse.value as never,
  )
  assert.equal(invalidResponse.result.status, 400)

  const oversized = fixture(true)
  const oversizedResponse = response()
  await oversized.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio: 'A'.repeat(1_400_001) }) as never,
    oversizedResponse.value as never,
  )
  assert.equal(oversizedResponse.result.status, 413)

  const missingDelete = fixture(false, { voiceprintId: 'vp-local-id' })
  const missingDeleteResponse = response()
  await missingDelete.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({}, 'DELETE') as never,
    missingDeleteResponse.value as never,
  )
  assert.equal(missingDeleteResponse.result.status, 502)
  assert.equal(missingDelete.storedPrefs().voiceprintId, 'vp-local-id')
})

test('cordis install shape: config objects do not masquerade as host dependencies', () => {
  // cordis calls apply(ctx, config); the installed `config: {}` must not be
  // mistaken for the optional test-injection object.
  assert.equal(isHostDependencies({}), false)
  assert.equal(isHostDependencies(undefined), false)
  assert.equal(isHostDependencies(null), false)
  assert.equal(isHostDependencies({ decideTurn: async () => ({ action: 'wait', revision: 0 }) }), false)
  assert.equal(isHostDependencies({
    decideTurn: async () => ({ action: 'wait', revision: 0 }),
    voiceprintEnroll: async () => '',
    voiceprintVerify: async () => ({ decision: false, score: 0 }),
    voiceprintDelete: async () => {},
  } satisfies HostDependencies), true)
})

const decisionState = {
  transcript: '明天会下雨吗？', stableText: '明天会下雨吗？', revision: 4,
  isFinal: true, userSpeaking: false, assistantSpeaking: false, mainBusy: false, recentAssistantText: '',
}

test('decision route uses Token Plan host credentials and returns only the decision', async () => {
  const fx = fixture(true, { decisionModel: 'decision-model-preview', decisionTimeoutMs: 1750 })
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/decide')?.(request(decisionState) as never, res.value as never)
  assert.equal(res.result.status, 200)
  assert.deepEqual(JSON.parse(res.result.body), { action: 'submit', revision: 4 })
  assert.equal(fx.decisionCalls().count, 1)
  assert.deepEqual(fx.decisionCalls().args?.[0], decisionState)
  assert.deepEqual(fx.decisionCalls().args?.[3], { model: 'decision-model-preview', timeoutMs: 1750 })
  assert.deepEqual(fx.resolvedCredentials, ['BAILIAN_TOKEN_PLAN_API_KEY'])
  assert.doesNotMatch(res.result.body, /fake-test-key|transcript/)
})

test('invalid, cross-origin and disabled decisions are rejected before credential resolution', async () => {
  for (const scenario of ['invalid', 'cross-site', 'disabled'] as const) {
    const fx = fixture(true, { decisionEnabled: scenario !== 'disabled' })
    const req = request(scenario === 'invalid' ? { ...decisionState, transcript: 42 } : decisionState)
    if (scenario === 'cross-site') (req.headers as Record<string, string>)['sec-fetch-site'] = 'cross-site'
    const res = response()
    await fx.routes.get('/dsh-realtime-voice/decide')?.(req as never, res.value as never)
    assert.equal(res.result.status, scenario === 'invalid' ? 400 : scenario === 'cross-site' ? 403 : 409)
    assert.equal(fx.decisionCalls().count, 0)
    assert.deepEqual(fx.resolvedCredentials, [])
  }
})

test('missing credentials and provider failures never expose raw diagnostics', async () => {
  for (const configured of [false, true]) {
    const fx = fixture(configured, {}, { decideTurn: async () => { throw new Error('Authorization: Bearer secret-provider-key; private account diagnostics') } })
    const res = response()
    await fx.routes.get('/dsh-realtime-voice/decide')?.(request(decisionState) as never, res.value as never)
    assert.equal(res.result.status, 502)
    assert.deepEqual(JSON.parse(res.result.body), { error: 'turn decision service unavailable' })
    assert.equal(fx.decisionCalls().count, configured ? 1 : 0)
    assert.doesNotMatch(res.result.body, /secret-provider-key|Authorization|private account/)
  }
})

test('decision upstream is aborted on response disconnect or aborted request and listeners are removed', async () => {
  for (const event of ['response-close', 'request-aborted'] as const) {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let signal: AbortSignal | undefined
    const fx = fixture(true, {}, {
      decideTurn: async (_state, _key, receivedSignal) => {
        signal = receivedSignal
        started()
        return await new Promise((_, reject) => receivedSignal.addEventListener('abort', () => reject(receivedSignal.reason), { once: true }))
      },
    })
    const req = request(decisionState)
    const res = response()
    const pending = fx.routes.get('/dsh-realtime-voice/decide')!(req as never, res.value as never)
    await ready
    if (event === 'response-close') { res.value.destroyed = true; res.value.emit('close') }
    else req.emit('aborted')
    await pending
    assert.equal(signal?.aborted, true)
    assert.equal(res.result.status, 0)
    assert.equal(res.result.body, '')
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(res.value.listenerCount('close'), 0)
  }
})

test('playback and interjection context stays in one session and is replaced, disabled or expired', async () => {
  const fx = fixture(false)
  const on = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(request({
    sessionId: 'voice', active: true, heardText: '只播完了这句话。', interrupted: true, interject: true,
  }, 'PUT') as never, on.value as never)
  assert.equal(on.result.status, 200)
  assert.match(fx.voiceContext('voice'), /只播完了这句话/)
  assert.match(fx.voiceContext('voice'), /不要假定其听到了记录之后/)
  assert.match(fx.voiceContext('voice'), /不要调用工具/)
  assert.match(fx.voiceContext('voice'), /已被用户打断/)
  assert.equal(fx.voiceContext('other'), '')
  const replaced = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(request({ sessionId: 'voice', active: true }, 'PUT') as never, replaced.value as never)
  assert.doesNotMatch(fx.voiceContext('voice'), /只播完了这句话|本轮是主动插话澄清|已被用户打断/)
  const originalNow = Date.now
  const future = originalNow() + 16 * 60_000
  try { Date.now = () => future; assert.equal(fx.voiceContext('voice'), '') }
  finally { Date.now = originalNow }
  assert.equal(fx.voiceContext('voice'), '')
})

test('playback context validates bounded text and boolean flags without changing a valid context', async () => {
  const fx = fixture(false)
  for (const invalid of [{ heardText: 'a'.repeat(2001) }, { heardText: 1 }, { interrupted: 'yes' }, { interject: 1 }]) {
    const res = response()
    await fx.routes.get('/dsh-realtime-voice/context')?.(request({ sessionId: 'voice', active: true, ...invalid }, 'PUT') as never, res.value as never)
    assert.equal(res.result.status, 400)
    assert.equal(fx.voiceContext('voice'), '')
  }
})

test('prefs force the main-model-only speech path, bound decisions, and omit obsolete providers', async () => {
  const fx = fixture(false)
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/prefs')?.(request({
    provider: 'openai', speechService: 'token-plan', qwenWorkspaceId: 'arbitrary', qwenRegion: 'ap-southeast-1',
    decisionTimeoutMs: 90000, openaiModel: 'gpt-realtime', qwenModel: 'omni', floorComposerEnabled: true,
  }, 'PUT') as never, res.value as never)
  assert.equal(res.result.status, 200)
  const stored = fx.storedPrefs()
  assert.equal(stored.provider, 'qwen')
  assert.equal(stored.speechService, 'token-plan')
  assert.equal(stored.qwenWorkspaceId, 'token-plan')
  assert.equal(stored.qwenRegion, 'cn-beijing')
  assert.equal(stored.decisionTimeoutMs, 10000)
  assert.equal(stored.decisionModel, 'decision-model-preview')
  assert.equal(stored.decisionEnabled, true)
  assert.equal(stored.proactiveEnabled, true)
  assert.equal(stored.qwenMergeMs, 400)
  assert.equal(stored.voiceDraftDwellMs, 700)
  assert.equal(stored.voiceDraftAllowWithoutVoiceprint, true)
  for (const removed of ['openaiModel', 'qwenModel', 'floorComposerEnabled']) assert.equal(removed in stored, false)
})

test('status reports Token Plan and standard Qwen configuration without any credential values', async () => {
  const fx = fixture(true)
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/status')?.(request({}, 'GET') as never, res.value as never)
  assert.equal(res.result.status, 200)
  assert.deepEqual(JSON.parse(res.result.body).tokenPlan, { configured: true })
  assert.deepEqual(JSON.parse(res.result.body).qwen, { configured: true })
  assert.equal('openai' in JSON.parse(res.result.body), false)
  assert.doesNotMatch(res.result.body, /fake-test-key/)
})
