import { WindowedAsr } from './windowed-asr.ts'
import { LocalSenseVoice } from './local-asr.ts'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { isLoopbackRequest } from './security.ts'
import { QwenHttpAsr, QwenInferenceTts, TOKEN_PLAN_ASR_ENDPOINT } from './qwen-inference.ts'

export type QwenSpeechKind = 'asr' | 'tts'
export type QwenSpeechService = 'token-plan' | 'dashscope'

const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/
const REALTIME_MODELS = {
  asr: new Set(['qwen3-asr-flash-realtime', 'qwen3-asr-flash-realtime-2026-02-10', 'qwen3-asr-flash-realtime-2025-10-27']),
  tts: new Set(['qwen3-tts-flash-realtime', 'qwen3-tts-flash-realtime-2025-11-27', 'qwen3-tts-flash-realtime-2025-09-18', 'qwen3-tts-instruct-flash-realtime', 'qwen3-tts-instruct-flash-realtime-2026-01-22']),
}

/** Validates the billing boundary and selects only the protocol this proxy carries. */
export function resolveQwenSpeechRoute(kind: QwenSpeechKind, params: URLSearchParams): {
  service: QwenSpeechService; workspaceId: string; endpoint: string; model: string; protocol: 'realtime' | 'inference' | 'http'
} {
  const service = params.get('service') ?? 'token-plan'
  if (service !== 'token-plan' && service !== 'dashscope') throw new Error('unsupported speech service')

  // Token Plan has its own credentials and fixed workspace. Never redirect its
  // key to an arbitrary workspace or a pay-as-you-go domain.
  // https://help.aliyun.com/zh/model-studio/token-plan-realtime-voice
  if (service === 'token-plan') {
    const model = params.get('model') ?? (kind === 'tts' ? 'qwen-audio-3.0-tts-plus' : 'qwen-audio-3.0-asr-flash')
    if (model !== (kind === 'tts' ? 'qwen-audio-3.0-tts-plus' : 'qwen-audio-3.0-asr-flash')) throw new Error('unsupported Token Plan speech model')
    const workspace = params.get('workspaceId')
    const region = params.get('region')
    if ((workspace && workspace !== 'token-plan') || (region && region !== 'cn-beijing')) throw new Error('invalid Token Plan workspace or region')
    return {
      service, workspaceId: 'token-plan', model, protocol: kind === 'tts' ? 'inference' : 'http',
      endpoint: kind === 'tts' ? 'wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference'
        : TOKEN_PLAN_ASR_ENDPOINT,
    }
  }

  const workspaceId = params.get('workspaceId') ?? ''
  const region = params.get('region') ?? 'cn-beijing'
  const model = params.get('model') ?? (kind === 'asr' ? 'qwen3-asr-flash-realtime' : 'qwen3-tts-flash-realtime')
  if (!REALTIME_MODELS[kind].has(model)) throw new Error('unsupported realtime speech model')
  if (!WORKSPACE_RE.test(workspaceId) || workspaceId === 'token-plan'
    || (region !== 'cn-beijing' && region !== 'ap-southeast-1')) throw new Error('invalid DashScope workspace or region')
  return {
    service, workspaceId, model, protocol: 'realtime',
    endpoint: kind === 'asr'
      ? `wss://${workspaceId}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`
      : `${region === 'ap-southeast-1' ? 'wss://dashscope-intl.aliyuncs.com' : 'wss://dashscope.aliyuncs.com'}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`,
  }
}

export class QwenSpeechProxy {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  private readonly sockets = new Set<WebSocket>()

  constructor(
    private readonly resolveKey: (service: QwenSpeechService) => Promise<string | undefined>,
    private readonly connectUpstream: (endpoint: string, options: WebSocket.ClientOptions) => WebSocket = (endpoint, options) => new WebSocket(endpoint, options),
    private readonly requestAsr: typeof fetch = fetch,
    private readonly localAsr: Pick<LocalSenseVoice, 'prepare' | 'recognize'> = new LocalSenseVoice(),
  ) {}

