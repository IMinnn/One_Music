const $ = id => document.getElementById(id);
let fontSize = Math.max(20, Math.min(42, Number(localStorage.getItem('lyric-size')) || 30));
function resize(delta = 0) { fontSize = Math.max(20, Math.min(42, fontSize + delta)); document.documentElement.style.setProperty('--lyric-size', fontSize + 'px'); localStorage.setItem('lyric-size', fontSize); }
resize();
$('smaller').onclick = () => resize(-2); $('larger').onclick = () => resize(2);
document.addEventListener('click', event => { const button = event.target.closest('[data-control]'); if (button) window.lyricsOverlay.control(button.dataset.control); });
window.lyricsOverlay.onData(data => { $('title').textContent = data.title; $('line').textContent = data.line; $('next').textContent = data.next; $('play').textContent = data.playing ? '暂停' : '播放'; });
window.lyricsOverlay.onLock(locked => $('overlay').classList.toggle('locked', locked));
