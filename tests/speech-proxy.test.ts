import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { QwenSpeechProxy, resolveQwenSpeechRoute, type QwenSpeechService } from '../src/host/qwen-speech-proxy.ts'
import { QwenHttpAsr, QwenInferenceTts, TOKEN_PLAN_ASR_ENDPOINT } from '../src/host/qwen-inference.ts'

test('Token Plan speech uses its fixed Beijing workspace and endpoint', () => {
  for (const kind of ['asr', 'tts'] as const) {
    const route = resolveQwenSpeechRoute(kind, new URLSearchParams())
    assert.equal(route.service, 'token-plan')
    assert.equal(route.workspaceId, 'token-plan')
    assert.equal(route.endpoint, kind === 'tts'
      ? 'wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference'
      : TOKEN_PLAN_ASR_ENDPOINT)
  }
})

test('pay-as-you-go speech requires explicit service and a real workspace', () => {
  const params = new URLSearchParams({ service: 'dashscope', workspaceId: 'workspace-test', region: 'ap-southeast-1' })
  assert.equal(resolveQwenSpeechRoute('asr', params).endpoint, 'wss://workspace-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime')
  assert.equal(resolveQwenSpeechRoute('tts', params).endpoint, 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime')
  for (const workspaceId of ['', 'token-plan', 'x.example.com']) {
    assert.throws(() => resolveQwenSpeechRoute('asr', new URLSearchParams({ service: 'dashscope', workspaceId })), /workspace/)
  }
})

test('route validation rejects account switching, unsupported service and incompatible models', () => {
  for (const input of [
    { service: 'other' }, { workspaceId: 'another-workspace' }, { region: 'ap-southeast-1' },
    { model: 'qwen3.8-omni-flash-realtime' }, { model: 'qwen3-tts-flash-realtime' },
    { model: 'qwen3-asr-flash-realtime' }, { model: 'https://example.com' },
  ]) assert.throws(() => resolveQwenSpeechRoute('asr', new URLSearchParams(input)))
  assert.throws(() => resolveQwenSpeechRoute('tts', new URLSearchParams({ model: 'qwen3-tts-flash-realtime' })), /unsupported Token Plan speech model/)
})

test('inference TTS synthesizes only committed main-model text and maps binary audio', () => {
  const sent: Record<string, any>[] = []
  const emitted: Record<string, any>[] = []
  const tts = new QwenInferenceTts('qwen-audio-3.0-tts-plus', event => sent.push(event), event => emitted.push(event))
  tts.open()
  tts.client({ type: 'session.update', session: { voice: 'longanlingxin', mode: 'commit', response_format: 'pcm', sample_rate: 24000 } })
  assert.deepEqual(emitted.map(event => event.type), ['session.created', 'session.updated'])
  assert.equal(sent.length, 0, 'no idle task starts while the user is speaking')
  tts.client({ type: 'input_text_buffer.append', text: '这是主模型已经写好的回答。' })
  tts.client({ type: 'input_text_buffer.commit' })
  const run = sent[0]!
  assert.equal(run.payload.model, 'qwen-audio-3.0-tts-plus')
  assert.equal(run.payload.parameters.voice, 'longanlingxin')
  assert.equal(run.payload.parameters.format, 'pcm')
  assert.equal(run.payload.parameters.sample_rate, 24000)
  assert.deepEqual(run.payload.input, {})
  const taskId = run.header.task_id
  const provider = (event: string, id = taskId) => tts.upstream(Buffer.from(JSON.stringify({ header: { event, task_id: id } })), false)
  provider('task-started', 'unrelated')
  assert.equal(sent.length, 1)
  provider('task-started')
  assert.deepEqual(sent[1]?.payload.input, { text: '这是主模型已经写好的回答。' })
  assert.equal(sent[2]?.header.action, 'finish-task')
  const pcm = Buffer.from([0, 1, 2, 3])
  tts.upstream(pcm, true)
  assert.deepEqual(emitted.at(-1), { type: 'response.audio.delta', delta: pcm.toString('base64') })
  provider('task-finished')
  assert.equal(emitted.at(-1)?.type, 'response.done')
  tts.client({ type: 'input_text_buffer.append', text: '下一句。' })
  tts.client({ type: 'input_text_buffer.commit' })
  assert.notEqual(sent.at(-1)?.header.task_id, taskId)
})

test('TTS cancellation discards late audio and errors omit provider diagnostics', () => {
  const sent: Record<string, any>[] = []
  const emitted: Record<string, any>[] = []
  const tts = new QwenInferenceTts('qwen-audio-3.0-tts-plus', event => sent.push(event), event => emitted.push(event))
  tts.client({ type: 'session.update', session: { voice: 'longanlingxin', mode: 'commit', response_format: 'pcm', sample_rate: 24000 } })
  tts.client({ type: 'input_text_buffer.append', text: '待取消的语音。' })
  tts.client({ type: 'input_text_buffer.commit' })
  const taskId = sent[0]!.header.task_id
  tts.upstream(Buffer.from(JSON.stringify({ header: { event: 'task-started', task_id: taskId } })), false)
  tts.client({ type: 'session.finish' })
  assert.deepEqual(sent.at(-1)?.payload.input, { directive: 'cancel' })
  const count = emitted.length
  tts.upstream(Buffer.from([1, 2]), true)
  assert.equal(emitted.length, count)
  tts.client({ type: 'input_text_buffer.append', text: '再次测试。' })
  tts.client({ type: 'input_text_buffer.commit' })
  tts.upstream(Buffer.from(JSON.stringify({ header: { event: 'task-failed', task_id: sent.at(-1)!.header.task_id, error_message: 'secret-provider-body' } })), false)
  assert.deepEqual(emitted.at(-1), { type: 'error', error: { message: 'Qwen TTS synthesis failed' } })
})

test('HTTP ASR pauses locally before recognition and prioritizes the final segment over stale previews', async () => {
  const emitted: Record<string, any>[] = []
  const responses: Array<(value: Response) => void> = []
  const bodies: Record<string, any>[] = []
  const asr = new QwenHttpAsr('qwen-audio-3.0-asr-flash', 'fake-key', event => emitted.push(event), async (url, init) => {
    assert.equal(url, TOKEN_PLAN_ASR_ENDPOINT)
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return await new Promise(resolve => responses.push(resolve))
  })
  asr.client({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 200 } } })
  const voiced = Buffer.alloc(3200)
  for (let offset = 0; offset < voiced.length; offset += 2) voiced.writeInt16LE(3000, offset)
  const append = (pcm: Buffer) => asr.client({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
  append(voiced)
  assert.equal(emitted.at(-1)?.type, 'input_audio_buffer.speech_started')
  assert.equal(bodies.length, 0, 'local speech detection does not wait for HTTP')
  for (let count = 0; count < 9; count++) append(voiced)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0]!.model, 'qwen-audio-3.0-asr-flash')
  const uri = bodies[0]!.input.messages[0].content[0].input_audio.data as string
  const wav = Buffer.from(uri.split(',')[1]!, 'base64')
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.length, 32044)
  append(Buffer.alloc(3200)); append(Buffer.alloc(3200))
  assert.equal(emitted.at(-1)?.type, 'input_audio_buffer.speech_stopped')
  responses[0]!(new Response(JSON.stringify({ output: { text: '过时预览' } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bodies.length, 2)
  assert.equal(emitted.some(event => event.text === '过时预览'), false)
  responses[1]!(new Response(JSON.stringify({ output: { text: '帮我查看这个文件。' } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(emitted.at(-1)?.type, 'conversation.item.input_audio_transcription.completed')
  assert.equal(emitted.at(-1)?.transcript, '帮我查看这个文件。')
  assert.equal(emitted.at(-1)?.item_id, emitted[1]?.item_id)
  asr.close()
})

test('HTTP ASR stops on provider failure and never exposes a raw response', async () => {
  const emitted: Record<string, any>[] = []
  let calls = 0
  const asr = new QwenHttpAsr('qwen-audio-3.0-asr-flash', 'fake-key', event => emitted.push(event), async () => {
    calls++
    return new Response('sensitive provider body', { status: 401 })
  })
  asr.client({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 200 } } })
  const pcm = Buffer.alloc(32000)
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(3000, offset)
  const input = { type: 'input_audio_buffer.append', audio: pcm.toString('base64') }
  asr.client(input)
  asr.client(input)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(emitted.at(-1), { type: 'error', error: { message: 'ASR recognition failed' } })
  asr.client(input)
  assert.equal(calls, 1)
})

test('HTTP ASR treats only the observed 400 empty-object response as no speech and keeps listening', async () => {
  const emitted: Record<string, any>[] = []
  let calls = 0
  const asr = new QwenHttpAsr('qwen-audio-3.0-asr-flash', 'fake-key', event => emitted.push(event), async () => {
    calls++
    if (calls === 1) return new Response('{}', { status: 400 })
    return new Response(JSON.stringify({ text: '这次有人说话。' }))
  })
  asr.client({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 6000 } } })
  assert.equal(emitted.at(-1)?.type, 'session.updated', 'the UI maximum is accepted')
  asr.client({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 200 } } })
  const voiced = Buffer.alloc(3200)
  for (let offset = 0; offset < voiced.length; offset += 2) voiced.writeInt16LE(3000, offset)
  for (let turn = 0; turn < 2; turn++) {
    asr.client({ type: 'input_audio_buffer.append', audio: voiced.toString('base64') })
    asr.client({ type: 'input_audio_buffer.append', audio: Buffer.alloc(6400).toString('base64') })
    await new Promise(resolve => setImmediate(resolve))
  }
  const finals = emitted.filter(event => event.type === 'conversation.item.input_audio_transcription.completed')
  assert.deepEqual(finals.map(event => event.transcript), ['', '这次有人说话。'])
  assert.equal(emitted.some(event => event.type === 'error'), false)
  assert.equal(calls, 2)
  asr.close()
})

