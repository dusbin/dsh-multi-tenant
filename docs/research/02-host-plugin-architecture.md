# DSH 多租户插件调研报告：Host 端（Cordis）插件架构

> 调研对象：DeepSeek Harness（DSH）安装根（只读）`/Users/robinddu/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/`（版本 `0.1.1-rc.2`）。
> 证据路径约定：下文 `$DSH` = 上述安装根；`@dk/<pkg>` = `$DSH/node_modules/@deepseek-ai/<pkg>`；`~/.dsh` = 实际 harness home（`$DSH_HOME` 未设置时的默认值）。行号指 `lib/index.js`/`lib/startup.js` 等打包产物或 `lib/types/*.d.ts` 类型声明的行号。
> 调研方式：只读。未修改任何源码、未启动任何服务、未执行任何安装。结论均附"证据：文件 + API 签名/配置键/关键行"；不确定处标注"未确认"。
> 关联文档：`docs/research/03-identity-session-metering.md`（身份/会话/计量，已存在）；`docs/方案.md`（v0 草案）。本文是 03 的上游基础（插件架构 + 传输/信任模型 + 配置树）。

---

## 0. 关键结论（TL;DR）

1. **DSH 插件 = Cordis 4 插件**（vendored `@deepseek-ai/cordis` 4.0.1，Koishi 系 meta-framework）。插件三种形态：函数 `(ctx, config)`、类（`new (ctx, config)`，Service 子类即此类）、对象 `{ apply(ctx, config) }`。元数据走 `Plugin.Base`：`name` / `Config?: StandardSchemaV1`（schemastery `z.object`）/ `inject` / `provide` / `intercept`。服务注册 = `super(ctx, name)`（Service）或 `ctx.provide(name, value)`，随 fiber 卸载自动注销。最小实例：`@dk/dsh-command-goal`（`export { name, inject, apply }`）与 `@dk/dsh-token-meter`（`class TokenMeter extends Service` + `static Config = z.object({})`）。
2. **profile = `$DSH_HOME/profiles/<name>` 目录**：`package.json`（依赖 + `"dsh": {"profile": {"bundles": [...]}}`）+ 用户 `cordis.patch.yml`（+ `pnpm-workspace.yaml`）。启动时按序叠层：bundle 层（`dsh-base` → `dsh-web-app`，每包 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`）→ profile 层 → home 层（`$DSH_HOME/cordis.patch.yml`）→ `--patch` overlays。**第三方/源码插件零成本接入**：`cordis.patch.yml` 里 `- insert: [{id, name, config}]` 一行即可，`name` 可为裸包名（Node 解析）、绝对路径文件、带 `?v=N` 的 URL（ESM 缓存破坏，免重启）；`dsh.bundle` 声明只决定是否进 bundles 列表，**不是加载前置条件**。
3. **web 启动链路**：`dsh web`（= `--profile web`）→ `lib/bin.js` → `profile-boot-*.js:runProfile` → `@dk/dsh-app-boot.boot()`（`ctx.plugin(Loader)` → `mountRootInclude` → `loader.await()` → 审计）→ Loader 挂载 patch 树 → 树内 `web-startup`（`@dk/dsh-web-app/startup`）用 commander 解析 `--host/--port/--trusted-host/--no-open` 并 `ctx.provide("webStartup", ...)` → `webserver` 行（`@dk/dsh-host-webserver` 的 `WebServer`，`server.listen(port, host)`）绑定端口。**默认端口 3080 定义在配置不在代码**：`@dk/dsh-web-app/cordis.patch.yml` webserver 行 `port: !!js ctx.webStartup.port ?? 3080`。
4. **`--host 0.0.0.0` 拒绝是 CLI 层护栏，唯一强制点**：`@dk/dsh-web-app/lib/startup.js:40`（`program.error("...intentionally not supported yet for safety...")`）。`WebServer` 的 schema 本身**接受** `0.0.0.0`，且 patch 可覆盖 webserver 行 config 绕过 CLI 拦截（`!!js` 表达式整体替换）。但真正的纵深防御在 `@dk/dsh-client-connection` 的 **api-request-trust 栅栏**（loopback/`trustedHosts`/Origin 校验，403 `"forbidden"`），且 `PRIVILEGED_METHODS`（`settings.*`/`credentials.*`/`host.pickDirectory`/`host.openPath`/`agentPreset.*`/`llm.discoverModels`）被**钉死回环**。官方声明：栅栏"是可达性策略，而不是认证"，Web 载体**不提供认证层**，生产加固出路是前置反向代理。
5. **RPC 分发前拦截的现状**：`/api` 是挂在原生 `node:http`（`WebServer`）上的 prefix 路由，经 `bridge()`（node:http ↔ fetch）进入复合 fetch handler = **interceptor 优先 + apiProxy fallback**。唯一的"分发前拦截"API 是 `ctx.connection.rpc.intercept('/api', matches, handler, options)`（`@dk/dsh-client-connection`），但它**单座位且已被 `@dk/dsh-api-gateway` 占用**（重复注册抛错），且 handler 只能返回 RPC 信封（业务错误恒 HTTP 200，无法输出裸 401/302）。**不改源码前提下，唯一能拦截既有 /api 流量并返回 401/302 的点是注册 exact 路由遮蔽 `/api/<method>`**（exact 表优先于 prefix 表）。WebSocket upgrade 无任何插件钩子（无事件、无中间件），两条下行路径（`/api/events.mux`、`/api/events.host`）被 client-connection 独占。
6. **host 侧现成服务**：`ctx.settings`（按 namespace 分节的配置，默认→base→用户三层解析，`~/.dsh/settings.yaml`）、`ctx.credentials`（引用 = 环境变量名 + 记录 = `<scope>/<id>`，明文 0600 存 `~/.dsh/.credentials.yaml`）、`ctx.sessions`（事件溯源会话，`create/prepare/enter/announce/fork/flush`，`session/event` 事件流）、`ctx.sessionProjections`（纯同步 fold 投影注册表）、`ctx.tokenMeter`（`measure/estimateMessage`）、`ctx.llm`（`stream` + `resolveModelInfo` + 适配器注册）、`ctx.jobs`、`ctx.timer`、`ctx.fs`。**没有 `ctx.schedule` 服务**（dsh-schedule 是函数插件+会话事件）。**`ctx.webRuntime` 存在**（`dsh-web-app` 提供 `{lanAddresses, trustedHosts}`，供 connection 行取信任名单）。
7. **遥测**：DSH **不带通用 OpenTelemetry**；仅有可选会话遥测后端 `@dk/dsh-session-telemetry-otel`（OTLP/HTTP 日志导出器，`mode: FULL|FEEDBACK_ONLY|DISABLED`，默认 DISABLED）。**日志**：Cordis 结构化 logger（`ctx.logger(name)`），默认 exporter 只缓冲最近 1000 条，**没有随包发货的 console exporter**；插件打印走直接 `console.log`（如 web-app 的 URL 行）。**"每用户用量"现成通道**：会话投影 `tokenUsage` 四桶（`uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`）+ `sessionStats`（轮/步/耗时）；**无价格/金额字段、无按用户归集**——`dsh-anonymous-user-id` 是每个 harness home 一个匿名 UUID，不是登录身份。
8. **patch 机制**：`!!js <expr>` 在行激活时经 `with (ctx) { eval(expr) }` 求值（`@dk/cordis-plugin-loader/lib/index.js:279`），可用 `process.env.*`、`ctx.<注入服务>`、`dshHomePath(...)`；id 定位的 patch **替换整行 config（不深合并）**；`name` 字段是**防错守卫**（不匹配即跳过该 patch），**不能改行实现**；`disabled: true` 可禁用行，`insert` 可加新行。

---

## 1. Cordis 插件包解剖（Q1）

### 1.1 cordis 核心：Context / Plugin / Service / Fiber / Events

`@dk/cordis`（`package.json`：`@deepseek-ai/cordis` 4.0.1，repository `vendor/cordis`，ESM）。

**Plugin 三种形态**（证据：`cordis/lib/types/registry.d.ts` L48-81）：

```ts
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;
interface Function<T = any> extends Base<T> { (ctx: Context, config: T): any; }      // 函数插件
interface Constructor<T = any> extends Base<T> { new (ctx: Context, config: T): any; } // 类插件（Service 子类）
interface Object<T = any> extends Base<T> { apply(ctx: Context, config: T): any; }     // 对象插件
```

**Plugin.Base 元数据**（证据：同上 L52-63）：

```ts
interface Base<T = any> {
  name?: string;                                  // 显示名（fiber 诊断、logger 名）
  Config?: StandardSchemaV1<any, T>;              // 启动前对 config 做标准 schema 校验（schemastery z.object 即实现）
  inject?: Inject;                                // 依赖的服务；全部可用前插件不加载
  provide?: string | string[];                    // 本插件提供的服务名（Service 与 loader 读取）
  intercept?: Dict<boolean>;                      // 声明消费哪些服务的 intercept 配置
}
```

- `Config` 校验：`cordis/lib/types/fiber.d.ts` 的 `resolveConfig(runtime, config)`，失败抛 `ValidationError`。**注意：本版本没有独立的 `Service.Config` 静态字段概念**——Service 子类以 Constructor 形态写 `static Config = ...`，等同 `Plugin.Base.Config`。
- `inject` 形态：`(keyof M)[] | { [K in keyof M]?: M[K] }`（对象形式可附每服务 intercept 配置）。`ctx.inject(deps, callback)` 是 `ctx.plugin({ inject, apply: callback })` 的简写。

**Service 基类**（证据：`cordis/lib/types/service.d.ts` 全文）：

```ts
export declare abstract class Service<out T = never> {
  static readonly init / check / config / invoke / extend / tracker / resolveConfig: unique symbol;
  name: string;
  constructor(ctx: Context, name: string);  // 调用 ctx.reflect.provide(name, this, this[Service.check])
}
```

- `super(ctx, name)` 即注册（`ctx.reflect.provide`），随 owning fiber 卸载自动注销；`[Service.invoke]` 可让服务可调用（如 `ctx.logger()`）；`[Service.check]` 是可用性谓词（`ctx.provide(name, value, check?)`，`ReflectService`/`Impl = { name, fiber, value?, check? }`，证据 `cordis/lib/types/reflect.d.ts` L89-98、L144）。
- 生命周期符号（`init`=构造后运行的实例方法、`check`=可用性谓词、`invoke`=可调用体、`extend`=派生实例、`resolveConfig`=intercept 合并）全部集中在 `cordis/lib/types/utils.d.ts` 的 `symbols` 对象。

**Context 是 proxy**（证据：`cordis/lib/types/context.d.ts` L15-99）：属性读取走 service resolver；`extend(meta)` 建子上下文、`isolate(name, label)` 独立服务作用域、`intercept(name, config)` 叠加服务 intercept 配置；`root` 指向根上下文；内置 `events/logger/reflect/registry` 四个服务。混合方法均通过 `declare module './context.ts' { interface Context {...} }` 增强：

- `ctx.plugin<P>(plugin, ...args): Fiber & PromiseLike<Fiber>`；`ctx.inject(deps, callback)`（`registry.d.ts` L99-122）
- `ctx.get(name, strict?)`、`ctx.set(name, value)`、`ctx.provide(name, value): () => void`、`ctx.accessor(name, options)`、`ctx.mixin(name, keys)`（`reflect.d.ts` L4-68；provide 重复注册抛错）
- `ctx.on/once/emit/parallel/serial/bail/waterfall`（`events.d.ts` L26-99，`DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'`；waterfall 末尾 `next` 回调，不调用即否决；bail = 首个非 null/false/undefined 返回值即停）
- `ctx.logger(name?)`（`logger.d.ts` L78-80，`LoggerService` 可调用，`LoggerType = 'error'|'info'|'warn'|'debug'`）

