import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PREVIEW_PORT || 47831);
const origin = `http://127.0.0.1:${port}`;
async function available() {
  try {
    const response = await fetch(origin + '/preview-bridge.js', { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.text()).includes('window.harmonyPreview');
  } catch { return false; }
}
if (await available()) {
  console.log(`预览服务已在运行：${origin}`);
} else {
  const logs = join(project, 'test-results');
  mkdirSync(logs, { recursive: true });
  const out = openSync(join(logs, 'preview-service.log'), 'a');
  const err = openSync(join(logs, 'preview-service-error.log'), 'a');
  // Do not attach the preview lifetime to the calling terminal's stdio.
  const child = spawn(process.execPath, ['scripts/preview.mjs'], {
    cwd: project, detached: true, windowsHide: true, stdio: ['ignore', out, err],
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.unref(); closeSync(out); closeSync(err);
  let ready = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    if (await available()) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (ready) console.log(`预览服务已在后台启动：${origin}`);
  else { console.error('预览启动失败，请检查 test-results/preview-service-error.log'); process.exitCode = 1; }
}
