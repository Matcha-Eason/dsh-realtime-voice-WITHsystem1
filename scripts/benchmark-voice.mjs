import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import os from 'node:os'
import WebSocket from 'ws'
import { QwenHttpAsr, QwenInferenceTts } from '../lib/host/qwen-inference.js'
import { decideTurn } from '../lib/host/turn-decision.js'
import { VoiceController } from '../lib/client/controller.js'
import { LocalSenseVoice } from '../lib/host/local-asr.js'
import { WindowedAsr } from '../lib/host/windowed-asr.js'
import { updatePrefs } from '../lib/client/prefs.js'

const key = process.env.BAILIAN_TOKEN_PLAN_API_KEY
if (!key) throw new Error('BAILIAN_TOKEN_PLAN_API_KEY is required')
const rounds = Number(process.env.BENCH_ROUNDS ?? 3)
const label = process.env.BENCH_LABEL ?? 'current'
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20 || !/^[\w-]+$/.test(label)) throw new Error('Invalid benchmark options')
const localAsr = process.env.BENCH_ASR === 'local' ? new LocalSenseVoice() : undefined
if (localAsr) await localAsr.prepare()
const model = process.env.DSH_VOICE_MAIN_MODEL ?? 'deepseek-v4.1-flash'
const inputText = '我只有二十分钟，请推荐一种适合在家放松的活动。'
await mkdir('.local', { recursive: true })

// Uses the production task adapter; synthesis always receives exactly this text.
async function synthesizer() {
  const socket = new WebSocket('wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference', { headers: { Authorization: `Bearer ${key}` } })
  let readyResolve, readyReject, pending
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const timeout = setTimeout(() => readyReject(new Error('TTS connection timeout')), 15000)
  const adapter = new QwenInferenceTts('qwen-audio-3.0-tts-plus', event => socket.send(JSON.stringify(event)), event => {
    if (event.type === 'session.updated') { clearTimeout(timeout); readyResolve() }
    if (event.type === 'error') { readyReject(new Error(event.error.message)); pending?.reject(new Error(event.error.message)) }
    if (event.type === 'response.audio.delta' && pending) { pending.first?.(); pending.first = undefined; pending.chunks.push(Buffer.from(event.delta, 'base64')) }
    if (event.type === 'response.done' && pending) { const done = pending; pending = undefined; done.resolve(Buffer.concat(done.chunks)) }
  })
  socket.on('open', () => adapter.client({ type: 'session.update', session: { mode: 'commit', voice: 'longanlingxin', response_format: 'pcm', sample_rate: 24000 } }))
  socket.on('message', (data, binary) => adapter.upstream(data, binary))
  socket.on('error', () => { readyReject(new Error('TTS connection failed')); pending?.reject(new Error('TTS failed')) })
  socket.on('close', () => pending?.reject(new Error('TTS closed')))
  try { await ready } catch (error) { socket.close(); throw error }
  return {
    say(text, first) {
      return new Promise((resolve, reject) => {
        if (pending) return reject(new Error('Concurrent TTS in benchmark'))
        pending = { resolve, reject, first, chunks: [] }
        adapter.client({ type: 'input_text_buffer.append', text })
        adapter.client({ type: 'input_text_buffer.commit' })
      })
    },
    close() { clearTimeout(timeout); socket.close() },
  }
}