**Fiber 生命周期**（证据：`cordis/lib/types/fiber.d.ts` L67-112）：

```
FiberState { PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5 }
fiber.state: FiberState     // ⚠️ 字段是 state 不是 status
fiber.dispose(): Promise<void>; fiber.await(): Promise<this>; fiber.restart(); fiber.update(config, noSave?)
ctx.effect(execute, label?)  // 注册 disposer，卸载时逆序执行
```

- 状态迁移发出 `internal/status` 事件；`CordisError('INACTIVE_EFFECT')` 在已 dispose 的 ctx 上创建 effect 时抛。

**事件系统**（证据：`cordis/lib/types/events.d.ts`）：`EventsService` 挂在 `ctx.events` 并混合到 ctx。事件名是开放词汇——外部包用 `declare module '@deepseek-ai/cordis' { interface Events { 'xxx'(...): void } }` 增强（实例：`cordis-plugin-loader` 声明 `exit`/`loader/config-update` 等；`dsh-session` 声明 `session/created|disposed|event|flush`；`dsh-llm` 声明 `llm/stream` waterfall）。内置内部事件：`internal/plugin|status|config|service|update|get|set|listener|dispatch`。`Context.filter` 符号用于 dispatch 时按 ctx 过滤监听器；`dsh-scope` 在此基础上做 agent-scope 过滤。

### 1.2 最小插件实例（代码级形态）

**实例一：纯消费型对象插件 `@dk/dsh-command-goal`**（证据：`dsh-command-goal/lib/index.js` L8-9、L173-185；`lib/types/index.d.ts` 全文）：

```js
// lib/index.js
const name = "command-goal";
const inject = ["commands", "goals"];          // 依赖 services：全部可用前不加载
function apply(ctx) {
  ctx.commands.register({
    name: "goal",
    description: "set or view the goal for a long-running task",
    input: { hint: "[<objective>|clear|edit <objective>|pause|resume]", images: true },
    handler: (invocation) => executeGoalCommand(ctx, invocation)
  });
}
export { apply, inject, name };
```

```ts
// lib/types/index.d.ts（全文）
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "command-goal";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
```

**实例二：提供服务型（Service 子类 = Constructor 插件）`@dk/dsh-token-meter`**（证据：`dsh-token-meter/lib/index.js` L469-483、L652-653；`lib/types/index.d.ts`）：

```js
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
var TokenMeter = class extends Service {
  static Config = z.object({});                 // schemastery schema（标准 schema）
  constructor(ctx, config = {}) {
    super(ctx, "tokenMeter");                   // ← 注册 ctx.tokenMeter（随 fiber 注销）
    validateConfigKeys(config);
    ctx.inject(["sessionProjections"], (projectionCtx) => {
      projectionCtx.sessionProjections.register(tokenUsageProjectionDefinition);
      projectionCtx.sessionProjections.register(contextPressureProjectionDefinition);
      projectionCtx.sessionProjections.register(contextBreakdownProjectionDefinition);
    });
    ctx.on("session/event", (session) => { if (this.states.has(session)) this._sync(session); });
  }
  measure(session, requestHeader) { ... }
};
export { TokenMeter, TokenMeter as default };
```

```ts
// lib/types/index.d.ts（节选）
declare module '@deepseek-ai/cordis' {
    interface Context { tokenMeter: TokenMeter; }   // ← 类型增强：ctx.tokenMeter
}
export declare class TokenMeter extends Service {
    static Config: z<TokenMeterConfig>;
    constructor(ctx: Context, config?: TokenMeterConfig);
    measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement;
    estimateMessage(message: Message): number;
}
```

要点：**"插件包内 `declare module '@deepseek-ai/cordis' { interface Context/Events {...} }` 增强"是 DSH 插件的标准类型约定**——提供服务（Context 属性）与消费事件（Events 签名）都靠它；运行时则靠 `super(ctx, name)` / `ctx.provide` 注册、`ctx.on` 订阅。

### 1.3 package.json 的 "dsh" manifest 字段与 exports

- **bundle 包**：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（证据：`dsh-base/package.json` L36-40、`dsh-web-app/package.json` L41-45）。bundle = 一个把自身 patch 层叠进 profile 树的包。
- **profile**：`"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }`（真实 `~/.dsh/profiles/web/package.json`）。类型定义：`dsh-app-boot/lib/types/profile.d.ts` 的 `DshBundleManifest { patch: string }` / `DshProfileManifest { bundles?: string[] }` / `DshManifestSection { bundle?; profile? }`。
- **exports 的 `"./src/*": "./src/*"`**：把 `@deepseek-ai/<pkg>/src/<file>` 直通到包内 `src/<file>`。**发布包（registry tarball）的 `files` 数组不含 src**（实测 `dsh-base`/`dsh-web-app`/`dsh-command-goal` 均无 `src/` 目录；`cordis` 是唯一带 src 的包），因此对 registry 安装是**悬空导出**；只有从 git checkout 用 `pnpm link`/workspace 协议安装、包目录含完整 `src/` 时才解析到源码——这就是"开发期源码执行"路径（另见 §2.3 的绝对路径文件/`?v=N` 方式）。
- 其他 manifest 角色：第三方浏览器端插件用 `"dsh": { "client": { "platform": "web", "inject": [...] } }` 声明 client roster（`profile.d.ts` 注释"other consumers own additional keys"）。

---

## 2. 插件安装到 profile（Q2）

### 2.1 `dsh plugin --profile <name> <pnpm args>` 机制

证据：`$DSH/lib/bin.js` L96-105（CLI 定义）、`$DSH/lib/plugin-9h8shc4d.js` L101-127（`runPlugin`）：

1. `resolveProfileDir(profile)` → `$DSH_HOME/profiles/<name>`（非法名含 `/`、`\`、`.`、`..`、`node_modules` 报错）；
2. 首次使用：`initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)` 写三件套：`package.json`（`name: dsh-profile-<name>`、`private`、`dependencies: {}`、`dsh.profile.bundles`）、`cordis.patch.yml`（模板 `[]`）、`pnpm-workspace.yaml`（`packages: [.]` + `nodeLinker: hoisted` + `autoInstallPeers: false`）。模板：web = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`、headless = `[base, headless]`，其他名默认 `["@deepseek-ai/dsh-base"]`（`dsh-app-boot/lib/index.js` L323-334）；
3. **`spawnSync("pnpm", args, { cwd: profileDir, stdio: "inherit" })`**——在 profile 目录里原样转发 pnpm 参数（`add <pkg>`、`remove <pkg>`、`why <pkg>`…）；`anchorPathSpec` 把 `.`/`../`（含 `file:`/`link:` 前缀）相对路径锚定回调用者 cwd，防止 `add .` 自链 profile；pnpm 不在 PATH 返回 127；
4. 成功后 `reconcilePlugins(before, dir)`：重读 manifest，对每个新依赖检查 `exportsPatch()`（`readProfileManifest(dir).dsh?.bundle?.patch !== void 0`）——声明 `dsh.bundle` 的依赖**自动追加进 `dsh.profile.bundles`**（按依赖序），否则警告"declares no dsh.bundle — installed as a plain dependency, not a profile layer"；被移除/失去声明的从 bundles 剔除；写回 manifest。git 托管插件需在 `pnpm-workspace.yaml` 的 `allowBuilds` 放行 prepare 脚本（`plugin-9h8shc4d.js` L124）。

### 2.2 profile 目录布局（真实 `~/.dsh/profiles/web/`，只读实测）

