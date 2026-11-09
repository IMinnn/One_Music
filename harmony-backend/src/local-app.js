import { createAppCore } from './app-core.js';

export function createApp(options) {
  return createAppCore({ ...options, origin: '', production: false, secure: false });
}
