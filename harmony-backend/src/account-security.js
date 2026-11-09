import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './security.js';

const derive = promisify(scrypt);
const params = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function validateUsername(value, registration = false) {
  if (typeof value !== 'string') throw new ApiError(400, '请输入用户名');
  const username = value.trim().normalize('NFC');
  if (registration && !/^[a-z0-9]{3,32}$/.test(username))
    throw new ApiError(400, '用户名需为 3–32 位，仅支持数字和小写字母');
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username))
    throw new ApiError(400, '用户名需为 3–32 位文字、数字、下划线、点或短横线');
  return { username, key: username.toLocaleLowerCase('en-US') };
}
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128)
    throw new ApiError(400, '密码需为 8–128 位字符');
  return value;
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, params);
  return `scrypt$16384$8$1$${salt}$${key.toString('hex')}`;
}
export async function checkPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [, n, r, p, salt, hex] = stored.split('$');
  const expected = Buffer.from(hex, 'hex');
  const actual = await derive(password, salt, expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: params.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
// Unknown usernames still run the same password derivation to reduce timing differences.
export const dummyHash = `scrypt$16384$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