| 文件 | 内容 | 说明 |
|---|---|---|
| `package.json` | `{ "name": "dsh-profile-web", "private": true, "dependencies": {}, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }` | bundles 有序列表 = 组合包层 |
| `cordis.yml` | `[]`（注释模板） | **每次启动被重写为空数组**（`profile-boot-DG5t9aNs.js` L140-145：防止 Loader 树写回把组合行烤进根文件导致下次重复 insert；文件存在仅为 Loader 提供 include 根锚定 baseUrl） |
| `cordis.patch.yml` | 用户 patch 层（`- insert:` 条目） | 热更新（`watchUserPatches`），见 §7 |
| `pnpm-workspace.yaml` | 同模板 | pnpm workspace 根 |
| `node_modules/` | 仅手动软链的 `dsh-voice` | pnpm 管理 |

另有 `~/.dsh/profiles/node_modules/`：`healProfilesModuleFallback` 维护的**扁平 symlink farm**（DSH 安装包 + 各 bundle 依赖闭包每包一个链接，`dsh-app-boot/lib/index.js` L409-438），使任意 profile 中的裸包名能经 Node 父目录逐级向上解析到随安装内置的包。

**关于"dsh.profile 文件"**：当前版本**没有独立 `dsh.profile` 文件**——`dsh.profile.bundles` 是 profile 的 `package.json` 内的 manifest 段（证据：`profile.d.ts` L36-39；`dsh-app-boot/README.zh.md`"profile manifest `dsh.profile` 及其有序的 `bundles` 层列表"）。任务题设中的 "dsh.profile" 即此 manifest 段。**历史旧格式：未确认**。

### 2.3 第三方插件与源码插件的加载

**普通第三方包（如 tree-out，无 dsh 字段）**：在 `cordis.patch.yml` 里 `- insert: - id: tree-out / name: 'tree-out'` 一行即可。证据链：`EntryOptions { id; name; config?; group?; disabled?; inject? }`（`cordis-plugin-loader/lib/types/config/entry.d.ts` L6-19，name 注释 "Module specifier imported by the entry tree"）；loader 导入（`cordis-plugin-loader/lib/index.js` L260-274）：`cordis:` 内置 → 相对路径按 `ctx.baseUrl`（= profile 目录）→ **裸名走 Node `import(name)`**（从 profile 目录逐级向上 node_modules，命中 profile 的或扁平 fallback 的均可）。`dsh.bundle` 声明**不是加载前置条件**（只决定是否进 bundles 列表）。真实先例：`dsh-voice`（有 `dsh.client` 无 `dsh.bundle`）已在本 profile 正常运行。

**开发期源码执行**，实测 profile 里有三种 name 写法（`~/.dsh/profiles/web/cordis.patch.yml` 只读）：
- `name: '/Users/.../scratch-plugin/src/my-plugin.mjs'` —— **绝对路径源码文件**；
- `name: '.../knowledge-base.mjs?v=3'` —— **绝对路径 + `?v=N` 查询串**，注释原文："?v=N 强制 loader 以新 URL 重新 import（源码改动后绕过 ESM 模块缓存，免重启）"（ESM 按完整 URL 含查询串缓存）；
- `name: 'dsh-voice'` —— 裸包名 + 软链到源码目录。

`Entry._init()` 里 `plugin = this.loader.unwrapExports(await this.parent.tree.import(this.options.name, ...))`（loader `lib/index.js` L512），`unwrapExports` 归一化 ESM/CJS/default 导出。`"./src/*"` 导出（§1.3）只在 checkout 安装（`pnpm link`/workspace）时生效。

### 2.4 dsh-app-boot 配置层次（`@dk/dsh-app-boot/README.zh.md` 全文要点）

- home：`resolveDshHome()` 先取 `$DSH_HOME` 否则 `~/.dsh`（`dsh-home-paths`）。
- `loadProfile` 双锚点解析每个 `dsh.profile.bundles` 名（**先 dsh 安装目录、后 profile 目录**，`resolveBundleDir`，`profile.d.ts` L134-145）；列出的包无 `dsh.bundle` 声明则**显式报错**。
- patch 叠加顺序（README 原文）：bundle 层 → profile 层 → **home 层（`$DSH_HOME/cordis.patch.yml`，优先级更高）** → `--patch` overlays → 遥测开关 patch（`DSH_TELEMETRY_DISABLED` 任意非空值生成 `{ id: "session-telemetry-otel", disabled: true }`）。
- 环境变量：`DSH_HOME`、`DSH_TELEMETRY_MODE`/`DSH_TELEMETRY_OTLP_URL`/`DSH_TELEMETRY_DISABLED`、`DSH_PERMISSION_MODE`、`DSH_TOOLS_MODE`；`.env` 加载顺序：继承环境 > 项目 `.env` > 用户 `.env`（`loadLayeredEnv`）。
- 启动管线：`boot(binName, configPath, patches, prepare?, bareModuleBaseUrl?)`：`new Context()` → `ctx.plugin(Loader)` → `prepare`（host 提供 `cmdlineArgs`/`appExit`）→ `mountRootInclude`（根 include = `cordis.yml` + 全部 patch 层）→ `loader.await()` → `assertEntriesActivated`；失败 dispose 部分构造树并以带标签错误 reject。

---

## 3. web profile 启动链路（Q3）

### 3.1 启动链路（含一处重要修正）

```
dsh web（lib/bin.js L91-95：web 别名 = --profile web）
 └─ lib/bin.js L131-139 → runProfile（lib/profile-boot-DG5t9aNs.js L220-254）
     ├─ composeProfile() L166-198：按序叠层 bundlePatches(dsh-base→dsh-web-app) → profile patch → home patch → --patch overlays
     └─ boot(NAME, rootConfig, allPatches(...), prepare)（@dk/dsh-app-boot lib/index.js L1167-1189）
          ├─ prepare：provideCmdline(hostCtx, {args, exit})（dsh-cmdline）
          └─ mountRootInclude：挂 cordis.yml 根 include + 全部 patch 层 → Loader 加载激活整棵插件树
     树内（web 特有行，@dk/dsh-web-app/cordis.patch.yml）：
       web-startup（L113-114）解析 flag → ctx.provide("webStartup", ...)
       webserver（L121-126）→ @dk/dsh-host-webserver WebServer 绑定端口
       web-runtime（L137-144）→ @dk/dsh-web-app 提供 webRuntime（信任栅栏数据）
       connection（L164-171）→ @dk/dsh-client-connection 挂 /api 信任栅栏 + RPC
```

**修正**：`@dk/dsh-cordis-host-runner` **不是启动链路的一部分**——它是树内一行普通插件（`web-app/cordis.patch.yml` L108-109，提供 `ctx.dynamicCordisRunner`，供模型动态挂载插件包），Loader 由 `dsh-app-boot.boot()` 直接驱动。

### 3.2 端口绑定与默认端口 3080

- **默认端口 3080 定义在配置表达式，不在代码**：`@dk/dsh-web-app/cordis.patch.yml` L121-126：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

- `WebServer`（`@dk/dsh-host-webserver`）**没有端口默认值**：Config schema `{ host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(), port: z.natural().max(65535).required() }`（`lib/index.js` L99-100）；绑定在激活时 `this.server.listen(this.config.port, this.config.host)`（`lib/index.js` L244，原生 `node:http` `createServer`）。
- 关键机制：**Loader 把行的 `!!js` 插值推迟到该行声明的注入服务激活之后**，再基于该行的插件 ctx 求值（`dsh-cmdline/README.zh.md`"注入如何排列配置求值"）——所以 `webserver` 行 `inject: [webStartup]` 保证求值 `ctx.webStartup.port` 时服务已就绪；`dsh --profile web --help` 不提供 `webStartup` → 不绑端口。

### 3.3 flag 解析（dsh-cmdline）

- `@dk/dsh-cmdline` 提供两个 launcher 事实（`provideCmdline(ctx, {args, exit})`，`lib/types/index.d.ts` L40-47、L90）：`ctx.cmdlineArgs`（`{ get(): readonly string[] }`，launcher 自身 flag 之后的全部参数原样快照）与 `ctx.appExit`（`(code) => void`）。
- `parseCmdline(ctx, program)`（`lib/index.js` L54-66）只适配 commander：检查 action 存在 → 把各命令的 exit/output 接到启动器 → `program.parse(args)`。`--help`/`--version`/解析错误/`program.error(...)` 由 commander 输出文本并请求退出，**提供方不发布服务**，依赖行不激活。
- **flag 类型由 app 自己的 commander program 决定**，dsh-cmdline 不声明类型。web-app 实际用法（`@dk/dsh-web-app/lib/startup.js` L21-28 `webCommand()`）：`--host <host>`（string）、`--no-open`（boolean）、`--port <port>`（string，action 内 `/^\d+$/` 校验后 `Number()`）、`--trusted-host <authority...>`（commander variadic，repeatable）。
- 任意插件可 `inject: ["cmdlineArgs"]` 建自己的 flag 族：action 里 `ctx.provide(自己的服务, {...})`，消费行 `inject: [该服务]` + `!!js ctx.<服务>.xxx` 读取。

### 3.4 "远程访问具备认证层之前有意不受支持"的强制点

**唯一强制点 = CLI flag 层**：`@dk/dsh-web-app/lib/startup.js:40` 原文：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead
```

配套文档：`@dk/dsh-web-app/README.zh.md`（"它会在发布该服务前拒绝 `--host 0.0.0.0`"）；`@dk/dsh-client-connection/README.zh.md`（"`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持"）。全库 grep 仅此一处。

