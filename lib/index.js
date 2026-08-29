/**
 * dsh-multi-tenant — host 半（Cordis 插件入口）。
 *
 * M1 职责：
 *  - 打开/迁移 SQLite（users/tenants/sessions/audit/login_attempts）
 *  - 启动认证反代网关（登录/会话/登出/me/bootstrap + HTTP/WS 代理到 DSH）
 *  - 生命周期清理（dispose 时关网关、关 DB）
 *
 * 后续里程碑（M2+）：/mt 管理通道、RBAC、配额、用量统计、审计查询、
 * LDAP/OIDC 登录策略——全部在本插件的 host 半内扩展。
 */

import { resolveConfig } from './host/config.js';
import { openDatabase, createStore } from './host/db.js';
import { createAuthService } from './host/auth-service.js';
import { createGateway } from './host/gateway.js';

export const name = 'dsh-multi-tenant';

/** 需要等待的服务：webServer（读取 DSH 实际监听端口作为代理目标） */
export const inject = ['webServer'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} [config]
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const log = ctx.logger ?? console;

  const db = openDatabase(cfg.db.path);
  const store = createStore(db);
  const authService = createAuthService(store, cfg);

  let gateway = null;

  if (cfg.gateway.enabled) {
    const target = {
      hostname: '127.0.0.1',
      port: ctx.webServer.port,
    };
    gateway = createGateway({ cfg, target, authService, logger: log });
    const port = Number(cfg.gateway.port);
    const host = String(cfg.gateway.host);
    gateway.listen(port, host).then(() => {
      const addr = gateway.address();
      log.info(
        `[dsh-multi-tenant] gateway listening on http://${host}:${typeof addr === 'object' && addr ? addr.port : port} ` +
        `→ ${target.hostname}:${target.port} (cookie: ${cfg.cookie.name})`,
      );
    }).catch((error) => {
      log.warn(`[dsh-multi-tenant] gateway failed to listen: ${error.message}`);
      gateway = null;
    });
  } else {
    log.info('[dsh-multi-tenant] gateway disabled (config.gateway.enabled=false)');
  }

  // 周期清理过期会话与登录尝试记录
  const pruneTimer = setInterval(() => {
    try {
      store.deleteExpiredSessions();
      store.pruneAttempts(Date.now() - 24 * 60 * 60 * 1000);
    } catch (error) {
      log.warn(`[dsh-multi-tenant] prune failed: ${error.message}`);
    }
  }, 10 * 60 * 1000);
  pruneTimer.unref?.();

  ctx.on('dispose', () => {
    clearInterval(pruneTimer);
    if (gateway) {
      gateway.close().catch(() => {});
      gateway = null;
    }
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });
}
