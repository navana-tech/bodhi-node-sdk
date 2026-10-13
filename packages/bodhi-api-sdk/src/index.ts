// SPDX-License-Identifier: Apache-2.0
//
// Bodhi (Navana Tech) Speech-to-Text and Text-to-Speech SDK for Node.js.
//
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { type RawData, WebSocket } from 'ws';

const TTS_DEFAULT_BASE_URL = 'https://tts.navana.ai';
const STT_DEFAULT_BASE_URL = 'wss://stt.navana.ai';
const TTS_SAMPLE_RATES = [8000, 16000, 24000];

const authHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'x-api-key': apiKey,
});
const toBuffer = (data: RawData): Buffer =>
  Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

export interface BodhiTTSConfig {
  /** Bodhi API key. Falls back to `$BODHI_API_KEY`. */
  apiKey?: string;
  /** Base URL of the deployment. Defaults to `https://tts.navana.ai`. */
  baseUrl?: string;
  /** Voice id. Defaults to `default_female`. */
  voice?: string;
  /** Language code: `hi`, `gu`, `en`, … Defaults to `hi`. */
  language?: string;
  /** Output rate in Hz: 8000, 16000 or 24000. Defaults to 24000. */
  sampleRate?: number;
  /** Use the distilled model where available. */
  useFast?: boolean;
  /** Flow-matching steps, 1–100. */
  numStep?: number;
  /** Classifier-free guidance. */
  guidanceScale?: number;
}

export interface TTSResult {
  /** Raw PCM16 audio, no container. */
  audio: Buffer;
  sampleRate: number;
  encoding: string;
  durationMs?: number;
}

export class BodhiTTS {
  #apiKey: string;
  #baseUrl: string;
  #cfg: Required<Pick<BodhiTTSConfig, 'voice' | 'language' | 'sampleRate'>> &
    Pick<BodhiTTSConfig, 'useFast' | 'numStep' | 'guidanceScale'>;

