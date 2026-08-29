/**
 * 密码哈希与会话令牌（Node 内置 crypto，零依赖）。
 *
 *  - 密码：scrypt（N=16384, r=8, p=1, 32 字节 key），存储格式
 *    `scrypt$N$r$p$saltBase64$hashBase64`，校验用 timingSafeEqual。
 *  - 会话令牌：32 字节随机数（base64url），DB 只存 SHA-256 摘要，
 *    明文只在 Set-Cookie 里出现一次。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

/**
 * @param {string} password
 * @returns {string} `scrypt$N$r$p$salt$hash`
 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * @param {string} password
 * @param {string | null | undefined} stored
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P) || N < 2 || R < 1 || P < 1) return false;
  let salt;
  let expected;
  let actual;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
    actual = scryptSync(password, salt, expected.length, { N, r: R, p: P });
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/** 新会话令牌：32 字节随机 base64url（明文，只用于 Set-Cookie）。 */
export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

/** 存储用摘要：SHA-256 hex。 */
export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** 简单密码强度检查（v1：长度 ≥ 8）。 */
export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'password must be at least 8 characters';
  }
  return null;
}

/** 用户名合法性（字母数字 + _ - . @，2-64 字符）。 */
export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{2,64}$/.test(username)) {
    return 'invalid username';
  }
  return null;
}
