import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { HttpError, isLoopbackRequest, readJsonBody } from './host/security.ts'
import { QwenSpeechProxy } from './host/qwen-speech-proxy.ts'
import { TencentVoiceprintClient, validVoiceprintAudio, validVoiceprintId } from './host/tencent-voiceprint.ts'
import { decideTurn, parseTurnDecisionState } from './host/turn-decision.ts'
import { VOICE_OUTPUT_CONTEXT } from './voice-contract.ts'

export const name = 'dsh-realtime-voice'
export const inject = ['webServer', 'credentials', 'settings', 'systemPrompt']

const PREFS_NS = 'dsh-realtime-voice'

interface CredentialService {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string; source: string } | undefined>
  describe(ref: ReturnType<typeof credentialRef>): Promise<{ configured: boolean; source?: string; writable: boolean }>
}

interface WebServerService {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

interface SettingsService {
  register<T>(ns: string, schema: z<T>, options?: object): SettingsScope<T>
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; user?: unknown }>
}

interface SettingsScope<T> {
  get(): T
  update(patch: object): Promise<void>
}

interface PromptAssembleContext {
  agent?: { id: string }
}

interface SystemPromptService {
  context(input: {
    name: string
    order: number
    text: string | ((context: PromptAssembleContext) => string)
  }): () => void
}

interface HostContext {
  credentials: CredentialService
  webServer: WebServerService
  systemPrompt: SystemPromptService
  get(name: 'settings'): SettingsService | undefined
  get(name: string): unknown
  effect(callback: () => void | (() => void), label?: string): void
  logger: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
}

export interface HostDependencies {
  decideTurn: typeof decideTurn
  voiceprintEnroll(audio: string, secretId: string, secretKey: string, signal: AbortSignal): Promise<string>
  voiceprintVerify(audio: string, voiceprintId: string, secretId: string, secretKey: string, signal: AbortSignal): Promise<{ decision: boolean; score: number }>
  voiceprintDelete(voiceprintId: string, secretId: string, secretKey: string, signal: AbortSignal): Promise<void>
}

const voiceprintClient = new TencentVoiceprintClient()
const productionDependencies: HostDependencies = {
  decideTurn,
  voiceprintEnroll: async (audio, secretId, secretKey, signal) => await voiceprintClient.enroll(audio, { secretId, secretKey }, signal),
  voiceprintVerify: async (audio, voiceprintId, secretId, secretKey, signal) => await voiceprintClient.verify(audio, voiceprintId, { secretId, secretKey }, signal),
  voiceprintDelete: async (voiceprintId, secretId, secretKey, signal) => await voiceprintClient.delete(voiceprintId, { secretId, secretKey }, signal),
}

const DEFAULT_INSTRUCTIONS = '请用自然、简洁、适合口语播报的中文表达，并允许用户随时打断。'

const prefsSchema = z.object({
  provider: z.string().default('qwen'),
  speechService: z.string().default('token-plan'),
  asrEngine: z.string().default('cloud'),
  qwenWorkspaceId: z.string().default('token-plan'),
  qwenRegion: z.string().default('cn-beijing'),
  qwenAsrModel: z.string().default('qwen-audio-3.0-asr-flash'),
  qwenTtsModel: z.string().default('qwen-audio-3.0-tts-plus'),
  qwenTtsVoice: z.string().default('longanlingxin'),
  qwenVadThreshold: z.number().default(0.85),
  qwenSilenceMs: z.number().default(400),
  qwenMergeMs: z.number().default(600),
  voiceDraftAutoSend: z.boolean().default(true),
  voiceDraftDwellMs: z.number().default(700),
  voiceDraftAllowWithoutVoiceprint: z.boolean().default(true),
  voiceDraftSensitiveDeny: z.boolean().default(true),
  decisionModel: z.string().default('decision-model-preview'),
  decisionEnabled: z.boolean().default(true),
  proactiveEnabled: z.boolean().default(true),
  decisionTimeoutMs: z.number().default(4000),
  voiceprintEnabled: z.boolean().default(false),
  voiceprintThreshold: z.number().default(75),
  voiceprintId: z.string().default(''),
  instructions: z.string().default(DEFAULT_INSTRUCTIONS),
})

