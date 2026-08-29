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
import { createMtChannel, wireMtRoute } from './host/mt-channel.js';
import { createAuthRouter, wireAuthRoutes } from './host/auth-router.js';
import { createQuotaService } from './host/quota.js';
import { createMetering } from './host/metering.js';
import { createLdapStrategy } from './host/auth/ldap.js';
import { createOidcStrategy } from './host/auth/oidc.js';

export const name = 'dsh-multi-tenant';

/** 需要等待的服务：webServer（读取 DSH 实际监听端口作为代理目标 + 挂 /mt 路由） */
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
  const ldapStrategy = cfg.auth.ldap.enabled ? createLdapStrategy({ cfg, store, logger: log }) : null;
  const oidcStrategy = cfg.auth.oidc.enabled ? createOidcStrategy({ cfg, store, logger: log }) : null;
  const authService = createAuthService(store, cfg, ldapStrategy, oidcStrategy);
  const quotaService = createQuotaService(store);
  const mtChannel = createMtChannel({ store, authService, quotaService });
  const authRouter = createAuthRouter({ cfg, authService, oidcStrategy, logger: log });

  let gateway = null;
  let metering = null;
  let meterTimer = null;
  let disposed = false;

  // 清理注册提前：任何装配失败也保证释放（DB 句柄、网关、定时器）
  const pruneTimer = setInterval(() => {
    try {
      store.deleteExpiredSessions();
      store.pruneAttempts(Date.now() - 24 * 60 * 60 * 1000);
    } catch (error) {
      log.warn(`[dsh-multi-tenant] prune failed: ${error.message}`);
    }
  }, 10 * 60 * 1000);
  pruneTimer.unref?.();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(pruneTimer);
    if (meterTimer) clearInterval(meterTimer);
    if (metering) {
      try { metering.flushAll(); } catch (error) { log.warn(`[dsh-multi-tenant] final metering flush failed: ${error.message}`); }
    }
    if (gateway) {
      gateway.close().catch(() => {});
      gateway = null;
    }
    try {
      db.close();
    } catch {
      /* already closed */
    }
  };
  ctx.on('dispose', dispose);

  // 用量计量（M3）：依赖 sessions + sessionProjections 组合（web profile 具备）
  const sessions = ctx.get('sessions');
  const projections = ctx.get('sessionProjections');
  if (sessions && projections) {
    metering = createMetering({
      store,
      quotaService,
      listSessions: () => sessions.list(),
      readTokenUsage: (session) => projections.stateOf(session, 'tokenUsage'),
      logger: log,
    });
    meterTimer = setInterval(() => {
      try {
        const tokens = metering.flushAll();
        if (tokens > 0) log.info(`[dsh-multi-tenant] metering: +${tokens} tokens`);
      } catch (error) {
        log.warn(`[dsh-multi-tenant] metering tick failed: ${error.message}`);
      }
    }, cfg.metering.intervalMs);
    meterTimer.unref?.();
    ctx.on('session/disposed', (session) => {
      try { metering.flushSession(session); } catch (error) { log.warn(`[dsh-multi-tenant] session final flush failed: ${error.message}`); }
    });
    log.info('[dsh-multi-tenant] metering enabled (tokenUsage projection)');
  } else {
    log.warn('[dsh-multi-tenant] metering disabled: sessions/sessionProjections not composed');
  }

  // /mt 管理通道 + /api/auth 认证端点（挂 DSH webserver；直连 DSH 端口也可登录）
  try {
    wireMtRoute(ctx, { store, authService, mtChannel });
    wireAuthRoutes(ctx, authRouter);
    log.info('[dsh-multi-tenant] /mt channel + /api/auth mounted on DSH webserver');
  } catch (error) {
    log.warn(`[dsh-multi-tenant] webserver mount failed: ${error.message}`);
  }

  if (cfg.gateway.enabled) {
    const target = {
      hostname: '127.0.0.1',
      port: ctx.webServer.port,
    };
    gateway = createGateway({
      cfg,
      target,
      authService,
      quotaService,
      oidcStrategy,
      audit: (entry) => {
        try { store.writeAudit(entry); } catch (error) { log.warn(`[dsh-multi-tenant] audit write failed: ${error.message}`); }
      },
      logger: log,
    });
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
}