**注意两点**：
1. 该拦截只发生在**用户显式传 `--host 0.0.0.0`** 时；`WebServer` schema 本身接受 `0.0.0.0`（"有意向网络开放"），且**不接受其它 host 字面量**（不能绑具体网卡 IP）。
2. **patch 可绕过 CLI 拦截**：`webserver` 行的 `host` 是 `!!js` 表达式，profile/home/`--patch` 层按 id 整体替换 config 即可写 `host: '0.0.0.0'`（schema 接受）。这是设计内的 LAN 路径（`dsh-client-connection/README.zh.md`：非回环组合必须显式信任其服务权威）。

真正的纵深防御在 §4 的 api-request-trust 栅栏 + PRIVILEGED_METHODS 回环钉扎；`dsh-host-webserver/README.zh.md` 已知限制原文："**不提供 TLS、认证或来源策略**：绑定非回环地址会向对应网络公开服务器；面向部署的加固措施（或在前方放置真正的反向代理）有意不纳入面向开发环境的 v1。"

### 3.5 远程 + 认证的可行路径（小结，详 §9）

1. **放开 0.0.0.0 绑定**：patch 覆盖 `webserver` 行 config 即可（不改 dsh-web-app）。
2. **信任名单**：`connection` 行 `trustedHosts` 可 patch 为 `!!js ['app.internal', ...ctx.webRuntime.trustedHosts]` 或 `--trusted-host`。
3. **认证层**：DSH 内**不存在**（无 cookie/session/token 中间件、无认证配置键、patch 造不出来）；硬编码部分 = 栅栏算法、PRIVILEGED_METHODS 回环钉扎、webserver schema 两字面量。官方出路 = **前置反向代理**（TLS+认证后代理到 127.0.0.1）；或改/换宿主包新增认证中间件（见 §9 的可行性评估）。

### 3.6 dsh-headless 是兄弟面

`PROFILE_TEMPLATES = { web: [base, web-app], headless: [base, headless] }`（`dsh-app-boot/lib/index.js` L323-325）；`@dk/dsh-headless` 不挂任何 Host/HTTP server/Web runtime/浏览器插件，**不监听端口**（headless patch 无 webserver/connection 行）。

---

## 4. /api 与 WebSocket 的可拦截点（Q4）

### 4.1 Host half 如何注册 /api 路由

- **载体是原生 `node:http`**（`@dk/dsh-host-webserver`，`createServer`，无 koa/express 中间件链）。路由表 = `exact` Map + `prefixes` Map，匹配顺序：exact 优先 → prefix 最长前缀 → fallback（`lib/index.js` L270-279 `match()`）。
- **`/api` 是 prefix 路由，由 `@dk/dsh-client-connection` 的 `apply()` 注册**（`lib/index.js` L550-562）：

```js
const route = { kind: "prefix", path: API_PATH, handler: async (req, res) => {
  if (!isTrustedApiRequest(req, trustedHosts)) { res.writeHead(403); res.end("forbidden"); return; }
  await bridge(req, res, fetchHandler, maxRequestBodyBytes);
} };
ctx.effect(() => ctx.webServer.register(route), "client-connection: /api route");
```

- **Fetch bridge**（`lib/index.js` L38-87）：node:http `IncomingMessage` → 缓冲为 WHATWG `Request` → `apiHandler.fetch(request)` → `Response` 流式写回（SSE 逐块）；`DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024`（413 超限）。
- **/api 路径清单**（证据：`dsh-host-apiproxy/lib/types/fetch/handler.js`、`dsh-client-connection`）：
  - `POST /api/<method>`：旧版 unary RPC（`RpcMethodMap`，53 个方法：`session.*`/`subagent.*`/`host.*`/`workspace.*`/`skill.list`/`agentPreset.*`/`goal.*`/`settings.*`/`credentials.*`/`llm.*`）；
  - `POST /api/<namespace>/<method>`：Typert RPC（api-gateway interceptor 认领）；
  - `POST /api/respond`：client-response 回执；
  - `GET /api/events.mux`、`GET /api/events.host`：Web 载体返回 426 upgrade required；进程内载体是 SSE 流；
  - `GET|HEAD /api/session.export?sessionId=...`：会话日志 ZIP 下载（无信封）；
  - WebSocket upgrade：`/api/events.mux`、`/api/events.host`；
  - 其余未认领 → 404。

### 4.2 复合 fetch handler：interceptor + fallback

`client-connection` 构建**复合 handler**（`lib/index.js` L232-240 `createSharedFetchHandler`）：

```js
return { fetch: (request) => {
  const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
  const interceptor = this.interceptors.get(channel);
  if (endpoint === void 0 || interceptor === void 0 || !interceptor.matches(endpoint)) return fallback.fetch(request);
  if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, [])) return new Response("forbidden", { status: 403 });
  return interceptor.fetchHandler.fetch(request);
} };
```

- fallback 本体（`lib/index.js` L535-549）：`PRIVILEGED_METHODS`（L504-520：`agentPreset.read/copy/openDocument/remove`、`host.pickDirectory`、`host.openPath`、`settings.describe/openDocument/update/replace/mutate`、`credentials.describe/set/unset`、`llm.discoverModels`）用**空信任表**再过栅栏（403）——注释原文："`trustedHosts` 是 DNS-rebinding 栅栏，明确不是认证……整个配置面在真正的认证层出现之前保持 loopback-same-origin"；其余方法 → `toFetchHandler(ctx.get("apiProxy"))`（`@dk/dsh-host-apiproxy`，无则 404）。
- **interceptor 类型**（`dsh-client-connection/lib/types/rpc.d.ts`）：

```ts
type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean;
type ConnectionRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>;
interface ConnectionRpcHandlerOptions { authority: 'trusted-host' | 'loopback' }
rpc.intercept(channel: '/api', matches, handler, options): () => Promise<void>;
```

- **interceptor 单座位**：`registerInterceptor`（`lib/index.js` L259-273）对非 `/api` 通道抛错，且 `if (this.interceptors.has(channel)) throw ...already has an interceptor`。
- **已被占用**：`@dk/dsh-api-gateway` 的 `TypertGatewayService` 在 connection 可用时注册（`dsh-api-gateway/lib/index.js` L61-63）：`connectionCtx.connection.rpc.intercept("/api", (endpoint) => this.claimsEndpoint(endpoint), (endpoint, payload, signal) => this.dispatchRpc(endpoint, payload, signal), { authority: "trusted-host" })`；`claimsEndpoint` = `<ns>/<method>` 两段 + `typert.local.get/hasSeen` 或 SRC 绑定命中。
- **interceptor handler 只能返回 RPC 信封**（`rpcFetchHandler`，`lib/index.js` L275-301）：POST 校验（415 非 JSON）、信封解析、方法匹配、`fullResponse(rpcId, result)`——**业务错误恒 HTTP 200**，无法输出裸 401/302。

### 4.3 Typert 机制与 dsh-api-remotes

- **Typert 无 per-RPC 前置钩子**（typert-protocol/registry/loader 无 interceptor 概念）；"Typert interceptor"就是 §4.2 的 Connection RPC interceptor。
- 装饰器/基类（`dsh-typert-protocol/lib/types/index.d.ts`）：`TypertRemoteService`、`@Remote(exportName?)`、`@RemoteScope(key, exportName?)`、`bindTypertRemote`、`remoteMethods()`；`InvocationDescriptor { id, service, namespace, method, invocation: 'direct'|'context', parameters, cancellation?: {parameter: 'signal'}, result }`。
- Host 分发：`TypertGatewayService.invoke()`（`dsh-api-gateway/lib/index.js` L92-113）解析描述符 → `assertExactArguments` → 解析 receiver（`@RemoteScope` 经已注册 host context）→ 解析参数（json / lookup）→ 注入 `signal` → `Reflect.apply` → 解码。`TypertLookupFailure` 携带既有 RPC 错误码原样透传（L266-269）。
- **dsh-api-remotes**（`@dk/dsh-api-remotes`）：Host 入口 `apply()` 为空；真正贡献是 `createApiRemoteAgentResolver(ctx, options)`（`lib/index.js` L101-166）：复用 live agent、恢复冷会话、subagent ownership fence（`agent-busy`）、并发去重，并配置 typert 身份解析：`typeCtx.typert.lookups.configure("agent"|"session", resolveAgent)`、`typeCtx.typert.contexts.configureHost("agent", ...)`。**Remote 无 check 回调/hooks**；`typert.lookups.configure` 单次占用（重复配置抛错，`dsh-typert-registry/lib/index.js` L191）。Client 面 `ctx.remote`（`TypertClientRemote`：`$mount/$on/$dispatch`）由 `@dk/dsh-api-gateway/client` 提供，**不存在 `ctx.api` namespace 注册 API**。
- **TrustedHosts 在 dsh-client-connection（不在 api-remotes）**：`Config { trustedHosts: z.array(String).default([]), maxRequestBodyBytes }`（`lib/index.js` L480-483）；组合传入链：`--trusted-host` → `webStartup.trustedHosts` → web-app `resolveLanTrust()` → `ctx.provide("webRuntime", { lanAddresses, trustedHosts: [...lanAddresses, ...extra] })`（`dsh-web-app/lib/index.js` L89-95、L172-175）→ connection 行 `trustedHosts: !!js ctx.webRuntime.trustedHosts`。

### 4.4 信任栅栏（api-request-trust）——在哪里、能否叠加

证据：`dsh-client-connection/lib/index.js` L100-198：

```js
isLoopbackHostname(hostname)  // localhost | [::1] | 127/8
isTrustedAuthority(hostUrl, trustedHosts)  // host:port 精确；无端口条目匹配任意端口；WHATWG 归一化
assertTrustedAuthority(entry)  // 非规范裸 host[:port] 加载即抛错（防授权漂移）
isTrustedApiRequest(request, trustedHosts):
  Host 头必须命中 loopback 或 trustedHosts；sec-fetch-site === 'cross-site' 拒绝；
  Origin 存在时必须与 Host authority 同源；无标记请求不开捷径
```

