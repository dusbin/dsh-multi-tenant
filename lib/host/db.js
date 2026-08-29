/**
 * 多租户数据层：node:sqlite（Node ≥22.5 内置，零 native 依赖）。
 *
 * 约定（与 DSH 存储形态一致）：
 *  - 单进程单所有者：禁止多个 host 进程共享同一 DB 文件
 *  - WAL 日志模式；目录 0700 / 文件 0600
 *  - 迁移版本号存 PRAGMA user_version
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** 迁移列表：下标 i 对应从 user_version=i 迁移到 i+1。只追加，不修改历史。 */
const MIGRATIONS = [
  // v1：核心表（租户/用户/会话/审计/登录尝试）
  `
  CREATE TABLE tenants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    config      TEXT    NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT,
    password_hash TEXT,
    ldap_dn       TEXT,
    oidc_sub      TEXT,
    status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','locked')),
    role          TEXT    NOT NULL CHECK (role IN ('system','admin','auditor','user')),
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER,
    last_login_ip TEXT
  );

  CREATE TABLE auth_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );

  CREATE TABLE audit_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    actor_user_id INTEGER,
    tenant_id    INTEGER,
    action       TEXT    NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    detail       TEXT    NOT NULL DEFAULT '{}',
    result       TEXT    NOT NULL DEFAULT 'success' CHECK (result IN ('success','denied')),
    ip           TEXT
  );

  CREATE TABLE login_attempts (
    id  INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT    NOT NULL,
    ts  INTEGER NOT NULL
  );

  CREATE INDEX idx_users_tenant    ON users(tenant_id);
  CREATE INDEX idx_sessions_user   ON auth_sessions(user_id);
  CREATE INDEX idx_sessions_expire ON auth_sessions(expires_at);
  CREATE INDEX idx_audit_ts        ON audit_logs(ts);
  CREATE INDEX idx_audit_tenant    ON audit_logs(tenant_id);
  CREATE INDEX idx_login_key_ts    ON login_attempts(key, ts);
  `,
];

/**
 * 打开（必要时创建）数据库并迁移到最新版本。
 * @param {string} dbPath
 * @returns {DatabaseSync}
 */
export function openDatabase(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** 内存库（测试用） */
export function openMemoryDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row.user_version);
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`dsh-multi-tenant: migration to v${v + 1} failed: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// DAO：所有读写集中在此，供 auth-service / gateway / 后续里程碑调用
// ---------------------------------------------------------------------------

export function createStore(db) {
  return {
    // ---- tenants ----
    countTenants() {
      return db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
    },
    createTenant({ name, config = {} }) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO tenants (name, config, created_at) VALUES (?, ?, ?)')
        .run(name, JSON.stringify(config), Date.now());
      return Number(lastInsertRowid);
    },
    getTenant(id) {
      return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    },
    getTenantByName(name) {
      return db.prepare('SELECT * FROM tenants WHERE name = ?').get(name);
    },
    listTenants() {
      return db.prepare('SELECT * FROM tenants ORDER BY id').all();
    },
    setTenantStatus(id, status) {
      db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, id);
    },

    // ---- users ----
    countUsers() {
      return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    },
    createUser({ tenantId = null, username, email = null, passwordHash = null, ldapDn = null, oidcSub = null, role, status = 'active' }) {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO users (tenant_id, username, email, password_hash, ldap_dn, oidc_sub, status, role, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(tenantId, username, email, passwordHash, ldapDn, oidcSub, status, role, Date.now());
      return Number(lastInsertRowid);
    },
    getUserById(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    },
    getUserByUsername(username) {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    },
    getUserByEmail(email) {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    },
    listUsers(tenantId = null) {
      if (tenantId === null) return db.prepare('SELECT * FROM users ORDER BY id').all();
      return db.prepare('SELECT * FROM users WHERE tenant_id = ? ORDER BY id').all(tenantId);
    },
    setUserStatus(id, status) {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
    },
    setUserRole(id, role) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    },
    setUserPasswordHash(id, passwordHash) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
    },
    setUserEmail(id, email) {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, id);
    },
    deleteUser(id) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },
    countUsersByTenant(tenantId) {
      return db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?').get(tenantId).n;
    },
    touchUserLogin(id, ip) {
      db.prepare('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?').run(Date.now(), ip ?? null, id);
    },

    // ---- auth sessions ----
    createSession({ userId, tokenHash, expiresAt, ip = null, userAgent = null }) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, tokenHash, Date.now(), expiresAt, ip, userAgent);
      return Number(lastInsertRowid);
    },
    getSessionByTokenHash(tokenHash) {
      return db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(tokenHash);
    },
    deleteSessionByTokenHash(tokenHash) {
      db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
    },
    deleteUserSessions(userId) {
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    },
    deleteExpiredSessions(now = Date.now()) {
      db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    },

    // ---- audit ----
    writeAudit({ actorUserId = null, tenantId = null, action, targetType = null, targetId = null, detail = {}, result = 'success', ip = null }) {
      db.prepare(
        'INSERT INTO audit_logs (ts, actor_user_id, tenant_id, action, target_type, target_id, detail, result, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(Date.now(), actorUserId, tenantId, action, targetType, targetId, JSON.stringify(detail), result, ip);
    },
    listAudit({ limit = 200, offset = 0, tenantId = null, action = null }) {
      let sql = 'SELECT * FROM audit_logs';
      const where = [];
      const args = [];
      if (tenantId !== null) { where.push('tenant_id = ?'); args.push(tenantId); }
      if (action !== null) { where.push('action = ?'); args.push(action); }
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
      args.push(limit, offset);
      return db.prepare(sql).all(...args);
    },

    // ---- login attempts（防爆破）----
    countRecentAttempts(key, since) {
      return db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND ts > ?').get(key, since).n;
    },
    recordAttempt(key, ts = Date.now()) {
      db.prepare('INSERT INTO login_attempts (key, ts) VALUES (?, ?)').run(key, ts);
    },
    clearAttempts(key) {
      db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
    },
    pruneAttempts(before) {
      db.prepare('DELETE FROM login_attempts WHERE ts <= ?').run(before);
    },
  };
}
