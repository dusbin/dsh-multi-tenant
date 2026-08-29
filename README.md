# dsh-multi-tenant

DeepSeek Harness 多租户插件：把 DSH 从"本地单用户开发工具"扩展为**多租户、多角色、可登录、可计量、可审计**的服务形态。

> 状态：**M7 完成（全部里程碑）**——M1-M6 已交付，M7 硬化/部署文档/打包验证完成
> 方案文档：`docs/方案.md`（v2.0 定稿，含用户决策 D1–D6）；调研报告：`docs/research/01/02/03`

## 功能路线

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 工程骨架 + 认证反代网关（HTTP/WS 代理、cookie 会话）+ bootstrap 平台管理员 + DB 层 | ✅ 完成 |
| M2 | 多租户 + RBAC：/mt 管理通道、租户/用户/角色管理 API、会话归属前缀强制、管理控制台 UI | ✅ 完成 |
| M3 | 用量统计（token 四桶）+ 配额（同步检查 + 周期累计）+ 用量/配额 UI | ✅ 完成 |
| M4 | 审计日志（查询/CSV 导出/登录失败留痕）+ 审计员视图 + 强制下线 | ✅ 完成 |
| M5 | LDAP 登录（ldapts，目录绑定验证 + 自动建号） | ✅ 完成 |
| M6 | SSO/OIDC 登录（openid-client，Authorization Code + PKCE） | ✅ 完成 |
| M7 | 硬化 + 交付：账号自动锁定、安全响应头、部署文档、真实 `dsh plugin add` 安装验证 | ✅ 完成 |

## 架构一句话

**认证反代网关**：DSH 本体保持 loopback 绑定，插件内嵌网关监听对外端口，做登录/会话校验后把 HTTP 与 WebSocket 全量代理到 DSH——`/api` 信任栅栏天然放行 loopback Host，DSH 零改源码。

```
浏览器 → 网关(:3090)  [登录/RBAC/配额/归属强制] → 127.0.0.1:<DSH端口>（原样运行）
```

## 安装

### 方式 A：`dsh plugin`（发布包/本地目录）

```sh
dsh plugin --profile web add dsh-multi-tenant            # 已发布包
dsh plugin --profile web add /path/to/dsh-multi-tenant   # 本地目录（开发验证）
```

包声明了 `dsh.bundle`，`dsh plugin` 会自动把它加入 profile 的 bundles 并应用
`cordis.patch.yml`（默认网关 `0.0.0.0:3090`），零手动配置即可启动。
已实测：`dsh plugin add <本地目录>` → bundles 自动接入 → 启动后网关按默认配置生效。

### 方式 B：源码开发（本仓库）

```sh
# 1. 软链到 profile node_modules
ln -sfn /Users/robinddu/Desktop/workspace/robinddu/dsh-multi-tenant \
        ~/.dsh/profiles/web/node_modules/dsh-multi-tenant

# 2. 在 profile 的 cordis.patch.yml 里插入一行
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: multi-tenant
      name: 'dsh-multi-tenant'
      config:
        gateway:
          enabled: true
          host: '0.0.0.0'
          port: 3090
```

> 源码改动后重启 profile 即可（或把 name 里的包名换成 `...dsh-multi-tenant/lib/index.js?v=N` 用 `?v=` 破除 ESM 缓存）。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `gateway.enabled` | `true` | 是否启动认证网关 |
| `gateway.host` / `gateway.port` | `0.0.0.0` / `3090` | 网关监听地址（对外入口） |
| `cookie.name` | `mt_session` | 会话 Cookie 名 |
| `cookie.maxAgeDays` | `14` | 会话有效期 |
| `cookie.secure` | `false` | 公网 HTTPS 部署置 `true`（Cookie 加 Secure） |
| `db.path` | `$DSH_HOME/multi-tenant/mt.db` | SQLite 数据文件（node:sqlite） |
| `auth.local.enabled` | `true` | 邮箱密码登录 |
| `auth.local.maxFailedAttempts` | `5` | 防爆破：窗口内失败上限 |
| `auth.local.lockWindowMs` | `900000` | 防爆破窗口（15 分钟） |
| `auth.bootstrap.enabled` | `true` | 首启 bootstrap 平台管理员 |

