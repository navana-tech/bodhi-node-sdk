# bodhi-node-sdk

Node.js SDK and integrations for [Bodhi](https://www.navanatech.in/) (Navana Tech)
Speech-to-Text and Text-to-Speech.

## Packages

| Package | npm | Description |
| --- | --- | --- |
| [`bodhi-api-sdk`](packages/bodhi-api-sdk) | [`bodhi-api-sdk`](https://www.npmjs.com/package/bodhi-api-sdk) | Framework-agnostic Bodhi STT/TTS client (`BodhiTTS`, `BodhiSTT`). |
| [`livekit-agents-plugin-bodhi`](packages/livekit-agents-plugin-bodhi) | [`livekit-agents-plugin-bodhi`](https://www.npmjs.com/package/livekit-agents-plugin-bodhi) | Bodhi STT/TTS plugin for LiveKit Node Agents (`bodhi.STT`, `bodhi.TTS`). |

Each package builds independently with `npm install && npm run build`.

See the Python counterparts in
[`bodhi-python-sdk`](https://github.com/navana-tech/bodhi-python-sdk).

## License

Apache-2.0
