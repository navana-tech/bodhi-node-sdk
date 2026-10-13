// SPDX-License-Identifier: Apache-2.0
//
// Bodhi (Navana Tech) Speech-to-Text for LiveKit Node Agents.
//
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  mergeFrames,
  normalizeLanguage,
  shortuuid,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'wss://stt.navana.ai';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_MODEL = 'hi-general-v2-8khz';
const DEFAULT_MIN_CONFIDENCE = 0.5;

export interface BodhiHotword {
  phrase: string;
  score?: number;
}

export interface STTOptions {
  /** Bodhi API key. Falls back to `$BODHI_API_KEY`. */
  apiKey?: string;
  /** Websocket base URL of the deployment. Defaults to `wss://stt.navana.ai`. */
  baseUrl: string;
  /** Bodhi model name, e.g. `hi-general-v2-8khz`. */
  model: string;
  /** Language tag for transcripts. Defaults to the model prefix. */
  language?: string;
  /** Rate audio is sent at; the pipeline audio is resampled to it. */
  sampleRate: number;
  /** Emit interim (partial) transcripts. */
  interimResults: boolean;
  /** Normalise numbers, dates and currency. */
  parseNumber?: boolean;
  /** Attach timing/confidence metadata (needed for minConfidence). */
  aux?: boolean;
  /** Drop finals below this confidence; 0 keeps everything. */
  minConfidence: number;
  /** Phrase boosting. */
  hotwords?: BodhiHotword[];
  /** Trailing silence (seconds) before an utterance is finalised. */
  endpointSilenceDuration?: number;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.BODHI_API_KEY,
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  sampleRate: DEFAULT_SAMPLE_RATE,
  interimResults: true,
  minConfidence: DEFAULT_MIN_CONFIDENCE,
};

const langFromModel = (model: string) => model.split('-', 1)[0].toLowerCase();
const authHeaders = (apiKey: string): Record<string, string> => ({
  'x-api-key': apiKey,
  Authorization: `Bearer ${apiKey}`,
});

const buildConfig = (o: STTOptions): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    transaction_id: randomUUID(),
    model: o.model,
    sample_rate: o.sampleRate,
    channels: 1,
    parse_number: !!o.parseNumber,
    aux: !!o.aux,
    exclude_partial: !o.interimResults,
  };
  if (o.hotwords?.length) {
    config.hotwords = o.hotwords.map((h) => (h.score == null ? { phrase: h.phrase } : { phrase: h.phrase, score: h.score }));
  }
  if (o.endpointSilenceDuration != null) config.endpoint_silence_duration = o.endpointSilenceDuration;
  return { config };
};

