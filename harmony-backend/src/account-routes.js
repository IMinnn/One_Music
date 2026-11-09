import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { ApiError, digest, rateLimit } from './security.js';
import { validateUsername, validatePassword, hashPassword, checkPassword, dummyHash } from './account-security.js';

export function createAccountRoutes({ db, providers, secure, session, setSession, ownTrack, tokenFrom, body, json }) {
  const playbackContinuations = new Map();
  return {
    async publicRoute(req, res, path, method) {
        if (path === '/api/auth/register' && method === 'POST') {
          const input = await body(req), { username, key } = validateUsername(input.username, true);
          validatePassword(input.password);
          rateLimit(db, `register:${req.socket.remoteAddress}`, 15, 3600000);
          const hash = await hashPassword(input.password);
          const id = randomUUID();
          transaction(db, () => {
            if (db.prepare('SELECT id FROM users WHERE username_key = ?').get(key))
              throw new ApiError(409, '这个用户名已被使用，请换一个');
            db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(id, username, key, hash, Date.now());
          });
          setSession(req, res, id, input.remember !== false);
          json(res, 201, { user: { id, username } }); return true;
        }
        if (path === '/api/auth/login' && method === 'POST') {
          const input = await body(req), { key } = validateUsername(input.username);
          validatePassword(input.password);
          rateLimit(db, `login-ip:${req.socket.remoteAddress}`, 60, 900000);
          rateLimit(db, `login-user:${digest(key)}`, 12, 900000);
          const user = db.prepare('SELECT * FROM users WHERE username_key = ?').get(key);
          const valid = await checkPassword(input.password, user?.password_hash || dummyHash);
          if (!user || !valid) throw new ApiError(401, '用户名或密码不正确', 'INVALID_CREDENTIALS');
          // A concurrent password change must not create a session from an obsolete hash.
          const current = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
          if (current?.password_hash !== user.password_hash) throw new ApiError(401, '密码已变更，请重新登录');
          db.prepare('DELETE FROM rate_limits WHERE key = ?').run(`login-user:${digest(key)}`);
          let continuation;
          if (typeof input.continueTrackId === 'string') {
            try {
              const previous = session(req);
              if (previous.local) continuation = ownTrack(input.continueTrackId, previous.id);
            } catch {} // Invalid/missing prior sessions never grant access to another library.
          }
          const loginToken = setSession(req, res, user.id, input.remember !== false);
          if (continuation) playbackContinuations.set(digest(loginToken), { userId: continuation.user_id, trackId: continuation.id, expiresAt: Date.now() + 2 * 3600000 });
          json(res, 200, { user: { id: user.id, username: user.username } }); return true;
        }
        if (path === '/api/auth/logout' && method === 'POST') {
          await body(req);
          const token = tokenFrom(req);
          const existing = token && db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(digest(token));
          if (existing) providers.cancel(existing.user_id);
          if (token) { playbackContinuations.delete(digest(token)); db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token)); }
          res.setHeader('Set-Cookie', `harmony_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
          json(res, 200, { ok: true }); return true;
        }
    },
    async userRoute(req, res, path, method, user) {
        if (path === '/api/auth/password' && method === 'POST') {
          if (user.local) throw new ApiError(403, '本地模式无需密码');
          const input = await body(req);
          validatePassword(input.newPassword);
          rateLimit(db, `password:${user.id}`, 8, 900000);
          const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
          if (!await checkPassword(input.currentPassword, row.password_hash)) throw new ApiError(400, '当前密码不正确');
          const hash = await hashPassword(input.newPassword);
          transaction(db, () => {
            if (db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id).password_hash !== row.password_hash)
              throw new ApiError(409, '密码已在另一处修改，请重新登录');
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
            setSession(req, res, user.id, true);
          });
          json(res, 200, { ok: true }); return true;
        }
    },
    continuedOwner(req, url, trackId, action) {
      const continuation = playbackContinuations.get(digest(tokenFrom(req)));
      if (['audio', 'lyrics'].includes(action) && !url.searchParams.has('download') && continuation?.trackId === trackId && continuation.expiresAt > Date.now()) return continuation.userId;
    },
    cleanup(now) {
      for (const [key, value] of playbackContinuations) if (value.expiresAt <= now) playbackContinuations.delete(key);
    },
  };
}
