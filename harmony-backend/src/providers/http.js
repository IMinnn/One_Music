import { ApiError } from '../security.js';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export function cookiesFrom(headers, previous = '') {
  const jar = new Map(previous.split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';')[0], i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
}
export const cookieValue = (cookie, key) => cookie.split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length + 1) || '';

// Login responses can set a valid cookie for a narrow domain and clear the
// same name for a parent domain. Resolve scopes before making a Cookie header.
export function cookiesForUrl(headers, responseUrl, destinationUrl) {
  const source = new URL(responseUrl), target = new URL(destinationUrl), jar = new Map();
  const matches = (host, domain) => host === domain || host.endsWith('.' + domain);
  for (const line of headers.getSetCookie()) {
    const [pair, ...parts] = line.split(';'), equals = pair.indexOf('=');
    if (equals <= 0) continue;
    const name = pair.slice(0, equals).trim(), value = pair.slice(equals + 1).trim();
    const attributes = new Map(parts.map(part => {
      const i = part.indexOf('=');
      return [part.slice(0, i < 0 ? undefined : i).trim().toLowerCase(), i < 0 ? '' : part.slice(i + 1).trim()];
    }));
    const domain = (attributes.get('domain') || source.hostname).toLowerCase().replace(/^\./, '');
    if (!matches(source.hostname, domain)) continue;
    const path = attributes.get('path')?.startsWith('/') ? attributes.get('path') : source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1) || '/';
    const key = `${domain}:${path}:${name}`;
    const maxAge = attributes.get('max-age'), expires = attributes.get('expires');
    const deleted = !value || (maxAge !== undefined ? Number(maxAge) <= 0 : expires && Date.parse(expires) <= Date.now());
    jar.set(key, { name, value, domain, path, deleted, hostOnly: !attributes.has('domain'), secure: attributes.has('secure') });
  }
  const selected = new Map();
  for (const c of [...jar.values()].sort((a, b) => b.path.length - a.path.length || b.domain.length - a.domain.length)) {
    if (c.deleted || (c.secure && target.protocol !== 'https:') || (c.hostOnly ? target.hostname !== c.domain : !matches(target.hostname, c.domain))) continue;
    if (target.pathname !== c.path && !(target.pathname.startsWith(c.path) && (c.path.endsWith('/') || target.pathname[c.path.length] === '/'))) continue;
    if (!selected.has(c.name)) selected.set(c.name, c.value);
  }
  return [...selected].map(([name, value]) => `${name}=${value}`).join('; ');
}

export async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': UA, ...options.headers } });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new ApiError(502, '音乐平台响应超时，请检查网络后重试', 'PROVIDER_UNAVAILABLE');
    throw new ApiError(502, '暂时无法连接音乐平台，请检查网络后重试', 'PROVIDER_UNAVAILABLE');
  }
  if (response.status >= 400) throw new ApiError(502, `音乐平台请求失败（${response.status}），请稍后重试`, 'PROVIDER_UNAVAILABLE');
  return response;
}
export async function readJson(response) {
  try { return await response.json(); }
  catch { throw new ApiError(502, '音乐平台返回了无法识别的数据，请稍后重试', 'PROVIDER_UNAVAILABLE'); }
}
export function authError() { return new ApiError(401, '平台授权已失效，请重新扫码登录', 'PROVIDER_AUTH_EXPIRED'); }
export function safeMediaUrl(input) {
  let url; try { url = new URL(input); } catch { throw new ApiError(502, '平台未返回可用音频'); }
  const allowed = ['music.126.net', 'qqmusic.qq.com', 'stream.qqmusic.tc.qq.com', 'aqqmusic.tc.qq.com'];
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port)) || !allowed.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)))
    throw new ApiError(502, '平台音频地址不在允许的域名范围内');
  url.protocol = 'https:'; url.port = ''; return url.href;
}