const toArrayBuffer = (data: RawData): ArrayBuffer => {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const frameBytes = (frame: AudioFrame): Buffer => {
  const d = frame.data; // Int16Array
  return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
};

interface BodhiMessage {
  type?: string;
  text?: string;
  error?: string;
  message?: string;
  segment_meta?: { confidence?: number };
}

export class STT extends stt.STT {
  label = 'bodhi.STT';
  #opts: STTOptions;

  constructor(opts: Partial<STTOptions> = {}) {
    const resolved: STTOptions = { ...defaultSTTOptions, ...opts };
    super({ streaming: true, interimResults: resolved.interimResults });
    if (!resolved.apiKey) {
      throw new Error('Bodhi API key is required: pass apiKey or set BODHI_API_KEY');
    }
    resolved.language = resolved.language ?? langFromModel(resolved.model);
    this.#opts = resolved;
  }

  get opts(): STTOptions {
    return this.#opts;
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };
    if (opts.model && !opts.language) this.#opts.language = langFromModel(opts.model);
  }

  belowMinConfidence(content: BodhiMessage): boolean {
    if (this.#opts.minConfidence <= 0) return false;
    const c = content.segment_meta?.confidence;
    return c != null && c < this.#opts.minConfidence;
  }

  protected async _recognize(buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const requestId = shortuuid();
    const finals: stt.SpeechData[] = [];

    const ws = new WebSocket(this.#opts.baseUrl, { headers: authHeaders(this.#opts.apiKey!) });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(new APIConnectionError({ message: `Bodhi STT connect failed: ${err.message}` })));
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data: RawData) => {
        let msg: BodhiMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.error) {
          reject(new APIStatusError({ message: `Bodhi error ${msg.error}: ${msg.message ?? ''}`, options: { statusCode: -1, requestId } }));
          return;
        }
        if (msg.type === 'complete' && !this.belowMinConfidence(msg)) {
          const d = speechDataFor(this.#opts, msg);
          if (d.text) finals.push(d);
        }
      });
      ws.on('close', () => resolve());
      ws.on('error', (err) => reject(new APIConnectionError({ message: `Bodhi STT socket error: ${err.message}` })));

      ws.send(JSON.stringify(buildConfig(this.#opts)));
      const bytes = frameBytes(frame);
      const step = this.#opts.sampleRate * 2; // ~1s of PCM16
      for (let i = 0; i < bytes.length; i += step) ws.send(bytes.subarray(i, i + step));
      ws.send(JSON.stringify({ eof: 1 }));
    });

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId,
      alternatives: finals.length
        ? (finals as [stt.SpeechData, ...stt.SpeechData[]])
        : [{ language: normalizeLanguage(this.#opts.language!), text: "", startTime: 0, endTime: 0, confidence: 1 }],
    };
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS);
  }
}

export class SpeechStream extends stt.SpeechStream {
  label = 'bodhi.SpeechStream';
  #opts: STTOptions;
  #bodhi: STT;
  #speaking = false;
  #logger = log();

  constructor(sttEngine: STT, opts: STTOptions, connOptions: APIConnectOptions) {
    super(sttEngine, opts.sampleRate, connOptions);
    this.#bodhi = sttEngine;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    let closing = false;

    const ws = new WebSocket(this.#opts.baseUrl, { headers: authHeaders(this.#opts.apiKey!) });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(new APIConnectionError({ message: `Bodhi STT connect failed: ${err.message}` })));
    });
    ws.send(JSON.stringify(buildConfig(this.#opts)));

    const sendTask = async () => {
      const bstream = new AudioByteStream(this.#opts.sampleRate, 1, Math.floor(this.#opts.sampleRate / 10));
      for await (const data of this.input) {
        if (data === SpeechStream.FLUSH_SENTINEL) {
          for (const frame of bstream.flush()) ws.send(frameBytes(frame));
          continue;
        }
        for (const frame of bstream.write(toArrayBuffer(frameBytes(data as AudioFrame)))) ws.send(frameBytes(frame));
      }
      closing = true;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ eof: 1 }));
    };

    const recvTask = () =>
      new Promise<void>((resolve, reject) => {
        ws.on('message', (data: RawData) => {
          let msg: BodhiMessage;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (msg.error) {
            reject(new APIStatusError({ message: `Bodhi error ${msg.error}: ${msg.message ?? ''}`, options: { statusCode: -1, requestId } }));
            return;
          }
          const text = (msg.text ?? '').trim();
          if (!text) return;

          if (!this.#speaking) {
            this.#speaking = true;
            this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
          }

          if (msg.type === 'complete') {
            if (this.#bodhi.belowMinConfidence(msg)) return;
            this.queue.put({
              type: stt.SpeechEventType.FINAL_TRANSCRIPT,
              requestId,
              alternatives: [speechDataFor(this.#opts, msg)],
            });
            if (this.#speaking) {
              this.#speaking = false;
              this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
            }
          } else if (msg.type === 'partial' && this.#opts.interimResults) {
            this.queue.put({
              type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
              requestId,
              alternatives: [speechDataFor(this.#opts, msg)],
            });
          }
        });
        ws.on('close', () => {
          if (closing) resolve();
          else reject(new APIConnectionError({ message: 'Bodhi STT connection closed unexpectedly' }));
        });
        ws.on('error', (err) => reject(new APIConnectionError({ message: `Bodhi STT socket error: ${err.message}` })));
      });

    try {
      await Promise.all([sendTask(), recvTask()]);
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }
}

function speechDataFor(opts: STTOptions, content: BodhiMessage): stt.SpeechData {
  const confidence = content.segment_meta?.confidence;
  return {
    language: normalizeLanguage(opts.language ?? langFromModel(opts.model)),
    text: (content.text ?? '').trim(),
    startTime: 0,
    endTime: 0,
    confidence: confidence == null ? 1.0 : confidence,
  };
}