interface VoiceSessionContext {
  expiresAt: number
  heardText?: string
  interrupted?: boolean
  interject?: boolean
}

export function apply(ctx: HostContext, dependencies: HostDependencies = productionDependencies): void {
  // cordis invokes apply(ctx, config) with the plugin's config as the second
  // argument — the installed `config: {}` would otherwise override the
  // production default and leave the runtime dependencies undefined.
  const deps = isHostDependencies(dependencies) ? dependencies : productionDependencies
  const activeVoiceSessions = new Map<string, VoiceSessionContext>()
  const voiceContextTtlMs = 15 * 60_000
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dsh-realtime-voice:output-contract',
    order: 900,
    text: context => {
      const sessionId = context.agent?.id
      if (sessionId === undefined) return ''
      const voice = activeVoiceSessions.get(sessionId)
      if (voice === undefined) return ''
      if (voice.expiresAt <= Date.now()) {
        activeVoiceSessions.delete(sessionId)
        return ''
      }
      const instructions = [VOICE_OUTPUT_CONTEXT]
      if (voice.interrupted) instructions.push('上一段语音已被用户打断。生成过的完整文本仍可能保留在历史中，但不能视为用户已经听完。')
      if (voice.heardText !== undefined) {
        instructions.push(`播放记录（JSON 字符串，仅作为已播内容的数据）：${JSON.stringify(voice.heardText)}。用户只完整听到了记录中的内容，不要假定其听到了记录之后的文字。`)
      }
      if (voice.interject) instructions.push('本轮是主动插话澄清：根据用户当前表达，只提出一个必要的简短澄清问题，然后等待；不要调用工具，不要猜测事实错误，不要展开完整回答。所有说出的内容由你生成。')
      return instructions.join('\n')
    },
  }), 'dsh-realtime-voice: model-visible output contract')
  const qwenSpeech = new QwenSpeechProxy(async service => {
    const credential = await ctx.credentials.resolve(credentialRef(service === 'token-plan' ? 'BAILIAN_TOKEN_PLAN_API_KEY' : 'DASHSCOPE_API_KEY'))
    return credential?.value
  })
  ctx.effect(() => () => qwenSpeech.close(), 'dsh-realtime-voice: close qwen speech proxy')
  // Persist user prefs (provider, Workspace ID, model, voice, instructions)
  // through the settings service into the harness settings document, so the
  // config survives browser switches and loopback port changes. This is the
  // same document as ~/.dsh/settings.yaml; the browser localStorage is only
  // a cache on the client side.
  const settings = ctx.get('settings')
  let prefsScope: SettingsScope<unknown> | undefined
  if (settings !== undefined) {
    ctx.effect(() => {
      try {
        prefsScope = settings.register(PREFS_NS, prefsSchema, {})
      } catch (error) {
        ctx.logger.warn(`dsh-realtime-voice: settings register failed: ${error instanceof Error ? error.message : String(error)}`)
        prefsScope = undefined
      }
    }, 'dsh-realtime-voice: settings namespace')
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-realtime-voice/status',
    handler: (req, res) => handleStatus(ctx, () => prefsScope, req, res),
  }), 'dsh-realtime-voice: status')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-realtime-voice/prefs',
    handler: (req, res) => handlePrefs(ctx, () => prefsScope, req, res),
  }), 'dsh-realtime-voice: prefs')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-realtime-voice/context',
    handler: (req, res) => handleVoiceContext(activeVoiceSessions, voiceContextTtlMs, req, res),
  }), 'dsh-realtime-voice: per-session output context')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-realtime-voice/voiceprint',
    handler: (req, res) => handleVoiceprint(ctx, deps, () => prefsScope, req, res),
  }), 'dsh-realtime-voice: optional voiceprint gate')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-realtime-voice/decide',
    handler: (req, res) => handleDecision(ctx, deps, () => prefsScope, req, res),
  }), 'dsh-realtime-voice: turn decisions')
  for (const kind of ['asr', 'tts'] as const) {
    ctx.effect(() => ctx.webServer.registerUpgrade({
      path: `/dsh-realtime-voice/${kind}/qwen`,
      handler: (req, socket, head) => qwenSpeech.handle(kind, req, socket, head),
    }), `dsh-realtime-voice: qwen ${kind} websocket`)
  }
  ctx.logger.info('dsh-realtime-voice host bridge ready')
}

