import { createServer } from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'
import { QwenSpeechProxy } from '../lib/host/qwen-speech-proxy.js'
import { decideTurn } from '../lib/host/turn-decision.js'

// Opt-in integration check: a short main-model answer is synthesized, then
// transcribed through the same local protocol adapters used by the browser.
const key = process.env.BAILIAN_TOKEN_PLAN_API_KEY
if (!key) throw new Error('Set BAILIAN_TOKEN_PLAN_API_KEY in .env.local')
const mainModel = process.env.DSH_VOICE_MAIN_MODEL ?? 'deepseek-v4.1-flash'
const localAsr = process.env.CHECK_ASR === 'local'
const requestStarted = Date.now()
const response = await fetch('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: mainModel, enable_thinking: false, messages: [{ role: 'user', content: '请只回复这一句话，不解释：你好，语音测试已经准备好了。' }], max_tokens: 512 }),
  signal: AbortSignal.timeout(30_000),
})
if (!response.ok) throw new Error(`Main model HTTP ${response.status}`)
const reply = await response.json()
const text = reply.choices?.[0]?.message?.content
if (typeof text !== 'string' || !text.trim() || text.length > 160) throw new Error('Main model returned no short spoken answer')
console.log(JSON.stringify({ check: 'main-model', model: mainModel, ms: Date.now() - requestStarted, text }))
const decision = await decideTurn({ transcript: '请告诉我明天北京的天气。', stableText: '请告诉我明天北京的天气。', revision: 1, isFinal: true, userSpeaking: false, assistantSpeaking: false, mainBusy: false, recentAssistantText: '' }, key, AbortSignal.timeout(10_000), { timeoutMs: 10_000 })
console.log(JSON.stringify({ check: 'decision', ...decision }))

const proxy = new QwenSpeechProxy(async service => service === 'token-plan' ? key : undefined)
const server = createServer()
server.on('upgrade', (req, socket, head) => {
  const kind = req.url?.includes('/tts/') ? 'tts' : 'asr'
  void proxy.handle(kind, req, socket, head)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port
const origin = `http://127.0.0.1:${port}`
const sockets = new Set()
try {
  const ttsStarted = Date.now()
  const pcm24 = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tts/qwen?service=token-plan`, { headers: { Origin: origin } })
    sockets.add(ws)
    const chunks = []
    let firstAudioMs
    const timer = setTimeout(() => { ws.close(); reject(new Error('TTS timeout')) }, 20_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: { mode: 'commit', voice: 'longanlingxin', response_format: 'pcm', sample_rate: 24000 } })))
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString())
      if (event.type === 'session.updated') {
        ws.send(JSON.stringify({ type: 'input_text_buffer.append', text }))
        ws.send(JSON.stringify({ type: 'input_text_buffer.commit' }))
      } else if (event.type === 'response.audio.delta') {
        firstAudioMs ??= Date.now() - ttsStarted
        chunks.push(Buffer.from(event.delta, 'base64'))
      } else if (event.type === 'response.done') {
        clearTimeout(timer); ws.close()
        const pcm = Buffer.concat(chunks)
        if (!pcm.length) { reject(new Error('TTS returned no PCM')); return }
        console.log(JSON.stringify({ check: 'tts-via-plugin', firstAudioMs, bytes: pcm.length }))
        resolve(pcm)
      } else if (event.type === 'error') {
        clearTimeout(timer); ws.close(); reject(new Error(event.error.message))
      }
    })
    ws.on('error', () => { clearTimeout(timer); reject(new Error('Local TTS connection failed')) })
  })
  // The fixture is synthetic speech, never microphone data. Nearest-sample
  // conversion is sufficient for this smoke check; browser capture resamples.
  const pcm16 = Buffer.alloc(Math.floor(pcm24.length / 3) * 2)
  for (let i = 0; i < pcm16.length / 2; i++) pcm16.writeInt16LE(pcm24.readInt16LE(Math.floor(i * 1.5) * 2), i * 2)
  const transcript = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/asr/qwen?service=token-plan${localAsr ? '&engine=local-sensevoice' : ''}`, { headers: { Origin: origin } })
    sockets.add(ws)
    const timer = setTimeout(() => { ws.close(); reject(new Error('ASR timeout')) }, 25_000)
    let previews = 0
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 700 } } })))
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString())
      if (event.type === 'session.updated') {
        void (async () => {
          const fixture = Buffer.concat([pcm16, Buffer.alloc(32_000)])
          for (let offset = 0; offset < fixture.length && ws.readyState === WebSocket.OPEN; offset += 3200) {
            ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: fixture.subarray(offset, offset + 3200).toString('base64') }))
            await new Promise(done => setTimeout(done, 100))
          }
        })()
      } else if (event.type === 'conversation.item.input_audio_transcription.text') previews++
      else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        clearTimeout(timer); ws.close()
        console.log(JSON.stringify({ check: 'asr-via-plugin', engine: localAsr ? 'local-sensevoice' : 'cloud', previews, transcript: event.transcript }))
        resolve(event.transcript)
      } else if (event.type === 'error') {
        clearTimeout(timer); ws.close(); reject(new Error(event.error.message))
      }
    })
    ws.on('error', () => { clearTimeout(timer); reject(new Error('Local ASR connection failed')) })
  })
  if (typeof transcript !== 'string' || !transcript.trim()) throw new Error('ASR returned no transcription')
} finally {
  for (const socket of sockets) socket.close()
  proxy.close()
  await new Promise(resolve => server.close(resolve))
}