## 认证 API（网关直答）

| 端点 | 说明 |
|---|---|
| `GET /api/auth/me` | 当前用户；未初始化返回 `{ok:true,user:null,bootstrapRequired:true}` |
| `POST /api/auth/login` | `{username, password}` → 200 + `Set-Cookie`；401/423/429 |
| `POST /api/auth/logout` | 登出（幂等） |
| `POST /api/auth/bootstrap` | 首次使用创建平台管理员（201；已初始化 409） |

## 访问策略（v1）

- 除公开路径外**一切请求**（任意方法，含 `/api`、`/mt`）必须登录，否则 401
- 公开路径：`/api/auth/*`（认证端点）、GET/HEAD 静态资源（`/`、`/assets/*`、`/plugins/*`、favicon）
- `/api/events.mux`、`/api/events.host` 的 WebSocket upgrade：必须登录，否则拒绝握手
- **会话归属强制**：`session.create` 的 `sessionId` 被网关改写为归属前缀
  `u-<uid>-t-<tid>-s-<uuid>`（伪造他人前缀无效）；其他会话作用域请求校验前缀，
  越权返回 403 并记审计
- 直连 DSH 端口（`127.0.0.1:<port>`）保持开发者模式开放；生产请只暴露网关端口

## 角色与权限（M2）

| 角色 | 权限 |
|---|---|
| 平台管理员（system） | 租户生命周期（建/停/列）、任意租户用户管理、全局审计（不占租户配额） |
| 租户管理员（admin） | 本租户用户管理（建/启停/改角色/重置密码/删除）、配额设置、审计查看（自动含审计权限，D4） |
| 审计员（auditor） | 本租户只读统计 + 审计日志 |
| 使用者（user） | 登录、使用会话、查看个人用量 |

租户间完全隔离：会话、用户、用量、审计、配额互不可见（网关 + 服务层双重强制）。

## 管理 API（`/mt` 通道）

客户端经 `ctx.connection.rpc.call('/mt', endpoint, payload)` 调用（响应为 RPC 信封）。

| 端点 | 说明 | 权限 |
|---|---|---|
| `me` | 当前用户 + 租户信息 | 任意已登录 |
| `auth.changePassword` | 修改本人密码 | 任意已登录 |
| `tenant.list` / `tenant.create` / `tenant.setStatus` | 租户管理 | system |
| `user.list` | 用户列表（本租户） | admin+ |
| `user.create` / `user.setStatus` / `user.setRole` / `user.setPassword` / `user.delete` | 用户管理 | admin+（租户内） |
| `usage.summary` / `usage.sessions` | 用量统计（汇总/按用户/会话明细，period: day/month/all） | auditor+（租户内），user 仅本人 |
| `quota.view` | 配额视图（本人/指定用户/指定租户） | 任意已登录（他人需 admin+） |
| `quota.set` / `quota.clear` | 设置/清除配额（scope: platform/tenant/user，period: daily/monthly/total） | admin+（platform 需 system） |
| `audit.list` / `audit.export` | 审计日志查询/CSV 导出（可按 action/result 过滤） | auditor+（租户内只读），system 全局 |
| `user.revokeSessions` | 强制下线（吊销该用户全部会话） | admin+（租户内），本人亦可 |

管理控制台 UI（浏览器）：设置面板新增页签 **个人中心 / 用户管理 / 租户管理 / 用量统计 / 配额 / 审计日志**（按角色可见）。

## 用量统计与配额（M3）

- **计量**：`tokenUsage` 会话投影（web profile 已组合 dsh-token-meter）四桶
  `{uncachedInput, output, cacheRead, cacheWrite}`；插件按会话前缀归属，差分记账到
  `usage_records`（首见只建基线，恢复的旧会话不重复计费；压缩/失败请求由投影正确处理）
