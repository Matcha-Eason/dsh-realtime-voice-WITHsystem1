import assert from 'node:assert/strict'
import test from 'node:test'
import { QwenPipelineConnection } from '../src/client/qwen-pipeline.ts'
import type { VoicePrefs } from '../src/client/prefs.ts'
import type { RealtimeCallbacks, TranscriptMeta } from '../src/client/realtime.ts'

interface Internals {
  asr?: WebSocket
  tts?: WebSocket
  openAsr(): Promise<void>
  openTts(): Promise<void>
  handleAsr(raw: string): Promise<void>
  handleTts(raw: string): void
  pendingSpeechText: string
  currentSpeechText: string
}

const prefs = {
  qwenWorkspaceId: 'workspace', qwenRegion: 'cn-beijing',
  qwenAsrModel: 'qwen3-asr-flash-realtime', qwenTtsModel: 'qwen3-tts-flash-realtime',
  qwenTtsVoice: 'Chelsie', qwenVadThreshold: 0.85, qwenSilenceMs: 700,
  voiceprintEnabled: false,
} as VoicePrefs

function connection(callbacks: Partial<RealtimeCallbacks> = {}) {
  const value = new QwenPipelineConnection(prefs, { onState() {}, ...callbacks })
  return { value, internals: value as unknown as Internals }
}

test('partials and finals retain utterance identity, busy origin and echo evidence without losing text', async () => {
  const partials: Array<{ text: string; meta?: TranscriptMeta }> = []
  const finals: Array<{ text: string; meta?: TranscriptMeta }> = []
  const starts: string[] = []
  const { value, internals } = connection({
    onSpeechStart: meta => { starts.push(meta?.utteranceId ?? '') },
    onPartialTranscript: (text, meta) => { partials.push({ text, meta }) },
    onTranscript: async (text, meta) => { finals.push({ text, meta }) },
  })
  value.setInputPhase('tts-speaking')
  await internals.handleAsr(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'u1' }))
  await internals.handleAsr(JSON.stringify({ type: 'conversation.item.input_audio_transcription.text', item_id: 'u1', text: '我想', stash: '补充一点' }))
  value.setInputPhase('listening')
  await internals.handleAsr(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '我想补充一点' }))
  await internals.handleAsr(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '我想补充一点' }))
  await internals.handleAsr(JSON.stringify({ type: 'conversation.item.input_audio_transcription.text', item_id: 'u1', text: '过时的文本' }))
  assert.deepEqual(starts, ['u1'])
  assert.equal(partials.length, 1)
  assert.equal(partials[0]?.text, '我想补充一点')
  assert.equal(partials[0]?.meta?.utteranceId, 'u1')
  assert.equal(finals.length, 1)
  assert.equal(finals[0]?.meta?.capturedWhileBusy, true)
  assert.equal(finals[0]?.meta?.utteranceId, 'u1')
  value.disconnect()
})

test('likely playback echoes are annotated and delivered rather than silently deleting user text', async () => {
  const finals: Array<{ text: string; meta?: TranscriptMeta }> = []
  const { value, internals } = connection({ onTranscript: async (text, meta) => { finals.push({ text, meta }) } })
  internals.currentSpeechText = '今天天气晴朗，出门不用带伞。'
  await internals.handleAsr(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'echo' }))
  // Preserve the utterance's playback reference even if playback ended before
  // its final transcript arrived.
  internals.currentSpeechText = ''
  await internals.handleAsr(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'echo', transcript: '今天天气晴朗' }))
  assert.equal(finals[0]?.meta?.likelyEcho, true)
  assert.equal(finals[0]?.text, '今天天气晴朗')
  value.disconnect()
})

