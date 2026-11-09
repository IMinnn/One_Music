export function parseLyrics(input = '') {
  const text = String(input).replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (all, dec, hex, name) => {
    const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : 0;
    if (dec || hex) return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name] ?? all;
  });
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d{2}(?:[.:]\d+)?)\]/g)];
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!words) continue;
    for (const stamp of stamps) lines.push({ time: Math.max(0, Number(stamp[1]) * 60 + Number(stamp[2].replace(':', '.')) - offset), text: words });
  }
  return lines.sort((a, b) => a.time - b.time);
}