- **配额**：平台/租户/用户 三级 × 日/月/累计 周期，任一适用限额达到即拒绝新的
  `session.prompt`/`subagent.prompt`（网关前置检查，返回 `quota-exhausted` 业务错误）；
  周期窗口自动滚动
- **视图**：用量仪表盘（今日/本月/累计 + 按用户 + 会话明细）、个人配额剩余、配额管理

## 审计日志（M4）

- **留痕**：登录（成功/失败原因）、登出、bootstrap、改密、租户/用户/配额全部管理操作、
  会话越权（session.denied）、配额拒绝（quota.denied）——`audit_logs` 只追加不可改删
- **查询**：`audit.list`（action/result/用户/时间过滤 + 分页）；**导出**：`audit.export`（CSV，UTF-8 BOM）
- **审计员角色**：租户内只读查询与导出；使用者无审计权限；平台管理员全局可查
- **强制下线**：`user.revokeSessions` 吊销指定用户全部会话（启停账号时同样即时失效会话）

## LDAP 登录（M5）

`/api/auth/login` 支持 `method: 'local' | 'ldap'`（省略时自动：有本地账号走本地，否则尝试 LDAP）；
登录页按 `me` 返回的 `methods` 渲染按钮。

| 配置键（`auth.ldap.*`） | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 启用 LDAP |
| `url` | — | `ldap://host:389` 或 `ldaps://host:636` |
| `bindDn` / `bindPassword` | 空 | 服务账号（空 = 匿名搜索） |
| `baseDn` | — | 用户搜索基 |
| `userFilter` | `(uid={{username}})` | 搜索过滤器，`{{username}}` 自动转义 |
| `attributes` | `{username: 'uid', email: 'mail', displayName: 'cn'}` | LDAP 属性 → 本地字段映射 |
| `autoProvision` | `true` | 首次登录自动建号（按 `ldap_dn` 关联） |
| `defaultTenantId` | `null` | 自动建号归属租户（null = 平台域） |
| `defaultRole` | `user` | 自动建号默认角色 |
| `timeoutMs` | `5000` | 目录操作超时 |

- 认证流程：服务账号 bind → 按过滤器搜索用户 → **以用户 DN + 密码绑定**（标准 LDAP 密码校验）
- 目录凭据错误 → `invalid-credentials`；目录不可达 → `ldap-unavailable`（不泄漏目录细节）
- LDAP 登录同样受防爆破与审计；禁用/锁定账号即时生效

## SSO / OIDC 登录（M6）

登录页按 `me` 返回的 `methods` 渲染 **SSO 登录** 按钮（含 `oidc` 时）：
点击 → `/api/auth/oidc/start` 返回 IdP 授权 URL → IdP 登录 → 302 回
`/api/auth/oidc/callback` → 网关换令牌（PKCE）并校验 ID token（签名/iss/aud/exp）→
Set-Cookie + 302 回原目标。

| 配置键（`auth.oidc.*`） | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 启用 OIDC |
| `issuerUrl` | — | OIDC 发现端点（自动获取 JWKS/端点） |
| `clientId` / `clientSecret` | — | 客户端凭据 |
| `publicBaseUrl` | 空 | 对外基址（redirect_uri 用；空 = 取请求 Host / X-Forwarded-Proto） |
| `redirectPath` | `/api/auth/oidc/callback` | 回调路径 |
| `scopes` | `openid profile email` | 请求的 scope |
| `claimsMapping` | `{subject:'sub', username:'preferred_username', email:'email'}` | ID token 声明 → 本地字段 |
| `autoProvision` | `true` | 首次登录自动建号（按 `oidc_sub` 关联） |
| `defaultTenantId` / `defaultRole` | `null` / `user` | 自动建号归属 |

- 认证流程：Authorization Code + PKCE（state 内存 TTL）；openid-client 校验 ID token 签名与 issuer/audience
- state 失效/换令牌失败/无 subject → 明确错误码，302 回 `/?mt_error=<code>` 并记审计
- SSO 登录同样受禁用/锁定账号即时校验