生效位置（5 处，全部包内部）：
1. `/api` prefix 路由（L554，所有请求先 403）；
2. `connection.rpc` 通用 channel 路由（L249）；
3. interceptor 声明 `authority: 'loopback'` 时的空信任表检查（L237）；
4. fallback 的 PRIVILEGED_METHODS 空信任表检查（L538）；
5. WebSocket upgrade handler 前置检查（L570，`rejectWebSocketUpgrade` L456-465 在协议协商前写回 HTTP 403）。

**能否叠加自定义检查：不能**（Remote 无 check 回调；lookups.configure 单次占用；栅栏是包内闭包）。注释原文（L112-119）："Network reachability and authentication stay out of scope: binding policy belongs to the webserver config, and this fence is not an auth layer."

### 4.5 WebSocket upgrade

- `WebServer` 原生 `server.on("upgrade")`，按 pathname **精确匹配** `upgrades` Map，未命中直接 `socket.destroy()`；**无中间件、无插件钩子、无 `websocket/upgrade` 之类 Cordis 事件**（全库 d.ts 检索无 Events 声明）。
- `registerUpgrade({path, handler: (req, socket, head) => ...})`（`dsh-host-webserver/lib/types/index.d.ts` `WebUpgradeRoute`），**每路径唯一 owner**，重复注册抛错（`lib/index.js` L142-148）。
- client-connection 注册两条下行（`lib/index.js` L566-584）：handler 先过 `isTrustedApiRequest`（403 → `rejectWebSocketUpgrade` 拒绝握手），再交给 `WebSocketDownlinks`（ws 包 `WebSocketServer({noServer:true})`）泵 `EventsApi.mux/host` 流（`dsh-host-apiproxy/lib/types/api/events.d.ts`）。
- **WS 认证目前只能通过 trustedHosts/loopback 配置影响放行（可达性，非认证）**。

### 4.6 api-gateway / authorization / user-approval 是否构成把关点

- `@dk/dsh-api-gateway`（`ctx.typertGateway`）：纯 RPC 分发器，**无白名单/权限判定**。
- `@dk/dsh-host-apiproxy`（组合中 id 也叫 `api-gateway`，`ctx.apiProxy`）：旧版 API 网关，`toFetchHandler` 按 UNARY_ROUTES 表分发，**无白名单/权限**（HTTP 状态只表达载体：404/415/400/500）。
- `@dk/dsh-authorization`（`ctx.authorization`）：**凭据获取 flow 注册表**（OAuth 类对话：`registerFlow({key,label,methods,run})`、`begin`、`cancel`、`authorization/settled`），不是请求把关。
- `@dk/dsh-user-approval`（`ctx.approval`）：一次性工具调用审批（`approval/request` waterfall，`ApprovalPolicy = 'ask'|'never'`），面向 agent 轮次内操作，不是 /api 入口把关。
- 结论：**三者都不构成 /api 入口认证/授权中间件扩展点**；入口把关只有信任栅栏（可达性）+ interceptor（端点认领）。

---

## 5. Host 侧可用服务盘点（Q5）

> 详表见 `docs/research/03-identity-session-metering.md` §1-4（credentials/settings/session/token-meter 展开）。此处为与多租户插件直接相关的签名速查。

### 5.1 `ctx.settings`（@dk/dsh-settings + dsh-settings-file）

```ts
settings: SettingsProvider
register<T>(ns: SettingsNamespace, schema: z<T>, options?: { base?; applies?: 'live'|'restart'; validate? }): SettingsScope<T>
get(ns): unknown; describe(options?): SettingsDescriptor[]
update(ns, patch, expectedRevision?): Promise<void>; replace(ns, section, expectedRevision?): Promise<void>
mutate(ns, ops: readonly SettingsPathOp[], expectedRevision?): Promise<void>
SettingsScope<T>: { get(): T; watch(cb): () => void; update(patch); replace(section) }
```

- 按 **namespace**（lowercase kebab-case，插件注册名）分节，解析顺序 = schema 默认 → 组合 `base` → 用户文档分节；**无 session 级隔离**、无 `sessionIsolation` 键（`dsh-settings/lib/types/index.d.ts` L16-20、L225-275）。
- 事件：`'settings/updated'(ns, next, prev, source: 'update'|'provider')`、`'settings/document-updated'(ns, revision)`。
- 持久化：`dsh-settings-file` Config `{ path?; dshHome?; watch?; debounceMs? }`，默认 `~/.dsh/settings.yaml`（0600），写操作在跨进程写锁下重读文档、leaf-level diff 补丁提交。
- **多租户含义**：settings 是**全局单用户层**——每用户/每租户配置需插件自建 namespace 前缀（如 `mt-user-<id>.xxx`）或自建存储。

### 5.2 `ctx.credentials`（@dk/dsh-credentials + dsh-credentials-local）

```ts
credentials: CredentialProvider
resolve(ref: CredentialRef): Promise<ResolvedCredential|undefined>   // 逐操作解析
describe(ref); set(ref, value: string); unset(ref)
readRecord(key: CredentialKey); describeRecord(key); listRecords()
modifyRecord(key, mutate: (cur) => Promise<CredentialRecord|undefined>): Promise<CredentialRecord|undefined>  // 唯一写路径，序列化读-改-写
deleteRecord(key)
```

- `CredentialRef` = POSIX 环境变量名（`DEEPSEEK_API_KEY`）；`CredentialKey` = `<scope>/<id>`（scope=拥有插件注册名）；`CredentialRecord = ApiKeyRecord {kind:'api-key'; key?; env?} | GrantRecord {kind:'grant'; payload}`。
- 事件：`'credentials/reference-updated'(ref)`、`'credentials/record-updated'(key)`。
- 存储：**明文** `~/.dsh/.credentials.yaml`（目录 0700、文件 0600，带 group/other 权限位即拒绝解析）；分层：继承环境(只读胜出) > `.credentials.yaml`(可写) > `<cwd>/.env` > `$DSH_HOME/.env`。Config `{ path?; dshHome?; watch?; debounceMs? }`。
- **多租户含义**：凭据是单机单用户概念；每用户凭据需自建（如每用户 GrantRecord）。

### 5.3 `ctx.sessions`（@dk/dsh-session；注册名是复数 `sessions`）

```ts
sessions: SessionStore
create(id?: SessionId, options?: CreateSessionOptions): Session      // 已进 store 并 announce
prepare(id?, options?) → enter(session): () => void → announce(session): void  // prepare+enter+announce 即 attach 机制
get(id): Session|undefined; list(): Session[]
fork(source, boundary?, childSessionId?): Session
flush(session): Promise<boolean>
```

- `Session`：`header: SessionHeader { version; id; createdAt; cwd?; parentSession?; seedLength?; origin?: 'subagent'; ... }`（**无 user 字段**）、`events`（不可变快照）、`seq`、`surface`、`append(type, data, opts)`、`requestHeader()`、`requestContext()`、`deriveMessages()`。
- 事件（scope 过滤）：`'session/created'`、`'session/disposed'`、`'session/event'(session, event)`、`'session/flush'`（parallel）。
- 事件类型（`SessionEventMap`）：`turn/start|end`、`step/start|end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call|result`、`todo/write`、`request/header`、`request/context`、`session/end-seed`；插件扩展：`schedule/change`、`goal/change`、`command/run`、`compaction/*`、`llm/retry` 等。
- 持久化是插件关注点（订阅 `session/event`、`session/flush`；默认 `dsh-session-persistence-jsonl`）。
- **多租户含义**：`CreateSessionOptions.meta` 可携带归属信息（自定义字段进 `SessionHeader`），但 header 无内建 `user`；会话隔离需插件层（见 §9）。

### 5.4 `ctx.sessionProjections`（@dk/dsh-session-projection + cache）

```ts
sessionProjections: SessionProjectionRegistry
register<K,S>(definition: Omit<ProjectionDefinition<K,S>,'wire'> & { wire: {...} }): () => void   // 客户端可见单元
register<K,S>(definition: Omit<ProjectionDefinition<K,S>,'wire'>): () => void                      // host-only 单元
// ProjectionDefinition { key; stateSchema: ZodType<S>; init(): S; apply(state, event): S; wire?: {viewSchema; view(state)}; stateVersion: number }
onChanged(listener: (session, key, value, seq) => void): () => void
stateOf(session, key); snapshot(session): { asOfSeq, values }; checkpoint(session); restore(checkpoint, events, baseSeq)
```

- 已注册键（`declare module '@deepseek-ai/dsh-session-projection/types'` 增强）：`tokenUsage`、`contextPressure`、`contextBreakdown`（dsh-token-meter）、`sessionStats`（dsh-session-stats，view = `{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }`）。
- `ctx.sessionProjectionCache`：Config `{ writeEveryEvents; writeIntervalMs }`，`cachedSnapshot(meta)`/`coldSnapshot(id)`，存储于 `session_projcache` domain。

### 5.5 `ctx.tokenMeter`（@dk/dsh-token-meter）

```ts
tokenMeter: TokenMeter
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement
estimateMessage(message: Message): number
// TokenMeasurement { logRevision; baseline: {kind:'none'|'estimated'|'usage', tokens, usage?}; surfaceDeltaTokens; totalTokens; surfaceTokens; nodes }
```

- 估算器（`estimate.d.ts`）：`ROLE_OVERHEAD = 4`、`estimateContent/estimateMessage/estimateSystemTokens/estimateToolsTokens/estimateHeader`（固定密度 4 字符/token）。
- Config = `Record<string, never>`（无设置）。

