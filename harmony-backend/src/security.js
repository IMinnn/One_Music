import { randomBytes, createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message); this.status = status; this.code = code;
  }
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function rateLimit(db, key, limit, windowMs, now = Date.now()) {
  const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
  if (row && row.expires_at > now && row.count >= limit)
    throw new ApiError(429, '尝试次数过多，请稍后再试', 'RATE_LIMITED');
  if (!row || row.expires_at <= now) {
    db.prepare('INSERT OR REPLACE INTO rate_limits VALUES (?, 1, ?)').run(key, now + windowMs);
  } else db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
}

export function cleanText(value, label, max, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max)
    throw new ApiError(400, `${label}需为${optional ? '不超过' : '1–'}${max}个字符`);
  return value.trim();
}
