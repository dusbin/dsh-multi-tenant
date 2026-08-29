/**
 * 配额服务（M3，token 口径，D5）。
 *
 * 模型：平台 / 租户 / 用户 三级限额，周期 daily / monthly / total 可叠加。
 *  - 任一适用限额（scope 命中用户）在其周期内达到或超过 → 拒绝新的耗 token 请求
 *  - spent 按周期窗口滚动：daily=自然日、monthly=自然月、total=累计不滚动
 *  - 记账：metering 每次用量差分后调用 addUsage 累计（同步检查点用最新 spent）
 *
 * 权限边界在调用方（/mt 端点 RBAC）与网关（session.prompt 门禁）执行。
 */

import { parseSessionPrefix } from './ownership.js';

export const QUOTA_PERIODS = ['daily', 'monthly', 'total'];
export const QUOTA_SCOPES = ['platform', 'tenant', 'user'];

/** 当前周期窗口起点（epoch ms）。total 恒为 0（不滚动）。 */
export function periodStart(period, now = Date.now()) {
  if (period === 'total') return 0;
  const d = new Date(now);
  if (period === 'daily') {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  // monthly
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * @param {ReturnType<import('./db.js').createStore>} store
 */
export function createQuotaService(store) {
  /**
   * 某个用户命中的所有限额（scope+period），含各自 spent。
   * @param {object} user  原始 user 行（tenant_id）
   * @param {number} [now]
   */
  function applicableLimits(user, now = Date.now()) {
    const uid = user.id;
    const tid = user.tenant_id ?? user.tenantId ?? null;
    const limits = [];
    const push = (scope, targetId) => {
      for (const period of QUOTA_PERIODS) {
        const quota = store.getQuota(scope, targetId, period);
        if (!quota) continue;
        const start = periodStart(period, now);
        const usage = store.getQuotaUsage(scope, targetId, period, start);
        limits.push({
          scope,
          targetId,
          period,
          tokenLimit: quota.token_limit,
          periodStart: start,
          spent: usage ? usage.spent_tokens : 0,
        });
      }
    };
    push('platform', 0);
    if (tid !== null) push('tenant', tid);
    push('user', uid);
    return limits;
  }

  /**
   * 同步门禁检查：当前 spent 是否已达任一适用限额。
   * @param {object} user
   * @returns {{allowed: boolean, reason?: string, limits: Array}}
   */
  function check(user, now = Date.now()) {
    const limits = applicableLimits(user, now);
    const exhausted = limits.filter((l) => l.spent >= l.tokenLimit);
    if (exhausted.length > 0) {
      const first = exhausted[0];
      return {
        allowed: false,
        reason: `quota exhausted (${first.scope}/${first.period}: ${first.spent}/${first.tokenLimit} tokens)`,
        limits,
      };
    }
    return { allowed: true, limits };
  }

  /** 记账：把本次用量增量累计到所有适用限额（周期窗口滚动）。 */
  function addUsage(user, tokens, now = Date.now()) {
    const tid = user.tenant_id ?? user.tenantId ?? null;
    const targets = [{ scope: 'platform', targetId: 0 }, { scope: 'user', targetId: user.id }];
    if (tid !== null) targets.push({ scope: 'tenant', targetId: tid });
    for (const { scope, targetId } of targets) {
      for (const period of QUOTA_PERIODS) {
        const quota = store.getQuota(scope, targetId, period);
        if (!quota) continue; // 未配置限额的维度不记账（也可记，但无意义）
        const start = periodStart(period, now);
        const usage = store.getQuotaUsage(scope, targetId, period, start);
        store.upsertQuotaUsage({
          scope,
          targetId,
          period,
          periodStart: start,
          spentTokens: (usage ? usage.spent_tokens : 0) + tokens,
          ts: now,
        });
      }
    }
  }

  /** 用户配额视图（个人中心/仪表盘）。 */
  function view(user, now = Date.now()) {
    const limits = applicableLimits(user, now);
    return {
      limits: limits.map((l) => ({
        scope: l.scope,
        targetId: l.targetId,
        period: l.period,
        tokenLimit: l.tokenLimit,
        spent: l.spent,
        remaining: Math.max(0, l.tokenLimit - l.spent),
      })),
    };
  }

  return { check, addUsage, view, applicableLimits };
}

/** 由 sessionId 前缀解析归属（用量记账用）。 */
export function attributeSession(sessionId) {
  return parseSessionPrefix(sessionId);
}