test('speech onset pauses playback reversibly, preserving incoming PCM and completed playback markers', async () => {
  const restore = audioGlobals()
  const played: string[] = []
  const finals: string[] = []
  const { value, internals } = connection({
    onPlaybackProgress: text => { played.push(text) },
    onTranscript: async text => { finals.push(text) },
  })
  try {
    internals.pendingSpeechText = '完整回答。'
    internals.handleTts(JSON.stringify({ type: 'response.audio.delta', delta: pcm(100) }))
    const playback = FakeAudioContext.instances[0]!
    await internals.handleAsr(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'noise' }))
    assert.equal(playback.state, 'suspended')
    internals.handleTts(JSON.stringify({ type: 'response.audio.delta', delta: pcm(200) }))
    internals.handleTts(JSON.stringify({ type: 'response.done' }))
    await internals.handleAsr(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'noise', transcript: '嗯' }))
    assert.deepEqual(finals, ['嗯'])
    assert.equal(playback.sources.length, 2)
    assert.equal(playback.sources.every(source => !source.stopped), true)
    assert.deepEqual(played, [])
    let idle = false
    const waiting = value.waitForSpeechIdle().then(() => { idle = true })
    await Promise.resolve()
    assert.equal(idle, false)
    value.resumeSpeech()
    assert.equal(playback.state, 'running')
    playback.sources[0]!.finish()
    assert.deepEqual(played, [])
    playback.sources[1]!.finish()
    await waiting
    assert.deepEqual(played, ['完整回答。'])
    assert.equal(playback.sources[0]!.buffer?.samples[0], 100 / 32768)
    assert.equal(playback.sources[1]!.buffer?.samples[0], 200 / 32768)
  } finally { value.disconnect(); restore() }
})

test('pause before the first audio holds later audio, while cancellation drops its heard marker', async () => {
  const restore = audioGlobals()
  const played: string[] = []
  const { value, internals } = connection({ onPlaybackProgress: text => { played.push(text) } })
  try {
    value.pauseSpeech()
    internals.pendingSpeechText = '不该播放。'
    internals.handleTts(JSON.stringify({ type: 'response.audio.delta', delta: pcm(100) }))
    internals.handleTts(JSON.stringify({ type: 'response.done' }))
    const playback = FakeAudioContext.instances[0]!
    assert.equal(playback.state, 'suspended')
    value.cancelSpeech()
    assert.equal(playback.sources[0]!.stopped, true)
    await value.waitForSpeechIdle()
    assert.deepEqual(played, [])
  } finally { value.disconnect(); restore() }
})

test('cancelling inside the first-audio callback prevents that same frame from entering playback', async () => {
  const restore = audioGlobals()
  const played: string[] = []
  const { value, internals } = connection({
    onState: state => { if (state === 'speaking') value.cancelSpeech() },
    onPlaybackProgress: text => { played.push(text) },
  })
  try {
    internals.pendingSpeechText = '已过时的插话。'
    internals.handleTts(JSON.stringify({ type: 'response.audio.delta', delta: pcm(100) }))
    internals.handleTts(JSON.stringify({ type: 'response.done' }))
    assert.equal(FakeAudioContext.instances.length, 0)
    await value.waitForSpeechIdle()
    assert.deepEqual(played, [])
  } finally { value.disconnect(); restore() }
})

test('microphone ASR stays continuous through speaking, soft pause and post playback with native AEC', async () => {
  const restore = audioGlobals()
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let constraints: MediaStreamConstraints | undefined
  const microphone = { getTracks: () => [{ stop() {} }] } as unknown as MediaStream
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: async (value: MediaStreamConstraints) => { constraints = value; return microphone } },
  } })
  const frames: unknown[] = []
  const { value, internals } = connection()
  internals.openTts = async () => {}
  internals.openAsr = async () => {
    internals.asr = { readyState: 1, bufferedAmount: 0, send: raw => { frames.push(JSON.parse(String(raw))) }, close() {} } as WebSocket
  }
  try {
    await value.connect()
    const capture = FakeAudioContext.instances[0]!
    const input = { inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) } }
    for (const phase of ['listening', 'tts-speaking', 'post-playback'] as const) {
      value.setInputPhase(phase)
      if (phase === 'tts-speaking') value.pauseSpeech()
      capture.processor!.onaudioprocess!(input)
    }
    assert.equal(frames.length, 3)
    assert.equal(capture.state, 'running')
    assert.deepEqual(constraints?.audio, { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 })
  } finally {
    value.disconnect()
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
    restore()
  }
})

test('disconnect during microphone permission stops a late stream and skips speech initialization', async () => {
  const restore = audioGlobals()
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let grant!: (stream: MediaStream) => void
  let stopped = 0
  let ttsOpens = 0
  let asrOpens = 0
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve }) },
  } })
  const { value, internals } = connection()
  internals.openTts = async () => { ttsOpens++ }
  internals.openAsr = async () => { asrOpens++ }
  try {
    const connecting = value.connect()
    value.disconnect()
    grant({ getTracks: () => [{ stop() { stopped++ } }] } as unknown as MediaStream)
    await connecting
    assert.equal(stopped, 1)
    assert.equal(ttsOpens, 0)
    assert.equal(asrOpens, 0)
    assert.equal(FakeAudioContext.instances.length, 0)
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
    restore()
  }
})