## 管理员逃生通道 / 系统重置 / 数据备份（逃生与运维）

### 主机侧维护 CLI（逃生通道，免登录）

```sh
node scripts/maintenance.mjs status                          # 系统概览
node scripts/maintenance.mjs reset-admin-password --username <u> --password <p>  # 重置密码（免登录）
node scripts/maintenance.mjs create-system-admin --username <u> --password <p>   # 无可用管理员时创建
node scripts/maintenance.mjs unlock-user --username <u>                          # 解锁账号
node scripts/maintenance.mjs reset-system [--keep-usage]                         # 重置多租户系统
node scripts/maintenance.mjs export --out backup.json                            # 导出全量数据
node scripts/maintenance.mjs import --in backup.json --replace                   # 导入恢复（覆盖）
```

- 需要本机文件系统访问（与 DSH 同信任级）；`--db` 缺省 `$DSH_HOME/multi-tenant/mt.db`
- 导出为**版本化 JSON**（含密码哈希——视为敏感凭据），覆盖 tenants/users/quotas/用量/审计

### UI 逃生通道（环回受限）

- 当**无任何可用平台管理员**（全部禁用/锁定/删除）时，登录页显示"管理员恢复"表单
- `POST /api/auth/recovery` **仅允许环回来源**（本机/网关本地）——远程无法触发
- 恢复 = 新建平台管理员（复用会话机制）

### 控制台导出

- `/mt data.export`（**仅平台管理员**）：全量备份下载（与 CLI export 同格式）
- 导入仅 CLI（覆盖式恢复，防止误操作）

## 租户可见性（工作区 / 会话）

- **平台管理员**：查看所有工作区与会话/任务
- **租户管理员 / 审计员**：仅本租户（`t-<tid>` 前缀归属）
- **使用者**：仅本人（`u-<uid>-t-<tid>-s-` 精确前缀）
- **无归属前缀的遗留会话**：仅平台管理员可见

实现：
- 列表端点（`session.list` / `session.search` / `workspace.list`）响应按会话前缀过滤
  （工作区按可见会话裁剪，无可视会话则隐藏）
- **WS 下行帧级过滤**（`events.mux` / `events.host`）：`host/workspace-changed`、
  `host/session-*`、`archived-sessions-changed` 与带 sessionId 的 mux 帧按可见性
  裁剪/丢弃（含与 101 同段到达的 upHead 帧），杜绝推送帧泄漏

## 开发

```sh
npm test          # node:test 单元 + 集成测试（13 个用例，含 HTTP/WS 代理）
node --check lib/client.js   # client bundle 语法校验
```

### M1 冒烟验证（真实 DSH profile）

```sh
export DSH_HOME=<workspace 内独立目录>
dsh plugin --profile web-mt install        # 初始化测试 profile
# 补 dsh.profile.bundles 为 [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]
# 软链插件 + cordis.patch.yml 插入行（网关 127.0.0.1:3990）
dsh --profile web-mt --port 3980 --no-open # 启动
curl http://127.0.0.1:3990/api/auth/me     # bootstrapRequired → bootstrap → login → 代理 host.describe
```

## 安全边界（明示）

- v1 为**逻辑隔离**：会话/权限/配额/数据按用户与租户隔离，网关强制；DSH 单进程内无进程级隔离（模型与工具同 UID）。生产强隔离建议每租户独立容器/独立 `DSH_HOME`
- 登录会话为 `HttpOnly + SameSite=Lax` Cookie；公网部署务必 `cookie.secure: true` + 反代 TLS
- 防爆破：每账号+每 IP 窗口内失败计数，连续失败达阈值**自动锁定账号**（管理员解锁清计数）；网关统一安全响应头（nosniff/DENY/CSP）
- 部署形态（内网直连 + 公网反代 TLS）与备份/升级见 **`docs/部署.md`**
- `settings.*`/`credentials.*` 等 DSH 特权方法对远程用户恒 403（DSH 原有限制），多租户场景符合预期

## License

MIT
