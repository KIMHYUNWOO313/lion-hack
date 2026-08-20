const TARGET_RATE = 24000;
const BATCH_SAMPLES = 2400;

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.boostGain = opts.boostGain ?? 1.0;
    this._buf = new Float32Array(0);
    this._ratio = sampleRate / TARGET_RATE;
    this._pcmQueue = new Float32Array(0);
  }

  _append(input) {
    const merged = new Float32Array(this._buf.length + input.length);
    merged.set(this._buf);
    merged.set(input, this._buf.length);
    this._buf = merged;
  }

  _rms(samples) {
    if (!samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  _downsample(input) {
    const ratio = this._ratio;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = input[idx] || 0;
      const s1 = input[Math.min(idx + 1, input.length - 1)] || s0;
      out[i] = s0 + (s1 - s0) * frac;
    }
    return out;
  }

  _emitBatch(batch) {
    const int16 = new Int16Array(batch.length);
    for (let i = 0; i < batch.length; i++) {
      const s = Math.max(-1, Math.min(1, batch[i] * this.boostGain));
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    const rms = this._rms(batch);
    this.port.postMessage({ audio: int16.buffer, level: rms }, [int16.buffer]);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    this._append(input);
    const need = Math.floor(BATCH_SAMPLES * this._ratio);

    while (this._buf.length >= need) {
      const chunk = this._buf.slice(0, need);
      this._buf = this._buf.slice(need);
      const pcm = this._downsample(chunk);

      const merged = new Float32Array(this._pcmQueue.length + pcm.length);
      merged.set(this._pcmQueue);
      merged.set(pcm, this._pcmQueue.length);
      this._pcmQueue = merged;

      while (this._pcmQueue.length >= BATCH_SAMPLES) {
        const batch = this._pcmQueue.slice(0, BATCH_SAMPLES);
        this._pcmQueue = this._pcmQueue.slice(BATCH_SAMPLES);
        this._emitBatch(batch);
      }
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