  handle = async (kind: QwenSpeechKind, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    if (!isLoopbackRequest(req)) return rejectUpgrade(socket, 403, 'Forbidden')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const engine = url.searchParams.get('engine')
    // Local recognition owns no cloud credential and cannot change TTS billing.
    if (engine === 'local-sensevoice' && kind === 'asr') {
      try { await this.localAsr.prepare() }
      catch {
        this.server.handleUpgrade(req, socket, head, local => {
          sendSafeError(local, '本地 ASR 未就绪，请先运行 npm run setup:asr')
          local.close(1011, 'local ASR unavailable')
        })
        return
      }
      this.acceptAsr(req, socket, head, emit => new WindowedAsr(this.localAsr.recognize, emit, 500))
      return
    }
    if (engine !== null && engine !== 'cloud') return rejectUpgrade(socket, 400, 'Bad Request')
    let route: ReturnType<typeof resolveQwenSpeechRoute>
    try {
      route = resolveQwenSpeechRoute(kind, url.searchParams)
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request')
    }
    const key = await this.resolveKey(route.service)
    if (key === undefined || key.trim() === '') return rejectUpgrade(socket, 502, 'Speech credential unavailable')

    if (route.protocol === 'http') {
      this.acceptAsr(req, socket, head, emit => new QwenHttpAsr(route.model, key, emit, this.requestAsr))
      return
    }
    this.server.handleUpgrade(req, socket, head, local => {
      this.sockets.add(local)
      const upstream = this.connectUpstream(route.endpoint, {
        headers: {
          Authorization: `Bearer ${key}`,
          'X-DashScope-WorkSpace': route.workspaceId,
          'User-Agent': 'dsh-realtime-voice/0.3',
        },
        maxPayload: 4 * 1024 * 1024,
      })
      this.sockets.add(upstream)
      const pending: Array<{ data: RawData; binary: boolean }> = []
      const inference = route.protocol === 'inference' ? new QwenInferenceTts(route.model,
        event => { if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event)) },
        event => { if (local.readyState === WebSocket.OPEN) local.send(JSON.stringify(event)) },
      ) : undefined
      const send = (data: RawData, binary: boolean): void => {
        if (!inference) return upstream.send(data, { binary })
        try {
          const event = JSON.parse(data.toString()) as unknown
          if (binary || !event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid event')
          inference.client(event as Record<string, unknown>)
        } catch { sendSafeError(local, 'Invalid Qwen TTS client event') }
      }

      local.on('message', (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) send(data, binary)
        else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 256) pending.push({ data, binary })
      })
      upstream.on('open', () => {
        inference?.open()
        for (const item of pending.splice(0)) send(item.data, item.binary)
      })
      upstream.on('message', (data, binary) => {
        if (inference) inference.upstream(Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data, binary)
        else if (local.readyState === WebSocket.OPEN) local.send(data, { binary })
      })
      upstream.on('unexpected-response', (_request, response) => {
        sendSafeError(local, `Qwen ${kind.toUpperCase()} connection rejected (${response.statusCode})`)
        local.close(1011, 'upstream rejected')
      })
      upstream.on('error', () => {
        sendSafeError(local, `Qwen ${kind.toUpperCase()} connection unavailable`)
      })
      local.on('error', () => upstream.close())
      local.on('close', () => {
        this.sockets.delete(local)
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close()
      })
      upstream.on('close', () => {
        this.sockets.delete(upstream)
        if (local.readyState === WebSocket.OPEN) local.close(1000, 'upstream closed')
      })
    })
  }

  private acceptAsr(req: IncomingMessage, socket: Duplex, head: Buffer, create: (emit: (event: Record<string, unknown>) => void) => WindowedAsr): void {
    this.server.handleUpgrade(req, socket, head, local => {
      this.sockets.add(local)
      const asr = create(event => { if (local.readyState === WebSocket.OPEN) local.send(JSON.stringify(event)) })
      local.on('message', (data, binary) => {
        try {
          const event = JSON.parse(data.toString()) as unknown
          if (binary || !event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid event')
          asr.client(event as Record<string, unknown>)
        } catch { sendSafeError(local, 'Invalid ASR client event'); asr.close() }
      })
      local.on('close', () => { this.sockets.delete(local); asr.close() })
      local.on('error', () => asr.close())
    })
  }

  close(): void {
    for (const socket of this.sockets) socket.close(1001, 'plugin disposed')
    this.sockets.clear()
  }
}

function sendSafeError(socket: WebSocket, message: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', error: { message } }))
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
