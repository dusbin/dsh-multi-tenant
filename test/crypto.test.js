import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, newSessionToken, hashSessionToken, validatePasswordStrength, validateUsername } from '../lib/host/crypto.js';

test('hashPassword/verifyPassword roundtrip', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.ok(stored.startsWith('scrypt$16384$8$1$'));
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
});

test('verifyPassword rejects malformed/tampered hashes', () => {
  assert.equal(verifyPassword('x', null), false);
  assert.equal(verifyPassword('x', undefined), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'bcrypt$aaa$bbb'), false);
  assert.equal(verifyPassword('x', 'scrypt$1$1$1$!!$!!'), false); // 非法参数
  const stored = hashPassword('pw');
  const tampered = stored.slice(0, -2) + (stored.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(verifyPassword('pw', tampered), false);
});

test('session token: random, hashed digest stored', () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.notEqual(a, b);
  assert.equal(typeof hashSessionToken(a), 'string');
  assert.equal(hashSessionToken(a).length, 64);
  assert.notEqual(hashSessionToken(a), a);
  assert.equal(hashSessionToken(a), hashSessionToken(a));
});

test('validation helpers', () => {
  assert.equal(validatePasswordStrength('short'), 'password must be at least 8 characters');
  assert.equal(validatePasswordStrength('longenough1'), null);
  assert.equal(validateUsername('ab'), null);
  assert.equal(validateUsername('a'), 'invalid username');
  assert.equal(validateUsername('has space'), 'invalid username');
  assert.equal(validateUsername('ok.user-name@example.com'), null);
});