test('disconnect during speech setup prevents later ASR and capture initialization', async () => {
  const restore = audioGlobals()
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let stopped = 0
  let ready!: () => void
  let asrOpens = 0
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++ } }] }) },
  } })
  const { value, internals } = connection()
  internals.openTts = () => new Promise<void>(resolve => { ready = resolve })
  internals.openAsr = async () => { asrOpens++ }
  try {
    const connecting = value.connect()
    await Promise.resolve()
    value.disconnect()
    ready()
    await connecting
    assert.equal(stopped, 1)
    assert.equal(asrOpens, 0)
    assert.equal(FakeAudioContext.instances.length, 0)
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
    restore()
  }
})

test('audio and completion from a cancelled TTS socket cannot enter a replacement speech generation', async () => {
  const restore = audioGlobals()
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'localhost' } })
  const { value, internals } = connection()
  try {
    const opening = internals.openTts()
    const old = FakeWebSocket.instances[0]!
    old.open()
    old.message({ type: 'session.updated' })
    await opening
    const speech = value.speak('第一句。')
    await Promise.resolve()
    old.message({ type: 'response.audio.delta', delta: pcm(100) })
    const rejected = assert.rejects(speech, /打断/)
    value.cancelSpeech()
    await rejected
    const nextOpening = internals.openTts()
    const current = FakeWebSocket.instances[1]!
    current.open()
    current.message({ type: 'session.updated' })
    await nextOpening
    const next = value.speak('第二句。')
    await Promise.resolve()
    let nextDone = false
    void next.then(() => { nextDone = true })
    old.message({ type: 'response.audio.delta', delta: pcm(999) })
    old.message({ type: 'response.done' })
    await Promise.resolve()
    assert.equal(nextDone, false)
    const playback = FakeAudioContext.instances[0]!
    assert.equal(playback.sources.length, 1)
    current.message({ type: 'response.audio.delta', delta: pcm(200) })
    current.message({ type: 'response.done' })
    await next
    assert.equal(playback.sources.length, 2)
    assert.equal(playback.sources[1]!.buffer?.samples[0], 200 / 32768)
  } finally {
    value.disconnect()
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor)
    else Reflect.deleteProperty(globalThis, 'location')
    restore()
  }
})

function pcm(value: number): string {
  const samples = new Int16Array(240).fill(value)
  return Buffer.from(samples.buffer).toString('base64')
}

class FakeSource {
  buffer?: { duration: number; samples: Float32Array }
  onended?: () => void
  stopped = false
  connect() {}
  start() {}
  stop() { this.stopped = true; this.onended?.() }
  finish() { this.onended?.() }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state = 'running'
  currentTime = 0
  sampleRate = 48000
  destination = {}
  sources: FakeSource[] = []
  processor?: { onaudioprocess?: (event: { inputBuffer: { getChannelData(): Float32Array } }) => void; connect(): void; disconnect(): void }
  constructor() { FakeAudioContext.instances.push(this) }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const buffer = { duration: length / sampleRate, samples: new Float32Array(length), copyToChannel(value: Float32Array) { buffer.samples.set(value) } }
    return buffer
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source }
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createScriptProcessor() { return this.processor = { connect() {}, disconnect() {} } }
  async suspend() { this.state = 'suspended' }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
}

class FakeWebSocket extends EventTarget {
  static OPEN = 1
  static CONNECTING = 0
  static instances: FakeWebSocket[] = []
  readyState = 0
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  sent: unknown[] = []
  constructor(_url: string) { super(); FakeWebSocket.instances.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
  close() { this.readyState = 3; this.onclose?.() }
}

function audioGlobals(): () => void {
  const audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  FakeAudioContext.instances = []
  FakeWebSocket.instances = []
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket })
  return () => {
    if (audioDescriptor) Object.defineProperty(globalThis, 'AudioContext', audioDescriptor)
    else Reflect.deleteProperty(globalThis, 'AudioContext')
    if (socketDescriptor) Object.defineProperty(globalThis, 'WebSocket', socketDescriptor)
    else Reflect.deleteProperty(globalThis, 'WebSocket')
  }
}
