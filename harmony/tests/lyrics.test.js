import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLyrics } from '../web/lyrics.js';

test('歌词解析支持多时间标签、毫秒、偏移和转义', () => {
  assert.deepEqual(parseLyrics('[offset:500]\n[00:01.50][00:03.00]A &amp; B\n[ar:艺人]\n[00:05:20]末句'), [
    { time: 1, text: 'A & B' }, { time: 2.5, text: 'A & B' }, { time: 4.7, text: '末句' },
  ]);
  assert.equal(parseLyrics('纯音乐')[0], undefined);
});
