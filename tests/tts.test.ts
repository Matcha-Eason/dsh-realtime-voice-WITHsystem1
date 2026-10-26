import assert from 'node:assert/strict'
import test from 'node:test'
import { isLikelyTtsEcho, QwenPipelineConnection, splitForTts } from '../src/client/qwen-pipeline.ts'
import type { VoicePrefs } from '../src/client/prefs.ts'

test('TTS chunks remove code and remain below the weighted limit', () => {
  const chunks = splitForTts(`<!-- /voice-summary -->这是最终答案。\n\`\`\`json\n{"private":"tool payload"}\n\`\`\`\n更多说明：${'很长的中文句子。'.repeat(180)}`, 200)
  assert.equal(chunks.some(chunk => chunk.includes('tool payload')), false)
  assert.equal(chunks.some(chunk => /voice|summary|<!--|-->/i.test(chunk)), false)
  assert.equal(chunks.every(chunk => weighted(chunk) <= 200), true)
  assert.match(chunks.join(''), /这是最终答案/)
})

function weighted(text: string): number {
  let value = 0
  for (const char of text) value += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 2 : 1
  return value
}

test('TTS echo is rejected while distinct speech remains distinct', () => {
  const speech = '今天天气晴朗，最高温度二十八度，出门不用带伞。'
  assert.equal(isLikelyTtsEcho('今天天气晴朗，最高温度二十八度。', speech), true)
  assert.equal(isLikelyTtsEcho('天气晴朗最高温度二十八度', speech), true)
  assert.equal(isLikelyTtsEcho('帮我打开音乐播放器', speech), false)
  assert.equal(isLikelyTtsEcho('停止', speech), false)
})

test('TTS rechecks the speech generation between text chunks', async () => {
  const originalWebSocket = globalThis.WebSocket
  class WebSocketState { static readonly OPEN = 1 }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: WebSocketState })
  try {
    const connection = new QwenPipelineConnection(prefs(), { onState() {} })
    const internals = connection as unknown as {
      tts?: WebSocket
      ttsReady?: Promise<void>
      handleTts(raw: unknown): void
    }
    let commits = 0
    internals.tts = {
      readyState: WebSocketState.OPEN,
      close() {},
      send(raw: string) {
        const event = JSON.parse(raw) as { type?: string }
        if (event.type !== 'input_text_buffer.commit') return
        commits++
        internals.handleTts(JSON.stringify({ type: 'response.done' }))
        if (commits === 1) connection.cancelSpeech()
      },
    } as WebSocket
    internals.ttsReady = Promise.resolve()

    await assert.rejects(connection.speak('很长的中文句子。'.repeat(180)), /语音已被替换/)
    assert.equal(commits, 1)
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket })
  }
})

function prefs(): VoicePrefs {
  return {
    provider: 'qwen',
    qwenWorkspaceId: 'ws_123',
    qwenRegion: 'cn-beijing',
    qwenModel: 'qwen3.5-omni-plus-realtime',
    qwenVoice: 'Tina',
    qwenAsrModel: 'qwen3-asr-flash-realtime',
    qwenTtsModel: 'qwen3-tts-flash-realtime',
    qwenTtsVoice: 'Chelsie',
    qwenVadThreshold: 0.85,
    qwenSilenceMs: 700,
    qwenMergeMs: 1200,
    voiceDraftAutoSend: true,
    voiceDraftDwellMs: 1800,
    voiceDraftAllowWithoutVoiceprint: false,
    voiceDraftSensitiveDeny: true,
    floorDelayMs: 800,
    floorComposerEnabled: true,
    qwenFloorModel: 'qwen3.5-flash',
    openaiFloorModel: 'gpt-5-mini',
    voiceprintEnabled: false,
    voiceprintThreshold: 75,
    openaiModel: 'gpt-realtime-2.1',
    openaiVoice: 'marin',
    instructions: '',
  }
}