let fixture
try { fixture = await readFile('.local/benchmark-input.pcm') }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  const tts = await synthesizer()
  try {
    const pcm24 = await tts.say(inputText)
    fixture = Buffer.alloc(Math.floor(pcm24.length / 3) * 2)
    for (let i = 0; i < fixture.length / 2; i++) fixture.writeInt16LE(pcm24.readInt16LE(Math.floor(i * 1.5) * 2), i * 2)
    await writeFile('.local/benchmark-input.pcm', fixture)
  } finally { tts.close() }
}
// Trim synthesized leading/trailing silence with the same RMS threshold as ASR.
let start = 0, end = fixture.length
const voiced = chunk => { let sum = 0; for (let i = 0; i < chunk.length; i += 2) sum += (chunk.readInt16LE(i) / 32768) ** 2; return Math.sqrt(sum / (chunk.length / 2)) >= .015 }
while (start + 640 < end && !voiced(fixture.subarray(start, start + 640))) start += 640
while (end - 640 > start && !voiced(fixture.subarray(end - 640, end))) end -= 640
fixture = fixture.subarray(Math.max(0, start - 3200), end)
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } })
const networkFetch = globalThis.fetch
// Preference persistence is the only browser endpoint in this headless run.
globalThis.fetch = (url, init) => url === '/dsh-realtime-voice/prefs' ? Promise.resolve(new Response('{}')) : networkFetch(url, init)
const prefs = updatePrefs({ proactiveEnabled: process.env.BENCH_PROACTIVE !== 'false', ...(process.env.BENCH_MERGE_MS ? { qwenMergeMs: Number(process.env.BENCH_MERGE_MS) } : {}), ...(process.env.BENCH_SILENCE_MS ? { qwenSilenceMs: Number(process.env.BENCH_SILENCE_MS) } : {}), ...(process.env.BENCH_DECISION_TIMEOUT ? { decisionTimeoutMs: Number(process.env.BENCH_DECISION_TIMEOUT) } : {}) })
const results = []
for (let round = 0; round < rounds; round++) {
  let callbacks, observer, asr, draft = '', rev = 0, busy = false, modelTask
  const marks = {}, requests = [], decisions = []
  const mark = name => { marks[name] ??= performance.now() }
  let firstResolve, firstReject
  const firstAudio = new Promise((resolve, reject) => { firstResolve = resolve; firstReject = reject }).then(() => undefined, error => error)
  const deadline = setTimeout(() => firstReject(new Error('No answer audio within 45 seconds')), 45000)
  const tts = await synthesizer()
  const bridge = {
    observeSession(_id, value) { observer = value; return () => {} },
    async setVoiceMode() {}, isBusy: () => busy,
    async cancel() { return true }, async delegate() { firstReject(new Error('Benchmark requires an ordinary reply; model requested proactive clarification')); throw new Error('Proactive clarification is outside this benchmark') },
  }
  async function mainReply() {
    busy = true; observer.onTurnStart('bench'); mark('mainRequest')
    const response = await networkFetch('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, max_tokens: 256, ...(process.env.BENCH_THINKING === 'default' ? {} : { enable_thinking: false }), messages: [{ role: 'system', content: '请用两句简短中文口语回答，不调用工具、不输出思考过程。' }, { role: 'user', content: draft }] }),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error(`Main model HTTP ${response.status}`)
    let buffer = '', text = ''
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content
        if (delta) { mark('mainFirstText'); text += delta; observer.onTextDelta('bench', delta) }
      }
    }
    busy = false; observer.onTurnEnd('bench', { ok: true, text }); mark('mainDone')
  }
  const controller = new VoiceController('benchmark', bridge, (prefs, value) => {
    callbacks = value
    const emit = event => {
      const meta = { utteranceId: event.item_id }
      if (event.type === 'input_audio_buffer.speech_started') { mark('speechStart'); callbacks.onSpeechStart?.(meta) }
      if (event.type === 'input_audio_buffer.speech_stopped') { marks.endpoint = performance.now(); callbacks.onSpeechEnd?.({ ...meta, silenceMs: event.silence_ms }) }
      if (event.type === 'conversation.item.input_audio_transcription.text') { mark('firstPreview'); callbacks.onPartialTranscript?.(event.text, meta) }
      if (event.type === 'conversation.item.input_audio_transcription.completed') { marks.asrFinal = performance.now(); callbacks.onTranscript?.(event.transcript, meta) }
      if (event.type === 'error') firstReject(new Error(event.error.message))
    }
    asr = localAsr ? new WindowedAsr(localAsr.recognize, emit, 500) : new QwenHttpAsr('qwen-audio-3.0-asr-flash', key, emit, async (url, init) => {
      const entry = { started: performance.now() }; requests.push(entry)
      try {
        const response = await networkFetch(url, init)
        const body = await response.arrayBuffer()
        return new Response(body, { status: response.status, headers: response.headers })
      } finally { entry.ms = performance.now() - entry.started; entry.aborted = init.signal?.aborted ?? false }
    })
    return {
      async connect() { asr.client({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: prefs.qwenSilenceMs } } }) },
      disconnect() { asr.close() },
      async speak(text) { mark('ttsRequest'); await tts.say(text, () => { mark('firstAudio'); callbacks.onState('speaking'); firstResolve() }) },
      async waitForSpeechIdle() {}, cancelSpeech() {}, pauseSpeech() {}, resumeSpeech() {},
    }
  }, async (state, signal) => {
    const started = performance.now()
    let decision, attempts = 0
    try { decision = await decideTurn(state, key, signal, { timeoutMs: prefs.decisionTimeoutMs, fetch: (...args) => { attempts++; return networkFetch(...args) } }) }
    catch (error) { decisions.push({ ms: performance.now() - started, final: state.isFinal, attempts, action: signal.aborted ? 'superseded' : 'error', error: error.message }); throw error }
    decisions.push({ ms: performance.now() - started, final: state.isFinal, attempts, action: decision.action })
    if (state.isFinal) { marks.decisionRequest = started; marks.decisionDone = performance.now() }
    return decision
  })
  const target = {
    getDraft: () => draft, getDraftRev: () => rev, getPhase: () => 'plain',
    setDraft(text) { draft = text; rev++; controller.bindDraft(target) },
    submit() { mark('submit'); modelTask = mainReply().catch(error => { firstReject(error); return error }) },
  }
  controller.bindDraft(target)
  try {
    await controller.toggle()
    const audio = Buffer.concat([fixture, Buffer.alloc(32000 * 2)])
    const began = performance.now()
    for (let offset = 0; offset < audio.length; offset += 640) {
      if (offset >= fixture.length) mark('userStopped')
      asr.client({ type: 'input_audio_buffer.append', audio: audio.subarray(offset, offset + 640).toString('base64') })
      await sleep(Math.max(0, began + (offset + 640) / 32 - performance.now()))
    }
    const audioError = await firstAudio
    if (audioError) throw audioError
    const modelError = await modelTask
    if (modelError) throw modelError
    const ms = (a, b) => Math.round(marks[b] - marks[a])
    const result = { round: round + 1, inputMs: Math.round(fixture.length / 32), transcript: draft,
      endpointMs: ms('userStopped', 'endpoint'), asrAfterEndpointMs: ms('endpoint', 'asrFinal'),
      finalToDecisionMs: ms('asrFinal', 'decisionRequest'), decisionMs: ms('decisionRequest', 'decisionDone'),
      mainFirstTextMs: ms('mainRequest', 'mainFirstText'), sentenceBufferMs: ms('mainFirstText', 'ttsRequest'),
      ttsFirstAudioMs: ms('ttsRequest', 'firstAudio'), userEndToFirstAudioMs: ms('userStopped', 'firstAudio'),
      asrRequests: requests.map(x => ({ ms: Math.round(x.ms), aborted: x.aborted })), decisions: decisions.map(x => ({ ...x, ms: Math.round(x.ms) })) }
    results.push(result); console.log(JSON.stringify(result))
  } catch (error) {
    const failure = { round: round + 1, error: error.message, state: controller.getSnapshot(), requests, decisions }
    results.push(failure); console.error(JSON.stringify(failure))
  } finally { clearTimeout(deadline); controller.stop(); tts.close() }
}
const report = { at: new Date().toISOString(), label, asr: localAsr ? 'local-sensevoice' : 'token-plan', cpu: os.cpus()[0]?.model, model, settings: { silenceMs: prefs.qwenSilenceMs, mergeMs: prefs.qwenMergeMs, decisionTimeoutMs: prefs.decisionTimeoutMs, proactiveEnabled: prefs.proactiveEnabled, thinking: process.env.BENCH_THINKING === 'default' ? 'provider-default' : 'off' }, scope: 'Production turn controller and ASR/TTS adapters; streamed main API, no DSH tools or physical speaker. Synthetic Mandarin fixture. No microphone captured.', results }
await writeFile(`.local/latency-${label}.json`, JSON.stringify(report, null, 2) + '\n')