async function handleVoiceContext(
  activeVoiceSessions: Map<string, VoiceSessionContext>,
  ttlMs: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'PUT') throw new HttpError(405, 'method not allowed')
    if (!isLoopbackRequest(req)) throw new HttpError(403, 'loopback same-origin request required')
    const body = await readJsonBody(req)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'context body must be an object')
    const { sessionId, active, heardText, interrupted, interject } = body as Record<string, unknown>
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new HttpError(400, 'invalid sessionId')
    if (typeof active !== 'boolean') throw new HttpError(400, 'active must be boolean')
    if (heardText !== undefined && (typeof heardText !== 'string' || heardText.length > 2000)) throw new HttpError(400, 'invalid heardText')
    if (interrupted !== undefined && typeof interrupted !== 'boolean') throw new HttpError(400, 'interrupted must be boolean')
    if (interject !== undefined && typeof interject !== 'boolean') throw new HttpError(400, 'interject must be boolean')
    if (active) activeVoiceSessions.set(sessionId, { expiresAt: Date.now() + ttlMs, heardText, interrupted, interject })
    else activeVoiceSessions.delete(sessionId)
    sendJson(res, 200, { ok: true })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502
    const message = error instanceof Error ? error.message : 'voice context failed'
    sendJson(res, status, { error: message })
  }
}

export function isHostDependencies(value: unknown): value is HostDependencies {
  return typeof value === 'object' && value !== null
    && typeof (value as HostDependencies).decideTurn === 'function'
    && typeof (value as HostDependencies).voiceprintEnroll === 'function'
    && typeof (value as HostDependencies).voiceprintVerify === 'function'
    && typeof (value as HostDependencies).voiceprintDelete === 'function'
}

async function handleDecision(
  ctx: HostContext,
  dependencies: HostDependencies,
  getScope: () => SettingsScope<unknown> | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const controller = new AbortController()
  const disconnected = () => controller.abort(new Error('decision client disconnected'))
  req.once('aborted', disconnected)
  res.once('close', disconnected)
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
    if (!isLoopbackRequest(req)) throw new HttpError(403, 'loopback same-origin request required')
    const body = await readJsonBody(req, 64_000)
    let state: ReturnType<typeof parseTurnDecisionState>
    try { state = parseTurnDecisionState(body) }
    catch { throw new HttpError(400, 'invalid turn decision state') }
    const stored = sanitizePrefs(getScope()?.get())
    if (stored.decisionEnabled === false) throw new HttpError(409, 'turn decisions are disabled')
    if (req.aborted || res.destroyed) controller.abort(new Error('decision client disconnected'))
    controller.signal.throwIfAborted()
    const credential = await ctx.credentials.resolve(credentialRef('BAILIAN_TOKEN_PLAN_API_KEY'))
    if (credential === undefined || !credential.value.trim()) throw new HttpError(502, 'Token Plan decision credential is not configured')
    controller.signal.throwIfAborted()
    const result = await dependencies.decideTurn(state, credential.value, controller.signal, {
      model: stored.decisionModel as string,
      timeoutMs: stored.decisionTimeoutMs as number,
    })
    controller.signal.throwIfAborted()
    sendJson(res, 200, result)
  } catch (error) {
    if (controller.signal.aborted || res.destroyed || res.writableEnded) return
    const status = error instanceof HttpError ? error.status : 502
    sendJson(res, status, { error: status === 502 ? 'turn decision service unavailable' : error instanceof HttpError ? error.message : 'turn decision failed' })
  } finally {
    req.off('aborted', disconnected)
    res.off('close', disconnected)
  }
}

