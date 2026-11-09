import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../web/icon.svg', import.meta.url));
const output = fileURLToPath(new URL('../desktop/icon-mac.png', import.meta.url));

execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', '1024', '1024', source, '--out', output], {
  stdio: 'inherit',
});