### 5.6 `ctx.llm`（@dk/dsh-llm）

```ts
llm: LlmRuntime
stream(options: GenerateOptions): AsyncIterable<StreamChunk>        // 无 ctx.llm.chat；'llm/stream' waterfall 可拦截
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
registerConfigurableProviders(entries); registerModelDiscovery(settingsNs, discover); discoverModels(settingsNs, req)
listProviders(); listConfigurableProviders(); listModels(provider); providerRetryPolicy(provider)
resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>   // { provider, id, name, context?: {contextWindow}, defaultMaxTokens?, reasoning? }
resolveCallConfig(config, signal?); prepareCall(config, signal?): Promise<PreparedLlmCall>
```

- `GenerateOptions { provider; model; reasoningEffort?; messages; system?; tools?; temperature?; maxTokens?; stop?; signal?; sessionId?; purpose? }`；`TokenUsage { inputTokens; outputTokens; cacheReadTokens?; cacheWriteTokens?; reasoningTokens? }`（**inputTokens 仅 uncached**，cached 单列）。
- 事件：`'llm/stream'(options, next)`（waterfall）、`'llm/adapters-updated'`。
- 消息工具：`createMessage/createUserMessage/createAssistantMessage/createToolResultMessage({callId, content, isError})`。
- **无价格/金额字段**（ModelInfo 无 pricePerToken）——金额折算需自建价格表。

### 5.7 `ctx.jobs`（@dk/dsh-jobs + dsh-jobs-local）

```ts
jobs: JobRegistry
start(spec: JobStart): JobId; list(caller?); get(id, caller?); read(id, caller?): JobRead
kill(id, caller?, reason?): 'requested'|'already-finished'; wait(id, timeoutMs, caller?, signal?)
onJobDone(listener); onJobsChanged(listener); attachController(name)
// JobStatus = 'running'|'stopping'|'completed'|'killed'|'failed'
```

- **无 Cordis ctx 事件**（完成/变更经 `onJobDone`/`onJobsChanged` 监听器投递）。Config（local）`{ maxConcurrentJobsPerOwner?: number }`（默认 10）；访问按 owner session id 隔离。

### 5.8 `ctx.timer`（@dk/cordis-plugin-timer）

- 混入 Context：`ctx.timeout(cb, delay) / ctx.timeout(delay): Promise<void>`、`ctx.interval(cb, delay) / ctx.interval(delay): AsyncIterableIterator`、`ctx.throttle(fn, delay, noTrailing?)`、`ctx.debounce(fn, delay)`（均 dispose-aware，随 fiber 释放）；`setTimeout/setInterval` 别名标 deprecated。**无 setImmediate 包装（未确认存在）**。

### 5.9 `ctx.schedule` —— 不存在该服务

`@dk/dsh-schedule` 是**函数插件**（`name = "schedule"`），不注册 `ctx.schedule`；经 `registerScheduleTools()` 在 agent scope 注册工具 `schedule_create/list/delete`；规则仅 `after`/`at`/`every`（**无 cron**，`MIN_EVERY_INTERVAL_SECONDS = 300` 下限）；持久化走会话事件 `'schedule/change'`。

### 5.10 `ctx.fs`（@dk/dsh-fs + dsh-fs-local/sandbox/observation-policy）

```ts
fs: FileSystem
resolve(path, {cwd?, signal?}): Promise<FsTarget>; processPath(target); fileUrl(target); contains(parent, child)
stat(target, signal?): Promise<FsInfo|undefined>; lstat(path, {cwd?}, signal?)
readText(target, signal?): Promise<string>; streamText(target, signal?); readBytes(target, signal, maxBytes)
listDir(target, signal?): Promise<FsDirEntry[]>
writeText(target, content, expected?: FsWriteIntent, signal?, sandboxPolicy?): Promise<FsWriteOutcome>   // 原子写 + 版本守卫
editText(target, edit: FsEditRequest, expected?: {version}, signal?, sandboxPolicy?): Promise<FsEditOutcome>
```

- **无 mkdir/delete/rename**（`writeFileAtomic` 会创建缺失父目录）。事件：`'fs/write-intent'`（waterfall）、`'fs/edit-intent'`（waterfall）、`'fs/observed'`（emit）。
- `dsh-fs-sandbox` 的 `SandboxedFileSystem`：对写操作按 `ctx.sandboxPolicy` 栅栏（`read-only` 拒 / `workspace-write` 要求 canonicalize 于 workspace root 或平台临时区 / `danger-full-access` 放行），拒绝抛结构化 `FS_SANDBOX_DENIED`；`dsh-fs-observation-policy` 是纯事件插件（不注册服务），从 `fs/observed` 派生 stale-version 守卫；`dsh-atomic-write`：`writeFileAtomic` + `withFileLock`（跨进程 `<file>.lock` 写锁）。

### 5.11 其他（一句话）

- `ctx.goals`（@dk/dsh-goal）：`GoalService extends TypertRemoteService`，`get/create/edit/pause/resume/complete/block/clear(agent, ref?, …)`，CAS + 会话事件 `'goal/change'`，Config `{ defaultMaxGoalRounds? }`。
- `ctx.commands`（@dk/dsh-commands）：`CommandRuntime extends TypertRemoteService`，`register(definition)`（handler 直连 UI）、`list/find/parseCommand`，会话事件 `'command/run'`。
- `ctx.webRuntime`（@dk/dsh-web-app 提供）：`{ lanAddresses, trustedHosts }`（`dsh-web-app/lib/index.js` L28、L172-175；SA4 曾报"无此名"——**实测存在**，仅 host 侧类型增强未随包发布）。
- `ctx.cmdlineArgs?` / `ctx.appExit?`（@dk/dsh-cmdline）：launcher 挂载前注入的进程事实（非 Service，可选）。

---

## 6. 遥测与日志（Q6）

### 6.1 OpenTelemetry：仅限可选会话遥测后端

- **DSH 不带通用 OTel 埋点**：全仓 package.json grep `opentelemetry` 仅命中 `@dk/dsh-session-telemetry-otel`（依赖 `@opentelemetry/api|api-logs|exporter-logs-otlp-http|resources|sdk-logs`，版本 `0.220.0` 系）。
- `dsh-session-telemetry`（Service Definition `SessionTelemetrySink { emit(record); flush?(); shutdown() }`，注册 `ctx.sessionTelemetry`）：捕获点 = `session/created`（收养）、`session/event`（投影+脱敏+交接）、`session/flush`、`session/disposed`（shutdown 运维记录）、`agent/error`；脱敏扩展点 = `sessionTelemetry/record` waterfall；记录 = `SessionTelemetryRecord { channel: 'ledger'|'ops'; time; severity; attributes {session.id, event.type, event.seq, cwd?, parent_id?, seed_length?}; body = 深拷贝 event.data }`。
- `dsh-session-telemetry-otel`（部署方唯一要加载的条目）：`mode: FULL | FEEDBACK_ONLY | DISABLED`（默认 DISABLED，fail-closed）；`FULL` = 每条记录立即交 OTLP/HTTP 日志导出器（`LoggerProvider → BatchLogRecordProcessor → OTLP/HTTP`，`logger.emit()` 日志记录，**非 span/trace、非 metrics**），资源含 `service.name/version`（`APP_IDENTITY` from dsh-llm）+ 匿名 `user.id`（`$DSH_HOME/.anonymous-user-id`）；Config `{ mode; shutdownTimeoutMillis?（默认 3000）; exporter: OTLPExporterNodeConfigBase & {url}; processor? }`。
- **base 层默认接线**（证据：`dsh-base/cordis.patch.yml` 行 `session-telemetry-otel`）：`mode: !!js process.env.DSH_TELEMETRY_MODE || 'DISABLED'`、`exporter.url: !!js process.env.DSH_TELEMETRY_OTLP_URL ?? 'https://harness-telemetry.deepseeksvc.com/v1/logs'`、`compression: gzip`、`timeoutMillis: 1000`、`processor: { scheduledDelayMillis: 10000, maxQueueSize: 2048, maxExportBatchSize: 2048, exportTimeoutMillis: 1500 }`；`DSH_TELEMETRY_DISABLED` 任一非空值（含 '0'）由 launcher 追加 `{ id: 'session-telemetry-otel', disabled: true }` 硬禁用（`profile-boot-DG5t9aNs.js` `resolveTelemetryPatch`）。
- `dsh-anonymous-user-id`：`getOrCreateAnonymousUserId()` 返回单个 harness home 一个随机 UUID v4（`~/.dsh/.anonymous-user-id`），OTel 资源 `user.id`、DeepSeek 提供方 `x-deepseek-harness-user-id` 头、`/feedback` 确认文本共用。**不是登录身份，不可用于多用户归属**。

### 6.2 日志

- Cordis 结构化 logger：`ctx.logger(name)` → `LoggerType = error|info|warn|debug`，`LoggerLevel = 0|1|2|3`；`Exporter { export(message: Message) }`，`Message { sn, ts, name, type, level, args, fiber? }`。
- **默认 exporter 只缓冲最近 1000 条**（`cordis/lib/index.js` LoggerService 构造器），**全仓无 console exporter 注册**（grep `.exporter(` 仅 cordis 自身）；插件打印走直接 `console.log`（web-app 的 `dsh web:` URL 行）。**无 `--log-level` flag、无 `logLevel` 配置键**。级别机制本身存在（`exporter.levels?: Record<string, number>` / `logger.level`，默认 INFO；`ctx.intercept('logger', { name?, level? })` 可配，`LoggerService.Intercept`），但没有任何随包插件使用——**部署方需自挂 `ctx.logger.exporter(...)` 才能看到结构化日志**。结论：logger 面目前是"诊断缓冲 + 直接 console 打印"混合，日志可观测性弱；多租户审计日志需插件自建通道。
- 配置面（loader/include）日志：`enableLogs` 开关控制 `ctx.logger("loader").info(...)`（`cordis-plugin-loader/lib/index.js` L721-722）。

