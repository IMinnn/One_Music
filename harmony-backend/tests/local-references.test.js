import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
test('local reference registration is metadata-only, idempotent and account isolated', async () => {
 const f=await fixture();
 try {
  const a=f.client(),b=f.client(); await a.register('referencea');await b.register('referenceb');
  const input={tracks:[{referenceId:'file-local-test',title:'本地音乐'}]};
  const first=await a.request('/tracks/references','POST',input);
  assert.equal(first.status,200); assert.equal(first.data.tracks[0].canPlay,false);
  assert.equal(first.data.tracks[0].providerId,'file-local-test');
  assert.equal((await a.request('/tracks/references','POST',input)).data.tracks[0].id,first.data.tracks[0].id);
  assert.notEqual((await b.request('/tracks/references','POST',input)).data.tracks[0].id,first.data.tracks[0].id);
  assert.equal((await a.request('/tracks/references','POST',{tracks:[{referenceId:'../private.mp3',title:'bad'}]})).status,400);
  assert.equal((await a.request('/tracks/references','POST',{tracks:[]})).status,400);
  const row=f.app.db.prepare('SELECT * FROM tracks WHERE id=?').get(first.data.tracks[0].id);
  assert.equal(row.file_name,null); assert.equal(row.bytes,0);
 }finally{await f.close();}
});
