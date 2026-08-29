# DSH 多租户插件调研报告：身份 / 会话 / 用量计量

- 调研日期：本次会话
- 调研对象：DeepSeek Harness（DSH）`0.1.1-rc.2` 已安装包（只读调研，未修改任何源码、未启动服务、未执行 npm install）
- DSH 根目录：`/Users/robinddu/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/`
- 包目录统一记为 `@deepseek-ai/<pkg>`，实际路径为 `.../dsh/node_modules/@deepseek-ai/<pkg>/`
- 目标：为「多租户插件」（用户账号：邮箱密码/LDAP/SSO-OIDC 登录；角色：管理员/审计员/使用者；配额：token/金额限额；会话与 token 用量统计；审计日志）评估 DSH 的现有抓手与硬障碍
- 阅读对象：中英 README 均以中文 README（`README.zh.md`）为准引用，英文原文（`README.md`）作为补充；类型签名引用 `lib/types/*.d.ts`

---

## 0. 关键结论（TL;DR）

1. **身份（用户/角色/口令哈希）DSH 没有任何现成位置**。`dsh-credentials` 是「为 LLM 提供方保存 API 密钥/OAuth grant」的凭据 seam，不是用户目录；`dsh-anonymous-user-id` 只是一个 `$DSH_HOME` 级别的匿名 UUID，明确「不是登录身份」。**用户账号必须自建**，推荐用 DSH 自带的领域 KV 存储（`ctx.storage.domain` + JSON 后端，落盘 `$DSH_HOME/storages/`）或自建 SQLite（node:sqlite 已可用）。
2. **会话模型天然支持"多会话并行"，但**没有**用户/归属字段**。`SessionHeader` 只有 `{version, id, createdAt, cwd?, parentSession?, seedLength?, origin?, delegationDepth?, agentPreset?}`；隔离单元是 **agent/session 作用域**（`dsh-scope`，key 即 sessionId），不是用户。按用户隔离的可行做法：插件维护 `userId → sessionId[]` 的映射表（领域存储），并给 `SessionId` 直接编码用户前缀（`SessionId` 是任意品牌字符串，`create(id?)` 接受自定义 id）。
3. **token 用量有完整的"提供方真实用量"链路**：适配器在流上发 `usage` 分片 → 会话日志持久化 `assistant/chunk {type:'usage'}` → `ctx.tokenMeter.measure()` / `tokenUsage` 投影单元给出四桶（uncachedInput/output/cacheRead/cacheWrite）。**DSH 没有任何价格表**：`ctx.llm.resolveModelInfo()` 只返回 `context`（contextWindow）/`defaultMaxTokens`/`reasoning`，**没有价格字段**——金额计价必须自建价格表（且要自己把"用量发生"与"用户"挂钩，DSH 只按 session 计量）。
4. **DSH 官方立场 = 单用户本地服务**，多用户是"载体（carrier）"的职责：`dsh-host-apiproxy`：「网关是单用户本地服务。将其暴露给多名用户的载体必须用可安全公开的诊断信息替代内部搜索细节」；`dsh-client-connection`：「这些方法在真正的认证层出现之前仍只限回环本机」「`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持」「这道栅栏是可达性策略，而不是认证；Web 载体不提供认证层」。
5. **在同一 host 进程内做"按用户隔离会话 + 配额 + 用量统计"是可行的**，抓手齐全（session 隔离、tokenMeter、fs/bash 沙箱按会话 cwd 解析策略、领域存储）；**硬障碍是进程级隔离缺失与共享 host**（所有 agent 跑在同一进程、同一 `$DSH_HOME`、共享 settings/credentials 文档、bash 工具与模型同用户权限、无 per-user 沙箱）。每个用户独立 profile 不可行（profile 是整进程组合，web profile 一次一个进程/端口；存储文档是 `$DSH_HOME` 级共享）。
6. **存储选型**：DSH **不带** better-sqlite3/sqlite3/lowdb/level；已内置使用 **`node:sqlite`（Node 22.5+ 内置，当前 Node v24.18.0 可用且无警告）**（`dsh-session-query-sqlite`）；非会话数据已有 `ctx.storage` 中心 + `json` 后端 + `domain` 领域表单（`dsh-storage-domain`），写链串行化 + 原子替换。插件自建 SQLite 可行（node:sqlite 零 native 依赖；pnpm 通过 `dsh plugin --profile <name>` 安装）。`dsh-atomic-write` 提供跨进程原子写 + 文件锁。
7. **客户端↔Host 的 RPC 链路**：`dsh-api-gateway`（Typert `ctx.typertGateway` / `ctx.remote`）管"调用分发"，`dsh-api-remotes` 管"选哪些 Remote 能力 + agent/session 身份解析 + 转发事件白名单（`API_REMOTE_FORWARDED_EVENTS`）"。加新 Remote 命名空间的步骤明确（见 §7）。

---

## 1. dsh-credentials / dsh-credentials-local / dsh-settings（Q1）

### 1.1 dsh-credentials：凭据 seam（不是用户目录）

`dsh-credentials/README.zh.md` 开头即定义其职责：

> 凭据 Service Definition（`ctx.credentials`）。一条准则，三个推论：**配置只携带对机密的引用，绝不携带机密本身。** … 凭据 Provider 处存放。

它有两个键空间（README 原文）：

> `CredentialRef` 回答的是*这个环境变量名背后是什么*，分层覆盖进程环境、托管存储与 `.env` 文件。… `CredentialKey` 回答的是*某个插件为某个 id 持有什么凭据*。… 键的形式是 `<scope>/<id>`，其中 `scope` 是**拥有该记录的插件的注册名**。

记录结构（`dsh-credentials/lib/types/types.d.ts`）：

```ts
export interface ApiKeyRecord { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }
export interface GrantRecord { readonly kind: 'grant'; readonly payload: unknown } // 不透明，JSON 可往返
export type CredentialRecord = ApiKeyRecord | GrantRecord
```

读写 API（`lib/types/index.d.ts`，`CredentialProvider` 抽象类）：

- 引用半：`resolve(ref): Promise<ResolvedCredential | undefined>`、`describe(ref)`、`set(ref, value)`、`unset(ref)`
- 记录半：`readRecord(key)`、`describeRecord(key)`、`listRecords()`、`modifyRecord(key, mutate)`（唯一写路径，独占跨进程读-改-写）、`deleteRecord(key)`
- 事件：`credentials/reference-updated (ref)`、`credentials/record-updated (key)`

**结论：** 它适合存"LLM 提供方密钥 / OAuth grant"，不适合当用户账号库——记录只有 `api-key`/`grant` 两种判别，`payload` 不透明且按 `<scope>/<id>` 寻址（scope 必须是插件注册名）；没有"用户"维度的概念（一个用户可拥有多条凭据、一个凭据属于某个用户这类关系无处表达）。存用户名+口令哈希+角色需要自建（推荐领域存储或 SQLite，见 §6）。

### 1.2 dsh-credentials-local：文件后端

`dsh-credentials-local/README.zh.md`：文档为 `$DSH_HOME/.credentials.yaml`（配置 `path` 默认 `<harness home>/.credentials.yaml`），四层来源优先级：

> | 层 | 来源 id | 可写 | 优先 |
> | 继承的进程环境 | `env` | 否 | 始终优先 |
> | `$DSH_HOME/.credentials.yaml` 文档 | `file` | 是 | 高于两个 `.env` 层 |
> | `<invocation cwd>/.env` | `project-env` | 不在此处 | 高于用户 `.env` |
> | `$DSH_HOME/.env` | `user-env` | 不在此处 | 其余情况 |

文档本身是带 `version: 1` 的 YAML，`refs:` 与 `records:` 两个分节；写入经 `dsh-atomic-write` 跨进程锁 + 0600 原子提交；安全边界明确写「挡得住其他 OS 用户，**挡不住**模型」（`0700` 目录、`0600` 文件，工具进程与模型同用户）。

**对多租户的意义：** 这是"单机单用户"语义的存储——`$DSH_HOME` 全局一份，没有 per-user 分区。

### 1.3 dsh-settings：配置持久化（host 侧可用，但"单一用户层"）

`dsh-settings/README.zh.md`：`ctx.settings` 服务，提供方按 namespace 存原始文档：

- `register(ns, schema, { base?, applies? })` → `SettingsScope`（`get`/`watch`/`update`）
- `documentPath` / `prepareDocument()` —— **Host 侧可用**（提供方为本地文件时返回绝对路径；「Host 配置适配器据此派生可用性，而浏览器协议只暴露一个布尔能力」）
- `update(ns, patch)`（深合并进用户分节）、`replace(ns, section)`、`mutate(ns, ops)`（`{op:'set'|'unset', path}`）
- 每次写入可带 `expectedRevision`，冲突抛 `SettingsConflictError`（`code: 'SETTINGS_CONFLICT'`）
- 事件：`settings/updated (ns, next, prev, source)`、`settings/document-updated (ns, revision)`
- 解析层：schema 默认值 → 组合 `base` → 用户文档分节

已知限制原文：

> **单一用户层** — 解析只认识 schema 默认值、一个组合 `base` 与一个用户文档；它尚未记录每个解析值由哪一层提供。

**结论：** settings 适合存"每用户偏好/模型路由"吗？——不适合直接存用户级配置（单一用户层、`$DSH_HOME/settings.yaml` 全局一份）；但它适合插件自身（管理员级）配置。文件提供方 `dsh-settings-file` 默认路径 `$DSH_HOME/settings.yaml`（`dsh-base/cordis.patch.yml` 确认行 `id: settings, name: '@deepseek-ai/dsh-settings-file'`）。

---

## 2. dsh-session（Q2）

### 2.1 数据模型：事件溯源日志 + 内存存储

`dsh-session/README.zh.md`：

> 事件溯源的会话日志和内存存储。`Session` 是 agent 全部交互历史的仅追加真源，LLM 消息历史由它*派生*。

`SessionStore`（ctx 键 `sessions`）**有意不实现持久化**：

> 这里有意不实现持久化：插件订阅 `session/event`，在 `session/flush` 时刷新，并可镜像成对的 `session/created`／`session/disposed` 生命周期。

### 2.2 会话 id 结构

`lib/types/types.d.ts`：

```ts
export type SessionId = Branded<'SessionId'>;
export declare function SessionId(id: string): SessionId; // 编译期 brand，无运行时校验
```

- 存储默认铸造：`create(id?)` ——「省略时，store 铸造 `session-<n>`」；agent 声明式配置默认生成 `${label}-session-<uuid>`（`dsh-agent-loop` README：`agents[].id` 视为稳定 label，通常会先生成 `${label}-session-<uuid>`）。
- **id 是"未验证的品牌字符串"**（`dsh-session-persistence-jsonl` README：会话 id 使用前单射转义为安全路径段）。因此**自定义 id 前缀（如 `u-<userId>-s-<uuid>`）完全可行**。

### 2.3 SessionHeader（可归属的元数据，但没有 user 字段）

`lib/types/types.d.ts`：

```ts
export interface SessionHeader {
  readonly version: number;          // SESSION_FORMAT_VERSION = 0
  readonly id: SessionId;
  readonly createdAt: number;
  readonly cwd?: string;             // 绝对工作目录（沙箱 workspaceRoot 的权威来源！）
  readonly parentSession?: SessionId;
  readonly seedLength?: number;
  readonly origin?: 'subagent';
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}
```

`CreateSessionOptions.meta` 只接受上述字段（`cwd/parentSession/createdAt/seedLength/origin/delegationDepth/agentPreset`），**没有自由扩展字段**——不能往 header 塞 `userId`。归属要么靠"id 编码"，要么靠插件自己的映射表。

### 2.4 公共 API（`lib/types/index.d.ts`）

```ts
class SessionStore extends Service {
  create(id?: SessionId, options?: CreateSessionOptions): Session;   // 发布并绑定调用方 fiber
  prepare(id?, options?) / enter(session): () => void / announce(session): void; // 拆分生命周期
  flush(session): Promise<boolean>;      // 受等待的持久性检查点
  get(id: SessionId): Session | undefined;
  list(): Session[];                      // 全部活跃会话（内存）
  fork(source, boundary?, childSessionId?): Session;
}
class Session {
  append(type, data, opts?): SessionEvent<T>;  // 同步提交，仅追加
  deriveMessages(): Message[];
  deriveEventMessage(event): Message | null;
  surface: SessionSurface; events; seq; id; header;
}
```

事件（`declare module '@deepseek-ai/cordis'`）：`session/created`、`session/disposed`、`session/event (session, event)`、`session/flush`。`session/event` 与 `session/created` 均带 **agent 作用域过滤**（`@dshScopeScan unsupported` + `this: Scoped<Session>`）：「Scope-filtered dispatch…agent-scoped listeners receive only sessions entered through that agent's context」。

### 2.5 持久化位置与文件格式（dsh-session-persistence-jsonl）

磁盘布局（README 原文）：

```
<root>/
  --<normalized-cwd>--/          # 可读项目目录（或 _no-cwd/）
    <encoded-id>/                # 会话自有目录
      session.jsonl.zstd         # 默认：checksummed header frame + append frames
      session.jsonl              # 仅 compression: 'none'