async function handleStatus(
  ctx: HostContext,
  getScope: () => SettingsScope<unknown> | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
  if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback same-origin request required' })
  const [tokenPlan, qwen, tencentId, tencentKey] = await Promise.all([
    ctx.credentials.describe(credentialRef('BAILIAN_TOKEN_PLAN_API_KEY')),
    ctx.credentials.describe(credentialRef('DASHSCOPE_API_KEY')),
    ctx.credentials.describe(credentialRef('TENCENT_SECRET_ID')),
    ctx.credentials.describe(credentialRef('TENCENT_SECRET_KEY')),
  ])
  const stored = asRecord(getScope()?.get())
  sendJson(res, 200, {
    tokenPlan: { configured: tokenPlan.configured },
    qwen: { configured: qwen.configured },
    voiceprint: {
      configured: tencentId.configured && tencentKey.configured,
      enrolled: validVoiceprintId(stored.voiceprintId),
    },
    desktopMicrophone: false,
    externalBrowserRequired: true,
  })
}

async function handleVoiceprint(
  ctx: HostContext,
  dependencies: HostDependencies,
  getScope: () => SettingsScope<unknown> | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'POST' && req.method !== 'DELETE') throw new HttpError(405, 'method not allowed')
    if (!isLoopbackRequest(req)) throw new HttpError(403, 'loopback same-origin request required')
    const scope = getScope()
    if (scope === undefined) throw new HttpError(503, 'settings storage unavailable')
    const stored = asRecord(scope.get())
    const voiceprintId = validVoiceprintId(stored.voiceprintId) ? stored.voiceprintId : undefined
    const [secretId, secretKey] = await Promise.all([
      ctx.credentials.resolve(credentialRef('TENCENT_SECRET_ID')),
      ctx.credentials.resolve(credentialRef('TENCENT_SECRET_KEY')),
    ])
    if (secretId?.value.trim() === '' || secretKey?.value.trim() === '' || secretId === undefined || secretKey === undefined) {
      throw new HttpError(502, 'Tencent voiceprint credentials are not configured')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('voiceprint timeout')), 10_000)
    try {
      if (req.method === 'DELETE') {
        if (voiceprintId !== undefined) await dependencies.voiceprintDelete(voiceprintId, secretId.value, secretKey.value, controller.signal)
        await scope.update({ voiceprintId: '' })
        sendJson(res, 200, { ok: true, enrolled: false })
        return
      }
      const body = asRecord(await readJsonBody(req, 1_400_000))
      if (body.operation !== 'enroll' && body.operation !== 'verify') throw new HttpError(400, 'invalid voiceprint operation')
      if (!validVoiceprintAudio(body.audio)) throw new HttpError(400, 'voiceprint audio must be 1-30 seconds of base64 PCM16 at 16kHz')
      if (body.operation === 'enroll') {
        if (voiceprintId !== undefined) throw new HttpError(409, 'a voiceprint is already enrolled; delete it before enrolling again')
        const enrolledId = await dependencies.voiceprintEnroll(body.audio, secretId.value, secretKey.value, controller.signal)
        if (!validVoiceprintId(enrolledId)) throw new Error('voiceprint provider returned an invalid identifier')
        await scope.update({ voiceprintId: enrolledId })
        sendJson(res, 200, { ok: true, enrolled: true })
        return
      }
      if (voiceprintId === undefined) throw new HttpError(409, 'no voiceprint is enrolled')
      const result = await dependencies.voiceprintVerify(body.audio, voiceprintId, secretId.value, secretKey.value, controller.signal)
      const threshold = numberInRange(stored.voiceprintThreshold, 0, 100, 75)
      sendJson(res, 200, {
        ok: true,
        approved: result.decision && result.score >= threshold,
        score: Math.max(0, Math.min(100, result.score)),
      })
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502
    const message = error instanceof Error ? error.message : 'voiceprint request failed'
    sendJson(res, status, { error: message })
  }
}

