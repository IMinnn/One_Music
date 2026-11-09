async function setLocalSession(profile, target, localGuestKey) {
  const oldCookies = await profile.cookies.get({ url: target, name: 'harmony_session' });
  const response = await fetch(target + '/api/auth/guest', { method: 'POST', headers: { Origin: target, 'Content-Type': 'application/json', 'X-Harmony-Local-Key': localGuestKey, Cookie: oldCookies.map(c => c.name + '=' + c.value).join('; ') }, body: '{}' });
  if (!response.ok) throw new Error('本地模式暂时无法打开');
  const cookie = response.headers.get('set-cookie')?.match(/^harmony_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error('本地会话建立失败');
  await profile.cookies.set({ url: target, name: 'harmony_session', value: cookie, path: '/', httpOnly: true, sameSite: 'strict', expirationDate: Date.now() / 1000 + 30 * 86400 });
  await profile.cookies.flushStore();
}

module.exports = { setLocalSession };