test('HTTP ASR does not hide other 400 responses as silence', async () => {
  for (const body of ['[]', 'null', '{"code":"InvalidParameter","message":"private details"}']) {
    const emitted: Record<string, any>[] = []
    const asr = new QwenHttpAsr('qwen-audio-3.0-asr-flash', 'fake-key', event => emitted.push(event), async () => new Response(body, { status: 400 }))
    asr.client({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 200 } } })
    const pcm = Buffer.alloc(3200)
    for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(3000, offset)
    asr.client({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
    asr.client({ type: 'input_audio_buffer.append', audio: Buffer.alloc(6400).toString('base64') })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(emitted.at(-1), { type: 'error', error: { message: 'ASR recognition failed' } })
  }
})

test('closing HTTP ASR aborts its live request and ignores late results', async () => {
  let requestSignal: AbortSignal | undefined
  const emitted: Record<string, any>[] = []
  const asr = new QwenHttpAsr('qwen-audio-3.0-asr-flash', 'fake-key', event => emitted.push(event), async (_url, init) => {
    requestSignal = init?.signal as AbortSignal
    return await new Promise((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true }))
  })
  asr.client({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 200 } } })
  const pcm = Buffer.alloc(32000)
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(3000, offset)
  asr.client({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
  asr.client({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
  assert.ok(requestSignal)
  asr.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requestSignal.aborted, true)
  assert.equal(emitted.some(event => event.type === 'error'), false)
})

test('local Token Plan ASR socket uses HTTP recognition and the selected credential', async () => {
  const services: QwenSpeechService[] = []
  let requested = false
  const proxy = new QwenSpeechProxy(async service => { services.push(service); return 'fake-token-plan-key' },
    () => { throw new Error('HTTP ASR must not open an upstream WebSocket') },
    async (_url, init) => {
      requested = true
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fake-token-plan-key')
      return new Response(JSON.stringify({ output: { text: '测试本地语音代理。' } }))
    })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void proxy.handle('asr', req, socket, head) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/asr?service=token-plan`)
  try {
    await once(client, 'open')
    const ready = once(client, 'message')
    client.send(JSON.stringify({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 200 } } }))
    assert.equal(JSON.parse((await ready)[0].toString()).type, 'session.updated')
    const completed = new Promise<Record<string, any>>(resolve => client.on('message', data => {
      const event = JSON.parse(data.toString())
      if (event.type === 'conversation.item.input_audio_transcription.completed') resolve(event)
    }))
    const voiced = Buffer.alloc(3200)
    for (let offset = 0; offset < voiced.length; offset += 2) voiced.writeInt16LE(3000, offset)
    client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: voiced.toString('base64') }))
    client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(6400).toString('base64') }))
    assert.equal((await completed).transcript, '测试本地语音代理。')
    assert.equal(requested, true)
    assert.deepEqual(services, ['token-plan'])
  } finally {
    client.terminate()
    proxy.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('local proxy resolves the selected credential and forwards text and audio unchanged', async () => {
  const upstreamServer = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(upstreamServer, 'listening')
  const upstreamAddress = upstreamServer.address()
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object')
  const services: QwenSpeechService[] = []
  let requestedEndpoint = ''
  let authorization: string | undefined
  let upstreamClient: WebSocket | undefined
  upstreamServer.on('connection', (socket, req) => {
    authorization = req.headers.authorization
    socket.on('message', (data, binary) => socket.send(data, { binary }))
  })
  const proxy = new QwenSpeechProxy(async service => { services.push(service); return 'fake-test-token' }, (endpoint, options) => {
    requestedEndpoint = endpoint
    upstreamClient = new WebSocket(`ws://127.0.0.1:${upstreamAddress.port}`, options)
    return upstreamClient
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void proxy.handle('asr', req, socket, head) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/asr?service=dashscope&workspaceId=workspace-test`)
  try {
    await once(client, 'open')
    const textMessage = once(client, 'message')
    client.send('{"type":"input_audio_buffer.append","audio":"AA=="}')
    const [text, textBinary] = await textMessage
    assert.equal(text.toString(), '{"type":"input_audio_buffer.append","audio":"AA=="}')
    assert.equal(textBinary, false)
    const binaryMessage = once(client, 'message')
    client.send(Buffer.from([0, 1, 2, 255]))
    const [audio, binary] = await binaryMessage
    assert.deepEqual(audio, Buffer.from([0, 1, 2, 255]))
    assert.equal(binary, true)
    assert.deepEqual(services, ['dashscope'])
    assert.equal(authorization, 'Bearer fake-test-token')
    assert.match(requestedEndpoint, /^wss:\/\/workspace-test\.cn-beijing\.maas\.aliyuncs\.com\//)
    const failed = once(client, 'message')
    upstreamClient?.emit('error', new Error('sensitive upstream diagnostic fake-test-token'))
    const [failure] = await failed
    assert.equal(JSON.parse(failure.toString()).error.message, 'Qwen ASR connection unavailable')
  } finally {
    client.terminate()
    proxy.close()
    for (const socket of upstreamServer.clients) socket.terminate()
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => upstreamServer.close(() => resolve()))])
  }
})

test('final ASR aborts an obsolete preview immediately and starts its own request', async () => {
  const events: Record<string, any>[] = []
  let count = 0
  let previewSignal: AbortSignal | undefined
  const asr = new QwenHttpAsr('qwen-audio-3.0-asr-flash', 'fake', event => events.push(event), async (_url, init) => {
    count++
    if (count === 1) {
      previewSignal = init!.signal as AbortSignal
      return await new Promise((_resolve, reject) => previewSignal!.addEventListener('abort', () => reject(previewSignal!.reason), { once: true }))
    }
    return new Response(JSON.stringify({ text: '完整的用户请求。' }))
  })
  asr.client({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 400 } } })
  const speech = Buffer.alloc(32000)
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(3000, i)
  for (let i = 0; i < speech.length; i += 3200) asr.client({ type: 'input_audio_buffer.append', audio: speech.subarray(i, i + 3200).toString('base64') })
  asr.client({ type: 'input_audio_buffer.append', audio: Buffer.alloc(12800).toString('base64') })
  assert.equal(previewSignal?.aborted, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(count, 2)
  assert.equal(events.at(-1)?.transcript, '完整的用户请求。')
  assert.equal(events.some(event => event.type === 'error'), false)
  asr.close()
})

test('local ASR websocket never resolves credentials or calls cloud recognition', async () => {
  let prepared = 0, recognized = 0
  const proxy = new QwenSpeechProxy(
    async () => { throw new Error('Local ASR must not request cloud credentials') },
    () => { throw new Error('Local ASR must not connect to cloud') },
    async () => { throw new Error('Local ASR must not use HTTP') },
    { async prepare() { prepared++ }, async recognize(pcm, signal) { recognized++; assert.equal(signal.aborted, false); assert.ok(pcm.length); return '本地识别成功。' } },
  )
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void proxy.handle('asr', req, socket, head) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/asr?engine=local-sensevoice`)
  try {
    await once(client, 'open')
    const ready = once(client, 'message')
    client.send(JSON.stringify({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { silence_duration_ms: 400 } } }))
    await ready
    const final = new Promise<Record<string, any>>(resolve => client.on('message', data => { const event = JSON.parse(data.toString()); if (event.transcript) resolve(event) }))
    const pcm = Buffer.alloc(3200)
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(3000, i)
    client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }))
    client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(12800).toString('base64') }))
    assert.equal((await final).transcript, '本地识别成功。')
    assert.equal(prepared, 1); assert.equal(recognized, 1)
  } finally { client.close(); proxy.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