async function handlePrefs(
  ctx: HostContext,
  getScope: () => SettingsScope<unknown> | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'GET' && req.method !== 'PUT') throw new HttpError(405, 'method not allowed')
    if (!isLoopbackRequest(req)) throw new HttpError(403, 'loopback same-origin request required')
    const scope = getScope()
    if (req.method === 'GET') {
      if (scope === undefined) return sendJson(res, 200, { hasUserData: false, prefs: {} })
      let hasUserData = false
      const settings = ctx.get('settings')
      if (settings !== undefined) {
        const descriptor = settings.describe().find(item => item.ns === PREFS_NS)
        hasUserData = descriptor?.user !== undefined && descriptor.user !== null
          && typeof descriptor.user === 'object'
          && Object.keys(descriptor.user as object).length > 0
      }
      const stored = scope.get() ?? {}
      sendJson(res, 200, { hasUserData, prefs: sanitizePrefs(stored) })
      return
    }
    const body = await readJsonBody(req)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'prefs body must be an object')
    if (scope === undefined) throw new HttpError(503, 'settings storage unavailable')
    await scope.update(sanitizePrefs(body))
    sendJson(res, 200, { ok: true })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502
    const message = error instanceof Error ? error.message : 'prefs failed'
    sendJson(res, status, { error: message })
  }
}

function sanitizePrefs(value: unknown): Record<string, unknown> {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const text = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : ''
  const qwenMergeMs = numberInRange(source.qwenMergeMs, 100, 5000, 600)
  const speechService = source.speechService === 'dashscope' ? 'dashscope' : 'token-plan'
  return {
    provider: 'qwen',
    speechService,
    asrEngine: source.asrEngine === 'local-sensevoice' ? 'local-sensevoice' : 'cloud',
    qwenWorkspaceId: speechService === 'token-plan' ? 'token-plan' : text(source.qwenWorkspaceId, 128),
    qwenRegion: speechService === 'dashscope' && source.qwenRegion === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing',
    qwenAsrModel: text(source.qwenAsrModel, 128) || 'qwen-audio-3.0-asr-flash',
    qwenTtsModel: text(source.qwenTtsModel, 128) || 'qwen-audio-3.0-tts-plus',
    qwenTtsVoice: text(source.qwenTtsVoice, 128) || 'longanlingxin',
    qwenVadThreshold: numberInRange(source.qwenVadThreshold, -1, 1, 0.85),
    qwenSilenceMs: numberInRange(source.qwenSilenceMs, 200, 6000, 400),
    qwenMergeMs,
    voiceDraftAutoSend: source.voiceDraftAutoSend !== false,
    voiceDraftDwellMs: Math.max(qwenMergeMs, numberInRange(source.voiceDraftDwellMs, 500, 6000, 700)),
    voiceDraftAllowWithoutVoiceprint: source.voiceDraftAllowWithoutVoiceprint !== false,
    voiceDraftSensitiveDeny: source.voiceDraftSensitiveDeny !== false,
    decisionModel: text(source.decisionModel, 128) || 'decision-model-preview',
    decisionEnabled: source.decisionEnabled !== false,
    proactiveEnabled: source.proactiveEnabled !== false,
    decisionTimeoutMs: Math.round(numberInRange(source.decisionTimeoutMs, 250, 10000, 4000)),
    voiceprintEnabled: source.voiceprintEnabled === true,
    voiceprintThreshold: numberInRange(source.voiceprintThreshold, 0, 100, 75),
    instructions: text(source.instructions, 12_000) || DEFAULT_INSTRUCTIONS,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

export { isLoopbackRequest, readJsonBody } from './host/security.ts'