### 6.3 "每用户用量/金额统计"数据通道评估

- **tokenUsage 投影四桶**（证据：`dsh-token-meter/lib/types/projection.d.ts` L12-17）：

```ts
interface TokenUsageProjection { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
```

四桶互斥（reasoning 已含在 outputTokens）；来源：`assistant/chunk {type:'usage'}` 与 `assistant/message.usage` 事件（投影单元 `apply`，见 `dsh-token-meter/lib/index.js` L291-324）。另有 `contextPressure { pressureTokens?; projectedTokens?; contextWindow? }` 与 `contextBreakdown { systemTokens; toolsTokens; messageTokens }`。
- 读法：`ctx.sessionProjections.stateOf(session, 'tokenUsage')` / `snapshot(session)`；客户端经历史尾页 `projections` 块与 `session/projection` 推送帧。
- `sessionStats` 投影（@dk/dsh-session-stats）：`{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }`。
- **无价格/金额字段**（ModelInfo/TokenUsage 均无 cost）；**无按用户/租户归集通道**（session 无 user 字段；anonymous-user-id 是 home 级单值）。结论：**token 用量有可靠的每会话数据通道（投影 + 事件流），但"每用户/金额"必须插件自建**：自维护用户↔会话映射 + 价格表（可按 model id 配置），在 `session/event` 或投影变更时记账（可用 `dsh-session-projection` 注册自己的 `mtUserUsage` 单元，或自建存储）。

---

## 7. 配置树与 patch 机制（Q7）

### 7.1 cordis.patch.yml 语法（一个完整示例）

真实示例（`@dk/dsh-web-app/cordis.patch.yml` 摘录，web 组合核心行）：

```yaml
# 顶层是一个 YAML 数组：id 定位覆盖 / insert 列表 / disabled；允许 !!js 表达式
- id: hmr
  disabled: true                                    # 禁用已有行（base 层插入的 hmr）

- id: session-query-sqlite                          # 整行替换 config（不深合并，需重述所有键）
  config:
    path: ':memory:'
    openAt: never

- insert:                                           # 插入新行（可带 id/name/config/inject/disabled）
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      inject: [webStartup]
      config:
        host: !!js ctx.webStartup.host ?? '127.0.0.1'
        port: !!js ctx.webStartup.port ?? 3080

    - id: connection
      name: '@deepseek-ai/dsh-client-connection'
      inject: [webRuntime]
      config:
        trustedHosts: !!js ctx.webRuntime.trustedHosts

    - id: kb                                        # 用户层插第三方/源码插件
      name: '/Users/robinddu/Desktop/workspace/robinddu/scratch-plugin/src/knowledge-base.mjs?v=3'
      config:
        roots: ['/Users/robinddu/Desktop/workspace/output']
```

语法规则（证据：`cordis-plugin-include/lib/types/index.d.ts` `PatchOptions { id?; insert?: EntryOptions[]; name?; config?; group?; disabled?; inject?; intercept?; isolate?; [key: string]: any }` + `dsh-app-boot/lib/index.js` L57-106 `applyEntryPatches`）：
- **id 定位的 patch 替换目标行的整个 config**（README 原文："按 id 定位的 patch 会替换对应条目的整个 `config`（未改字段也要重述）"，无深度合并）；`disabled: true` 停用；`insert` 把条目追加进根列表或指定 group（`- insert: {id: <group-id>, ...}` 内嵌形式）。
- `name` 在 patch 里是**防错守卫**：`if (name && name !== target.name) skip`——**patch 不能改行的实现包**（只能改 config/disabled/inject 等其余键）。
- `!!js <expr>`：由 loader 求值（`cordis-plugin-loader/lib/index.js` L279-290：`new Function("ctx", "expr", "with (ctx) { return eval(expr) }")`），在**该行激活时、其注入服务就绪后**基于该行插件 ctx 求值。可用名字：① `ctx.<注入服务>`（如 `ctx.webStartup.port`、`ctx.webRuntime.trustedHosts`）；② Node 全局 `process`（`process.env.X`、`process.cwd()`、`process.platform`）；③ `dshHomePath(...)`——由 `boot()` 里 `ctx.provide("dshHomePath", dshHomePath)` 提供（`dsh-app-boot/lib/index.js` boot 主体；`dsh-home-paths` 的路径助手）。**`require` 无任何 provide 站点**（ESM 下 `new Function` 全局作用域无 require，大概率 ReferenceError，未确认）；`disabled` 同样支持 `!!js`（Boolean 化）。
- 空文件/纯注释文件报错；禁用某层写 `[]`。

### 7.2 行 id 与覆盖规则（应用顺序）

`profile-boot-DG5t9aNs.js` L147-198：`allPatches = [...bundlePatches, ...profile.patches, ...homePatches, ...overlays]`，`composeEntries` 用 `applyEntryPatches` 按序合成（同 id 后写覆盖前写；insert 的条目也进入 id 索引，后续 patch 可再定位）。最终顺序：

1. **bundle 层**：按 `dsh.profile.bundles` 顺序（web = `dsh-base` → `dsh-web-app`），每包内部按自身 `cordis.patch.yml` 条目序；
2. **profile 层**：`$DSH_HOME/profiles/<name>/cordis.patch.yml`；
3. **home 层**：`$DSH_HOME/cordis.patch.yml`（**优先级高于 profile 层**）；
4. **launcher 层**：`--patch <file>`（可重复）+ flag 派生 patch（如遥测开关）。

热更新：`watchUserPatches` 对 profile/home 层 patch 文件做 HMR（长驻面），失败时保留最后一个可用树（`dsh-app-boot/README.zh.md`）。

### 7.3 插件如何带默认配置、用户如何覆盖

- **默认配置两来源**：① 插件 `Config` schema（schemastery）默认值（如 web-app `{ openBrowser: z.boolean().default(true), ... }`）；② 组合 patch 行里写的 config（如 webserver 行 `host: ... ?? '127.0.0.1'`）。
- **用户覆盖**：在 profile/home/`--patch` 层按 id 重写行的 `config`（整行替换，需重述未改字段）。schema 校验失败 = 插件加载失败（fiber FAILED，`assertEntriesActivated` 报错）。
- **settings 与 patch 的关系**：patch 是**组合期配置**（哪行、什么插件、什么参数）；`ctx.settings` 是**运行期用户配置**（按 namespace 分层：默认→base→用户文档）。`dsh --dump-config` / `--dump-default-config` 离线合成并打印 patch 树（`renderConfigDump`，与启动同一套 `applyEntryPatches`，保证不漂移）。

---

## 8. 现成数据通道与多租户映射速查

| 需求 | 现成物 | 缺口 |
|---|---|---|
| 认证网关（/api 前校验） | 无；只有信任栅栏（可达性） | 需自建（§9） |
| 用户/角色/配额数据存储 | `ctx.settings`（全局单用户层）、`ctx.credentials`（环境变量+记录）、`dsh-storage`/`dsh-storage-json`（键值存储 domain） | 无用户实体；需自建用户表 + 角色 + 配额（可用 settings namespace 或 storage） |
| 会话按用户隔离 | `ctx.sessions`（`create(meta)` 可带归属）；`ctx.connection.rpc` 按 sessionId 寻址 | 无 user 字段、无所有权校验；需插件层 enforce |
| token 用量统计 | `tokenUsage` 投影四桶 + `assistant/*.usage` 事件 + `ctx.tokenMeter` | 无按用户归集、无价格/金额 |
| 会话数/请求数/时间分布 | `sessionStats` 投影（turns/steps/耗时）+ `session/event` | 无按用户归集 |
| 审计日志 | `ctx.logger`（缓冲）无 exporter；`sessionTelemetry` 是会话内容不是操作审计 | 需自建审计通道 |
| 配额强制 | 无现成 gating | 需在认证/分发层插入（§9） |

---

## 9. 认证网关插入点可行性评估（多租户插件视角）

### 9.1 结论先行

- **HTTP RPC（/api POST）**：不改源码的前提下，插件能做的"分发前拦截"极其有限：interceptor 座位单例且已被 api-gateway 占用；唯一能返回 HTTP 401/302 的点是 **exact 路由遮蔽**（逐路径，且会绕过信任栅栏、客户端表现为传输异常）。
- **WebSocket upgrade**：无任何插件钩子，两条路径被 client-connection 独占——**纯插件无法在 upgrade 前加认证**。
- **因此"插件内认证网关"在 v1 边界内不可完整实现**；可行的部署形态是下面 A/B/C 三选一（或组合），推荐 B + A 作为短期方案，C 作为中期方案。

### 9.2 可行路径（按侵入性升序）

**路径 A：前置反向代理（官方暗示的出路，零源码改动）**
- 依据：`dsh-host-webserver/README.zh.md`"面向部署的加固措施（或在前方放置真正的反向代理）有意不纳入面向开发环境的 v1"。
- 做法：多租户插件**自己内嵌一个反向代理服务**（或独立进程）绑定公网端口，做 TLS + 登录/会话 cookie 认证，再把通过认证的请求代理到 `127.0.0.1:<dsh端口>`——因为 `isTrustedApiRequest` 接受 loopback Host，代理请求天然通过信任栅栏；WS 也走同一代理（`ws` 转发）。
- 优点：不动 DSH 任何包；HTTP 与 WS 都覆盖；可以返回任意状态码/重定向；认证/会话/配额强制全在代理层。缺点：代理是独立监听面（多一个端口），需处理 WebSocket 转发与 SSE 背压。

