const supportedLocalFile = name => /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(name);
const desktop = () => window.harmonyDesktop?.listLocalFiles ? window.harmonyDesktop : null;
let database;
async function db() {
  return database ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('harmony-local-references', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function localReferences() {
  if (desktop()) return desktop().listLocalFiles();
  const database = await db();
  return new Promise((resolve, reject) => {
    const r = database.transaction('files').objectStore('files').getAll();
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function selectLocalReferences(kind) {
  if (desktop()) return desktop().pickLocalFiles(kind);
  const handles = [];
  if (kind === 'folder' && window.showDirectoryPicker) {
    const root = await window.showDirectoryPicker();
    async function walk(dir, prefix) {
      for await (const handle of dir.values()) {
        if (handle.kind === 'directory') await walk(handle, prefix + handle.name + '/');
        else if (supportedLocalFile(handle.name)) handles.push({ handle, path: prefix + handle.name });
      }
    }
    await walk(root, root.name + '/');
  } else if (kind !== 'folder' && window.showOpenFilePicker) {
    for (const handle of await window.showOpenFilePicker({ multiple: true, types: [{ description: '音频文件', accept: { 'audio/*': ['.mp3','.wav','.flac','.ogg','.m4a','.aac'] } }] })) {
      if (supportedLocalFile(handle.name)) handles.push({ handle, path: handle.name });
    }
  } else return undefined;
  const records = await localReferences();
  for (const value of handles) {
    let exists = false;
    for (const record of records) if (await record.handle.isSameEntry(value.handle)) { exists = true; break; }
    if (!exists) records.push({ ...value, id: 'file-' + crypto.randomUUID(), name: value.handle.name });
  }
  const database = await db();
  await new Promise((resolve, reject) => {
    const tx = database.transaction('files', 'readwrite');
    for (const record of records) tx.objectStore('files').put(record);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  return records;
}
async function readLocalReference(record) {
  if (desktop()) return new Blob([await desktop().readLocalFile(record.id)]);
  if (record.handle) {
    if (await record.handle.queryPermission({ mode: 'read' }) !== 'granted' && await record.handle.requestPermission({ mode: 'read' }) !== 'granted') throw new Error('请授权读取原音乐文件');
    try { return await record.handle.getFile(); } catch { throw new Error('原文件已移动、删除或无法读取，请重新选择文件'); }
  }
  return record.file;
}

import { parseLyrics } from './lyrics.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  home: '<path d="m3 10 9-7 9 7v10H15v-7H9v7H3z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  music: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
  playlist: '<path d="M4 6h16M4 11h16M4 16h8m5-1v6m-3-3h6"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>',
  next: '<path d="m5 5 10 7-10 7zM17 5h2v14h-2z" fill="currentColor" stroke="none"/>',
  previous: '<path d="m19 5-10 7 10 7zM5 5h2v14H5z" fill="currentColor" stroke="none"/>',
  shuffle: '<path d="M3 5h3c4 0 8 14 12 14h3m-4-4 4 4-4 3M3 19h3c2 0 4-3 5-5m3-4c1-3 2-5 4-5h3m-4-3 4 3-4 4"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/>',
  volume: '<path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  queue: '<path d="M4 5h16M4 10h16M4 15h8m3-1 6 4-6 4z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  cloud: '<path d="M7 18a6 6 0 1 1 1-12 7 7 0 0 1 13 4 4 4 0 0 1-1 8z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  edit: '<path d="m16 3 5 5-13 13H3v-5zM13 6l5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  up: '<path d="m5 15 7-7 7 7"/>', down: '<path d="m5 9 7 7 7-7"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.music}</svg>`;
const ib = (name, label, action, id = '', extra = '') => `<button class="icon-button" aria-label="${esc(label)}" title="${esc(label)}" data-action="${action}" data-id="${esc(id)}" ${extra}>${icon(name)}</button>`;
const audio = $('audio');
let user = null, library = { tracks: [], playlists: [], favorites: [], recent: [], providers: [] };
let libraryTab = 'own';
let playlistQuery = '', playlistSearchCollapsed = new Set();
let trackListQuery = '', trackListPlatform = 'all';
let page = 'home', playlistId = '', query = '', filter = 'all', authMode = 'login', epoch = 0;
let currentId = '', queue = [], playbackMode = 0, toastTimer;
let playbackGeneration = 0, playbackFailure = null;
let qrActive = null, qrTimer = null, qrGeneration = 0, searchGeneration = 0, remoteResults = [], searchErrors = [], searchBusy = false;
let searchPages = {};
let theme = 'light';
let collectionLoading = false, collectionLoadEpoch = -1, collectionErrors = [];
let searchTimer, composing = false, dragItem = null, suppressPlaylistClick = false;
let lyricId = '', lyricLines = [], lyricMessage = '选择一首歌，开始聆听', lyricIndex = -1, desktopLyrics = false;
let downloads = [];
const openedFiles = new Map(), fileFavorites = new Set(), favoriteBusy = new Set();
let continuingTrack = null;
const selectedTracks = new Set();
let selectionAnchor = '', displayedTracks = [], selectionBusy = false, favoritesSnapshot = null;
const failedTracks = new Set();
let pendingSeek = null, lastPlaybackSave = 0;
const defaultShortcuts = { 'toggle-play': 'Space', previous: 'Alt+ArrowLeft', next: 'Alt+ArrowRight', search: 'Ctrl+K', 'new-list': 'Ctrl+N' };
let shortcuts = { ...defaultShortcuts }, closeAction = 'tray';
try { closeAction = localStorage.getItem('harmony-close-action') || 'tray'; } catch {}
try { shortcuts = { ...defaultShortcuts, ...JSON.parse(localStorage.getItem('harmony-shortcuts') || '{}') }; } catch {}
function playbackKey() { return user ? `harmony-playback-${user.id}` : ''; }
function savePlayback() {
  if (!user || !currentId) return;
  const state = { id: currentId, queue, position: pendingSeek ?? (audio.currentTime || 0), mode: playbackMode, volume: audio.volume };
  if (window.harmonyDesktop?.savePlayback) window.harmonyDesktop.savePlayback(playbackKey(), state);
  else try { localStorage.setItem(playbackKey(), JSON.stringify(state)); } catch {}
}
async function restorePlayback() {
  try {
    const saved = window.harmonyDesktop?.getPlayback ? await window.harmonyDesktop.getPlayback(playbackKey()) : JSON.parse(localStorage.getItem(playbackKey()) || 'null');
    if (!saved || !track(saved.id) || !Array.isArray(saved.queue)) return;
    queue = [...new Set(saved.queue.filter(id => typeof id === 'string' && track(id)))];
    currentId = saved.id;
    if (!queue.includes(currentId)) queue.unshift(currentId);
    playbackMode = [0, 1, 2].includes(saved.mode) ? saved.mode : 0;
    pendingSeek = Number.isFinite(saved.position) ? Math.max(0, saved.position) : 0;
    audio.volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : .7;
    $('volume').value = audio.volume;
    if (!track(currentId).localReference) audio.src = `/api/tracks/${currentId}/audio`;
    renderPlayer(); renderContent();
  } catch {}
}
function applyPendingSeek() {
  if (pendingSeek === null || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.min(pendingSeek, Math.max(0, audio.duration - .05));
  pendingSeek = null;
}
function shortcutValue(event) {
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key].filter(Boolean).join('+');
}
function platformLogo(source) {
  const label = provider(source);
  if (source === 'local') return `<span class="source-logo local-logo" role="img" aria-label="${label}" title="${label}">${icon('music')}</span>`;
  const art = source === 'qq'
    ? '<path d="M42.667 516.693A469.333 469.333 0 1 0 512 52.053a469.333 469.333 0 0 0-469.333 464.64z" fill="#F8C913"/><path d="M654.933 12.373a217.173 217.173 0 0 1-105.386 49.494 409.6 409.6 0 0 0-128 39.68 184.747 184.747 0 0 0-42.667 29.866c-20.053 17.494-34.987 49.494-30.293 59.734s50.346 72.106 107.946 154.026S569.6 504.32 581.973 521.387a269.227 269.227 0 0 1 20.054 32.426c0 2.56-10.24 0-20.054-2.56A256 256 0 0 0 421.547 576a260.267 260.267 0 0 0-97.707 96.853 170.667 170.667 0 0 0-7.68 131.84 183.893 183.893 0 0 0 90.453 94.294 146.347 146.347 0 0 0 82.774 20.053 221.867 221.867 0 0 0 75.093-5.12 216.32 216.32 0 0 0 165.547-183.893c2.56-47.36-2.56-62.294-65.28-170.667-97.707-170.667-185.6-322.987-185.6-325.547l40.106-5.12a165.973 165.973 0 0 0 145.494-85.333c12.373-22.187 12.373-29.867 12.373-77.227A221.44 221.44 0 0 0 672 6.4c-2.133-8.96-4.267-6.4-17.067 5.973z" fill="#02B053"/>'
    : '<path d="M512 32c265.12 0 480 214.88 480 480 0 265.088-214.88 480-480 480-265.088 0-480-214.912-480-480C32 246.848 246.912 32 512 32z m82.08 173.568c-51.84 17.152-76.736 65.44-61.856 120.32l5.344 20.192c-11.2 2.432-22.208 5.696-32.928 9.824-50.656 19.52-90.848 62.816-104.896 113.024a153.696 153.696 0 0 0-5.088 55.04 137.92 137.92 0 0 0 57.536 100.576 121.504 121.504 0 0 0 103.264 17.6 120.96 120.96 0 0 0 63.68-42.56c24.736-32.288 32.096-74.752 20.8-119.52-4.16-16.32-9.344-34.368-14.4-51.904l-5.376-18.976c21.44 5.376 41.184 16.032 57.44 31.04 56 52.288 66.784 142.368 25.088 209.536-36.608 59.008-107.936 97.088-181.664 97.088a225.76 225.76 0 0 1-225.536-225.472c0-28.992 5.696-57.696 16.832-84.448a221.664 221.664 0 0 1 41.856-65.6 223.712 223.712 0 0 1 81.408-56.416A31.712 31.712 0 0 0 412.064 256a299.52 299.52 0 0 0-25.696 11.808 289.504 289.504 0 0 0-100 86.432 286.56 286.56 0 0 0-54.304 167.136c0 159.296 129.6 288.896 288.96 288.896 95.2 0 187.648-49.856 235.552-127.072 58.304-93.888 43.232-215.584-35.712-289.344-32.32-30.208-74.368-47.872-118.784-51.776-2.304-8.96-5.888-22.592-8.64-32.832-2.08-7.584-3.104-16.16-0.864-23.808a31.808 31.808 0 0 1 38.4-21.44c4.416 1.184 8.608 3.264 12.256 6.048 3.84 2.88 6.848 6.624 10.368 9.888a31.744 31.744 0 0 0 49.856-37.664l-0.64-1.056a65.312 65.312 0 0 0-14.4-16.448 100.48 100.48 0 0 0-53.376-23.392 96.128 96.128 0 0 0-40.96 4.224z m-40.224 201.92c3.36 12.416 7.04 25.344 10.752 38.176 4.928 17.28 9.888 34.432 13.824 49.92 4.576 18.176 6.624 44.192-9.664 65.472a57.056 57.056 0 0 1-30.24 19.936 58.464 58.464 0 0 1-50.144-8.544 73.92 73.92 0 0 1-30.528-53.952 89.6 89.6 0 0 1 2.944-32.416c8.8-31.36 34.304-58.528 66.624-71.008 8.672-3.36 17.536-5.856 26.432-7.584z" fill="#d81e06"/>';
  return `<svg class="source-logo" viewBox="0 0 1024 1024" role="img" aria-label="${label}"><title>${label}</title>${art}</svg>`;
}
function favoriteButton(t) {
  const liked = library.favorites.includes(t.id);
  return ib('heart', liked ? '取消喜欢' : '喜欢这首歌', 'favorite', t.id, `aria-pressed="${liked}"`);
}
async function storedTrackIds(ids) {
  const references = ids.filter(id => openedFiles.has(id));
  const mapped = new Map();
  for (let offset = 0; offset < references.length; offset += 100) {
    const chunk = references.slice(offset, offset + 100);
    const result = await api('/tracks/references', 'POST', { tracks: chunk.map(id => ({ referenceId: id, title: track(id).title })) });
    result.tracks.forEach(t => mapped.set(t.providerId, t.id));
  }
  return ids.map(id => mapped.get(id) || id);
}
async function toggleFavorite(id, value = !library.favorites.includes(id)) {
  if (favoriteBusy.has(id)) return;
  favoriteBusy.add(id);
  try {
    if (continuingTrack?.id === id && !openedFiles.has(id)) return toast('这首歌来自本地模式，请在账号中搜索后收藏');
    const [storedId] = await storedTrackIds([id]);
    await api(`/tracks/${storedId}/favorite`, 'PUT', { favorite: value });
    if (openedFiles.has(id)) { if (value) fileFavorites.add(id); else fileFavorites.delete(id); }
    await refresh(false);
    library.favorites = value ? [...new Set([...library.favorites, id])] : library.favorites.filter(x => x !== id);
    renderNav();
    document.querySelectorAll('[data-action="favorite"]').forEach(button => {
      const liked = library.favorites.includes(button.dataset.id);
      button.setAttribute('aria-pressed', liked);
      button.setAttribute('aria-label', liked ? '取消喜欢' : '喜欢这首歌');
      button.title = liked ? '取消喜欢' : '喜欢这首歌';
    });
  } finally { favoriteBusy.delete(id); }
}
function accountLogin() {
  modal('登录和音账号', `<p class="dialog-description">登录后显示账号歌单，当前音乐会继续播放。</p><form id="account-login-form"><label for="account-username">用户名</label><input id="account-username" autocomplete="username" required maxlength="32"><label for="account-password">密码</label><input id="account-password" type="password" autocomplete="current-password" required minlength="8" maxlength="128"><div id="dialog-error" class="form-error" role="alert"></div><div class="dialog-footer"><button type="button" class="btn" data-action="close-dialog">取消</button><button type="submit" class="btn primary">登录</button></div></form>`);
}

function layout() { return library.playlistLayout || {}; }
async function saveLayout(value, message = user?.local ? '歌单顺序已保存在本地' : '歌单顺序已保存到账号') {
  const result = await api('/playlist-layout', 'PUT', { collapsed: layout().collapsed || [], ...value, version: layout().version || 0 });
  library.playlistLayout = result.playlistLayout; renderNav(); toast(message);
}
function orderedGroups() {
  const order = layout().groups || [];
  return ['own', 'qq', 'netease'].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
}
function orderedLists(source) {
  const order = layout().lists?.[source] || [];
  return library.playlists.filter(p => p.source === source).sort((a, b) => (order.indexOf(a.id) < 0 ? 9999 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 9999 : order.indexOf(b.id)));
}
function trackCover(t) {
  return `<div class="mini-cover default-cover">${icon('music')}${t?.coverUrl ? `<img src="${esc(t.coverUrl)}" alt="${esc(t.title)}封面" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>`;
}
document.addEventListener('error', event => { if (event.target.matches?.('.mini-cover img,.playlist-art')) event.target.remove(); }, true);
try { theme = localStorage.getItem('harmony-theme') || 'light'; } catch {}
document.documentElement.dataset.theme = theme;
audio.volume = 0.7;
const track = id => library.tracks.find(t => t.id === id);
function collectionTracks() {
  const ids = new Set(library.collectionTrackIds || library.playlists.flatMap(p => p.trackIds || []));
  library.favorites.forEach(id => ids.add(id));
  const registeredReferences = new Set(library.tracks.filter(t => t.provider === 'local' && t.providerId?.startsWith('file-')).map(t => t.providerId));
  return library.tracks.filter(t => !registeredReferences.has(t.id) && !(continuingTrack?.id === t.id && !openedFiles.has(t.id)) && (ids.has(t.id) || t.provider === 'local' || openedFiles.has(t.id)));
}
async function loadCollection() {
  if (collectionLoadEpoch === epoch) return;
  const expected = epoch;
  collectionLoadEpoch = expected; collectionLoading = true; collectionErrors = []; renderContent();
  try {
    const result = await api('/library/aggregate', 'POST', {});
    if (expected !== epoch || !user) return;
    collectionErrors = result.errors;
    await refresh(false);
  } catch (error) { if (expected === epoch) collectionErrors = [{ provider: '音乐平台', message: error.message }]; }
  finally {
    if (expected === epoch) {
      collectionLoadEpoch = -1; collectionLoading = false; renderNav();
      if (page === 'tracks') renderContent();
    }
  }
}
const list = id => library.playlists.find(p => p.id === id);
const size = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
const time = value => { const v = Number.isFinite(value) ? Math.floor(value) : 0; return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };
const provider = name => ({ local: '本地', qq: 'QQ 音乐', netease: '网易云音乐' }[name] || name);

function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}
function syncStatus(text, error = false) {
  $('sync-state').classList.toggle('error', error);
  $('sync-state').replaceChildren(Object.assign(document.createElement('i'), {}), document.createTextNode(text));
}
async function api(path, method = 'GET', data, signal) {
  const requestEpoch = epoch;
  let response;
  try {
    response = await fetch('/api' + path, { method, credentials: 'same-origin', signal,
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  } catch {
    if (signal?.aborted) throw new Error('等待软件服务响应超时，请重试');
    syncStatus('连接中断，操作未保存', true); throw new Error(signal ? '无法连接软件服务，请检查网络后重试' : '连接暂时不可用，请稍后重试');
  }
  const result = await response.json().catch(error => {
    if (!signal) throw error;
    if (signal.aborted) throw new Error('等待软件服务响应超时，请重试');
    throw new Error('软件服务返回了无法识别的响应，请重试');
  });
  if (!response.ok) {
    if (response.status === 401 && result.code === 'UNAUTHENTICATED' && user && requestEpoch === epoch && !path.startsWith('/auth/login')) showAuth('登录已过期，请重新登录');
    const error = new Error(result.error || '操作失败，请重试'); error.code = result.code; error.status = response.status; throw error;
  }
  return result;
}
async function refresh(render = true) {
  const expected = epoch;
  const next = await api('/library');
  if (expected !== epoch || !user) return;
  for (const t of next.tracks) {
    const local = t.provider === 'local' && openedFiles.get(t.providerId);
    if (local) { t.localReference = local.localReference; t.canPlay = true; }
  }
  fileFavorites.clear();
  for (const t of next.tracks) if (openedFiles.has(t.providerId) && next.favorites.includes(t.id)) fileFavorites.add(t.providerId);
  next.tracks.push(...[...openedFiles.values()].filter(t => !next.tracks.some(x => x.id === t.id)));
  if (continuingTrack && !next.tracks.some(t => t.id === continuingTrack.id)) next.tracks.push(continuingTrack);
  next.favorites = [...new Set([...next.favorites, ...fileFavorites])];
  library = next;
  renderAccountCopy();
  queue = queue.filter(id => track(id));
  if (currentId && !track(currentId)) stopPlayback();
  syncStatus(user.local ? '已保存在本地' : '资料库已同步');
  if (render) { renderNav(); renderContent(); renderPlayer(); renderQueue(); }
}
function stopPlayback() {
  savePlayback(); pendingSeek = null; failedTracks.clear();
  playbackGeneration++; playbackFailure = null;
  audio.pause(); audio.removeAttribute('src'); audio.load(); currentId = ''; queue = [];
  lyricId = ''; lyricLines = []; lyricMessage = '选择一首歌，开始聆听'; lyricIndex = -1;
  window.harmonyDesktop?.updateLyrics({ title: '和音', line: lyricMessage, next: '' });
}
function showAuth(message = '') {
  savePlayback(); selectedTracks.clear(); favoritesSnapshot = null;
  collectionLoading = false; collectionErrors = []; collectionLoadEpoch = -1;
  playlistQuery = ''; playlistSearchCollapsed.clear(); trackListQuery = ''; trackListPlatform = 'all';
  libraryTab = 'own'; playbackMode = 0;
  clearTimeout(searchTimer); downloads = []; desktopLyrics = false; window.harmonyDesktop?.setLyricsVisible(false);
  stopQr(); searchGeneration++; remoteResults = []; searchErrors = []; searchBusy = false;
  epoch++; user = null; stopPlayback();
  for (const t of openedFiles.values()) URL.revokeObjectURL(t.blobUrl);
  openedFiles.clear(); fileFavorites.clear(); continuingTrack = null;
  library = { tracks: [], playlists: [], favorites: [], recent: [], providers: [] };
  page = 'home'; playlistId = ''; query = ''; filter = 'all';
  $('search').value = ''; $('file-input').value = ''; $('app').hidden = true;
  $('content').replaceChildren(); $('navigation').replaceChildren(); $('queue-panel').hidden = true;
  $('auth').hidden = false; $('boot').hidden = true; $('dialog').close();
  $('password').value = ''; $('confirm-password').value = ''; $('auth-error').textContent = message;
  renderPlayer();
}
async function enter(account) {
  epoch++; user = { ...account, username: account.local ? '本地模式' : account.username };
  $('auth').hidden = true; $('boot').hidden = true; $('app').hidden = false;
  $('account-name').textContent = user.username; $('avatar').textContent = user.username.slice(0, 1).toUpperCase();
  $('password').value = ''; $('confirm-password').value = ''; $('content').innerHTML = '<div class="loading-note">正在读取你的音乐资料库…</div>';
  try { addLocalRecords(await localReferences()); } catch (error) { toast('本地音乐记录读取失败：' + error.message); }
  await refresh();
  if (!currentId) await restorePlayback();
  if (window.harmonyDesktop?.getPreferences) {
    try { const preferences = await window.harmonyDesktop.getPreferences(); closeAction = preferences.closeAction; shortcuts = { ...defaultShortcuts, ...preferences.shortcuts }; } catch {}
  }
}
function setAuthMode(mode) {
  authMode = mode; const registering = mode === 'register';
  $('login-tab').setAttribute('aria-selected', !registering);
  $('register-tab').setAttribute('aria-selected', registering);
  $('auth-title').textContent = registering ? '开启你的音乐旅程' : '欢迎回来';
  $('auth-subtitle').textContent = registering ? '创建账号，让喜欢的音乐有处安放。' : '登录账号，继续收藏你的日常。';
  $('confirm-field').hidden = !registering; $('confirm-password').required = registering;
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  if (registering) $('username').setAttribute('pattern', '[a-z0-9]{3,32}');
  else $('username').removeAttribute('pattern');
  $('username-hint').textContent = registering ? '3–32 位，仅支持数字和小写字母' : '新账号仅支持数字和小写字母，已有账号仍可登录';
  $('auth-submit').innerHTML = registering ? '创建账号 <span>→</span>' : '登录和音 <span>→</span>';
  $('auth-error').textContent = '';
}
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('auth-submit');
  if (authMode === 'register' && $('password').value !== $('confirm-password').value) { $('auth-error').textContent = '两次输入的密码不一致'; return; }
  button.disabled = true; $('auth-error').textContent = ''; button.textContent = authMode === 'register' ? '正在创建…' : '正在登录…';
  try {
    const result = await api('/auth/' + authMode, 'POST', { username: $('username').value.trim(), password: $('password').value, remember: $('remember').checked });
    await enter(result.user);
  } catch (error) {
    if (user) { syncStatus('资料库读取失败', true); $('content').innerHTML = empty('cloud', '暂时无法读取资料库', error.message, '重新加载', 'refresh'); }
    else $('auth-error').textContent = error.message;
  } finally { button.disabled = false; button.innerHTML = authMode === 'register' ? '创建账号 <span>→</span>' : '登录和音 <span>→</span>'; }
});
$('show-password').onclick = () => {
  const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password';
  $('show-password').textContent = show ? '隐藏' : '显示'; $('show-password').setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
};

function renderAccountCopy() {
  const connected = library.providers.filter(p => p.connected).length;
  const needsConnection = user.local && connected === 0;
  $('account-name').textContent = needsConnection ? '关联音乐平台账号' : user.username;
  $('account-button').querySelector('.account-copy small').textContent = needsConnection
    ? '扫码连接 QQ 音乐或网易云音乐'
    : connected ? `账号与设置 · ${connected} 个平台已连接` : '账号与设置 · 连接音乐平台';
}
function renderNav() {
  const navScroll = $('navigation').scrollTop;
  const searchFocused = document.activeElement?.id === 'playlist-search';
  const selection = searchFocused ? [$('playlist-search').selectionStart, $('playlist-search').selectionEnd] : null;
  const item = (id, label, name, count = '') => `<button class="nav-item ${page === id ? 'active' : ''}" data-action="navigate" data-id="${id}" ${page === id ? 'aria-current="page"' : ''}>${icon(name)}<span>${label}</span>${count !== '' ? `<span class="count">${count}</span>` : ''}</button>`;
  $('navigation').innerHTML = '<div class="nav-label">我的资料库</div>' + item('tracks', '全部音乐', 'music', collectionTracks().length) + item('favorites', '我喜欢的', 'heart', library.favorites.filter(id => !openedFiles.has(id)).length) + item('recent', '最近播放', 'clock') + item('local', '本地音乐', 'music', openedFiles.size) + item('downloads', '下载管理', 'download') + `<div class="nav-label"><button class="playlist-heading-toggle" data-action="toggle-all-playlist-groups" aria-label="展开或收起全部歌单分组" aria-expanded="${['own', 'qq', 'netease'].some(source => !(playlistQuery.trim() ? playlistSearchCollapsed.has(source) : (layout().collapsed || []).includes(source)))}">我的歌单 ${icon('down')}</button>${ib('plus', '新建歌单', 'new-list')}</div>` + renderSidebarPlaylists() + item('library', '查看全部歌单', 'playlist');
  $('account-button').classList.toggle('active', page === 'settings');
  if (page === 'settings') $('account-button').setAttribute('aria-current', 'page');
  else $('account-button').removeAttribute('aria-current');
  if (searchFocused) { $('playlist-search').focus({ preventScroll: true }); $('playlist-search').setSelectionRange(...selection); }
  $('navigation').scrollTop = navScroll;
}
function renderSidebarPlaylists() {
  const keyword = playlistQuery.trim().normalize('NFKC').toLocaleLowerCase();
  const search = `<div class="playlist-search-box">${icon('search')}<input id="playlist-search" type="search" maxlength="100" placeholder="搜索歌单" aria-label="搜索歌单" value="${esc(playlistQuery)}">${playlistQuery ? '<button type="button" class="icon-button" data-action="clear-playlist-search" aria-label="清空歌单搜索">×</button>' : ''}</div>`;
  return search + orderedGroups().map(source => {
    const all = orderedLists(source), items = all.filter(p => p.name.normalize('NFKC').toLocaleLowerCase().includes(keyword));
    const expanded = keyword ? !playlistSearchCollapsed.has(source) : !(layout().collapsed || []).includes(source);
    const label = source === 'own' ? '和音歌单' : provider(source);
    return `<section class="playlist-group" data-group="${source}"><button type="button" class="group-heading" draggable="true" data-drag-group="${source}" data-action="toggle-playlist-group" data-id="${source}" aria-expanded="${expanded}" aria-controls="playlist-group-${source}" title="点击展开或收起，拖动调整分组顺序">${icon('down')}<span>${label}</span><small>${keyword ? items.length + ' / ' : ''}${all.length}</small><span class="drag-grip">⠿</span></button><div id="playlist-group-${source}" ${expanded ? '' : 'hidden'}>${items.map(p => `<button draggable="true" data-drag-list="${p.id}" class="nav-item ${page === 'playlist' && playlistId === p.id ? 'active' : ''}" data-action="open-list" data-id="${p.id}" title="${esc(p.name)} · 可拖动排序">${icon('playlist')}<span>${esc(p.name)}</span><span class="drag-grip">⠿</span></button>`).join('') || `<p class="group-empty">${keyword ? '无匹配歌单' : '暂无歌单'}</p>`}</div></section>`;
  }).join('');
}
function cover(p) {
  const first = track(p.trackIds?.[0]);
  const url = first?.coverUrl || p.coverUrl || (p.source !== 'own' && !p.loadedAt ? `/api/platform-playlists/${p.id}/cover` : '');
  return `<div class="cover ${p.color}">${url ? `<img class="playlist-art" src="${esc(url)}" alt="${esc(p.name)}首曲封面" loading="lazy" referrerpolicy="no-referrer">` : ''}<span>${esc(p.name)}</span><small>${p.source === 'own' ? 'HARMONY COLLECTION' : esc(provider(p.source))}</small></div>`;
}
function cards(playlists) {
  return `<div class="cards">${playlists.map(p => `<button class="playlist-card" data-action="open-list" data-id="${p.id}">${cover(p)}<h3>${esc(p.name)}</h3><p>${p.source === 'own' ? '我的歌单' : esc(provider(p.source))} · ${p.trackCount ?? p.trackIds.length} 首歌曲</p></button>`).join('')}</div>`;
}
function heading(title, subtitle = '', action = '') {
  return `<div class="page-heading"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`;
}
function empty(name, title, description, label = '', action = '') {
  return `<div class="empty"><div class="empty-icon">${icon(name)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${label ? `<button class="btn primary" data-action="${action}">${esc(label)}</button>` : ''}</div>`;
}
const newListButton = '<button class="btn quiet" data-action="new-list">＋ 新建歌单</button>';
let importingPlaylists = false;
const playlistTransferButtons = () => `<div class="button-row playlist-tools">${newListButton}<button class="btn quiet" data-action="export-playlists">${icon('download')}导出歌单</button><button class="btn quiet" data-action="import-playlists" ${importingPlaylists ? 'disabled' : ''}>${icon('playlist')}${importingPlaylists ? '正在导入…' : '导入歌单'}</button></div>`;
function visibleTracks() {
  if (page === 'local') return [...openedFiles.values()];
  if (page === 'playlist') return (list(playlistId)?.trackIds || []).map(track).filter(Boolean);
  if (page === 'favorites') return (favoritesSnapshot ??= [...library.favorites.filter(id => !openedFiles.has(id))]).map(track).filter(Boolean);
  if (page === 'recent') return library.recent.map(track).filter(Boolean);
  if (page === 'search') {
    return [...new Set(remoteResults)].map(track).filter(t => t && ['qq', 'netease'].includes(t.provider) && (filter === 'all' || t.provider === filter));
  }
  if (page === 'home') return library.recent.length ? library.recent.map(track).filter(Boolean).slice(0, 6) : collectionTracks().slice(0, 6);
  return collectionTracks();
}
function trackListResults() {
  const items = visibleTracks();
  const keyword = trackListQuery.trim().normalize('NFKC').toLocaleLowerCase();
  if (!keyword && trackListPlatform === 'all') return songTable(items);
  const matches = items.filter(t =>
    (trackListPlatform === 'all' || t.provider === trackListPlatform) &&
    (!keyword || [t.title, t.artist, t.album].some(
      field => field?.normalize('NFKC').toLocaleLowerCase().includes(keyword)
    ))
  );
  const hint = trackListPlatform === 'all' ? '换一个关键词，或清空搜索查看完整列表。' : '试试切换平台或调整关键词。';
  return matches.length ? songTable(matches) : empty('search', '没有匹配的歌曲', hint);
}
function platformFilters(selected, action) {
  return `<div class="filters" role="group" aria-label="筛选音乐平台">${[['all', '全部'], ['qq', 'QQ 音乐'], ['netease', '网易云音乐']].map(([id, name]) => `<button class="${selected === id ? 'active' : ''}" type="button" data-action="${action}" data-id="${id}" aria-label="${name}" title="${name}" aria-pressed="${selected === id}">${id === 'all' ? name : platformLogo(id)}</button>`).join('')}</div>`;
}
function trackListSearch() {
  const label = {
    playlist: '搜索当前歌单中的歌曲',
    tracks: '搜索全部音乐中的歌曲',
    favorites: '搜索我喜欢的歌曲',
  }[page];
  const showPlatform = page !== 'playlist' || list(playlistId)?.source === 'own';
  const filters = showPlatform ? platformFilters(trackListPlatform, 'filter-track-list') : '';
  return `<div class="track-list-filters" role="search"><div class="search-box track-list-search">${icon('search')}<input id="track-list-search" type="search" maxlength="100" aria-label="${label}" placeholder="搜索歌曲、艺人、专辑" value="${esc(trackListQuery)}">${ib('close', '清空歌曲搜索', 'clear-track-list-search', '', trackListQuery ? '' : 'hidden')}</div>${filters}</div><div id="track-list-results">${trackListResults()}</div>`;
}
function updateTrackListSearch(input) {
  trackListQuery = input.value;
  $('track-list-results').innerHTML = trackListResults();
  input.parentElement.querySelector('button').hidden = !trackListQuery;
}
function displayStatisticCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  if (value >= 100000000) return (value / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
  if (value >= 10000) return (value / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
  return value.toLocaleString('zh-CN');
}
function canDeleteSelection() {
  return page !== 'search' && !(page === 'playlist' && list(playlistId)?.source !== 'own');
}
function selectionToolbar() {
  return `<div class="selection-toolbar" role="region" aria-label="批量操作" ${selectedTracks.size ? '' : 'hidden'}><strong>已选 <span data-selection-count>${selectedTracks.size}</span> 首</strong><button class="btn" data-action="select-page">本页全选</button><button class="btn" data-action="bulk-favorite">${icon('heart')}收藏</button><button class="btn" data-action="bulk-add">${icon('plus')}加入歌单</button><button class="btn danger" data-action="bulk-delete" ${canDeleteSelection() ? '' : 'disabled title="平台原始歌单与搜索结果只读"'}>删除</button><button class="text-button" data-action="clear-selection">取消选择</button><span class="selection-feedback" role="status"></span></div>`;
}
function updateSelection() {
  document.querySelectorAll('tr[data-track]').forEach(row => {
    const selected = selectedTracks.has(row.dataset.track);
    row.classList.toggle('selected-row', selected);
    row.setAttribute('aria-selected', selected);
    row.querySelector('[data-select-track]').checked = selected;
  });
  const all = document.querySelector('[data-select-page]');
  if (all) { all.checked = displayedTracks.length > 0 && displayedTracks.every(id => selectedTracks.has(id)); all.indeterminate = selectedTracks.size > 0 && !all.checked; }
  const toolbar = document.querySelector('.selection-toolbar');
  if (toolbar) { toolbar.hidden = !selectedTracks.size; toolbar.querySelector('[data-selection-count]').textContent = selectedTracks.size; }
}
function selectTrack(id, checked, range = false) {
  const start = displayedTracks.indexOf(selectionAnchor), end = displayedTracks.indexOf(id);
  const ids = range && start >= 0 && end >= 0 ? displayedTracks.slice(Math.min(start, end), Math.max(start, end) + 1) : [id];
  for (const value of ids) { if (checked) selectedTracks.add(value); else selectedTracks.delete(value); }
  selectionAnchor = id; updateSelection();
}
async function bulkDelete(ids) {
  if (page === 'playlist') {
    const p = list(playlistId);
    if (p?.source !== 'own') return;
    await replaceTracks(p, p.trackIds.filter(id => !ids.includes(id)));
    ids.forEach(id => selectedTracks.delete(id));
    return;
  }
  for (const id of ids) {
    if (page === 'favorites') await toggleFavorite(id, false);
    else if (openedFiles.has(id)) {
      if (desktop()) await desktop().removeLocalFiles([id]);
      else {
        const database = await db();
        await new Promise((resolve, reject) => {
          const tx = database.transaction('files', 'readwrite'); tx.objectStore('files').delete(id);
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
      }
      URL.revokeObjectURL(openedFiles.get(id)?.blobUrl);
      openedFiles.delete(id); fileFavorites.delete(id);
      library.tracks = library.tracks.filter(t => t.id !== id);
      if (id === currentId) stopPlayback();
    } else await api(`/tracks/${id}`, 'DELETE', {});
    selectedTracks.delete(id);
  }
}
function songTable(items) {
  displayedTracks = items.map(t => t.id);
  for (const id of selectedTracks) if (!displayedTracks.includes(id)) selectedTracks.delete(id);
  if (!items.length) {
    if (page === 'search' && !query) return `<div class="empty search-empty"><form id="empty-search-form" class="search-box empty-search-form" role="search">${icon('search')}<input id="empty-search" type="search" maxlength="100" placeholder="搜索歌曲、艺人、专辑" aria-label="搜索网络音乐" value="${esc($('search').value)}"><button type="submit" class="search-submit">搜索</button></form><h3>搜索网络音乐</h3><p>输入歌曲、艺人或专辑，搜索 QQ 音乐与网易云音乐。请先连接音乐平台账号。</p></div>`;
    if (page === 'search' && query) return empty('search', searchBusy ? '正在搜索音乐平台…' : '没有找到相关音乐', '试试更换歌名、歌手或专辑关键词。');
    if (page === 'favorites') return empty('heart', '留住心动的瞬间', '点击歌曲右侧的爱心，把喜欢的声音收藏到账号中。', '浏览全部音乐', 'tracks');
    if (page === 'recent') return empty('clock', '这里记录你听过的歌', '播放第一首音乐，让熟悉的旋律随时可寻。', '浏览全部音乐', 'tracks');
    if (page === 'playlist') return list(playlistId)?.source === 'own' ? empty('playlist', '给这张歌单，第一首音乐', '从资料库选择歌曲加入，歌单会保存到你的账号。', '从资料库添加', 'add-from-library') : empty('cloud', '这张平台歌单暂无歌曲', '可刷新歌曲列表；原平台歌单保持只读。', '刷新歌曲', 'refresh-platform-list');
    return empty('music', '这里还很安静', '打开电脑里的音频文件即可播放，无需上传。支持 MP3、WAV、FLAC、OGG、M4A、AAC。', '导入本地音乐', 'import');
  }
  return `${selectionToolbar()}<div class="song-table-scroll" role="region" aria-label="歌曲列表" tabindex="0"><table class="song-table ${page === 'search' ? 'search-song-table' : ''}"><thead><tr><th class="number"><input type="checkbox" data-select-page aria-label="本页全选" ${items.every(t => selectedTracks.has(t.id)) ? 'checked' : ''}></th><th>歌曲 / 艺人</th><th class="album-column">专辑名</th><th class="release-column">发表时间</th>${page === 'search' ? '<th class="plays-column" title="平台提供的歌曲播放量，未提供时显示 —">平台播放量</th><th class="favorites-column" title="平台提供的歌曲收藏量，未提供时显示 —">平台收藏量</th>' : ''}<th class="source">来源</th><th class="actions">操作</th></tr></thead><tbody>${items.map((t, i) => `<tr data-track="${t.id}" tabindex="0" aria-label="播放 ${esc(t.title)}" class="${currentId === t.id ? 'playing-row' : ''} ${selectedTracks.has(t.id) ? 'selected-row' : ''} ${audio.paused ? 'is-paused' : ''}" aria-selected="${selectedTracks.has(t.id)}"><td class="number"><span class="row-number">${String(i + 1).padStart(2, '0')}</span><input type="checkbox" data-select-track="${esc(t.id)}" aria-label="选择 ${esc(t.title)}" ${selectedTracks.has(t.id) ? 'checked' : ''}></td><td><div class="song-cell">${trackCover(t)}<div><button class="song-name" data-action="play" data-id="${t.id}" title="播放 ${esc(t.title)}"><span class="song-title">${esc(t.title)}</span><span class="playing-equalizer" aria-label="正在播放"><i></i><i></i><i></i></span></button><small>${esc(t.artist || '未知艺人')}</small></div></div></td><td class="album-column" title="${esc(t.album || '未提供专辑名')}">${esc(t.album || '—')}</td><td class="release-column">${esc(t.releaseDate || '—')}</td>${page === 'search' ? `<td class="plays-column" title="${Number.isSafeInteger(t.playCount) && t.playCount >= 0 ? esc(t.playCount.toLocaleString('zh-CN')) + ' 次' : '平台未提供歌曲播放量'}">${displayStatisticCount(t.playCount)}</td><td class="favorites-column" title="${Number.isSafeInteger(t.favoriteCount) && t.favoriteCount >= 0 ? esc(t.favoriteCount.toLocaleString('zh-CN')) + ' 次收藏' : '平台未提供歌曲收藏量'}">${displayStatisticCount(t.favoriteCount)}</td>` : ''}<td class="source">${platformLogo(t.provider)}</td><td class="actions">${favoriteButton(t)}${ib('plus', '加入歌单', 'add-to-list', t.id)}${ib('download', t.canDownload ? '下载音乐文件' : t.downloadReason, 'download', t.id, t.canDownload ? '' : 'disabled')}${ib('more', '歌曲更多操作', 'track-more', t.id)}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderContent() {
  displayedTracks = [];
  document.querySelector('.sidebar .brand')?.setAttribute('aria-current', page === 'home' ? 'page' : 'false');
  if (!user) return;
  const labels = { local: '本地音乐', home: '现在聆听', search: '搜索', tracks: '全部音乐', favorites: '我喜欢的', recent: '最近播放', library: '我的歌单', settings: '账号与音乐平台', downloads: '下载管理', lyrics: '正在播放', playlist: list(playlistId)?.name || '歌单' };
  $('breadcrumb').textContent = labels[page];

  let html = '';
  if (page === 'home') {
    html = heading('现在聆听', '好音乐，不必分散在不同的地方。', newListButton) + `<section class="hero"><div class="hero-copy"><div class="eyebrow">YOUR EVERYDAY SOUNDTRACK</div><h2>把时间，留给音乐。</h2><p>${collectionTracks().length ? `已经收藏 ${collectionTracks().length} 首音乐，每一首都有自己的故事。` : '从第一首喜欢的歌开始，建立属于自己的音乐资料库。'}</p><button class="btn primary" data-action="${collectionTracks().length ? 'play-all' : 'import'}">${icon(collectionTracks().length ? 'play' : 'plus')}${collectionTracks().length ? '开始聆听' : '导入本地音乐'}</button></div><div class="hero-art" aria-hidden="true"></div></section><div class="section-heading"><h2>我的歌单</h2><span>${library.playlists.length} 张，都是真实的喜欢</span><button class="text-button" data-action="library">查看全部 →</button></div>` + renderLibraryTabs() + `<div class="section-heading"><h2>${library.recent.length ? '最近播放' : '资料库音乐'}</h2><button class="text-button" data-action="tracks">全部音乐 →</button></div>` + songTable(visibleTracks());
  } else if (page === 'lyrics') {
    html = '<div id="lyrics-page"></div>';
  } else if (page === 'local') {
    html = heading('本地音乐', `${openedFiles.size} 首音乐 · 仅记录原文件位置，播放时读取，不复制或上传音频。`, '<div class="button-row"><button class="btn primary" data-action="import-files">＋ 导入文件</button><button class="btn" data-action="import-folder">导入文件夹</button></div>') + (openedFiles.size ? songTable(visibleTracks()) : empty('music', '把电脑里的音乐，留在身边', '选择音频文件或文件夹，包含子文件夹。请保留原文件，移动或删除后需要重新选择。'));
  } else if (page === 'downloads') {
    html = heading('下载管理', '本次会话的下载记录') + (downloads.length ? `<div class="download-list">${downloads.map(d => `<div class="setting-row"><div><h3>${esc(d.title)}</h3><p>${esc(d.status)}</p></div><span>${d.bytes ? size(d.bytes) : '大小待获取'}</span></div>`).join('')}</div>` : empty('download', '还没有下载记录', '点击歌曲右侧的下载按钮，保存可以下载的音乐。'));
  } else if (page === 'library') {
    html = heading('我的歌单', user.local ? '本地收藏，仅保存在这台电脑。' : '属于你的收藏，跟随账号保存。', playlistTransferButtons()) + `<p class="playlist-transfer-hint">导出为 .hy 歌单文件，可选择保存位置；包含喜欢列表与自建歌单。导入时合并同名歌单，自动去重。文件仅包含歌曲记录，不含音频。</p>` + renderLibraryTabs();
  } else if (page === 'playlist') {
    const p = list(playlistId);
    if (!p) { page = 'library'; renderNav(); return renderContent(); }
    html = `<section class="playlist-header">${cover(p)}<div>${p.source === 'own' ? `<div class="eyebrow">${user.local ? 'MY COLLECTION · 保存在本地' : 'MY COLLECTION · 已保存到账号'}</div>` : ''}<h1>${esc(p.name)}</h1><p>${esc(p.description || '把喜欢的声音，收进同一张歌单。')}<br>${p.trackCount ?? p.trackIds.length} 首歌曲</p><div class="button-row"><button class="btn primary" data-action="play-all" ${p.trackIds.length ? '' : 'disabled'}>${icon('play')}播放</button>${p.source === 'own' ? '<button class="btn" data-action="add-from-library">' + icon('plus') + '添加音乐</button>' + ib('edit', '编辑歌单', 'edit-list', p.id) + ib('trash', '删除歌单', 'delete-list', p.id) : '<button class="btn" data-action="refresh-platform-list">刷新歌曲</button>'}</div></div></section>` + unavailableMusicNotice(visibleTracks()) + trackListSearch();
  } else if (['tracks', 'favorites', 'recent'].includes(page)) {
    html = heading(labels[page], page === 'tracks' ? `${collectionTracks().length} 首音乐 · 汇总各平台歌单与收藏，本地音乐按原文件位置播放` : page === 'favorites' ? '每一次喜欢，都值得被记住。' : '熟悉的旋律，随时回来。', page === 'tracks' ? '<button class="btn primary" data-action="import">＋ 导入本地音乐</button>' : page === 'favorites' ? '<button class="btn" data-action="export-favorites">导出喜欢的歌曲</button>' : '') + (page === 'tracks' ? (collectionLoading ? '<div class="notice">正在汇总各平台歌单中的音乐…</div>' : '') + collectionErrors.map(e => `<div class="notice">${esc(provider(e.provider))}：${esc(e.message)} <button class="text-button" data-action="retry-collection">重试</button></div>`).join('') : '') + (page === 'recent' ? songTable(visibleTracks()) : trackListSearch());
  } else if (page === 'search') {
    html = heading(query ? `搜索「${query}」` : '搜索音乐', '无需绑定账号即可搜索 QQ 音乐和网易云音乐。') + platformFilters(filter, 'filter') + (searchBusy ? '<div class="notice">正在搜索音乐平台…</div>' : '') + searchErrors.map(e => `<div class="notice">${esc(provider(e.provider))}：${esc(e.message)}</div>`).join('') + songTable(visibleTracks()) + (query && (remoteResults.length || searchErrors.length) ? `<div class="button-row">${Object.values(searchPages).some(state => state.hasMore) ? `<button class="btn" data-action="search-more" ${searchBusy ? 'disabled' : ''}>${searchBusy ? '正在加载…' : searchErrors.length ? '重试加载更多' : '加载更多'}</button>` : '<span class="muted">已显示平台返回的全部结果</span>'}<span class="muted">已加载 ${visibleTracks().length} 首</span></div>` : '');
  } else if (page === 'settings') {
    html = renderSettings();
  }
  const activeSearch = document.activeElement === $('track-list-search') ? document.activeElement : null;
  const activePlatform = document.activeElement.matches('[data-action="filter-track-list"]') ? document.activeElement.dataset.id : null;
  $('content').innerHTML = html;
  if (activePlatform) $('content').querySelector(`[data-action="filter-track-list"][data-id="${activePlatform}"]`)?.focus({ preventScroll: true });
  if (activeSearch && $('track-list-search')) {
    $('track-list-search').focus({ preventScroll: true });
    $('track-list-search').setSelectionRange(activeSearch.selectionStart, activeSearch.selectionEnd);
  }
  if (page === 'lyrics') renderLyricsPage();
  if (page === 'home') renderHomeLyrics();
}
function navigate(next, id = '') {
  if (next === 'providers') next = 'settings';
  if (next !== 'search') { clearTimeout(searchTimer); searchGeneration++; searchBusy = false; }
  if (next !== page || id !== playlistId) {
    selectedTracks.clear(); selectionAnchor = ''; favoritesSnapshot = null;
    trackListQuery = ''; trackListPlatform = 'all';
  }
  page = next; playlistId = id; renderNav(); renderContent(); $('content').scrollTop = 0;
  if (next === 'tracks') loadCollection();
}
function renderLibraryTabs() {
  const sources = ['own', 'qq', 'netease'];
  return `<div class="tabs library-tabs" role="tablist" aria-label="全部歌单分类">${sources.map(source => `<button type="button" role="tab" id="library-tab-${source}" aria-selected="${source === libraryTab}" tabindex="${source === libraryTab ? 0 : -1}" aria-controls="library-playlist-panel" data-action="library-tab" data-id="${source}">${source === 'own' ? '和音歌单' : esc(provider(source))}<span class="tab-count">${orderedLists(source).length}</span></button>`).join('')}</div><section id="library-playlist-panel" role="tabpanel" tabindex="0" aria-labelledby="library-tab-${libraryTab}">${orderedLists(libraryTab).length ? cards(orderedLists(libraryTab).slice(0, page === 'home' ? 4 : undefined)) : empty('playlist', libraryTab === 'own' ? '为喜欢的声音留个位置' : '暂无' + provider(libraryTab) + '歌单', libraryTab === 'own' ? '新建歌单，再把音乐加入其中。' : '连接平台账号并同步后，歌单将显示在这里。', libraryTab === 'own' ? '新建歌单' : '连接音乐平台', libraryTab === 'own' ? 'new-list' : 'providers')}</section>`;
}
function renderSettings() {
  const connected = library.providers.filter(p => p.connected).length;
  const accountName = user.local ? '本地模式' : user.username;
  const accountActions = user.local
    ? '<span class="account-login-unavailable" tabindex="0" aria-label="登录和音账号，敬请期待"><button class="btn" type="button" disabled aria-describedby="account-login-hint">登录和音账号 <span aria-hidden="true">→</span></button><span class="account-login-hint" id="account-login-hint" role="tooltip">敬请期待</span></span>'
    : '<button class="btn" data-action="password">修改密码</button><button class="btn quiet danger" data-action="logout">退出登录</button>';
  return `<div class="account-settings">${heading('账号与音乐平台', '你的账号、音乐连接与偏好，都在这里。')}
    <section class="account-overview" aria-label="和音账号">
      <div class="account-identity"><span class="settings-avatar" aria-hidden="true">${user.local ? icon('music') : esc(user.username.slice(0, 1).toUpperCase())}</span><div><span class="settings-kicker">和音账号</span><h2>${esc(accountName)}</h2><p>${user.local ? '平台绑定、歌单、收藏仅保存在此电脑。云端账号同步功能正在开发中' : '歌单、收藏与最近播放记录按账号保存。'}</p></div></div>
      <div class="button-row">${accountActions}</div>
    </section>
    <section class="platform-connections" aria-labelledby="connections-title">
      <div class="settings-section-title"><div><h2 id="connections-title">音乐平台</h2><p>连接常用平台，让喜欢的音乐汇聚在一起。</p></div><span class="connection-count">${connected} / ${library.providers.length} 已连接</span></div>
      ${renderProviderCards()}
      <p class="connection-hint">${icon('info')}扫码连接后可同步个人歌单，并按平台权限播放音乐。</p>
    </section>
    <section class="settings-preferences" aria-label="偏好与应用信息">
      <div class="preference-row"><div><h3>关闭主窗口时</h3><p>托盘中可重新打开和音或退出应用。${window.harmonyDesktop ? '' : '网页中可预设，关闭行为在桌面客户端生效。'}</p></div><select id="close-action" aria-label="关闭主窗口时">${[['tray', '最小化到托盘'], ['ask', '每次询问'], ['quit', '退出应用']].map(([id, label]) => `<option value="${id}" ${closeAction === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="preference-row"><div><h3>外观</h3><p>选择适合此刻的界面。</p></div><div class="theme-switch" role="group" aria-label="界面外观">${[['light', '浅色'], ['dark', '深色']].map(([id, label]) => `<button type="button" data-action="theme" data-id="${id}" aria-pressed="${theme === id}">${label}</button>`).join('')}</div></div>
      <div class="preference-row about-harmony"><div><h3>关于和音 · One Music</h3><p>Bring your music together.</p></div><span class="version-label">桌面版 0.5.1</span></div>
    </section>
    <div class="settings-section-title"><div><h2>快捷键</h2><p>点击按键框并按下新组合。快捷键在和音窗口内生效，输入文字时暂停响应。</p></div><button class="text-button" data-action="reset-shortcuts">恢复默认</button></div>
    <section class="settings-preferences shortcut-settings" aria-label="快捷键设置">${Object.entries({ 'toggle-play': '播放 / 暂停', previous: '上一首', next: '下一首', search: '搜索音乐', 'new-list': '新建歌单' }).map(([id, label]) => `<div class="preference-row"><label for="shortcut-${id}">${label}</label><input class="shortcut-input" id="shortcut-${id}" data-shortcut="${id}" aria-label="${label}快捷键" value="${esc(shortcuts[id])}" readonly></div>`).join('')}</section>
  </div>`;
}
function renderProviderCards() {
  return `<div class="provider-grid">${library.providers.map(p => {
    const expired = p.status === 'expired';
    const status = p.connected ? '已连接' : expired ? '登录已失效' : '未连接';
    return `<section class="provider-card connection-card" aria-label="${esc(p.name)}绑定设置">
      <div class="connection-heading"><div class="provider-heading"><div class="provider-logo">${platformLogo(p.id)}</div><h3>${esc(p.name)}</h3></div><span class="connection-state ${p.connected ? 'connected' : expired ? 'expired' : ''}"><i aria-hidden="true"></i>${status}</span></div>
      <div class="connection-details"><strong>${p.connected ? esc(p.nickname || '已连接平台账号') : expired ? '重新连接，继续聆听' : '让音乐在这里相遇'}</strong><p>${p.connected ? (p.syncedAt ? '上次同步：' + esc(new Date(p.syncedAt).toLocaleString('zh-CN')) : '尚未同步歌单') : p.id === 'qq' ? '使用手机 QQ 扫一扫，登录 QQ 音乐。' : '使用网易云音乐 App 扫一扫登录。'}</p></div>
      <div class="connection-actions"><div class="button-row"><button class="btn ${p.connected ? '' : 'primary'}" data-action="${p.connected ? 'sync-provider' : 'connect-provider'}" data-id="${p.id}">${p.connected ? '同步歌单' : expired ? '重新连接' : '扫码连接'}</button>${p.connected ? `<button class="btn" data-action="view-provider-playlists" data-id="${p.id}">查看歌单</button>` : ''}</div>${p.connected || expired ? `<button class="text-button disconnect-link" data-action="disconnect-provider" data-id="${p.id}">解除连接</button>` : ''}</div>
    </section>`;
  }).join('')}</div>`;
}
function stopQr() {
  qrGeneration++; clearTimeout(qrTimer); qrTimer = null;
  const active = qrActive; qrActive = null;
  if (active && user) api(`/providers/${active.provider}/qr/${active.id}`, 'DELETE', {}).catch(() => {});
}
async function startProviderQr(id) {
  modal('连接 ' + provider(id), '<div class="qr-area"><div class="qr-placeholder">正在获取平台二维码…</div><p class="dialog-description">登录需要你在手机上确认。</p></div>');
  const generation = qrGeneration;
  try {
    const result = await api(`/providers/${id}/qr`, 'POST', {}, AbortSignal.timeout(20000));
    if (generation !== qrGeneration || !$('dialog').open) { api(`/providers/${id}/qr/${result.id}`, 'DELETE', {}).catch(() => {}); return; }
    const active = qrActive = { id: result.id, provider: id, expiresAt: result.expiresAt };
    const image = new Image();
    image.className = 'qr-image';
    image.alt = provider(id) + '登录二维码';
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.image)) throw new Error('平台返回的二维码图片无效，请重新获取');
    image.src = result.image;
    await image.decode().catch(() => { throw new Error('二维码图片加载失败，请重新获取'); });
    if (active !== qrActive || !$('dialog').open) return;
    $('dialog-content').innerHTML = `<div class="dialog-header"><h2>连接${esc(provider(id))}</h2>${ib('close', '关闭弹窗', 'close-dialog')}</div><div class="qr-area"><div id="qr-image-slot"></div><p class="qr-status" id="qr-status" role="status">等待手机扫码</p><p class="dialog-description">${esc(result.hint)}</p><small id="qr-countdown">二维码约 3 分钟后失效</small><button class="btn" data-action="refresh-qr" data-id="${id}">刷新二维码</button></div>`;
    $('qr-image-slot').replaceWith(image);
    qrTimer = setTimeout(() => pollProviderQr(active), 2200);
  } catch (error) {
    if (generation === qrGeneration && $('dialog').open) {
      stopQr();
      $('dialog-content').innerHTML = `<div class="dialog-header"><h2>连接${esc(provider(id))}</h2>${ib('close', '关闭弹窗', 'close-dialog')}</div><p class="dialog-description" role="alert">无法获取${esc(provider(id))}二维码：${esc(error.message)}</p><button class="btn primary" data-action="refresh-qr" data-id="${id}">重新获取二维码</button>`;
    }
  }
}
function finishQr(message) {
  $('qr-status').textContent = message;
  $('qr-countdown').hidden = true;
  $('dialog-content').querySelector('.qr-image').hidden = true;
  stopQr();
}
async function pollProviderQr(active) {
  if (!active || active !== qrActive || !$('dialog').open) return;
  if (Date.now() >= active.expiresAt) { finishQr('二维码已过期，请刷新'); return; }
  try {
    const result = await api(`/providers/${active.provider}/qr/${active.id}`, 'POST', {}, AbortSignal.timeout(80000));
    if (active !== qrActive || !$('dialog').open) return;
    $('qr-status').textContent = { waiting: '等待手机扫码', scanned: '已扫码，请在手机上确认登录', authorized: '登录成功，正在同步歌单…' }[result.status] || '等待平台确认';
    if (result.status === 'expired') { finishQr('二维码已失效，请刷新'); return; }
    if (result.status === 'authorized') {
      let message = '平台已连接';
      try { const sync = await api(`/providers/${active.provider}/sync`, 'POST', {}); message = `已连接并同步 ${sync.count} 张歌单`; }
      catch (error) { message = '登录成功；歌单同步未完成：' + error.message; }
      if (active !== qrActive || !user) return;
      $('dialog').close(); stopQr(); await refresh(false); navigate('providers'); toast(message); return;
    }
  } catch (error) {
    if (active !== qrActive || !$('dialog').open) return;
    const message = '扫码确认失败：' + error.message;
    if ([401, 404, 409, 429].includes(error.status)) { finishQr(message); return; }
    $('qr-status').textContent = message + '。正在重试，也可刷新二维码。';
  }
  if (active === qrActive) {
    $('qr-countdown').textContent = `约 ${Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000))} 秒后失效`;
    qrTimer = setTimeout(() => pollProviderQr(active), 2500);
  }
}
async function searchPlatforms(append = false) {
  if (append && searchBusy) return;
  const generation = ++searchGeneration, authEpoch = epoch, term = query, source = filter;
  if (!append) {
    remoteResults = [];
    searchPages = Object.fromEntries(library.providers.filter(p => p.available && (source === 'all' || source === p.id)).map(p => [p.id, { nextPage: 1, hasMore: true }]));
  }
  searchErrors = [];
  const pages = Object.fromEntries(Object.entries(searchPages).filter(([, state]) => state.hasMore).map(([id, state]) => [id, state.nextPage]));
  if (!term || !Object.keys(pages).length) { searchBusy = false; renderContent(); return; }
  searchBusy = true; renderContent();
  try {
    const result = await api('/providers/search', 'POST', { query: term, provider: source, pages });
    if (generation !== searchGeneration || authEpoch !== epoch || !user) return;
    const existing = new Set(remoteResults);
    for (const state of result.pagination || []) {
      searchPages[state.provider] = { nextPage: state.page + 1, hasMore: state.hasMore && state.ids.some(id => !existing.has(id)) };
    }
    // Older preview backends have no pagination metadata.
    if (!result.pagination) searchPages = {};
    remoteResults = [...new Set([...remoteResults, ...result.trackIds])]; searchErrors = result.errors; await refresh(false);
  } catch (error) { if (generation === searchGeneration) searchErrors = [{ provider: source === 'all' ? '音乐平台' : source, message: error.message }]; }
  finally { if (generation === searchGeneration && authEpoch === epoch && user) { searchBusy = false; if (page === 'search') renderContent(); } }
}
function submitSearch() {
  clearTimeout(searchTimer);
  if (!user) return;
  query = $('search').value.trim().slice(0, 100); $('clear-search').hidden = !$('search').value;
  navigate('search'); searchPlatforms().catch(error => toast(error.message));
}
async function loadLyrics(id) {
  lyricId = id; lyricLines = []; lyricIndex = -1; lyricMessage = '正在加载歌词…';
  renderPlayer(); updateLyrics(true);
  const expectedEpoch = epoch;
  if (openedFiles.has(id)) { lyricMessage = '本地音乐暂无歌词'; renderPlayer(); updateLyrics(true); return; }
  try {
    const result = await api(`/tracks/${id}/lyrics`);
    if (currentId !== id || lyricId !== id || epoch !== expectedEpoch) return;
    const translated = parseLyrics(result.translation);
    lyricLines = parseLyrics(result.lyric).map(line => ({ ...line, translation: translated.find(t => Math.abs(t.time - line.time) < .15)?.text || '' }));
    lyricMessage = lyricLines.length ? '' : (result.lyric ? String(result.lyric).replace(/\[[^\]]*\]/g, '').trim() : '暂无歌词，静静聆听音乐');
  } catch (error) {
    if (currentId !== id || epoch !== expectedEpoch) return;
    lyricMessage = '歌词加载失败：' + error.message;
  }
  renderPlayer(); updateLyrics(true);
}
function renderHomeLyrics() {
  $('home-lyrics')?.remove();
  if (!currentId) return;
  const section = document.createElement('section'); section.id = 'home-lyrics'; section.className = 'home-lyrics';
  section.innerHTML = `<div><small>正在播放 · ${esc(track(currentId)?.title)}</small><p id="home-lyric-line"></p></div><button class="btn" data-action="lyrics">展开歌词 ${icon('up')}</button>`;
  $('content').prepend(section); updateLyrics(true);
}
function renderLyricsPage() {
  const target = $('lyrics-page'); if (!target) return;
  const t = track(currentId);
  target.innerHTML = t ? `<section class="listening-page"><div class="listening-art">${trackCover(t)}<h1>${esc(t.title)}</h1><p>${esc(t.artist)} · ${esc(t.album || provider(t.provider))}</p><div class="button-row">${favoriteButton(t)}${ib('plus', '加入歌单', 'add-to-list', t.id)}<button class="btn" data-action="retry-lyrics">刷新歌词</button></div></div><div id="lyric-scroll" class="lyric-scroll">${lyricLines.length ? lyricLines.map((l, i) => `<button class="lyric-line" data-action="seek-lyric" data-time="${l.time}" data-line="${i}" title="从此句播放">${esc(l.text)}${l.translation ? `<small>${esc(l.translation)}</small>` : ''}</button>`).join('') : `<p class="lyric-placeholder">${esc(lyricMessage)}</p>`}</div></section>` : empty('music', '每一首歌，都有故事', '选择歌曲后，在这里查看封面和滚动歌词。', '浏览全部音乐', 'tracks');
  updateLyrics(true);
}
let lastDesktopText = '';
function updateLyrics(force = false) {
  const position = audio.currentTime || 0;
  let index = -1;
  for (let i = 0; i < lyricLines.length && lyricLines[i].time <= position; i++) index = i;
  const line = index >= 0 ? lyricLines[index].text : lyricLines.length ? '♪ 音乐前奏 ♪' : lyricMessage;
  if ($('player-lyric-line')) $('player-lyric-line').textContent = currentId ? line : '选择一首喜欢的歌';
  if ($('home-lyric-line')) $('home-lyric-line').textContent = line;
  if (index !== lyricIndex || force) {
    lyricIndex = index;
    document.querySelectorAll('.lyric-line').forEach(el => {
      const active = Number(el.dataset.line) === index;
      el.classList.toggle('active', active); el.setAttribute('aria-current', active);
    });
    const active = document.querySelector('.lyric-line.active'), container = $('lyric-scroll');
    if (active && container) container.scrollTo({ top: active.offsetTop - container.offsetTop - container.clientHeight / 2 + active.clientHeight / 2, behavior: 'smooth' });
  }
  const payload = { title: track(currentId)?.title || '和音', line, next: lyricLines[index + 1]?.text || '', playing: !audio.paused };
  const serialized = JSON.stringify(payload);
  if (window.harmonyDesktop && (force || serialized !== lastDesktopText)) { lastDesktopText = serialized; window.harmonyDesktop.updateLyrics(payload); }
}
const navigation = $('navigation');
navigation.addEventListener('input', event => {
  if (event.target.id !== 'playlist-search' || event.isComposing) return;
  playlistQuery = event.target.value; playlistSearchCollapsed.clear(); renderNav();
});
navigation.addEventListener('compositionend', event => {
  if (event.target.id !== 'playlist-search') return;
  playlistQuery = event.target.value; playlistSearchCollapsed.clear(); renderNav();
});
navigation.addEventListener('dragstart', event => {
  const node = event.target.closest('[data-drag-list],[data-drag-group]'); if (!node) return;
  dragItem = node.dataset.dragList ? { type: 'list', id: node.dataset.dragList, source: list(node.dataset.dragList)?.source } : { type: 'group', id: node.dataset.dragGroup };
  event.dataTransfer.setData('text/plain', dragItem.id); event.dataTransfer.effectAllowed = 'move'; node.classList.add('dragging');
});
navigation.addEventListener('dragover', event => {
  const target = dragItem?.type === 'list' ? event.target.closest('[data-drag-list]') : event.target.closest('[data-group]');
  if (!target || (dragItem.type === 'list' && list(target.dataset.dragList)?.source !== dragItem.source)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  navigation.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target')); target.classList.add('drop-target');
});
navigation.addEventListener('drop', async event => {
  event.preventDefault();
  const moving = dragItem; if (!moving) return;
  const target = moving.type === 'list' ? event.target.closest('[data-drag-list]') : event.target.closest('[data-group]');
  if (!target || (moving.type === 'list' && list(target.dataset.dragList)?.source !== moving.source)) return;
  const targetId = moving.type === 'list' ? target.dataset.dragList : target.dataset.group;
  if (moving.id === targetId) return;
  const ids = moving.type === 'list' ? orderedLists(moving.source).map(p => p.id) : orderedGroups();
  const from = ids.indexOf(moving.id), to = ids.indexOf(targetId); ids.splice(from, 1); ids.splice(to, 0, moving.id);
  const value = { groups: orderedGroups(), lists: Object.fromEntries(['own', 'qq', 'netease'].map(s => [s, orderedLists(s).map(p => p.id)])) };
  if (moving.type === 'list') value.lists[moving.source] = ids; else value.groups = ids;
  try { await saveLayout(value); }
  catch (error) { if (error.code === 'VERSION_CONFLICT') await refresh().catch(() => {}); toast(error.message); }
});
navigation.addEventListener('dragend', () => {
  dragItem = null; suppressPlaylistClick = true; setTimeout(() => { suppressPlaylistClick = false; }, 200);
  navigation.querySelectorAll('.dragging,.drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
});
window.harmonyDesktop?.onLyricsVisibility(visible => { desktopLyrics = visible; renderPlayer(); });
window.harmonyDesktop?.onLyricsNotice(message => toast(message));
window.harmonyDesktop?.onLyricsControl(action => {
  if (!user) return;
  const button = document.querySelector(`[data-action="${action}"]`); button?.click();
});
function modal(title, html) {
  stopQr();
  $('dialog-content').innerHTML = `<div class="dialog-header"><h2>${esc(title)}</h2>${ib('close', '关闭弹窗', 'close-dialog')}</div>${html}`;
  if (!$('dialog').open) $('dialog').showModal();
}
function newList(existing = null, addTrackId = '') {
  modal(existing ? '编辑歌单' : '新建歌单', `<p class="dialog-description">为喜欢的声音命名，${user.local ? '保存在本地' : '保存到你的账号'}。</p><form id="playlist-form" data-id="${existing?.id || ''}" data-version="${existing?.version || ''}" data-track="${addTrackId}"><label for="list-name">歌单名称</label><input id="list-name" name="name" maxlength="80" required autofocus placeholder="例如：午后，慢一点" value="${esc(existing?.name || '')}"><label for="list-description">歌单介绍</label><textarea id="list-description" maxlength="500" placeholder="记录属于这张歌单的心情">${esc(existing?.description || '')}</textarea><label for="list-color">封面颜色</label><select id="list-color">${[['sage', '鼠尾草绿'], ['orange', '日落橘'], ['blue', '深海蓝'], ['cream', '暖沙色'], ['pink', '灰玫瑰']].map(([key, text]) => `<option value="${key}" ${existing?.color === key ? 'selected' : ''}>${text}</option>`).join('')}</select><div class="form-error" id="dialog-error" role="alert"></div><div class="dialog-footer"><button type="button" class="btn" data-action="close-dialog">取消</button><button type="submit" class="btn primary">${existing ? '保存修改' : '创建歌单'}</button></div></form>`);
}
async function addToList(id) {
  const t = track(id); if (!t) return;
  if (continuingTrack?.id === id && !openedFiles.has(id)) return toast('这首歌来自本地模式，请在账号中搜索后加入歌单');
  if (openedFiles.has(id)) { [id] = await storedTrackIds([id]); await refresh(false); }
  modal('加入我的歌单', `<p class="dialog-description">${esc(t.title)} · ${esc(provider(t.provider))}</p>${library.playlists.filter(p => p.source === 'own').map(p => `<button class="choice" data-action="choose-list" data-id="${p.id}" data-track="${id}" ${p.trackIds.includes(id) ? 'disabled' : ''}><div class="mini-cover ${p.color}">♫</div><span>${esc(p.name)}<small>${p.trackIds.includes(id) ? '已经在这张歌单中' : p.trackIds.length + ' 首歌曲'}</small></span>${icon('plus')}</button>`).join('')}<button class="choice" data-action="new-list-with-track" data-id="${id}">${icon('plus')}<span>新建歌单并添加</span></button>`);
}
function addFromLibrary() {
  const p = list(playlistId); if (!p || p.source !== 'own') return;
  const choices = library.tracks.filter(t => continuingTrack?.id !== t.id && !openedFiles.has(t.id) && !p.trackIds.includes(t.id));
  modal('添加音乐', `<p class="dialog-description">添加到「${esc(p.name)}」</p>${choices.length ? choices.map(t => `<button class="choice" data-action="choose-list" data-id="${p.id}" data-track="${t.id}">${icon('music')}<span>${esc(t.title)}<small>${esc(t.artist)}</small></span>${icon('plus')}</button>`).join('') : '<p class="dialog-description">资料库中的歌曲已全部加入，或尚未打开音乐。</p>'}<button class="choice" data-action="import">${icon('plus')}<span>导入本地音乐</span></button>`);
}
async function replaceTracks(p, ids) {
  await api(`/playlists/${p.id}/tracks`, 'PUT', { version: p.version, trackIds: ids });
  await refresh();
}
async function skipFailedTrack(id, generation, message) {
  if (generation !== playbackGeneration || currentId !== id || !user) return;
  failedTracks.add(id);
  audio.pause();
  const index = queue.indexOf(id);
  const candidates = [...queue.slice(index + 1), ...queue.slice(0, index + 1)];
  const following = candidates.find(value => !failedTracks.has(value) && track(value));
  if (!following) {
    toast(`本轮歌曲均无法播放，已暂停。${message}，可选择歌曲重试。`);
    savePlayback(); renderPlayer(); return;
  }
  toast(`${message}，已跳到下一首`);
  await Promise.resolve();
  await play(following, undefined, true);
}
async function reportPlaybackError(id, generation) {
  if (!id || currentId !== id || generation !== playbackGeneration) return;
  if (playbackFailure) return playbackFailure;
  playbackFailure = (async () => {
    let message = '当前歌曲无法播放';
    try {
      if (openedFiles.has(id)) throw new Error('无法解码本地文件');
      const response = await fetch(`/api/tracks/${id}/audio`, { credentials: 'same-origin', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(3000) });
      if (!response.ok && response.headers.get('content-type')?.includes('application/json')) message = (await response.json()).error || message;
      else await response.body?.cancel();
    } catch {}
    await skipFailedTrack(id, generation, message);
  })();
  return playbackFailure;
}
function missingPlatforms(tracks) {
  return ['qq', 'netease'].filter(source => tracks.some(t => t?.provider === source && !t.canPlay) && !library.providers.some(p => p.id === source && p.connected));
}
function unavailableMusicNotice(tracks) {
  const missing = missingPlatforms(tracks);
  return missing.length ? `<div class="notice playback-connection-notice">${icon('info')}<span>${esc(missing.map(provider).join('、'))}尚未连接或授权已失效，对应歌曲暂不可播放。可连接任意可用账号。</span><button class="text-button" data-action="import-connection-settings">连接音乐平台</button></div>` : '';
}
async function play(id, ids, recovering = false) {
  const t = track(id);
  if (!t) return;
  if (!recovering) failedTracks.clear();
  const generation = ++playbackGeneration; playbackFailure = null;
  if (ids) queue = [...new Set(ids)];
  if (!queue.includes(id)) queue.push(id);
  const changed = currentId !== id;
  if (changed) { audio.pause(); pendingSeek = null; }
  const previous = track(currentId);
  currentId = id;
  if (!t.canPlay) {
    await skipFailedTrack(id, generation, '当前歌曲暂无可用音频'); return;
  }
  if (changed || audio.error || !audio.getAttribute('src')) {
    let source = `/api/tracks/${id}/audio`;
    if (t.localReference) {
      try {
        const file = await readLocalReference(t.localReference);
        if (generation !== playbackGeneration) return;
        if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
        source = t.blobUrl = URL.createObjectURL(file);
      } catch (error) { await skipFailedTrack(id, generation, error.message); return; }
    }
    if (previous?.blobUrl && previous.id !== id) { URL.revokeObjectURL(previous.blobUrl); delete previous.blobUrl; }
    audio.src = source;
  }
  if (lyricId !== id) void loadLyrics(id);
  applyPendingSeek();
  try { await audio.play(); } catch (error) {
    if (generation !== playbackGeneration) return;
    if (error.name === 'NotAllowedError') { audio.pause(); toast('点击播放按钮继续聆听'); }
    else if (error.name !== 'AbortError') await reportPlaybackError(id, generation);
    return;
  }
  if (generation !== playbackGeneration || currentId !== id) return;
  renderPlayer(); renderContent(); renderQueue(); savePlayback();
  try { if (!openedFiles.has(id) && continuingTrack?.id !== id) await api(`/tracks/${id}/recent`, 'POST', {}); if (user) library.recent = [id, ...library.recent.filter(x => x !== id)].slice(0, 50); }
  catch (error) { toast(error.message); }
}
function next(direction = 1, automatic = false) {
  if (!queue.length) return;
  if (automatic && playbackMode === 2) { audio.currentTime = 0; audio.play().catch(() => reportPlaybackError(currentId, playbackGeneration)); return; }
  const index = queue.indexOf(currentId);
  let destination = index + direction;
  if (playbackMode === 1 && queue.length > 1) {
    const others = queue.filter(id => id !== currentId); return play(others[Math.floor(Math.random() * others.length)]);
  }
  destination = (destination + queue.length) % queue.length; play(queue[destination]);
}
function renderPlayer() {
  const t = track(currentId);
  $('now-playing-info').innerHTML = `${trackCover(t)}<div><b>${t ? esc(t.title) : '把喜欢的音乐，收在一起。'}</b><small>${t ? esc(t.artist) + ' · ' + esc(provider(t.provider)) : '选择一首喜欢的歌'}</small></div>`;
  $('play-toggle').innerHTML = icon(audio.paused ? 'play' : 'pause'); $('play-toggle').setAttribute('aria-label', audio.paused ? '播放' : '暂停');
  const modes = ['列表循环', '随机播放', '单曲循环'];
  $('playback-mode').innerHTML = playbackMode === 1 ? icon('shuffle') : icon('repeat') + (playbackMode === 2 ? '<span class="single-repeat">1</span>' : '');
  const modeTip = modes[playbackMode] + ' · 点击切换为' + modes[(playbackMode + 1) % 3];
  $('playback-mode').setAttribute('aria-label', modeTip); $('playback-mode').title = modeTip;
  $('playback-mode-tip').textContent = modeTip;
  $('queue-button').classList.toggle('active', !$('queue-panel').hidden);
  $('desktop-lyrics').hidden = !window.harmonyDesktop;
  $('desktop-lyrics').classList.toggle('active', desktopLyrics);
  $('desktop-lyrics').setAttribute('aria-pressed', desktopLyrics);
  if (page === 'lyrics') renderLyricsPage();
  if (page === 'home') renderHomeLyrics();
  document.querySelectorAll('tr[data-track]').forEach(row => {
    row.classList.toggle('playing-row', row.dataset.track === currentId);
    row.classList.toggle('is-paused', audio.paused);
  });
  updateProgress();
}
function updateProgress() {
  $('elapsed').textContent = time(pendingSeek ?? audio.currentTime); $('duration').textContent = time(audio.duration);
  updateLyrics();
  $('seek').max = Number.isFinite(audio.duration) ? audio.duration : 100; $('seek').value = pendingSeek ?? (audio.currentTime || 0);
}
function renderQueue() {
  if ($('queue-panel').hidden) return;
  $('queue-panel').innerHTML = `<div class="button-row"><h2>待播队列 · ${queue.length}</h2>${ib('close', '关闭队列', 'queue')}</div>` + (queue.length ? queue.map(id => { const t = track(id); return t ? `<button class="choice ${currentId === id ? 'selected' : ''}" data-action="play-queued" data-id="${id}">${icon(currentId === id && !audio.paused ? 'volume' : 'music')}<span>${esc(t.title)}<small>${esc(t.artist)}</small></span></button>` : ''; }).join('') : '<p class="dialog-description">播放歌曲后，会出现在这里。</p>');
}

async function handleAction(button) {
  const action = button.dataset.action, id = button.dataset.id;
  switch (action) {
    case 'reset-shortcuts': if (window.harmonyDesktop?.setPreferences) await window.harmonyDesktop.setPreferences({ shortcuts: defaultShortcuts }); shortcuts = { ...defaultShortcuts }; try { localStorage.setItem('harmony-shortcuts', JSON.stringify(shortcuts)); } catch {} renderContent(); toast('已恢复默认快捷键'); return;
    case 'clear-selection': selectedTracks.clear(); updateSelection(); return;
    case 'select-page': displayedTracks.forEach(id => selectedTracks.add(id)); updateSelection(); return;
    case 'bulk-add': {
      const ids = [...selectedTracks];
      const eligible = ids.filter(id => continuingTrack?.id !== id);
      modal('批量加入歌单', `<p class="dialog-description">已选 ${ids.length} 首，可添加 ${eligible.length} 首。${eligible.length < ids.length ? '正在续播的其他账号歌曲需重新搜索后添加。' : ''}</p>${library.playlists.filter(p => p.source === 'own').map(p => `<button class="choice" data-action="bulk-choose-list" data-id="${esc(p.id)}" data-tracks="${esc(JSON.stringify(eligible))}" ${eligible.length ? '' : 'disabled'}>${icon('playlist')}<span>${esc(p.name)}</span>${icon('plus')}</button>`).join('') || '<p class="dialog-description">请先新建歌单。</p>'}`);
      return;
    }
    case 'bulk-choose-list': {
      const p = list(id); if (!p || p.source !== 'own') return;
      await replaceTracks(p, [...new Set([...p.trackIds, ...await storedTrackIds(JSON.parse(button.dataset.tracks))])]);
      $('dialog').close(); selectedTracks.clear(); updateSelection(); toast('所选歌曲已加入歌单'); return;
    }
    case 'bulk-delete': {
      if (!canDeleteSelection()) return;
      const detail = page === 'favorites' ? '取消所选歌曲的收藏，刷新列表后隐藏。' : page === 'playlist' ? '从当前自建歌单移除所选歌曲。' : page === 'local' ? '移除所选本地音乐索引，原音乐文件保留。' : '从和音资料库删除所选歌曲，同时移除歌单、收藏和最近播放中的关联。本地引用只移除索引，账号内上传的音频也会删除。';
      modal('删除所选歌曲？', `<p class="dialog-description">共 ${selectedTracks.size} 首。${detail}</p><div class="dialog-footer"><button class="btn" data-action="close-dialog">取消</button><button class="btn danger" data-action="confirm-bulk-delete">确认删除</button></div>`); return;
    }
    case 'confirm-bulk-delete': case 'bulk-favorite': {
      const ids = [...selectedTracks];
      if (!ids.length || selectionBusy) return;
      selectionBusy = true;
      try {
        if (action === 'bulk-favorite') {
          for (const id of ids) { await toggleFavorite(id, true); selectedTracks.delete(id); }
        } else await bulkDelete(ids);
        $('dialog').close(); toast('批量操作完成');
      } catch (error) { toast(`操作中断，未完成 ${selectedTracks.size} 首：${error.message}`); }
      finally {
        selectionBusy = false;
        await refresh(false); renderNav(); renderContent(); renderPlayer(); updateSelection();
      }
      return;
    }
    case 'toggle-playlist-group': case 'toggle-all-playlist-groups': {
      const sources = ['own', 'qq', 'netease'];
      if (action === 'toggle-playlist-group' && !sources.includes(id)) return;
      const collapsed = new Set(playlistQuery.trim() ? playlistSearchCollapsed : layout().collapsed || []);
      if (action === 'toggle-all-playlist-groups') {
        const close = sources.some(source => !collapsed.has(source));
        sources.forEach(source => close ? collapsed.add(source) : collapsed.delete(source));
      } else if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      if (playlistQuery.trim()) { playlistSearchCollapsed = collapsed; renderNav(); }
      else await saveLayout({ groups: orderedGroups(), lists: Object.fromEntries(sources.map(source => [source, orderedLists(source).map(p => p.id)])), collapsed: [...collapsed] }, '歌单分组状态已保存');
      document.querySelector(action === 'toggle-playlist-group' ? `[data-action="toggle-playlist-group"][data-id="${id}"]` : '[data-action="toggle-all-playlist-groups"]')?.focus({ preventScroll: true });
      return;
    }
    case 'clear-track-list-search': {
      const input = $('track-list-search');
      input.value = ''; updateTrackListSearch(input); input.focus({ preventScroll: true }); return;
    }
    case 'clear-playlist-search': playlistQuery = ''; playlistSearchCollapsed.clear(); renderNav(); $('playlist-search').focus({ preventScroll: true }); return;
    case 'retry-collection': await loadCollection(); return;
    case 'navigate': navigate(id); if (id === 'search') { $('search').focus(); await searchPlatforms(); } return;
    case 'clear-search': clearTimeout(searchTimer); $('search').value = ''; query = ''; $('clear-search').hidden = true; navigate('search'); await searchPlatforms(); $('search').focus(); return;
    case 'desktop-lyrics': desktopLyrics = await window.harmonyDesktop.setLyricsVisible(!desktopLyrics); renderPlayer(); updateLyrics(true); return;
    case 'seek-lyric': audio.currentTime = Number(button.dataset.time); updateLyrics(true); return;
    case 'retry-lyrics': if (currentId) await loadLyrics(currentId); return;
    case 'export-favorites': case 'export-playlists': {
      const favoritesOnly = action === 'export-favorites';
      const filename = `${favoritesOnly ? '和音喜欢的歌曲' : '和音歌单'}-${new Date().toLocaleDateString('sv-SE')}.hy`;
      try {
        // Open the browser picker before any network await consumes user activation.
        let handle;
        if (!window.harmonyDesktop?.savePlaylistFile) {
          if (!window.showSaveFilePicker) throw new Error('当前浏览器不支持选择保存位置，请使用 Chrome、Edge 或 Windows 客户端导出');
          handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: '和音歌单', accept: { 'application/json': ['.hy'] } }], excludeAcceptAllOption: true });
        }
        const data = await api('/playlists/export');
        if (favoritesOnly) data.playlists = [];
        const content = JSON.stringify(data, null, 2);
        if (handle) {
          const writable = await handle.createWritable();
          try { await writable.write(content); await writable.close(); }
          catch (error) { await writable.abort().catch(() => {}); throw error; }
        } else if (!await window.harmonyDesktop.savePlaylistFile({ filename, content })) return;
        toast(favoritesOnly ? `已导出 ${data.favorites.length} 首喜欢的歌曲` : `已导出喜欢列表和 ${data.playlists.length} 张自建歌单`);
      } catch (error) { if (error.name !== 'AbortError') toast('导出未完成：' + error.message); }
      return;
    }
    case 'import-playlists': if (!importingPlaylists) $('playlist-file-input').click(); return;
    case 'connect-import-platform': navigate('settings'); await startProviderQr(id); return;
    case 'import-connection-settings': $('dialog').close(); navigate('settings'); return;
    case 'home': case 'tracks': case 'library': case 'settings': case 'lyrics': case 'downloads': navigate(action); return;
    case 'open-list': {
      const p = list(id); if (!p) return;
      navigate('playlist', id);
      if (p.source !== 'own' && !p.loadedAt) { syncStatus('正在读取平台歌单…'); await api(`/platform-playlists/${id}/refresh`, 'POST', {}); await refresh(); }
      return;
    }
    case 'connect-provider': await startProviderQr(id); return;
    case 'refresh-qr': await startProviderQr(id); return;
    case 'sync-provider': { const result = await api(`/providers/${id}/sync`, 'POST', {}); await refresh(); toast(`已同步 ${result.count} 张平台歌单`); return; }
    case 'refresh-platform-list': { await api(`/platform-playlists/${playlistId}/refresh`, 'POST', {}); await refresh(); toast('平台歌曲已刷新'); return; }
    case 'disconnect-provider': modal('解除平台连接？', `<p class="dialog-description">将清除和音保存的${esc(provider(id))}登录凭据和平台歌单缓存。你自己歌单中已添加的歌曲记录仍会保留。</p><div class="dialog-footer"><button class="btn" data-action="close-dialog">取消</button><button class="btn danger" data-action="confirm-disconnect-provider" data-id="${id}">解除连接</button></div>`); return;
    case 'confirm-disconnect-provider': await api(`/providers/${id}`, 'DELETE', {}); $('dialog').close(); if (track(currentId)?.provider === id) stopPlayback(); await refresh(); toast('已解除平台连接'); return;
    case 'new-list': newList(); return;
    case 'edit-list': newList(list(id)); return;
    case 'new-list-with-track': newList(null, id); return;
    case 'close-dialog': $('dialog').close(); return;
    case 'add-to-list': await addToList(id); return;
    case 'add-from-library': addFromLibrary(); return;
    case 'choose-list': {
      const p = list(id), trackId = button.dataset.track;
      if (!p || p.trackIds.includes(trackId)) return;
      await replaceTracks(p, [...p.trackIds, trackId]); $('dialog').close(); toast(user.local ? '已加入歌单并保存在本地' : '已加入歌单并保存到账号'); return;
    }
    case 'delete-list': {
      const p = list(id); if (!p) return;
      modal('删除这张歌单？', `<p class="dialog-description">「${esc(p.name)}」将从当前账号删除。音乐文件和其他歌单不受影响。</p><div class="dialog-footer"><button class="btn" data-action="close-dialog">取消</button><button class="btn danger" data-action="confirm-delete-list" data-id="${id}" data-version="${p.version}">删除歌单</button></div>`); return;
    }
    case 'confirm-delete-list': await api(`/playlists/${id}`, 'DELETE', { version: Number(button.dataset.version) }); $('dialog').close(); await refresh(false); navigate('library'); toast('歌单已从账号删除'); return;
    case 'play': await play(id, displayedTracks); return;
    case 'play-queued': await play(id); return;
    case 'play-all': {
      const items = page === 'home' ? collectionTracks() : visibleTracks(); if (items.length) await play(items[0].id, items.map(t => t.id)); return;
    }
    case 'toggle-play': if (!audio.paused) audio.pause(); else if (currentId) await play(currentId); else if (collectionTracks().length) await play(collectionTracks()[0].id, collectionTracks().map(t => t.id)); else toast('导入本地音乐或连接音乐平台，再开始聆听'); return;
    case 'next': next(); return;
    case 'previous': if (audio.currentTime > 3) audio.currentTime = 0; else next(-1); return;
    case 'playback-mode': playbackMode = (playbackMode + 1) % 3; savePlayback(); renderPlayer(); return;
    case 'queue': $('queue-panel').hidden = !$('queue-panel').hidden; renderQueue(); renderPlayer(); return;
    case 'favorite': await toggleFavorite(id); return;
    case 'download': {
      const t = track(id); if (!t?.canDownload) return;
      const entry = { title: t.title, bytes: t.bytes, status: '正在下载…' }; downloads.unshift(entry);
      try {
      const response = await fetch(`/api/tracks/${id}/audio?download=1`, { credentials: 'same-origin' });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || '下载失败'); }
      const blob = await response.blob(); entry.bytes = blob.size; entry.status = '已交给系统保存';
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = blobUrl; link.download = t.title + t.fileExtension;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(blobUrl), 60000); toast('已交给系统保存，可在下载管理查看大小');
      } catch (error) { entry.status = '下载失败：' + error.message; throw error; }
      finally { if (page === 'downloads') renderContent(); } return;
    }
    case 'track-more': {
      const t = track(id); if (!t) return;
      modal(t.title, `<p class="dialog-description">${esc(t.artist)} · ${esc(provider(t.provider))}</p><button class="choice" data-action="add-to-list" data-id="${id}">${icon('plus')}<span>加入歌单</span></button>${page === 'playlist' && list(playlistId)?.source === 'own' ? `<button class="choice" data-action="move-up" data-id="${id}">${icon('up')}<span>在歌单中上移</span></button><button class="choice" data-action="move-down" data-id="${id}">${icon('down')}<span>在歌单中下移</span></button><button class="choice" data-action="remove-from-list" data-id="${id}">${icon('close')}<span>从歌单删除</span></button>` : ''}${page === 'favorites' ? `<button class="choice" data-action="remove-favorite" data-id="${id}">${icon('heart')}<span>从喜欢列表删除</span></button>` : ''}`); return;
    }
    case 'remove-favorite': await toggleFavorite(id, false); $('dialog').close(); toast('已从喜欢列表删除'); return;
    case 'move-up': case 'move-down': {
      const p = list(playlistId); if (!p) return;
      const ids = [...p.trackIds], i = ids.indexOf(id), j = i + (action === 'move-up' ? -1 : 1);
      if (j < 0 || j >= ids.length) return toast(j < 0 ? '已经是第一首' : '已经是最后一首');
      [ids[i], ids[j]] = [ids[j], ids[i]]; await replaceTracks(p, ids); $('dialog').close(); toast('曲目顺序已保存'); return;
    }
    case 'remove-from-list': { const p = list(playlistId); if (p) await replaceTracks(p, p.trackIds.filter(x => x !== id)); $('dialog').close(); toast('已从歌单移除'); return; }
    case 'view-provider-playlists': if (['qq', 'netease'].includes(id)) { libraryTab = id; navigate('library'); $('library-tab-' + id)?.focus({ preventScroll: true }); } return;
    case 'library-tab': if (['own', 'qq', 'netease'].includes(id)) { libraryTab = id; renderContent(); $('library-tab-' + id)?.focus({ preventScroll: true }); } return;
    case 'providers': navigate('providers'); return;
    case 'account-mode': accountLogin(); return;

    case 'search-more': await searchPlatforms(true); return;
    case 'filter-track-list': {
      trackListPlatform = id;
      for (const option of button.parentElement.querySelectorAll('button')) {
        const selected = option === button;
        option.classList.toggle('active', selected);
        option.setAttribute('aria-pressed', selected);
      }
      $('track-list-results').innerHTML = trackListResults();
      return;
    }
    case 'filter': filter = id; await searchPlatforms(); return;
    case 'import': $('dialog').close(); navigate('local'); return;
    case 'import-files': await importLocal('files'); return;
    case 'import-folder': await importLocal('folder'); return;
    case 'refresh': favoritesSnapshot = null; await refresh(); toast('资料库已同步'); return;
    case 'theme': theme = id; document.documentElement.dataset.theme = id; try { localStorage.setItem('harmony-theme', id); } catch {} renderContent(); return;
    case 'logout': modal('退出当前账号？', '<p class="dialog-description">歌单和音乐已保存在账号中。重新登录即可继续使用。</p><div class="dialog-footer"><button class="btn" data-action="close-dialog">取消</button><button class="btn primary" data-action="confirm-logout">退出登录</button></div>'); return;
    case 'confirm-logout': await api('/auth/logout', 'POST', {}); showAuth(); toast('已退出登录'); return;
    case 'password': modal('修改密码', '<p class="dialog-description">修改后其他设备会退出登录，当前设备保持登录。</p><form id="password-form"><label for="old-password">当前密码</label><input id="old-password" type="password" autocomplete="current-password" required maxlength="128"><label for="new-password">新密码</label><input id="new-password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required><label for="new-password-confirm">确认新密码</label><input id="new-password-confirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required><div class="form-error" id="dialog-error" role="alert"></div><div class="dialog-footer"><button type="button" class="btn" data-action="close-dialog">取消</button><button type="submit" class="btn primary">保存新密码</button></div></form>'); return;
  }
}
document.addEventListener('click', async event => {
  const checkbox = event.target.closest('[data-select-track],[data-select-page]');
  if (checkbox) {
    if (selectionBusy) { event.preventDefault(); return; }
    if (checkbox.hasAttribute('data-select-page')) {
      displayedTracks.forEach(id => checkbox.checked ? selectedTracks.add(id) : selectedTracks.delete(id)); updateSelection();
    } else selectTrack(checkbox.dataset.selectTrack, checkbox.checked, event.shiftKey);
    return;
  }
  const authButton = event.target.closest('[data-auth]'); if (authButton) return setAuthMode(authButton.dataset.auth);
  const button = event.target.closest('[data-action]');
  if (button?.tagName === 'A') event.preventDefault();
  if (selectionBusy && (button || event.target.closest('tr[data-track]'))) return;
  if (!button) {
    const row = event.target.closest('tr[data-track]');
    if (row && !event.target.closest('button,a,input,select,textarea') && user) {
      if (event.shiftKey || selectedTracks.size) selectTrack(row.dataset.track, !selectedTracks.has(row.dataset.track), event.shiftKey);
      else await play(row.dataset.track, displayedTracks);
    }
    return;
  }
  if (button.disabled) return;
  if (['open-list', 'toggle-playlist-group'].includes(button.dataset.action) && suppressPlaylistClick) return;
  if (button.dataset.action === 'close-dialog') { $('dialog').close(); return; }
  if (!user) return;
  button.disabled = true;
  try { await handleAction(button); }
  catch (error) {
    if (error.code === 'VERSION_CONFLICT') { $('dialog').close(); await refresh().catch(() => {}); }
    if (error.code === 'PROVIDER_AUTH_EXPIRED') await refresh().catch(() => {});
    toast(error.message);
  } finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['playlist-form', 'password-form', 'account-login-form'].includes(form.id)) return;
  event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true;
  $('dialog-error').textContent = '';
  try {
    if (form.id === 'account-login-form') {
      const retained = track(currentId);
      const input = { username: $('account-username').value.trim(), password: $('account-password').value, remember: true, continueTrackId: retained?.id };
      const result = await window.harmonyDesktop?.loginAccount?.(input) || await api('/auth/login', 'POST', input);
      await window.harmonyDesktop?.accountSignedIn?.();
      continuingTrack = retained ? { ...retained, canDownload: false, downloadReason: '当前歌曲来自本地模式' } : null;
      clearTimeout(searchTimer); searchGeneration++; remoteResults = []; searchErrors = []; searchBusy = false;
      playlistId = ''; page = 'settings'; query = ''; $('search').value = '';
      stopQr();
      await enter(result.user); $('dialog').close(); toast('登录成功，音乐继续播放');
    } else if (form.id === 'playlist-form') {
      const data = { name: $('list-name').value.trim(), description: $('list-description').value.trim(), color: $('list-color').value };
      const id = form.dataset.id;
      let p;
      if (id) p = (await api(`/playlists/${id}`, 'PATCH', { ...data, version: Number(form.dataset.version) })).playlist;
      else p = (await api('/playlists', 'POST', data)).playlist;
      if (form.dataset.track) {
        // Keep the newly created playlist ID if adding a song fails, so retry does not create a duplicate.
        form.dataset.id = p.id; form.dataset.version = p.version;
        await api(`/playlists/${p.id}/tracks`, 'PUT', { version: p.version, trackIds: [form.dataset.track] });
      }
      await refresh(false); $('dialog').close(); navigate('playlist', p.id); toast(id ? '歌单修改已保存' : user.local ? '新歌单已保存在本地' : '新歌单已保存到账号');
    } else {
      if ($('new-password').value !== $('new-password-confirm').value) throw new Error('两次输入的新密码不一致');
      await api('/auth/password', 'POST', { currentPassword: $('old-password').value, newPassword: $('new-password').value });
      $('dialog').close(); toast('密码已更新，其他设备已退出登录');
    }
  } catch (error) {
    if (error.code === 'VERSION_CONFLICT') { $('dialog').close(); await refresh().catch(() => {}); toast(error.message); }
    else if ($('dialog-error')) $('dialog-error').textContent = error.message;
    else toast(error.message);
  } finally { button.disabled = false; }
});
function addLocalRecords(records) {
  for (const record of records) {
    if (openedFiles.has(record.id)) continue;
    const t = { id: record.id, provider: 'local', title: record.name.replace(/\.[^.]+$/, ''), artist: '本地文件', album: '', canPlay: true, canDownload: false, downloadReason: '本地文件无需下载', localReference: record };
    openedFiles.set(t.id, t);
    if (!library.tracks.some(x => x.id === t.id)) library.tracks.push(t);
  }
}
let importingLocal = false;
async function importLocal(kind) {
  if (importingLocal) return;
  importingLocal = true;
  try {
    const before = openedFiles.size;
    const records = await selectLocalReferences(kind);
    if (records === undefined) { $(kind === 'folder' ? 'folder-input' : 'file-input').click(); return; }
    if (records === null) return;
    addLocalRecords(records); renderNav(); renderContent();
    toast(`已新增 ${openedFiles.size - before} 首本地音乐，仅记录文件位置`);
  } catch (error) { if (error.name !== 'AbortError') toast(error.message); }
  finally { importingLocal = false; }
}
$('playlist-file-input').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || importingPlaylists || !user) return;
  const expectedEpoch = epoch;
  importingPlaylists = true;
  if (page === 'library') renderContent();
  try {
    if (!/\.hy$/i.test(file.name)) throw new Error('请选择 .hy 格式的和音歌单文件');
    if (file.size > 20 * 1024 * 1024) throw new Error('歌单文件不能超过 20 MB');
    let data;
    try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
    catch { throw new Error('文件无法读取，请选择和音导出的 .hy 歌单文件'); }
    if (expectedEpoch !== epoch || !user) return;
    const result = await api('/playlists/import', 'POST', data);
    if (expectedEpoch !== epoch || !user) return;
    await refresh();
    const summary = `新建 ${result.created} 张，合并 ${result.merged} 张，新增 ${result.added} 条收藏，跳过 ${result.skipped} 条重复`;
    const importedNames = new Set(data.playlists.map(p => p.name.trim().normalize('NFC')));
    const importedIds = new Set([...library.favorites, ...library.playlists.filter(p => p.source === 'own' && importedNames.has(p.name)).flatMap(p => p.trackIds)]);
    const importedTracks = library.tracks.filter(t => importedIds.has(t.id));
    const missing = missingPlatforms(importedTracks);
    const localMissing = importedTracks.some(t => t.provider === 'local' && !t.canPlay);
    modal('歌单导入完成', `<p class="dialog-description">${esc(summary)}</p>${unavailableMusicNotice(importedTracks)}${localMissing ? '<p class="dialog-description">部分本地歌曲缺少原音频。歌单文件仅包含歌曲记录，不含音频文件。</p>' : ''}<p class="dialog-description">播放使用当前连接的平台账号。实际播放仍受平台版权、会员权限及网络状态影响。</p><div class="dialog-footer"><button class="btn primary" data-action="close-dialog">完成</button>${missing.length ? '<button class="btn" data-action="import-connection-settings">连接音乐平台</button>' : ''}</div>`);
  } catch (error) { if (expectedEpoch === epoch) toast(error.message); }
  finally { importingPlaylists = false; if (user && page === 'library') renderContent(); }
});
for (const input of ['file-input', 'folder-input']) $(input).addEventListener('change', event => {
  if (!user) return;
  const records = [...event.target.files].filter(file => /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(file.name)).map(file => ({ id: 'file-' + file.name + '-' + file.size + '-' + file.lastModified, name: file.name, path: file.webkitRelativePath || file.name, file }));
  addLocalRecords(records); event.target.value = ''; navigate('local');
  toast('已添加文件引用；此浏览器不支持持久授权，刷新后需重新选择');
});
$('guest-start').hidden = !(window.harmonyDesktop || window.harmonyPreview);
$('guest-hint').hidden = !(window.harmonyDesktop || window.harmonyPreview);
$('guest-start').onclick = async () => {
  const button = $('guest-start'); button.disabled = true; $('auth-error').textContent = '';
  try { const result = await (window.harmonyDesktop || window.harmonyPreview).startLocalMode(); location.assign(result.redirect); }
  catch (error) { $('auth-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('search-form').onsubmit = event => { event.preventDefault(); if (!composing) submitSearch(); };
$('content').addEventListener('input', event => {
  if (event.target.id === 'track-list-search') {
    if (!event.isComposing) updateTrackListSearch(event.target);
    return;
  }
  if (event.target.id !== 'empty-search') return;
  clearTimeout(searchTimer);
  $('search').value = event.target.value;
  $('clear-search').hidden = !event.target.value;
});
$('content').addEventListener('compositionstart', event => { if (event.target.id === 'empty-search') composing = true; });
$('content').addEventListener('compositionend', event => {
  if (event.target.id === 'track-list-search') updateTrackListSearch(event.target);
  if (event.target.id === 'empty-search') composing = false;
});
$('content').addEventListener('submit', event => {
  if (event.target.id !== 'empty-search-form') return;
  event.preventDefault();
  if (composing) return;
  $('search').value = $('empty-search').value;
  submitSearch();
  ($('empty-search') || $('search')).focus();
});
$('search').addEventListener('input', () => { if ($('empty-search')) $('empty-search').value = $('search').value; });
$('search').addEventListener('input', () => { $('clear-search').hidden = !$('search').value; clearTimeout(searchTimer); if (!composing) searchTimer = setTimeout(submitSearch, 450); });
$('search').addEventListener('compositionstart', () => { composing = true; clearTimeout(searchTimer); });
$('search').addEventListener('compositionend', () => { composing = false; clearTimeout(searchTimer); searchTimer = setTimeout(submitSearch, 450); });
$('dialog').addEventListener('close', () => { if (!$('dialog').open) stopQr(); });
$('seek').oninput = () => { if (Number.isFinite(audio.duration)) audio.currentTime = Number($('seek').value); };
$('volume').oninput = () => { audio.volume = Number($('volume').value); };
audio.addEventListener('timeupdate', () => {
  updateProgress();
  if (!audio.paused && audio.currentTime > 1) failedTracks.clear();
  if (Date.now() - lastPlaybackSave > 1000) { savePlayback(); lastPlaybackSave = Date.now(); }
});
audio.addEventListener('loadedmetadata', () => { applyPendingSeek(); updateProgress(); });
audio.addEventListener('seeked', savePlayback);
audio.addEventListener('volumechange', savePlayback);
window.addEventListener('pagehide', savePlayback);
window.addEventListener('beforeunload', savePlayback);
audio.addEventListener('play', renderPlayer);
audio.addEventListener('pause', () => { renderPlayer(); savePlayback(); });
audio.addEventListener('ended', () => next(1, true));
audio.addEventListener('error', () => { if (currentId && audio.error) void reportPlaybackError(currentId, playbackGeneration); });
document.addEventListener('change', async event => {
  if (event.target.id !== 'close-action') return;
  const previous = closeAction;
  try {
    const value = event.target.value;
    if (window.harmonyDesktop?.setPreferences) await window.harmonyDesktop.setPreferences({ closeAction: value });
    localStorage.setItem('harmony-close-action', value); closeAction = value; toast('关闭行为已保存');
  } catch (error) { event.target.value = previous; toast(error.message); }
});
document.addEventListener('keydown', async event => {
  const capture = event.target.closest?.('[data-shortcut]');
  if (capture) {
    if (event.key === 'Tab') return;
    event.preventDefault();
    if (event.key === 'Escape') { capture.blur(); return; }
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    const value = shortcutValue(event);
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !['Space', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious'].includes(event.code)) { toast('请使用 Ctrl、Alt 组合键，或空格 / 媒体键'); return; }
    if (['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+R', 'Ctrl+W', 'Ctrl+Q', 'Alt+F4'].includes(value)) { toast('请避开常用编辑与系统快捷键'); return; }
    if (Object.entries(shortcuts).some(([id, key]) => id !== capture.dataset.shortcut && key === value)) { toast('这个快捷键已用于其他操作'); return; }
    const nextShortcuts = { ...shortcuts, [capture.dataset.shortcut]: value };
    try {
      if (window.harmonyDesktop?.setPreferences) await window.harmonyDesktop.setPreferences({ shortcuts: nextShortcuts });
      localStorage.setItem('harmony-shortcuts', JSON.stringify(nextShortcuts)); shortcuts = nextShortcuts;
    } catch (error) { toast(error.message); return; }
    capture.value = value; toast('快捷键已保存'); return;
  }

  const libraryTabButton = event.target.closest?.('[role="tab"][data-action="library-tab"]');
  if (libraryTabButton && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const tabs = [...document.querySelectorAll('.library-tabs [role="tab"]')], index = tabs.indexOf(libraryTabButton);
    tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].click(); return;
  }
  if (!user || $('dialog').open) return;
  const row = event.target.closest?.('tr[data-track]');
  if (row && event.target === row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); void play(row.dataset.track, visibleTracks().map(t => t.id)); return; }
  if (event.key === 'Escape' && event.target.id === 'playlist-search') { event.preventDefault(); playlistQuery = ''; playlistSearchCollapsed.clear(); renderNav(); $('playlist-search').focus({ preventScroll: true }); return; }
  if (event.key === 'Escape' && event.target === $('search')) { clearTimeout(searchTimer); $('search').blur(); return; }
  if (event.key === 'Escape' && selectedTracks.size) { selectedTracks.clear(); updateSelection(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.target.closest('input,textarea,select,[contenteditable="true"]') && displayedTracks.length) {
    event.preventDefault(); displayedTracks.forEach(id => selectedTracks.add(id)); updateSelection(); return;
  }
  if (!event.target.closest('input,textarea,select,[contenteditable="true"]') && !(event.code === 'Space' && event.target.closest('button'))) {
    const action = Object.keys(shortcuts).find(id => shortcuts[id] === shortcutValue(event));
    if (action && !event.repeat) {
      event.preventDefault();
      if (action === 'search') { $('search').focus(); $('search').select(); }
      else if (action === 'new-list') newList();
      else void handleAction({ dataset: { action } }).catch(error => toast(error.message));
      return;
    }
  }
  if (event.key === 'Escape') { $('queue-panel').hidden = true; renderPlayer(); }
});
window.addEventListener('focus', () => { if (user && !$('dialog').open) refresh(false).then(() => { renderNav(); renderContent(); renderPlayer(); renderQueue(); }).catch(error => syncStatus(error.message, true)); });
for (const name of ['previous', 'next']) $(name).innerHTML = icon(name);
$('volume-icon').innerHTML = icon('volume'); $('queue-button').innerHTML = icon('queue'); $('search-icon').innerHTML = icon('search'); renderPlayer();
try { await window.harmonyPreview?.ready; await enter((await api('/me')).user); }
catch (error) { if (user) { syncStatus('连接失败，请重试', true); $('content').innerHTML = empty('cloud', '资料库读取失败', error.message, '重新加载', 'refresh'); } else showAuth(error.code === 'UNAUTHENTICATED' ? '' : error.message); }
