/**
 * 用量计量（M3）。
 *
 * 数据源：`tokenUsage` 会话投影（dsh-token-meter 注册，web profile 已组合）
 * 提供每会话累计四桶 {uncachedInput, output, cacheRead, cacheWrite}，
 * 回放感知（压缩/替换/失败请求均正确）。
 *
 * 记账策略（差分）：
 *  - session_meter 表存每会话"上次已记账"的四桶基线
 *  - 每次扫描：当前累计 − 基线 = 增量 → 写 usage_records + 配额累计 → 更新基线
 *  - 首次见到的会话只建立基线，不产生用量（恢复的旧会话不会重复计费）
 *
 * 归属：SessionId 前缀 `u-<uid>-t-<tid>-s-*`（M2 强制，见 ownership.js）。
 *
 * 依赖注入（可测试）：listSessions / readTokenUsage 由装配方提供。
 */

import { attributeSession } from './quota.js';

/**
 * @param {object} deps
 * @param {ReturnType<import('./db.js').createStore>} deps.store
 * @param {ReturnType<import('./quota.js').createQuotaService>} deps.quotaService
 * @param {() => Array<{id: string}>} deps.listSessions  实时会话列表
 * @param {(session: {id: string}) => {uncachedInputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number} | undefined} deps.readTokenUsage
 * @param {() => number} [deps.now]
 * @param {{warn?: Function}} [deps.logger]
 */
export function createMetering({ store, quotaService, listSessions, readTokenUsage, now = Date.now, logger = console }) {
  /** 扫描并差分记账一个会话；返回本次写入的增量 token（无则 0）。 */
  function flushSession(session) {
    const sessionId = String(session.id);
    const attr = attributeSession(sessionId);
    if (!attr) return 0; // 非本插件前缀的会话（旧会话/无归属）不计量

    const usage = readTokenUsage(session);
    if (!usage) return 0; // 投影不可用或尚无用量

    const input = usage.uncachedInputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;

    const meter = store.getSessionMeter(sessionId);
    if (!meter) {
      // 首见：建立基线，不计费
      store.upsertSessionMeter({
        sessionId, userId: attr.uid, tenantId: attr.tid,
        inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
        ts: now(),
      });
      return 0;
    }

    const di = input - meter.last_input;
    const do_ = output - meter.last_output;
    const dcr = cacheRead - meter.last_cr;
    const dcw = cacheWrite - meter.last_cw;
    if (di <= 0 && do_ <= 0 && dcr <= 0 && dcw <= 0) {
      store.upsertSessionMeter({
        sessionId, userId: attr.uid, tenantId: attr.tid,
        inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
        ts: now(),
      });
      return 0;
    }

    const ts = now();
    store.insertUsageRecord({
      ts,
      tenantId: attr.tid,
      userId: attr.uid,
      sessionId,
      inputTokens: Math.max(0, di),
      outputTokens: Math.max(0, do_),
      cacheReadTokens: Math.max(0, dcr),
      cacheWriteTokens: Math.max(0, dcw),
      requestCount: 1, // v1 近似：每次有增量的扫描计 1 次请求
    });
    store.upsertSessionMeter({
      sessionId, userId: attr.uid, tenantId: attr.tid,
      inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      ts,
    });

    // 配额累计（用户仍存在时）
    const user = store.getUserById(attr.uid);
    if (user) {
      try {
        quotaService.addUsage(user, Math.max(0, di) + Math.max(0, do_) + Math.max(0, dcr) + Math.max(0, dcw), ts);
      } catch (error) {
        logger.warn?.(`[dsh-multi-tenant] quota add failed: ${error.message}`);
      }
    }
    return di + do_ + dcr + dcw;
  }

  function flushAll() {
    let total = 0;
    for (const session of listSessions()) {
      try {
        total += flushSession(session);
      } catch (error) {
        logger.warn?.(`[dsh-multi-tenant] metering failed for ${session.id}: ${error.message}`);
      }
    }
    return total;
  }

  return { flushAll, flushSession };
}
