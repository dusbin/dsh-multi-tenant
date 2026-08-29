#!/usr/bin/env node
/**
 * dsh-multi-tenant 主机侧维护 CLI（管理员逃生通道 / 重置 / 备份 / 恢复）。
 *
 * 用法：
 *   node scripts/maintenance.mjs <command> [--db <path>] [options]
 *
 * 命令：
 *   status                                   系统概览（租户/用户/配额/用量/审计计数）
 *   reset-admin-password --username <u> --password <p>   重置指定用户密码（免登录）
 *   create-system-admin --username <u> --password <p>    创建平台管理员（无可用管理员时逃生）
 *   unlock-user --username <u>                          解锁账号（清失败计数）
 *   reset-system [--keep-usage]                          重置多租户系统（可选保留用量）
 *   export --out <file>                                  导出全量数据（版本化 JSON）
 *   import --in <file> [--replace]                       导入数据（--replace=覆盖恢复）
 *
 * 说明：
 *  - 需要本机文件系统权限（与 DSH 同信任级）；导出文件含密码哈希，视为敏感凭据
 *  - --db 缺省：$DSH_HOME/multi-tenant/mt.db（DSH_HOME 缺省 ~/.dsh）
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { openDatabase, createStore } from '../lib/host/db.js';
import { hashPassword, validatePasswordStrength, validateUsername } from '../lib/host/crypto.js';
import { exportData, importData, resetSystem, exportSummary } from '../lib/host/backup.js';

function usage() {
  console.error(`用法: node scripts/maintenance.mjs <command> [--db <path>] [options]
命令: status | reset-admin-password | create-system-admin | unlock-user | reset-system | export | import`);
  process.exit(1);
}

function resolveDbPath(argv) {
  const dbIdx = argv.indexOf('--db');
  if (dbIdx !== -1 && argv[dbIdx + 1]) return argv[dbIdx + 1];
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'multi-tenant', 'mt.db');
}

function argValue(argv, name) {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function openStore(dbPath, { create = false } = {}) {
  if (!create && !fs.existsSync(dbPath)) {
    throw new Error(`数据库不存在: ${dbPath}\n（首次安装且未初始化时，请先通过登录页 bootstrap 创建平台管理员；import 会自动建库）`);
  }
  const db = openDatabase(dbPath); // 不存在时自动创建并迁移
  return { db, store: createStore(db) };
}

const [,, command, ...rest] = process.argv;
if (!command) usage();

const dbPath = resolveDbPath(rest);
const out = (obj) => { console.log(JSON.stringify(obj, null, 2)); };

try {
  const { db, store } = openStore(dbPath, { create: command === 'import' });

  switch (command) {
    case 'status': {
      const redact = (u) => ({ ...u, password_hash: u.password_hash ? '***' : null });
      const users = store.listUsers(null);
      out({
        db: dbPath,
        tenants: store.countTenants(),
        users: users.length,
        systemAdmins: users.filter((u) => u.role === 'system').map(redact),
        activeSystemAdmins: users.filter((u) => u.role === 'system' && u.status === 'active').map(redact),
        quotas: store.listQuotas().length,
        usageRecords: store.listAllUsageRecords().length,
        auditLogs: store.listAllAudit().length,
      });
      break;
    }

    case 'reset-admin-password': {
      const username = argValue(rest, '--username');
      const password = argValue(rest, '--password');
      if (!username || !password) usage();
      const passError = validatePasswordStrength(password);
      if (passError) throw new Error(passError);
      const user = store.getUserByUsername(username);
      if (!user) throw new Error(`用户不存在: ${username}`);
      store.setUserPasswordHash(user.id, hashPassword(password));
      store.deleteUserSessions(user.id);
      store.clearAttempts(`u:${username}`);
      store.writeAudit({ actorUserId: user.id, tenantId: user.tenant_id, action: 'maintenance.reset-password', result: 'success' });
      out({ ok: true, user: username, note: '密码已重置，该用户全部会话已失效' });
      break;
    }

    case 'create-system-admin': {
      const username = argValue(rest, '--username');
      const password = argValue(rest, '--password');
      if (!username || !password) usage();
      const nameError = validateUsername(username);
      if (nameError) throw new Error(nameError);
      const passError = validatePasswordStrength(password);
      if (passError) throw new Error(passError);
      if (store.getUserByUsername(username)) throw new Error(`用户名已存在: ${username}`);
      const active = store.listUsers(null).some((u) => u.role === 'system' && u.status === 'active');
      if (active && !rest.includes('--force')) {
        throw new Error('已存在可用平台管理员；如需强制创建请加 --force');
      }
      const id = store.createUser({ username, passwordHash: hashPassword(password), role: 'system' });
      store.writeAudit({ actorUserId: id, action: 'maintenance.create-system-admin', result: 'success' });
      out({ ok: true, user: username, userId: id });
      break;
    }

    case 'unlock-user': {
      const username = argValue(rest, '--username');
      if (!username) usage();
      const user = store.getUserByUsername(username);
      if (!user) throw new Error(`用户不存在: ${username}`);
      store.setUserStatus(user.id, 'active');
      store.clearAttempts(`u:${username}`);
      store.writeAudit({ actorUserId: user.id, tenantId: user.tenant_id, action: 'maintenance.unlock', result: 'success' });
      out({ ok: true, user: username, status: 'active' });
      break;
    }

    case 'reset-system': {
      const keepUsage = rest.includes('--keep-usage');
      const before = { tenants: store.countTenants(), users: store.countUsers(), usage: store.listAllUsageRecords().length };
      resetSystem(store, { keepUsage });
      out({ ok: true, keepUsage, cleared: before, note: '系统已重置；请通过登录页重新 bootstrap 创建平台管理员' });
      break;
    }

    case 'export': {
      const outFile = argValue(rest, '--out');
      if (!outFile) usage();
      const data = exportData(store);
      fs.writeFileSync(outFile, JSON.stringify(data, null, 2), 'utf8');
      out({ ok: true, file: outFile, summary: exportSummary(data), note: '导出文件含密码哈希，请妥善保管' });
      break;
    }

    case 'import': {
      const inFile = argValue(rest, '--in');
      if (!inFile) usage();
      const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
      const summary = importData(store, data, { replace: rest.includes('--replace') });
      out({ ok: true, imported: summary });
      break;
    }

    default:
      usage();
  }
  db.close();
} catch (error) {
  console.error(`maintenance failed: ${error.message}`);
  process.exit(1);
}