**路径 B：组合级替换 connection 行（改 profile patch，不改源码）**
- patch 机制确认：`name` 是守卫**不能改实现**，但可以 `- id: connection, disabled: true` + `- insert: {id: connection-auth, name: '<你的包>', ...}` 插入提供同一 `ctx.connection` 契约的替代实现（自建包可 fork `@deepseek-ai/dsh-client-connection` 的 lib（MIT）并在 `isTrustedApiRequest` 之后加认证检查，或直接继承 `HostConnectionService` 重写 `register` 的 route handler；WS upgrade handler 同理在 `registerDownlink` 前置认证）。`typert-gateway` 行 `inject: ["connection"]` 不受影响（只要你的包提供同名服务与 `rpc.intercept` API）。
- 优点：认证在 DSH 的 HTTP/WS 入口内部，行为最贴近"原生中间件"；HTTP RPC 可在 bridge 前返回 401/302（替代 route handler 拿原生 req/res）；WS 可在 `handleUpgrade` 前拒绝。缺点：fork/维护一个 host 包；是"换组合"不是"叠加插件"。
- 注意：替换 web-startup 同理（`disabled: true` 原行 + insert 自定义 `webStartup` 提供方，可加自定义 flag/校验）；Cordis 对同一服务重复 provide 抛错，所以必须禁用原行。

**路径 C：给 DSH 上游加认证钩子（改 dsh-client-connection / dsh-web-app）**
- 最小改动点：在 `dsh-client-connection` 的 `/api` route handler 与 `registerDownlink` 里、`isTrustedApiRequest` 之后插入一个可配置的 `authorize(request)` 钩子（Config 加 `authorize: !!js (req) => boolean`），interceptor 侧把 `ConnectionRpcHandlerOptions` 扩展为可叠加（改单座位为链式）；`dsh-web-app/lib/startup.js:40` 的 0.0.0.0 拦截改为"绑 0.0.0.0 时要求配置认证"。这是对发布包源码的修改（或 fork），但改动面小、语义清晰。

**路径 D（短期兜底，纯插件、不改源码）：exact 路由遮蔽 + 自建 login 端点**
- 插件 `ctx.webServer.register({ kind: 'exact', path: '/api/session.prompt', ... })` 等逐路径接管敏感 RPC，前置认证（读 cookie/token）后自行调用 `ctx.apiProxy`/`ctx.typertGateway.invoke()` 放行；并注册 `prefix: '/api/auth'` 提供 login/logout/me。**只适合临时验证，不适合生产**（逐路径、绕栅栏、非 200 表现为客户端传输失败）。

### 9.3 会话按用户隔离的落点（配套）

- 会话归属：`ctx.sessions.create(id, { meta: { userId, tenantId, role } })`（meta 进 `SessionHeader`，可扩展字段）；
- 隔离强制点：认证层下发 `userId`（路径 A：代理注入 header 后由插件读取；路径 B：认证中间件把 userId 挂到请求上下文），分发层（interceptor 或 apiProxy 包装）校验 `session.header.userId === 请求者`；
- 配额强制点：`session/event` 消费 `assistant/message.usage` + `ctx.sessionProjections.stateOf(session, 'tokenUsage')` 记账，超限在认证/分发层拒绝新请求（`session.prompt` 等入口）；
- 注意：`PRIVILEGED_METHODS`（settings/credentials/host 桌面）在未改源码时**恒钉死回环**——多租户部署中这些方法对远程用户本就不该开放，反而符合预期；需要开放时走路径 B/C。

### 9.4 必须改源码/换组合的点（patch 无能为力）

- 给 `isTrustedApiRequest` 叠加自定义检查（包内闭包）；
- 第二个 `/api` interceptor（单座位）；
- WS upgrade 认证（路径独占）；
- 在 RPC 信封中途输出 HTTP 401/302（恒 200 envelope）；
- webserver 绑定具体网卡 IP（schema 仅两字面量）。

---

## 10. 未确认 / 待验证事项

1. **独立 `dsh.profile` 文件（旧格式）是否存在**——当前版本只有 `package.json` 内 `dsh.profile.bundles` 段；文档未提旧文件格式。
2. **`fiber.status`**——本版本字段为 `fiber.state: FiberState`（PENDING/LOADING/ACTIVE/FAILED/UNLOADING/DISPOSED）。
3. **tree-out 包未在本机出现**——其加载按 loader 泛型机制（裸 specifier → Node 解析）推断，非实测。
4. **`ctx.webRuntime` 的 host 侧类型增强是否随包发布**——运行时有（`dsh-web-app/lib/index.js` L175 `ctx.provide("webRuntime", ...)`），类型面未确认。
5. **替换 web-startup 提供方（disabled 原行 + insert 新行）的实际加载行为**——基于 Cordis 重复 provide 抛错推断，未实测。
6. **客户端对未知 `RpcErrorCode` 的实际失败形态**——按 zod 解析逻辑推断为抛错，未做运行时验证。
7. **无随包发货的 console logger exporter**——全仓 grep `.exporter(` 仅 cordis 默认缓冲 exporter；若后续版本接入 `cordis-plugin-logger-console` 需更新本结论（另：无 `--log-level` flag 与 `logLevel` 配置键，级别机制存在但需自挂 exporter）。
8. **timer 是否有 `setImmediate` 包装**——类型面未出现。
9. **`dsh plugin` 安装 git 托管插件的 `allowBuilds` 具体语法**——仅读到提示文案，未实测。
10. **`dsh-schedule` 是否有 `ctx.schedule` 服务**——类型面未见（函数插件 + 工具 + 会话事件），未做运行时探测。

---

## 附：证据文件索引（按包）

| 包 | 关键证据文件 |
|---|---|
| cordis | `lib/types/{registry,service,context,reflect,events,fiber,logger}.d.ts`；`lib/index.js`（LoggerService 默认缓冲 exporter） |
| cordis-plugin-loader | `lib/types/config/{entry,group,tree,utils}.d.ts`；`lib/index.js` L260-290（import / `!!js` evaluate）、L512（unwrapExports） |
| cordis-plugin-include | `lib/types/index.d.ts`（PatchOptions / applyEntryPatches / entryListSchema） |
| dsh-app-boot | `lib/index.js` L43-106（applyEntryPatches）、L1167-1189（boot）、L323-334（PROFILE_TEMPLATES）、L409-438（healProfilesModuleFallback）；`lib/types/profile.d.ts`；`README.zh.md` |
| dsh-cmdline | `lib/index.js` L26-66；`lib/types/index.d.ts`（CmdlineArgs/AppExit/parseCmdline）；`README.zh.md` |
| dsh-web-app | `lib/startup.js` L21-50（flag 解析 + 0.0.0.0 拒绝）；`lib/index.js` L89-95（resolveLanTrust）、L172-213（webRuntime/FrontendStatic/URL）；`cordis.patch.yml`（webserver/web-startup/web-runtime/connection 行） |
| dsh-host-webserver | `lib/index.js`（createServer、listen、match、upgrade）；`lib/types/index.d.ts`（WebRoute/WebUpgradeRoute/WebServer）；`README.zh.md` |
| dsh-client-connection | `lib/index.js` L100-198（信任栅栏）、L232-301（interceptor/rpcFetchHandler）、L374-465（WebSocketDownlinks/rejectUpgrade）、L480-586（apply/PRIVILEGED_METHODS/路由注册）；`lib/types/{rpc,http-bridge,api-request-trust,api-path}.d.ts` |
| dsh-api-gateway | `lib/index.js` L49-71（TypertGatewayService + intercept 注册）、L92-135（invoke）、L257-278（rpcFailure）；`lib/client.js`；`README.zh.md` |
| dsh-api-remotes | `lib/index.js` L101-166（createApiRemoteAgentResolver / lookups.configure）；`lib/types/{agent-lookup,remote-events,client/index}.d.ts` |
| dsh-typert-protocol / registry / loader | `lib/types/index.d.ts`（TypertRemoteService/@Remote/InvocationDescriptor/TypertClientRemote）；`dsh-typert-registry/lib/index.js` L191/L288（configure 单次占用） |
| dsh-session | `lib/types/index.d.ts`（SessionStore/事件）；`lib/types/types.d.ts`（SessionHeader/SessionEventMap） |
| dsh-session-projection | `lib/types/index.d.ts`（ProjectionDefinition/读取 API） |
| dsh-token-meter | `lib/index.js`（TokenMeter）；`lib/types/{index,types,projection,estimate}.d.ts` |
| dsh-llm | `lib/types/index.d.ts`（LlmRuntime）；`lib/types/types.d.ts`（LlmModelInfo/TokenUsage/GenerateOptions） |
| dsh-settings / dsh-settings-file | `lib/types/index.d.ts`（SettingsProvider/SettingsScope） |
| dsh-credentials / dsh-credentials-local | `lib/types/index.d.ts`（CredentialProvider）；`lib/types/types.d.ts`（CredentialRecord） |
| dsh-session-telemetry / -otel / dsh-anonymous-user-id / dsh-session-stats | 各 `README.zh.md`；`lib/types/*.d.ts` |
| dsh-jobs / dsh-jobs-local / dsh-schedule / dsh-fs* | 各 `lib/types/index.d.ts` |
| $DSH 根 | `lib/bin.js`（L91-105 web/plugin 子命令）、`lib/plugin-9h8shc4d.js`（runPlugin/reconcile）、`lib/profile-boot-DG5t9aNs.js`（composeProfile/allPatches/boot） |
| 真实 profile | `~/.dsh/profiles/web/{package.json,cordis.yml,cordis.patch.yml,pnpm-workspace.yaml,node_modules}`（只读） |
