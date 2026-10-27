/** Runs resampling and fixed 20 ms framing off the UI thread. No audio is stored. */
export const PCM_CAPTURE_WORKLET = String.raw`
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.ratio = sampleRate / 16000; this.weight = 0; this.sum = 0;
    this.frame = new Int16Array(320); this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      let remaining = 1;
      while (remaining > 1e-6) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take; this.weight += take; remaining -= take;
        if (this.weight >= this.ratio - 1e-6) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = 0; this.weight = 0;
          if (this.offset === this.frame.length) {
            this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
            this.frame = new Int16Array(320); this.offset = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('dsh-pcm-capture', PcmCapture);
`
