# livekit-agents-plugin-bodhi

[Bodhi](https://www.navanatech.in/) (Navana Tech) speech-to-text and text-to-speech
for [LiveKit Node Agents](https://docs.livekit.io/agents/), exposed as standard
`STT` and `TTS` providers.

## Install

```bash
pnpm add livekit-agents-plugin-bodhi
# peers: @livekit/agents, @livekit/rtc-node
```

## Usage

```ts
import { voice } from '@livekit/agents';
import * as bodhi from 'livekit-agents-plugin-bodhi';
import * as silero from '@livekit/agents-plugin-silero';

const session = new voice.AgentSession({
  stt: new bodhi.STT({ model: 'hi-general-v2-8khz', sampleRate: 8000 }),
  vad: await silero.VAD.load(),
  // llm: ...,
  tts: new bodhi.TTS({ language: 'hi', voice: 'default_female' }),
});
```

Set `BODHI_API_KEY` in the environment, or pass `apiKey` to either class. Both
default to the Navana production hosts (`wss://stt.navana.ai`,
`https://tts.navana.ai`); pass `baseUrl` to target another deployment.

## STT options

`apiKey`, `baseUrl`, `model`, `language`, `sampleRate`, `interimResults`,
`parseNumber`, `aux`, `minConfidence`, `hotwords` (`{ phrase, score? }[]`),
`endpointSilenceDuration`.

Partial transcripts arrive as `INTERIM_TRANSCRIPT` events and endpointed finals
as `FINAL_TRANSCRIPT`.

## TTS options

`apiKey`, `baseUrl`, `voice`, `language` (`hi`, `gu`, `en`, …), `sampleRate`
(8000/16000/24000), `useFast`, `numStep`, `guidanceScale`.

Audio streams out as `SynthesizedAudio` frames; an interruption cancels the
utterance in progress.

## License

Apache-2.0
