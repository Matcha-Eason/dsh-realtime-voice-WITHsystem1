import assert from 'node:assert/strict'
import test from 'node:test'
import { extractVoiceSummary, VoiceSummaryStream } from '../src/client/voice-summary.ts'

test('speaks every paragraph as sentences arrive, without waiting for turn completion', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('天气晴朗。')
  assert.deepEqual(spoken, ['天气晴朗。'])
  for (const delta of ['出门不用带伞', '。\n', '\n晚上会降温。']) stream.push(delta)
  stream.finish('天气晴朗。出门不用带伞。\n\n晚上会降温。')
  assert.deepEqual(spoken, ['天气晴朗。', '出门不用带伞。', '晚上会降温。'])
})

test('flushes an unpunctuated ending exactly once and ignores late deltas', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('可以，已经处理好了')
  stream.finish('可以，已经处理好了')
  stream.finish('可以，已经处理好了')
  stream.push('迟到的文字。')
  assert.deepEqual(spoken, ['可以，已经处理好了'])
})

test('uses the completed answer when the transport provided no text deltas', () => {
  assert.equal(extractVoiceSummary('第一段。\n\n第二段没有句号'), '第一段。 第二段没有句号')
  const long = `${'这是完整回答的一部分。'.repeat(40)}最后一句。`
  assert.equal(extractVoiceSummary(long).replaceAll(' ', ''), long)
})

test('discards fenced code across arbitrary chunk boundaries and resumes following prose', () => {
  const response = '先安装依赖。\n```sh\necho "不能朗读！"\n```\n然后启动程序。\n~~~js\nthrow new Error("也不读。");\n~~~\n完成。'
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (const char of response) stream.push(char)
  stream.finish(response)
  assert.deepEqual(spoken, ['先安装依赖。', '然后启动程序。', '完成。'])
})

test('unfinished code and comments do not leak or reappear through final-text fallback', () => {
  assert.equal(extractVoiceSummary('```json\n{"result":"不朗读。"}'), '')
  assert.equal(extractVoiceSummary('<!-- 不朗读。'), '')
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('```json\n{"result":"不朗读。"}')
  stream.finish('```json\n{"result":"不朗读。"}')
  assert.deepEqual(spoken, [])
})

test('strips split comments, headings and link destinations while preserving their prose', () => {
  const response = '<!-- old marker -->\n# 配置方法\n1. 打开[设置](https://example.com/a?q=yes!#section)。\n- 选择 **语音模式**。\n<!-- /old marker -->后续内容。'
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (let i = 0; i < response.length; i += 2) stream.push(response.slice(i, i + 2))
  stream.finish(response)
  assert.deepEqual(spoken, ['配置方法', '打开设置。', '选择 语音模式。', '后续内容。'])
})

test('inline code keeps its text and English decimals survive split chunks', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (const delta of ['Use `foo_', 'bar` with 3.', '14. Then continue', '.']) stream.push(delta)
  stream.finish('')
  assert.deepEqual(spoken, ['Use foo_bar with 3.14.', 'Then continue.'])
})
