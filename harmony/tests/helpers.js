import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from 'harmony-backend';

export function wav(seconds = 1) {
  const samples = Math.round(8000 * seconds), bytes = samples * 2, data = Buffer.alloc(44 + bytes);
  data.write('RIFF'); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 8000) * 800), 44 + i * 2);
  return data;
}
export async function fixture(options = {}) {
  const root = resolve(tmpdir()), dir = await mkdtemp(join(root, 'harmony-test-'));
  let app = createApp({ webDir: resolve('web'), dataDir: dir, ...options }), url = await app.listen(0);
  function client() {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path, method = 'GET', data, extra = {}) {
        const response = await fetch(url + '/api' + path, { method,
          headers: { Origin: url, Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
          ...(data === undefined ? {} : { body: Buffer.isBuffer(data) ? data : JSON.stringify(data) }) });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
        return { status: response.status, data: result, headers: response.headers };
      },
      register(username = 'listener', password = 'correct horse battery') { return this.request('/auth/register', 'POST', { username, password }); },
      login(username = 'listener', password = 'correct horse battery') { return this.request('/auth/login', 'POST', { username, password }); },
      import(name = '测试音乐.wav', bytes = wav()) { return this.request('/tracks/import?name=' + encodeURIComponent(name), 'POST', bytes, { 'Content-Type': 'application/octet-stream' }); },
    };
  }
  return { get app() { return app; }, get url() { return url; }, dir, client,
    async restart() { await app.close(); app = createApp({ webDir: resolve('web'), dataDir: dir, ...options }); url = await app.listen(0); },
    async close() {
      await app.close();
      if (!resolve(dir).startsWith(root + '\\') && !resolve(dir).startsWith(root + '/')) throw new Error('Unsafe test cleanup');
      if (!dir.includes('harmony-test-')) throw new Error('Unsafe test cleanup');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
