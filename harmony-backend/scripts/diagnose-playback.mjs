// Temporary read-only diagnosis; never logs credentials, signed URLs or personal profile values.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { QQProvider } from '../src/providers/qq.js';
import { safeMediaUrl, request } from '../src/providers/http.js';
const dir = process.env.HARMONY_DIAGNOSTIC_DATA_DIR, username = process.env.HARMONY_DIAGNOSTIC_USER;
if (!dir || !username) throw new Error('Explicit account and data directory required');
const db = new DatabaseSync(join(dir, 'harmony.sqlite'), { readOnly: true });
const row = db.prepare("SELECT c.* FROM provider_connections c JOIN users u ON u.id=c.user_id WHERE c.provider='qq' AND u.username=?").get(username);
if (!row) throw new Error('Saved QQ connection missing');
const recent = db.prepare("SELECT t.provider_id FROM recent_tracks r JOIN tracks t ON t.id=r.track_id WHERE r.user_id=? AND t.provider='qq' ORDER BY r.played_at DESC LIMIT 2").all(row.user_id);
const liked = db.prepare("SELECT t.provider_id FROM playlists p JOIN playlist_tracks pt ON pt.playlist_id=p.id JOIN tracks t ON t.id=pt.track_id WHERE p.user_id=? AND p.source='qq' AND p.name='我喜欢' ORDER BY pt.position LIMIT 3").all(row.user_id);
db.close();
const bytes = Buffer.from(row.credential, 'base64'), d = createDecipheriv('aes-256-gcm', readFileSync(join(dir, 'platform.key')), bytes.subarray(0, 12));
d.setAAD(Buffer.from(row.user_id + ':' + row.provider)); d.setAuthTag(bytes.subarray(12, 28));
const credential = JSON.parse(Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString());
const p = new QQProvider(), original = p.music.bind(p);
p.music = async (...args) => {
  const data = await original(...args);
  console.log(JSON.stringify({ method: args[1], streams: data.midurlinfo?.map(info => ({ hasUrl: Boolean(info.purl), trial: info.freeTrialInfo ?? null, result: info.result, needBuy: info.pneedbuy, needVip: info.pneed, bought: info.isbuy, fileType: info.purl?.split('?')[0].split('.').at(-1) })) }));
  return data;
};
let index = 0;
for (const id of new Set([...recent, ...liked].map(t => t.provider_id))) {
  try {
    const media = await p.playback(credential, id);
    console.log(JSON.stringify({ index, mediaHost: new URL(media).hostname }));
    let url = safeMediaUrl(media);
    let response;
    for (let i = 0; i < 4; i++) {
      response = await request(url, { headers: { Range: 'bytes=0-1023' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { const next = response.headers.get('location'); await response.body?.cancel(); url = safeMediaUrl(new URL(next, url).href); }
      else break;
    }
    console.log(JSON.stringify({ index, ok: true, mediaStatus: response.status, type: response.headers.get('content-type'), range: response.headers.get('content-range') }));
    await response.body?.cancel();
  } catch (e) { console.log(JSON.stringify({ index, ok: false, code: e.code, message: e.message })); }
  try {
    const standard = await original('music.vkey.GetVkey', 'UrlGetVkey', { uin: credential.musicid, guid: '1234567890', filename: [`M500${id}${id}.mp3`], songmid: [id], songtype: [0], ctx: 0 }, credential, { ct: 19 });
    console.log(JSON.stringify({ index, standardMp3: standard.midurlinfo?.map(info => ({ result: info.result, hasUrl: Boolean(info.purl), needVip: info.pneed, needBuy: info.pneedbuy })) }));
  } catch (error) { console.log(JSON.stringify({ index, standardError: error.message })); }
  index++;
}
