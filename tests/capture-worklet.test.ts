import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { PCM_CAPTURE_WORKLET } from '../src/client/capture-worklet.ts'

function capture(rate: number, blocks: Float32Array[]) {
  const frames: Int16Array[] = []
  let Processor: new () => { process(inputs: Float32Array[][]): boolean }
  runInNewContext(PCM_CAPTURE_WORKLET, {
    sampleRate: rate,
    AudioWorkletProcessor: class { port = { postMessage: (buffer: ArrayBuffer) => frames.push(new Int16Array(buffer)) } },
    registerProcessor(_name: string, value: typeof Processor) { Processor = value },
  })
  const processor = new Processor!()
  for (const block of blocks) assert.equal(processor.process([[block]]), true)
  return frames
}

test('20 ms capture frames preserve samples and time at 44.1 kHz and 48 kHz', () => {
  for (const rate of [44100, 48000]) {
    const input = new Float32Array(rate).fill(.25)
    const blocks: Float32Array[] = []
    for (let i = 0; i < input.length; i += 128) blocks.push(input.subarray(i, i + 128))
    const frames = capture(rate, blocks)
    assert.equal(frames.length, 50)
    assert.equal(frames.every(frame => frame.length === 320), true)
    assert.equal(frames.every(frame => frame.every(sample => sample === 8192)), true)
  }
})

test('resampling phase survives render boundaries without dropped or duplicated samples', () => {
  const input = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 30) * .8)
  const blocks: Float32Array[] = []
  for (let i = 0; i < input.length; i += 137) blocks.push(input.subarray(i, i + 137))
  assert.deepEqual(capture(44100, blocks), capture(44100, [input]))
})
