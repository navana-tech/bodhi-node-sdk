import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { BodhiSTT } from '../dist/index.js';

test('sends the end marker after audio queued before the websocket opens', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const messages = [];
  let resolveMessages;
  const receivedThreeMessages = new Promise((resolve) => {
    resolveMessages = resolve;
  });

  server.once('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      messages.push({ data: Buffer.from(data), isBinary });
      if (messages.length === 3) resolveMessages();
    });
  });

  const session = new BodhiSTT({ apiKey: 'dummy-key', baseUrl: `ws://127.0.0.1:${port}` }).stream();
  t.after(() => new Promise((resolve, reject) => {
    session.close();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const audio = Buffer.from([1, 2, 3, 4]);
  session.sendAudio(audio);
  session.end();

  const timedOut = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), 1000);
    receivedThreeMessages.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  assert.equal(timedOut, false, `expected config, audio, and end messages; received ${messages.length}`);
  assert.equal(messages[0].isBinary, false);
  assert.equal(JSON.parse(messages[0].data.toString()).config.model, 'hi-general-v2-8khz');
  assert.equal(messages[1].isBinary, true);
  assert.deepEqual(messages[1].data, audio);
  assert.deepEqual(JSON.parse(messages[2].data.toString()), { eof: 1 });
});
