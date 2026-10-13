# bodhi-api-sdk (Node.js)

[Bodhi](https://www.navanatech.in/) (Navana Tech) Speech-to-Text and
Text-to-Speech SDK for Node.js. Framework-agnostic; for voice agents see the
`livekit-agents-plugin-bodhi` plugin.

## Install

```bash
npm install bodhi-api-sdk
```

## Text-to-speech

```ts
import { BodhiTTS } from 'bodhi-api-sdk';

const tts = new BodhiTTS({ language: 'hi', voice: 'default_female' }); // $BODHI_API_KEY

// one-shot
const { audio, sampleRate } = await tts.synthesize('नमस्ते');

// streaming (PCM16 chunks as they are produced)
for await (const chunk of tts.stream('नमस्ते')) {
  // play / forward `chunk`
}
```

## Speech-to-text

```ts
import { BodhiSTT } from 'bodhi-api-sdk';

const stt = new BodhiSTT({ model: 'hi-general-v2-8khz', sampleRate: 16000 });

// streaming
const session = stt.stream();
session.on('transcript', (t) => console.log(t.type, t.text));
session.sendAudio(pcm16Buffer);
session.end();

// one-shot buffer
const text = await stt.transcribe(pcm16Buffer);
```

Set `BODHI_API_KEY`, or pass `apiKey`. Defaults to the Navana prod hosts
(`wss://stt.navana.ai`, `https://tts.navana.ai`); pass `baseUrl` to override.

## License

Apache-2.0