```

- 首个逻辑行是不可变 `SessionHeader`；`assistant/chunk` 事件绝不丢弃，`seq` 连续。
- **`root` 无默认值，必须显式配置**（避免 `process.cwd()` 漂移）；`dsh-base/cordis.patch.yml` 配置为 `root: !!js dshHomePath('sessions')` → **`$DSH_HOME/sessions/`**。
- 压缩默认 `zstd`（Node 内置 Zstandard API）；`packChunks` 默认 true。
- 每会话一个活动 writer；同一会话只允许一个后端实例/进程写入（POSIX 硬链接无覆盖发布）。「不删除会话文件：日志在 `root` 下累积，直到外部移除（seam 无删除接口）」。
- 崩溃恢复：不完整尾部截断并补合成 closer；`inspect()` 非修改式。

### 2.6 会话与"连接"、并发能力

- **会话 ≠ 连接**。连接是浏览器 ↔ Host 的传输（`ctx.connection`，HTTP POST unary/respond + 两条下行 WebSocket）；会话是 Host 内存中的事件日志对象。一个连接可以同时打开/看到多个会话（Web UI 有 session 列表、workspace、多标签页），「**客户端会话一律由 Host 创建**（一次 `session.create` 同时产生 Session、agent 和 cwd）」（`dsh-client-runtime` README）。
- **一个进程能跑多个会话**：`SessionStore.list()` 返回全部活跃会话；每个 agent 一个会话、一个 scope（`dsh-agent-loop`：「每个 agent 与其会话共享一个由调用方选择的 `SessionId`」）；`ctx.agents.create({sessionId,…})` 可编程创建任意多个。会话是进程内存对象，事件经持久化插件异步落盘。
- **"attach"概念**：DSH 没有面向用户的"attach 到会话"（那个词在内部指 store 发布会话/绑定 fiber：`create` 的 `options.meta attaches creation metadata`；workspace 的 `Workspace.attachSession(id)` 是记账）。恢复历史 = `ctx.agents.resume({resumeSessionId})` 通过持久化加载；「History 会恢复未附加的会话：打开 history 可能创建宿主侧 agent」（`dsh-client-connection` 已知限制）。
- **会话归属**：会话属于创建它的 agent/fiber 作用域；`session/event` 按 agent scope 过滤。**多用户场景下，归属必须是插件自己维护的映射**（DSH 不感知用户）。

### 2.7 会话投影（dsh-session-projection）

`dsh-session-projection/README.zh.md`：`ctx.sessionProjections.register(definition)` 注册投影单元（`{key, stateSchema, init(), apply(state, event), wire?, stateVersion}`），驱动权归框架（每个已提交事件过每个单元的 `apply`）；`onChanged`、`stateOf`、`snapshot` 提供一致切面。已知限制明确写：

> **单元表是进程级的，因此 key 是否存在不能当作逐会话的能力信号**…… `dsh-token-meter` 正因如此留在那里（宿主平面）。

**结论：** 会话可被投影出"每会话"的派生读模型（token 用量、stats），但投影单元表是进程级注册，不是 per-user 注册——按用户聚合要在插件自己的存储里做。

---

## 3. dsh-token-meter（Q3）

### 3.1 measure() / estimateMessage()

`dsh-token-meter/lib/types/index.d.ts`：

```ts
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement;
estimateMessage(message: Message): number;   // 固定启发式
```

`TokenMeasurement`（`lib/types/types.d.ts`）逐字段：

```ts
export interface TokenMeasurement {
  readonly logRevision: number;              // 已消费事件数
  readonly baseline: TokenMeasurementBaseline; // {kind:'none',tokens:0}|{kind:'estimated',tokens}|{kind:'usage',tokens,usage}
  readonly surfaceDeltaTokens: number;       // 相对锚点的带符号表层重计价
  readonly totalTokens: number;              // 请求+响应压力（非负）
  readonly surfaceTokens: number;            // 表层启发式总量
  readonly nodes: readonly TokenSurfaceNode[]; // {seq, tokens}
}
export interface TokenSurfaceNode { readonly seq: number; readonly tokens: number; }
```

启发式（`lib/types/estimate.d.ts`）：`ROLE_OVERHEAD = 4`，「每个 token 按四个字符估算，再加上角色、块与请求 envelope 字段的结构开销」（README：「有意使用一项固定启发式规则…CJK 文本与 JSON schema 会被严重低估」）。

### 3.2 tokenUsage 投影单元（四桶）

`lib/types/projection.d.ts`：

```ts
export interface TokenUsageProjection {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
```

- 「四个桶互不重叠。特别是 reasoning tokens 已包含在 `outputTokens` 中，不再重复累加」。
- 状态 schema（`usage-projection.d.ts`）：`totals`（四桶）+ `last {turn, step, buckets}`——「同一 `(turn, step)` 的最终 assistant 消息用量会替换该样本，而不是重复计数」；「一旦某个更晚的步骤报告了用量，合法日志就绝不会再为更早的步骤报告用量」。
- 另有 `contextPressure`（`pressureTokens`/`projectedTokens`/`contextWindow`）与 `contextBreakdown`（`systemTokens`/`toolsTokens`/`messageTokens`）两个投影单元。

`TokenUsage` 原始类型（`dsh-llm/lib/types/types.d.ts`）：

```ts
export interface TokenUsage {
  inputTokens: number;          // 仅 uncached input
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

> Counts are DISJOINT: `inputTokens` is uncached input only; cached input is reported separately… (DeepSeek 的 `prompt_tokens` 会被适配器扣减)。

### 3.3 用量在哪个时机/事件更新（真实用量链路）

1. 适配器（`dsh-llm-deepseek` / `dsh-llm-pi-ai`）在流式响应中发出 `StreamChunk { type: 'usage', usage: TokenUsage }`（`dsh-llm/lib/types/types.d.ts`：「Adapters emit usage before the terminal finish and nothing afterward」；`dsh-llm/README.zh.md`：「两者都遵循 `types.ts` 中的 `StreamChunk` 约定：usage 先于 finish」）。
2. `dsh-agent-loop` 把 `assistant/chunk { type: 'usage' }` 事件写入会话日志（`dsh-session/README.zh.md` 原文）：
   > Token 记账读取每个步骤的 `assistant/chunk { type: 'usage' }` 记录；如果没有用量分片，则将 `assistant/message.usage` 作为已提交步骤的后备。失败的模型请求尝试没有 assistant 消息。
3. `ctx.tokenMeter` 从**持久日志**逐会话重放折叠（「从持久日志为每个会话推进一个隔离 fold」）；提供方用量仅在「最新成功调用的规范请求 envelope 与已测量 envelope 匹配，且其总量不低于该调用的完整启发式锚点」时复用，否则退回完整启发式估算。
4. 可选 `ctx.sessionProjections` 组合时注册 `tokenUsage` 等三个投影单元（每会话、全日志累计、可检查点缓存）。

**结论：能拿到"提供方真实用量"**（经由适配器 → 日志 → fold），粒度是每会话每 turn/step 的四桶累计；**但只到 session 粒度，且无计价**。

### 3.4 模型价格表？

`ctx.llm.resolveModelInfo(provider, model, signal)` 返回 `LlmResolvedModelInfo`（`dsh-llm/lib/types/types.d.ts`）：

```ts
export interface LlmModelContext { contextWindow: number; }   // 最大 combined 请求+响应 token
export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: LlmModelContext;
  defaultMaxTokens?: number;
  reasoning?: LlmModelReasoningInfo;
}
```

README：「缺少 `context` 表示模型容量未知…」。**整个 `LlmResolvedModelInfo` 没有任何价格字段**（无 per-token 价格、无货币）。`dsh-token-meter` README 亦确认「模型容量属于…适配器，可通过 `ctx.llm.resolveModelInfo().context` 获取」——只有容量。

**结论：算"金额"必须自己维护价格表**（模型 id → 输入/输出/cache 单价），且把四桶 × 单价在插件内按用户聚合。

---

## 4. 身份与"单用户假设"（Q4）

### 4.1 dsh-anonymous-user-id：不是登录身份

`dsh-anonymous-user-id/README.zh.md`：

> 会话遥测、直接反馈确认与 DeepSeek 提供方请求共用的匿名身份。`getOrCreateAnonymousUserId()` 返回一个限定于单个 harness home 的随机 UUID v4，并以裸行形式持久化到 `$DSH_HOME/.anonymous-user-id`…该身份绝不从 hostname、网络地址、git remote 或其他可用于识别身份的来源派生。…不同 harness home 拥有不同身份。

- 一个 `$DSH_HOME` 一个 id（**机器/部署级，不是用户级**；多个用户共用一台机器/一个 DSH_HOME 时是同一个匿名 id）。
- 用途：OTel `user.id`、`/feedback` 确认文本、DeepSeek 请求头 `x-deepseek-harness-user-id`。**不假设单用户，但也不提供用户概念**——它只是"harness home 的匿名标识"。

### 4.2 客户端 runtime 的用户概念：无

`dsh-client-runtime` README：「客户端会话一律由 Host 创建（一次 `session.create` 同时产生 Session、agent（智能体）和 cwd）；客户端不持有任何实体化之前的会话状态——agent scope（host dsh-scope 的客户端镜像，以 agent/session 共用 id 为键）…」。作用域/身份键 = **agent/session 共用 id**，没有 user 维度。

### 4.3 workspace 根目录是谁的：启动目录 / 会话 cwd

- `dsh` 主 README：「**运行命令时所在的目录将作为默认 workspace 根目录**」。
- 每个会话创建时记录不可变 `SessionHeader.cwd`（`meta.cwd` 必须是绝对路径，否则 create 拒绝：「`meta.cwd` is a non-absolute path」）。
- 沙箱策略（`dsh-sandbox-policy` README）：「普通 agent 调用改用其会话头中不可变的 `cwd`」作为 `workspaceRoot`；「创建时记录的不可变 `SessionHeader.cwd` 是该会话每次调用使用的根」。
- 即：**workspace 根是"每个会话一个 cwd"，源自启动目录**；web/headless 启动时以 `process.cwd()`/launcher 目录为准。没有 per-user workspace 概念。

### 4.4 全部"auth / 单用户 / 认证层"相关表述（原文清单）

| 出处 | 原文（中文 README） |
|---|---|
| `dsh-client-connection/README.zh.md` | 「以空信任表过信任 fence，从而钉在回环——已声明的 `trustedHosts` 授权可达其余全部方法，而**这些方法在真正的认证层出现之前仍只限回环本机**」 |
| 同上 | 「`dsh web --host 0.0.0.0` **在远程访问具备认证层之前有意不受支持**」 |
| 同上 | 「**这道栅栏是可达性策略，而不是认证；Web 载体不提供认证层**」 |
| `dsh-host-apiproxy/README.zh.md`（已知限制） | 「**搜索失败会包含提供方诊断信息**：**网关是单用户本地服务**。将其暴露给多名用户的载体必须用可安全公开的诊断信息替代内部搜索细节。」 |
| `dsh-host-webserver/README.zh.md` | 「**不提供 TLS、认证或来源策略**：绑定非回环地址会向对应网络公开服务器；面向部署的加固措施（或在前方放置真正的反向代理）有意不纳入面向开发环境的 v1。」 |
| `dsh-settings/README.zh.md`（已知限制） | 「**单一用户层** — 解析只认识 schema 默认值、一个组合 `base` 与一个用户文档」 |
| `dsh-web-app/README.zh.md` | 「它会在发布该服务前拒绝 `--host 0.0.0.0`，因为 CLI 目前有意不支持绑定所有网络接口。」 |
| `dsh-authorization/README.zh.md` | 「有些凭据无法配置，只能获取：拿到它意味着与人对话——打开这个页面、粘贴那个码、选一个账号。」（OAuth/login 交互 seam，非用户登录体系；「**flow 不可恢复** —— 一次尝试只存活于发起它的进程中」） |
| `dsh-llm/README.zh.md` | `LlmError` 稳定 code 含 `AUTH`／`RATE_LIMIT`／`QUOTA`（`QUOTA_EXCEEDED_CODE`：「帐户配额、余额、点数、预算或用量限制耗尽时使用的非暂时性提供方无关 code」）——这是**提供方 API 的配额错误码**，不是 DSH 自身的用户配额机制。 |
| 全局搜索 | 「multi-user / tenant / login（登录体系）」在全部 README 中**无**任何实现性表述；`dsh-bash-local` 的 "login" 仅指 shell 的 login shell。 |

**官方态度总结：** 认证层被明确预留为"未来的、由载体/部署提供"的位置；当前 `/api` 信任栅栏（loopback + `trustedHosts` 白名单）被官方反复声明为"可达性策略而非认证"。多租户插件正是官方所说的"暴露给多名用户的载体"。

---

## 5. 多租户可行性评估（Q5）

### 5.1 现成抓手

| 需求 | 抓手 | 证据 |
|---|---|---|
| 会话级隔离 | `SessionStore` 多会话 + agent/session 作用域；`session/event` 按 scope 过滤 | `dsh-session/lib/types/index.d.ts`（Scope-filtered dispatch）；`dsh-agent-loop` README |
| 会话归属用户 | 自定义 `SessionId`（brand 字符串，create 接受 id）+ 插件领域表 `userId→sessionIds` | `dsh-session/lib/types/types.d.ts`、`SessionStore.create` |
| token 用量统计 | `ctx.tokenMeter.measure()`、`tokenUsage` 投影单元（四桶累计）、`session/event`（`assistant/chunk usage`） | §3 |
| 文件系统限制 | `dsh-fs-sandbox`（workspace-write 只允许 workspaceRoot+tmp，per-call 策略） | `dsh-fs-sandbox/README.zh.md` |
| bash 限制 | `dsh-bash-sandbox` + `dsh-sandbox-local`（bwrap/Landlock/Seatbelt runner；read-only/workspace-write/danger-full-access） | `dsh-bash-sandbox/README.zh.md` |
| 沙箱策略 per 会话 | `ctx.sandboxPolicy.resolve({session, mode})`：会话不可变 cwd → workspaceRoot | `dsh-sandbox-policy/README.zh.md` |
| 非会话数据持久化 | `ctx.storage` + `dsh-storage-json`（`$DSH_HOME/storages/`）+ `dsh-storage-domain`（`ctx.storage.domain`，写链串行、`domain/changed`） | §6 |
| 配置持久化 | `ctx.settings`（namespace 注册、`update/replace/mutate`、revision 冲突检测） | §1.3 |
| 事件总线扩展 | `SessionEventMap` 声明合并（插件可加自己的事件类型）；`sessionProjections` 注册新投影单元 | `dsh-session/README.zh.md`、`dsh-session-projection/README.zh.md` |
| 审计日志载体 | `dsh-session-telemetry`（`SessionTelemetrySink`，捕获 `session/event` + 脱敏 waterfall）；`session/event` 订阅 | `dsh-session-telemetry/README.zh.md` |

### 5.2 硬障碍

1. **进程级隔离缺失**：所有 agent 跑在同一 host 进程；`dsh-credentials-local` 安全边界明确写「挡得住其他 OS 用户，**挡不住**模型——工具进程（bash、文件系统工具）以同一用户身份运行」。模型/agent 是**同信任级**的，无法用 DSH 现有机制把"用户 A 的 agent"与"用户 B 的 agent"做内核级隔离。
2. **workspace/`$DSH_HOME` 共享**：settings/credentials/存储文档都是 `$DSH_HOME` 级一份（单一用户层）；会话持久化 root 也是 `$DSH_HOME/sessions`。多用户要么接受共享 home（靠 id 前缀 + 插件映射区分），要么按用户建独立 home（见 5.4）。
3. **沙箱是"模式+根"不是"主体"**：sandbox 按会话 cwd 解析 workspaceRoot，没有 user 维度；同 `danger-full-access` 下无任何限制。配额插件只能限制"用户能发多少次请求/多少 token"，不能阻止一个 agent 用 `danger-full-access` 读另一个用户的数据（同 UID）。
4. **并发模型**：领域存储 `domain/changed` 只进程内可见（「第二个主机进程或重新连接的 GUI 无法观察变更」）；`dsh-storage-json`「没有跨进程写锁…当前消费方采用单一宿主进程部署」；`dsh-message-feedback`「Compare-and-set 仅限单进程…多个 Host 进程写入同一存储根目录时仍可能丢失更新」。→ **多 host 进程共享同一存储不成熟**，单 host 进程 + 多用户是正确形态。
5. **会话 attach 的归属**：DSH 的恢复/打开（`agents.resume`、history 打开）没有"当前用户"概念；任何能调 `session.create/resume` 的客户端都能碰任何会话——**归属检查必须由多租户插件在网关层/Remote 层拦截**（见 §7）。
6. **单进程多用户的身份边界**：`ctx.credentials`/`ctx.settings` 无 per-user 层；多用户插件不能复用它们存用户级数据，否则互相覆盖。

### 5.3 方案对比：每用户独立 profile vs 单 profile 多用户

| 维度 | 每用户独立 profile（每个用户一套 `$DSH_HOME/profiles/<p>` 或独立 `DSH_HOME`） | 单 profile 多用户（一个 host 进程内按用户隔离） |
|---|---|---|
| 进程模型 | profile 是整进程组合；web profile 每次启动一个 host 进程、绑一个端口（`dsh-host-webserver`：`{host, port}`，EADDRINUSE 即加载失败）。**一次只能起一个 web profile 实例**（同端口）；多个 profile 需多端口/多进程，且每个都是完整 host（各自内存 SessionStore、各自 agent），用户间**完全隔离**（进程级） | 一个 host 进程 + 一个 web profile，内存共享 |
| 存储 | 天然按用户隔离（各自 `$DSH_HOME`/`settings.yaml`/`sessions/`）；但 profile 由"bundles + patch"定义，`dsh plugin --profile <name>` 安装；每个用户一套凭据/模型配置 | `$DSH_HOME` 共享；必须插件层做用户分区（领域表 + id 前缀 + 网关拦截） |
| 会话隔离 | 进程级，强 | 逻辑级（作用域 + 插件归属表），进程内共享 host |
| 用量统计 | 每个进程自己记账，跨进程聚合难（无跨进程存储语义） | 同一进程内 `ctx.tokenMeter` 天然全局，按用户聚合方便 |
| 成本 | 高：每用户一进程、一端口、一配置面；`trustedHosts`/loopback 语义在远程场景下要每用户一套 | 低：一份部署，登录→会话→配额→统计都在一个进程内闭环 |
| 官方立场 | 「网关是单用户本地服务」——每个用户一套完整 DSH 是官方原意的使用方式 | 「将其暴露给多名用户的载体」——正是多租户插件该干的活 |

**结论：** 推荐**单 host 进程 + 多用户**（插件做登录、角色、归属、配额、聚合统计 + 网关层拦截）；把"每用户隔离"理解为**逻辑隔离**（session/作用域/映射表），并把"进程级安全"诉求明确标注为 DSH 当前不提供、需依赖外部（每用户容器/独立 DSH_HOME）或接受风险。

---

## 6. 持久化选型（Q6）

### 6.1 DSH 自带哪些数据库/存储依赖

- **没有** better-sqlite3 / sqlite3 / lowdb / level（在 `dsh/node_modules/` 顶层及全部包的 package.json 依赖中均不存在；`dsh-session-query-sqlite` 的依赖只有 `@deepseek-ai/schemastery`）。
- **使用 Node 内置 `node:sqlite`**（`dsh-session-query-sqlite/README.zh.md`）：
  > `openAt: startup` 是默认值：服务激活会导入 `node:sqlite` 并打开句柄…
  > 该模式通过把 SQLite 的实验性警告推迟到首次实际搜索，支持需要干净 Node 22 启动输出的组合…
  - 当前环境 Node `v24.18.0`：实测 `node:sqlite` 可加载（`DatabaseSync` 存在）且无实验警告。→ **零 native 依赖、零安装成本**。
  - 已用点：FTS5 全文搜索（`searchSessions`/`searchEvents`，`unicode61` 分词器）、`journalMode: wal` 默认、`0700`/`0600` 权限创建、**「每个索引路径在一个进程中只能由一个服务拥有；不支持外部写入者或第二个进程」**（再次印证单进程部署形态）。

### 6.2 DSH 自带的非会话存储中心（推荐先看这个）

- `dsh-storage`：`ctx.storage` 中心，`backend` 具名注册（「多个后端并排保持挂载（`json`、`sqlite`）」），当前唯一数据形状分面 `kv`。
- `dsh-storage-json`：`json` 后端，`root` 配置（web-app patch 里是 `dshHomePath('storages')` → `$DSH_HOME/storages/`），每个单元一个 `<unit>.json`，临时文件写入 + fsync + 原子 `rename()` 整文件替换；「内存中的单元状态具有最终决定权」；「没有跨进程写锁…当前消费方采用单一宿主进程部署」。
- `dsh-storage-domain`：`ctx.storage.domain` 领域表单。API（`lib/types/domain.d.ts`）：`DomainFacility.open` → `Domain`（`global.get/set`、`table(name)` → `KvTable`：`get/entries/keys/size/put/delete/update(fn)`，`update` 为**写链上的原子读-改-写**）；「写入在每个领域各自的一条链上串行化，先在已路由后端达到持久状态，再更新内存并发出 `domain/changed`」。限制：「没有跨表事务、二级索引或多段键：每次写入只触碰一条记录」；`domain/changed` 仅进程内。
- 已有消费者：`dsh-workspace`（workspace 记录/顺序/会话记账）、`dsh-session-projection-cache`（`session_projcache` 域，每会话一条 `(key→{ver,seq,val})`）、`dsh-message-feedback`。

**结论：** 用户账号（`userId → {email, passwordHash, roles[]}`）、配额（`userId → {tokenQuota, spentTokens, ...}`）、会话归属表、审计日志都适合用 `ctx.storage.domain` 的 KV 表实现（`domain/changed` 可做内存同步；`update()` 做配额扣减的原子 RMW）。**需要关系查询/二级索引/事务时自建 SQLite（node:sqlite）**，参考 `dsh-session-query-sqlite` 的写法（专用派生库、单进程单所有者、WAL）。

### 6.3 dsh-atomic-write

`dsh-atomic-write/README.zh.md`：零依赖原子文件替换（供 `dsh-settings-file` 与 `dsh-credentials-local` 共用）：

```ts
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })
await withFileLock('/home/u/.dsh/settings.yaml', async () => { ... })
```

- 独占创建临时文件（`wx`+随机后缀，抗符号链接）→ 全新 inode 带 `mode` rename → 同目录原子；`withFileLock` 跨进程串行化（`<file>.lock`，指数退避，超时失败）。
- **注意：原子但不持久**（无 fsync；崩溃后 rename 可能回退）；遗留锁需人工恢复。

### 6.4 插件自建存储的可行性与注意点

- **node 版本**：要求 Node ≥22.5（node:sqlite）；当前环境 v24.18.0 ✅。
- **native 模块**：node:sqlite 零 native；若用 better-sqlite3 等需编译/预构建——不必要。
- **安装方式**：插件经 profile 安装，`dsh plugin --profile <name> <pnpm args>`（dsh 主 README：「`dsh plugin --profile <name> <pnpm args>` 通过在 profile 目录中转发给 pnpm 来管理该 profile 的插件」）；profile 的 `node_modules` 与随附 bundle（`dsh.profile.bundles`）解析顺序：先从 dsh 安装目录解析（`@deepseek-ai/dsh-base` 等），再从 profile 自身 node_modules 解析。
- **注意点**：单进程单所有者（勿多进程共享同一 SQLite 派生库/JSON 单元根）；目录权限仿照 0700/0600；`$DSH_HOME` 语义是"每部署一份"（多用户 = 一个 `$DSH_HOME` + 插件内分区，或每用户独立 `$DSH_HOME`）。

---

## 7. dsh-api-gateway / dsh-api-remotes（Q7）

### 7.1 各自职责

- **`dsh-api-gateway`**：Typert RPC endpoint（`ctx.typertGateway`，Host 侧；`ctx.remote`，Client 侧）。
  - Host 侧 `invoke()`：解析 `InvocationDescriptor` → 校验参数 → 解析 lookup（`ctx.typert.lookups`，agent/session 等身份解析器）→ 调用 `@Remote`/`@RemoteScope` 标记的业务方法 → 校验结果。支持 `signal: AbortSignal` 取消（末位注入）。
  - Client 侧 `ctx.remote.$mount()`：校验并注册贡献项 → 安装 `remote.<namespace>` 子 Service；`ctx.remote.$on()` 订阅**被转发的 Host 事件**（合法键 = Host 声明的转发选择）；`$dispatch()` 是载体把 Host 帧交给 client 半。
  - 传输、信任栅栏归 `dsh-client-connection` 的 `/api` route（Gateway 作为 interceptor 先认领 Remote endpoint，未认领回退 API Proxy）。
- **`dsh-api-remotes`**：双侧 BFF（业务面）。Host 入口管 **Agent/Session 身份策略**（`createApiRemoteAgentResolver()`：复用 live agent、恢复冷会话、并发恢复去重、subagent ownership fence；同时配置 Typert `agent` 与 `session` lookup）；`src/remote-events.ts` 持有 **`API_REMOTE_FORWARDED_EVENTS`** 白名单（「本应用原样转发给消费端的 Host cordis 事件名单（无投影、无脱敏、无改名），它同时就是 `ctx.remote.$on` 的合法键集」）。

### 7.2 客户端调用 Host 服务的完整链路

1. 业务包用 `@Remote`/`@RemoteScope` 装饰器 + `TypertRemoteService`/`bindTypertRemote()` 声明 Remote 方法（`dsh-typert-protocol`）；生成的产物扩展 `TypertRemoteMap`/`TypertRemoteScopeMap`/`TypertRemoteNamespaceMap`。
2. Host 组合把服务挂到 `ctx.typertGateway`（Connection 可用时注册为 `/api` 上的 trusted-host interceptor）。
3. 浏览器 → `AbstractApiClient`（`dsh-host-apiproxy` 载体：HTTP POST unary/respond + WebSocket 下行）→ `dsh-client-connection` 的 `/api` 信任栅栏（loopback/trustedHosts）→ Gateway interceptor 认领 endpoint → `invoke()` → 业务方法。
4. Client 侧 `dsh-api-remotes` Client face 导入生成的 `/remote` 产物，`ctx.remote.$mount()` 挂载；业务包经 `remote.<namespace>` 调用，事件经 `ctx.remote.$on()`（键面 = 白名单）订阅。

### 7.3 插件加新 Remote 命名空间的步骤

按 README 与 `dsh-typert-protocol` 的约定，新 Remote 能力需要：

1. **Host 侧**：写业务 Service（继承 `TypertRemoteService`，`@Remote` 标记方法；`@RemoteScope(key)` 则注册 scope Context 提供方）；扩展 `TypertLookupMap`（如 `agent`/`session` 查找）与 `TypertContextMap`。
2. **生成**：跑 Typert 构建流水线生成严格 `InvocationDescriptor` 与客户端 `/remote` 产物（README：「参数、结果、查找和 schema 反射需要 Typert 构建流水线」；SRC 模式仅限开发回退）。
3. **Host 组合**：把服务注册进组合，经 `ctx.typertGateway` 暴露（或 `bindTypertRemote`）。
4. **Client 侧**：贡献项经 `ctx.remote.$mount()` 挂载（命名空间冲突/缺编解码器会报错）；新增转发事件时**在 `API_REMOTE_FORWARDED_EVENTS` 数组加一行**（「多转发一个事件只需在该数组里加一行：类型投影、消费端键面与 Host 转发循环全部由它派生」）；Host face 断言 `TypertForwardableEvent`（未声明的事件名、绑定 AgentScope 的事件、非单向事件会被拒绝）。
5. **身份策略**：若方法以 session/agent 寻址，把 resolver 交给 `createApiRemoteAgentResolver()`（`dsh-api-remotes` Host face）。

**对多租户的意义：** `dsh-api-remotes` 是**在 Remote 层注入"身份/归属策略"的官方位置**（agent/session lookup resolver、ownership fence、转发事件白名单）——多租户插件的「该用户能否访问该 session/该 Remote 方法」检查可以挂在 Host face 的 lookup resolver 与 Gateway 拦截层（与现有 `agentPreset.*` 权限方法同构）。

---

## 8. 多租户总体可行性评估（结论汇总）

**总体判断：可行（逻辑隔离级），且官方架构为"单用户本地服务 + 载体负责多用户"预留了明确位置。**

- **直接可用**：
  - 登录态/会话归属：自建（领域存储 KV 表或 SQLite）；`SessionId` 前缀编码用户 + `userId→sessionIds` 映射。
  - 角色/权限：插件自己的表 + 在 Remote lookup/Gateway 层拦截（`dsh-api-remotes` 的 resolver 是官方注入点）。
  - 配额（token）：`tokenUsage` 投影四桶 × 自建价格表 → 按用户聚合；`ctx.tokenMeter.measure()` 是同步精确面。
  - 配额（金额）：自建价格表（DSH 无价格字段），按 `(provider, model)` 匹配；注意用量到金额的换算点（每次 `assistant/chunk usage` 提交时记账最准，因为失败请求也可能有 usage 分片）。
  - 用量统计/审计：订阅 `session/event` + `session/flush`；或复用 `dsh-session-telemetry` 的 sink 约定（含脱敏 waterfall）。
  - 会话隔离：agent/session scope + `session/event` scope 过滤；`dsh-scope` 已按 sessionId 路由。
- **硬障碍（必须明示）**：
  - 无进程级/用户级隔离：模型与工具同 UID，`danger-full-access` 无限制；多用户之间的"安全边界"只能做到逻辑层 + 依赖外部（容器/独立 DSH_HOME/OS 用户）。
  - `$DSH_HOME` 级存储（settings/credentials/sessions/storages）无 per-user 层；跨进程共享存储不受支持（单进程部署形态）。
  - 官方 UI/网关面向单用户（搜索诊断、trustedHosts 模型、"认证层"未实现）；远程多用户暴露需要自建认证层并自己处理 trust 语义。
  - 会话"attach/恢复"无用户概念，归属校验必须插件自做。
- **建议架构（一句话）**：单 host 进程 + 多用户：登录（邮箱密码/LDAP/OIDC，自建）→ 会话创建时插件把 `SessionId` 编码 `userId` 并记账 → 网关/Remote resolver 拦截归属与角色 → `tokenMeter`+自建价格表按用户聚合配额 → `session/event` 订阅写审计日志 → 全部持久化用 `ctx.storage.domain`（KV）或 node:sqlite（关系查询）。

## 9. 未确认 / 待验证事项

- 多用户下"每个用户独立模型路由/凭据"是否可行：`ctx.credentials`/`ctx.settings` 均为进程级单层（无 per-user 层），**未确认**是否有插件级 workaround（例如按用户动态替换 llm 配置，需查 `dsh-llm` adapter 的 per-request override 能力）。
- OIDC/SSO：DSH 无任何现成 OIDC 客户端；`dsh-authorization` 只提供"人机交互式授权 flow"（OAuth grant 给 LLM 提供方），**未确认**能否借其 UX 承载用户登录（其交互词汇为 text/secret/select + notify，理论上可，但语义是凭据不是账号）。
- 金额计价的汇率/缓存价格表更新策略：完全自建，DSH 无涉。
- `dsh-session-telemetry-otel` 后端细节（是否随发行版默认挂载、导出字段全集）未逐一核对，审计日志若走它需再读该包 README。
- headless profile 每次一个全新持久化会话（`dsh-headless` README），对多用户 CLI 场景的含义未深究。
