// SPDX-License-Identifier: Apache-2.0
//
// Bodhi (Navana Tech) plugin for LiveKit Node Agents.
//
import { Plugin } from '@livekit/agents';

export * from './tts.js';
export * from './stt.js';

declare const __PACKAGE_VERSION__: string;
declare const __PACKAGE_NAME__: string;

class BodhiPlugin extends Plugin {
  constructor() {
    super({
      title: 'bodhi',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new BodhiPlugin());