  constructor(config: BodhiTTSConfig = {}) {
    const apiKey = config.apiKey ?? process.env.BODHI_API_KEY;
    if (!apiKey) throw new Error('Bodhi API key is required: pass apiKey or set BODHI_API_KEY');
    this.#apiKey = apiKey;
    this.#baseUrl = (config.baseUrl ?? TTS_DEFAULT_BASE_URL).replace(/\/$/, '');
    const sampleRate = config.sampleRate ?? 24000;
    if (!TTS_SAMPLE_RATES.includes(sampleRate)) {
      throw new Error(`sampleRate must be one of ${TTS_SAMPLE_RATES.join('/')}, got ${sampleRate}`);
    }
    this.#cfg = {
      voice: config.voice ?? 'default_female',
      language: (config.language ?? 'hi').split('-')[0].toLowerCase(),
      sampleRate,
      useFast: config.useFast,
      numStep: config.numStep,
      guidanceScale: config.guidanceScale,
    };
  }

  #params(): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (this.#cfg.useFast) p.use_fast = true;
    if (this.#cfg.numStep != null) p.num_step = this.#cfg.numStep;
    if (this.#cfg.guidanceScale != null) p.guidance_scale = this.#cfg.guidanceScale;
    return p;
  }

  /** Synthesize a whole clip in one HTTP request. */
  async synthesize(text: string): Promise<TTSResult> {
    const res = await fetch(`${this.#baseUrl}/tts/bytes`, {
      method: 'POST',
      headers: { ...authHeaders(this.#apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        lang: this.#cfg.language,
        voice: this.#cfg.voice,
        output_format: `${this.#cfg.sampleRate}:pcm16`,
        ...this.#params(),
      }),
    });
    if (!res.ok) {
      throw new Error(`Bodhi TTS synthesis failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    const rate = parseInt(res.headers.get('X-Sample-Rate') ?? `${this.#cfg.sampleRate}`, 10);
    const dur = res.headers.get('X-Audio-Duration-Ms');
    return {
      audio,
      sampleRate: rate,
      encoding: res.headers.get('X-Encoding') ?? 'pcm16',
      durationMs: dur ? parseInt(dur, 10) : undefined,
    };
  }

  /** Synthesize over a websocket, yielding PCM16 audio chunks as they arrive. */
  async *stream(text: string): AsyncGenerator<Buffer, void, unknown> {
    const wsUrl = `${this.#baseUrl.replace(/^http/, 'ws')}/v1`;
    const ws = new WebSocket(wsUrl, { headers: authHeaders(this.#apiKey) });
    const chunks: Buffer[] = [];
    let done = false;
    let err: Error | null = null;
    let notify: (() => void) | null = null;
    const wake = () => {
      notify?.();
      notify = null;
    };

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
    });

    ws.send(
      JSON.stringify({
        type: 'hello',
        lang: this.#cfg.language,
        voice: this.#cfg.voice,
        output_format: `${this.#cfg.sampleRate}:pcm16`,
        ...this.#params(),
      }),
    );
    ws.send(JSON.stringify({ type: 'text', seq: 1, target_text: text }));
    ws.send(JSON.stringify({ type: 'end' }));

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        chunks.push(toBuffer(data));
        wake();
        return;
      }
      let msg: { type?: string; code?: string; message?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'done') {
        done = true;
        ws.close();
        wake();
      } else if (msg.type === 'error') {
        err = new Error(`Bodhi TTS error ${msg.code ?? ''}: ${msg.message ?? ''}`);
        ws.close();
        wake();
      }
    });
    ws.on('close', () => {
      done = true;
      wake();
    });
    ws.on('error', (e) => {
      err = e as Error;
      done = true;
      wake();
    });

    while (true) {
      if (err) throw err;
      if (chunks.length) {
        yield chunks.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((r) => {
        notify = r;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

export interface BodhiHotword {
  phrase: string;
  score?: number;
}

export interface BodhiSTTConfig {
  /** Bodhi API key. Falls back to `$BODHI_API_KEY`. */
  apiKey?: string;
  /** Websocket base URL. Defaults to `wss://stt.navana.ai`. */
  baseUrl?: string;
  /** Bodhi model name, e.g. `hi-general-v2-8khz`. */
  model?: string;
  /** Rate the audio you send is at, in Hz. */
  sampleRate?: number;
  /** Emit interim (partial) transcripts. Defaults to true. */
  interimResults?: boolean;
  /** Normalise numbers, dates and currency. */
  parseNumber?: boolean;
  /** Attach timing/confidence metadata. */
  aux?: boolean;
  hotwords?: BodhiHotword[];
  endpointSilenceDuration?: number;
}

export interface Transcript {
  type: 'partial' | 'complete';
  text: string;
  confidence?: number;
}

export interface BodhiSTTSession {
  on(event: 'transcript', listener: (t: Transcript) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'open', listener: () => void): this;
}

/** A live recognition session. Feed audio with `sendAudio`, finish with `end`. */
export class BodhiSTTSession extends EventEmitter {
  #ws: WebSocket;
  #ready = false;
  #pending: Buffer[] = [];

  constructor(ws: WebSocket, config: Record<string, unknown>) {
    super();
    this.#ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ config }));
      this.#ready = true;
      for (const b of this.#pending) ws.send(b);
      this.#pending = [];
      this.emit('open');
    });
    ws.on('message', (data: RawData) => {
      let msg: { type?: string; text?: string; error?: string; message?: string; segment_meta?: { confidence?: number } };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.error) {
        this.emit('error', new Error(`Bodhi error ${msg.error}: ${msg.message ?? ''}`));
        return;
      }
      if ((msg.type === 'partial' || msg.type === 'complete') && msg.text) {
        this.emit('transcript', {
          type: msg.type,
          text: msg.text.trim(),
          confidence: msg.segment_meta?.confidence,
        } satisfies Transcript);
      }
    });
    ws.on('close', () => this.emit('close'));
    ws.on('error', (err) => this.emit('error', err as Error));
  }

  /** Send a chunk of raw PCM16 audio at the configured sample rate. */
  sendAudio(pcm: Buffer): void {
    if (this.#ready && this.#ws.readyState === WebSocket.OPEN) this.#ws.send(pcm);
    else this.#pending.push(pcm);
  }

  /** Tell the server no more audio is coming, so it flushes a final transcript. */
  end(): void {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ eof: 1 }));
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      /* ignore */
    }
  }
}

export class BodhiSTT {
  #apiKey: string;
  #baseUrl: string;
  #config: BodhiSTTConfig;

  constructor(config: BodhiSTTConfig = {}) {
    const apiKey = config.apiKey ?? process.env.BODHI_API_KEY;
    if (!apiKey) throw new Error('Bodhi API key is required: pass apiKey or set BODHI_API_KEY');
    this.#apiKey = apiKey;
    this.#baseUrl = (config.baseUrl ?? STT_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.#config = config;
  }

  #buildConfig(): Record<string, unknown> {
    const c = this.#config;
    const config: Record<string, unknown> = {
      transaction_id: randomUUID(),
      model: c.model ?? 'hi-general-v2-8khz',
      sample_rate: c.sampleRate ?? 16000,
      channels: 1,
      parse_number: !!c.parseNumber,
      aux: !!c.aux,
      exclude_partial: c.interimResults === false,
    };
    if (c.hotwords?.length) {
      config.hotwords = c.hotwords.map((h) => (h.score == null ? { phrase: h.phrase } : { phrase: h.phrase, score: h.score }));
    }
    if (c.endpointSilenceDuration != null) config.endpoint_silence_duration = c.endpointSilenceDuration;
    return config;
  }

  /** Open a streaming recognition session. */
  stream(): BodhiSTTSession {
    const ws = new WebSocket(this.#baseUrl, { headers: authHeaders(this.#apiKey) });
    return new BodhiSTTSession(ws, this.#buildConfig());
  }

  /** Transcribe a complete PCM16 buffer and resolve with the final text. */
  async transcribe(pcm: Buffer): Promise<string> {
    const session = this.stream();
    const finals: string[] = [];
    return new Promise<string>((resolve, reject) => {
      session.on('transcript', (t) => {
        if (t.type === 'complete' && t.text) finals.push(t.text);
      });
      session.on('error', reject);
      session.on('close', () => resolve(finals.join(' ')));
      session.on('open', () => {
        const rate = this.#config.sampleRate ?? 16000;
        const step = rate * 2; // ~1s of PCM16
        for (let i = 0; i < pcm.length; i += step) session.sendAudio(pcm.subarray(i, i + step));
        session.end();
      });
    });
  }
}
