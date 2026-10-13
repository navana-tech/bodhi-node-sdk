// SPDX-License-Identifier: Apache-2.0
//
// Bodhi (Navana Tech) Text-to-Speech for LiveKit Node Agents.
//
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  shortuuid,
  tts,
} from '@livekit/agents';
import { type RawData, WebSocket } from 'ws';

const NUM_CHANNELS = 1;
const DEFAULT_BASE_URL = 'https://tts.navana.ai';
const SAMPLE_RATES = [8000, 16000, 24000];

export interface TTSOptions {
  /** Bodhi API key. Falls back to `$BODHI_API_KEY`. */
  apiKey?: string;
  /** Base URL of the Bodhi TTS deployment. Defaults to `https://tts.navana.ai`. */
  baseUrl: string;
  /** Voice id for the language. Defaults to `default_female`. */
  voice: string;
  /** Language code: `hi`, `gu`, `en`, … Defaults to `hi`. */
  language: string;
  /** Output rate in Hz: 8000, 16000 or 24000. Defaults to 24000. */
  sampleRate: number;
  /** Use the distilled model where available. */
  useFast?: boolean;
  /** Flow-matching steps, 1–100. */
  numStep?: number;
  /** Classifier-free guidance. */
  guidanceScale?: number;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.BODHI_API_KEY,
  baseUrl: DEFAULT_BASE_URL,
  voice: 'default_female',
  language: 'hi',
  sampleRate: 24000,
};

const normalizeLang = (l: string) => l.split('-')[0].toLowerCase();
const authHeaders = (apiKey: string): Record<string, string> => ({
  // JWT hosts read Authorization; bd_ key hosts read either.
  Authorization: `Bearer ${apiKey}`,
  'x-api-key': apiKey,
});
const httpUrl = (baseUrl: string) => `${baseUrl.replace(/\/$/, '')}/tts/bytes`;
const wsUrl = (baseUrl: string) => `${baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/v1`;

const toArrayBuffer = (data: RawData): ArrayBuffer => {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const buildParams = (o: TTSOptions): Record<string, unknown> => {
  const p: Record<string, unknown> = {};
  if (o.useFast) p.use_fast = true;
  if (o.numStep != null) p.num_step = o.numStep;
  if (o.guidanceScale != null) p.guidance_scale = o.guidanceScale;
  return p;
};

export class TTS extends tts.TTS {
  label = 'bodhi.TTS';
  #opts: TTSOptions;

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolved: TTSOptions = { ...defaultTTSOptions, ...opts };
    super(resolved.sampleRate, NUM_CHANNELS, { streaming: true });
    if (!SAMPLE_RATES.includes(resolved.sampleRate)) {
      throw new Error(`sampleRate must be one of ${SAMPLE_RATES.join('/')}, got ${resolved.sampleRate}`);
    }
    if (!resolved.apiKey) {
      throw new Error('Bodhi API key is required: pass apiKey or set BODHI_API_KEY');
    }
    resolved.language = normalizeLang(resolved.language);
    this.#opts = resolved;
  }

  get opts(): TTSOptions {
    return this.#opts;
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };
    if (opts.language) this.#opts.language = normalizeLang(opts.language);
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'bodhi.ChunkedStream';
  #opts: TTSOptions;
  #text: string;

  constructor(
    ttsEngine: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsEngine, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const body = {
      text: this.#text,
      lang: this.#opts.language,
      voice: this.#opts.voice,
      output_format: `${this.#opts.sampleRate}:pcm16`,
      ...buildParams(this.#opts),
    };

    let res: Response;
    try {
      res = await fetch(httpUrl(this.#opts.baseUrl), {
        method: 'POST',
        headers: { ...authHeaders(this.#opts.apiKey!), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortSignal,
      });
    } catch (e) {
      throw new APIConnectionError({ message: `Bodhi TTS request failed: ${(e as Error).message}` });
    }
    if (!res.ok) {
      throw new APIStatusError({
        message: `Bodhi TTS synthesis failed (${res.status})`,
        options: { statusCode: res.status, requestId },
      });
    }

    const audio = Buffer.from(await res.arrayBuffer());
    const abuf = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    for (const frame of bstream.write(abuf)) {
      this.queue.put({ requestId, frame, final: false, segmentId: requestId });
    }
    for (const frame of bstream.flush()) {
      this.queue.put({ requestId, frame, final: false, segmentId: requestId });
    }
    this.queue.close();
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'bodhi.SynthesizeStream';
  #opts: TTSOptions;
  #logger = log();

  constructor(ttsEngine: TTS, opts: TTSOptions, connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) {
    super(ttsEngine, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    let seq = 0;
    let closedByServer = false;

    // Hold back one frame so the genuinely last frame of the segment can carry
    // `final: true`, as the base class expects.
    let pending: import('@livekit/rtc-node').AudioFrame | null = null;
    const pushFrame = (frame: import('@livekit/rtc-node').AudioFrame) => {
      if (pending) this.queue.put({ requestId, frame: pending, final: false, segmentId: requestId });
      pending = frame;
    };
    const finishSegment = () => {
      if (pending) {
        this.queue.put({ requestId, frame: pending, final: true, segmentId: requestId });
        pending = null;
      }
    };

    const ws = new WebSocket(wsUrl(this.#opts.baseUrl), { headers: authHeaders(this.#opts.apiKey!) });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(new APIConnectionError({ message: `Bodhi TTS connect failed: ${err.message}` })));
    });

    // hello/ready handshake
    ws.send(JSON.stringify({
      type: 'hello',
      lang: this.#opts.language,
      voice: this.#opts.voice || 'default_female',
      output_format: `${this.#opts.sampleRate}:pcm16`,
      ...buildParams(this.#opts),
    }));

    const sendTask = async () => {
      let buffer = '';
      const flushBuffer = () => {
        const text = buffer.trim();
        buffer = '';
        if (!text) return;
        seq += 1;
        this.markStarted();
        ws.send(JSON.stringify({ type: 'text', seq, target_text: text }));
      };
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          flushBuffer();
        } else {
          buffer += data;
        }
      }
      flushBuffer();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
    };

    const recvTask = () =>
      new Promise<void>((resolve, reject) => {
        ws.on('message', (data: RawData, isBinary: boolean) => {
          if (isBinary) {
            for (const frame of bstream.write(toArrayBuffer(data))) pushFrame(frame);
            return;
          }
          let msg: { type?: string; code?: string; message?: string };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (msg.type === 'done') {
            for (const frame of bstream.flush()) pushFrame(frame);
            finishSegment();
            this.queue.put(SynthesizeStream.END_OF_STREAM);
            closedByServer = true;
            ws.close();
          } else if (msg.type === 'error') {
            reject(new APIStatusError({
              message: `Bodhi TTS error ${msg.code ?? ''}: ${msg.message ?? ''}`,
              options: { statusCode: -1, requestId },
            }));
          }
          // msg.type === 'ready' and the per-chunk 'audio' header need no action.
        });
        ws.on('close', () => {
          if (closedByServer) resolve();
          else reject(new APIConnectionError({ message: 'Bodhi TTS connection closed unexpectedly' }));
        });
        ws.on('error', (err) => reject(new APIConnectionError({ message: `Bodhi TTS socket error: ${err.message}` })));
      });

    try {
      await Promise.all([sendTask(), recvTask()]);
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }
}
