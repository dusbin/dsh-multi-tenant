# DSH Web 前端插件体系研究报告（多租户插件前置调研）

> 调研对象：DSH v0.1.1-rc.2 已安装产物（只读）
> 安装根：`/Users/robinddu/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/`
> 包目录：`.../dsh/node_modules/@deepseek-ai/`（下文用 `$P` 代指）
> 调研性质：只读代码/文档分析，未启动任何服务，未修改任何源码。
> 目标：判断"在现有 Web shell 里加登录门禁 + 管理控制台页面"是否可行、怎么加。

---

## 1. 关键结论（逐条，含证据）

### 1.1 Q1：Web shell 如何启动与装配

**结论：前端是一个由 Vite 构建的 SPA（React 18），但"可启动"完全依赖 Host（Node 端）注入三样东西：`window.__ModuleLoader__`、`window.__DSH_BOOT__`、以及可选 `window.__DSH_TRANSPORT__`。没有这些注入，dist 打开就是死页面。前端自身没有任何路由（无 History API pathname 路由）。**

**启动链（从上到下）：**

1. **CLI 层**：`dsh` bin（`dsh/lib/bin.js`）解析 `--profile web`（`web` 是硬编码别名），走 `dsh-app-boot` 的 profile 机制。web profile 的 bundle 列表固定为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`（证据：`$P/dsh-app-boot/lib/index.js` 中 `const PROFILE_TEMPLATES = { web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], headless: [...] }`）。profile 位于 `$DSH_HOME/profiles/<name>`（`$DSH_HOME` 默认 `~/.dsh`），用户层 `cordis.patch.yml` 最后叠加。
2. **装配层**：`dsh-app-boot` 的 `boot(binName, absoluteConfigPath, patches?, prepare?, bareModuleBaseUrl?)` 创建根 Context、安装 Cordis Loader、挂载 include 树（`cordis.patch.yml`）、`assertEntriesActivated` 等（证据：`$P/dsh-app-boot/README.md` "Exports" 表）。
3. **web-app bundle 层**：`dsh-web-app/cordis.patch.yml` 是 web 专属组合补丁——它基于 `dsh-base` 插入 Web 宿主行（`webserver`、`api-gateway`、`web-startup`、`web-runtime`、`client-hmr`、`modules`、`connection`、`api-remotes`、`client-runtime`、`cordis-client-runner` 以及一长串 `ui-*` 浏览器插件名录）。关键注释（原文件）：
   > "`dsh.client` rows are the browser roster the modules node half scans into `window.__DSH_BOOT__`; the modules row is simultaneously a host row."
   - `web-startup`（`dsh-web-app/lib/startup.js`）解析 `--host/--port/--trusted-host/--no-open`，**拒绝 `--host 0.0.0.0`**（"would expose remote code execution to the network"）。
   - `web-runtime`（`dsh-web-app/lib/index.js`）通过 `@deepseek-ai/dsh-web-frontend` 的 exports `require.resolve("@deepseek-ai/dsh-web-frontend/dist/index.html")` 解析已构建的 dist，挂载 `frontend-static` 回退席位所有者，注册 `app:web-surface` 提示词段落与 bash 变量 `DSH_WEB_URL`，打印 `dsh web: <url>`，开浏览器。
4. **静态服务层**：`dsh-host-frontend-static`（`$P/dsh-host-frontend-static/README.md`）：持有 webserver 的唯一 fallback 席位，serving dist 目录；每次 index 响应走 webserver 的 `renderIndex`（结构化注入行 + 原始 tap 变换）——**这是 boot manifest 到达页面的通道**。
5. **注入层**：`dsh-client-modules/lib/index.js` 的 node 半：
   - 扫描 Loader 中声明 `dsh.client`（platform `"web"`）的包，解析 `exports["./client"]`，哈希 bundle，按模块图排序组合出 graph；
   - 在 `ctx.on("webserver/index-inject", ...)` 中 push `bootInjections(graph)`，共 3 类注入行（`lib/index.js` 的 `bootInjections()`）：
     - 内联 queue 脚本：安装 `window.__ModuleLoader__ = {mode:'queue', pendingQueue, load(registration){...}, create(options){...}}`；
     - parser 阻塞的经典脚本预载：`@deepseek-ai/dsh-client-modules` 与 `@deepseek-ai/dsh-client-runtime` 的 `lib/client.js`；
     - `{kind:'global', name:'__DSH_BOOT__', value: graph}`。
   - `__DSH_BOOT__` 载荷类型（`$P/dsh-client-modules/lib/types/client/manifest.d.ts`）：
     ```ts
     interface WebBootEntry { id: string; url: string /* '/plugins/<id>/client.js?rev=<rev>' */; rev: string;
       inject?: string[] /* 包名依赖边，信息性 */; immediately?: boolean /* 一阶段预取 */; external?: string[] /* 模块图边，约束代码到达顺序 */ }
     interface WebBootGraph { rev: string; entries: WebBootEntry[] }
     ```
     `url` 由 node 半的 `/plugins` prefix 路由（`serveBundle`）提供（`GET /plugins/<id>/client.js`，含 `.map`）。
   - 注意：**`host.describe` 不在 `__DSH_BOOT__` 里**。BOOT 只含插件图；host 信息通过连接后的 `host.describe` RPC 获取（见 1.5）。
6. **浏览器端**：`dsh-web-frontend/dist/index.html` → `<script type="module" src="/assets/index-*.js">` → 末尾 `new Yd(document.getElementById("root")).run()`。`Yd`（web boot，在 dist bundle 中）：
   - 校验 `window.__ModuleLoader__` 存在（否则 `throw new Error("web boot: window.__ModuleLoader__ bootstrap facade is missing")`）；
   - `this.modules = i.create({boot: window.__DSH_BOOT__, staticModules: Jd(), ...})`，其中静态模块表 `Jd()`：
     ```js
     { react, "react/jsx-runtime", "react-dom", "react-dom/client",
       "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives" }
     ```
   - `prefetchImmediateTier()`：对 `manifest.plugins.filter(i=>i.immediately)` 预取；
   - `runPluginBoot(ctx, ...)`：用内置（vendored）Cordis Loader 激活每个 entry（fiber 生命周期、inject 等待、update/refresh），失败时汇总抛 `web boot: N entries did not activate ...`；
   - `mountApp(ctx)`：`await n.inject(["uiRenderer"], i => i.effect(() => i.uiRenderer.mount(this.container), ...))` —— 应用挂载 = `uiRenderer.mount(#root)`。
   - 失败路径：`page.fail(message)` → 框架无关的 boot 页显示 "Failed to load plugins"（boot 页类 `Gd`，含 wordmark "HARNESS"、spinner、hint "Loading plugins…"）。
7. **渲染层**：`dsh-client-ui-renderer`（`$P/dsh-client-ui-renderer/README.md`）：提供 `ctx.uiRenderer`，`mount(container)` "installs the slot renderer, hydrates the existing boot DOM, switches to the assembled application before the next paint"。它执行唯一的 `ctx.slots.renderSlot('root')`。
8. **HMR/开发流**：`dsh-client-hmr`（`$P/dsh-client-hmr/README.md`）：浏览器半订阅 `GET /plugins/events` SSE，按 `rebuilt` 帧做 `invalidate → prefetch → registry.delete → drain fiber → entry.refresh()`；node 半用 interval 轮询 bundle 哈希。**只在 `pnpm run dev:web`（vite build --watch）改写 bundle 时生效**。

**`dsh-client-runtime` 的职责**（`$P/dsh-client-runtime/README.md` + client 类型）：浏览器 Cordis 对象层——提供 `ctx.slots`（SlotRegistry，Service 名 "slots"）、`ctx.sessions`、`ctx.workspaces`；启动连接流（`connection.start({onMuxEnvelope, onHostEnvelope, onConnected, onStateChange})`，在 `onConnected` 里 `ctx.emit("connection/reset")`，`onStateChange('reconnecting')` 时 `sessions.handleDisconnected()`）；把 `host/remote-event` 帧交给 `ctx.remote.$dispatch`。它本身不渲染 UI。

> 推论：Vite 入口在 `apps/web`（仓库目录），产物 `dsh-web-frontend` dist 只含构建结果；shell 库 `@deepseek-ai/dsh-client-web`（框架无关 boot 页 + boot 编排）与 `dsh-client-ui-slots`/`dsh-client-ui-primitives` 是构建期依赖，**未随安装发布**（`dsh-web-frontend/package.json` devDependencies；本机 node_modules 中不存在这三个包）。需要改 shell 本身（如登录门禁插到 boot 之前）时，必须改 `apps/web` 源码并重新构建 dist —— 本安装只读，无法就地改。

---

### 1.2 Q2：客户端 UI 插件如何注册与挂载

**结论：客户端 UI 插件 = 一个 npm 包，package.json 里声明 `dsh.client`（platform: "web"）+ `exports["./client"]` 指向构建产物；浏览器端按 Cordis 插件（apply/inject）激活；UI 通过"槽位（slots）"系统挂载——一个由类型驱动的声明式注册表，支持 single（遮蔽）/list（叠加）/keyed/chain 四种槽位。**

#### 1.2.1 包结构（manifest 与 exports）

`dsh.client` 字段完整语义（证据：`$P/dsh-client-modules/lib/index.js` 的 `parseDshClient()` + `$P/dsh-client-runtime/package.json` 实例）：

```jsonc
{
  "dsh": {
    "client": {
      "platform": "web",        // 必须；node 半只认 "web"
      "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-api-remotes"], // 包名依赖边（信息性，用于 preflight/HMR diff）
      "external": ["<specifier>"], // 可选：模块图边——本 bundle 额外 require 的、不在静态表里的模块；约束动态包先于消费者注册（require 是同步的）
      "immediately": true         // 可选：一阶段预取（script 加载+factory 注册，不物化）
    }
  },
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },   // node 半（可选）
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }, // 浏览器 bundle，必须
    "./src/*": "./src/*", "./package.json": "./package.json"
  }
}
```

- node 半扫描条件：`decl.platform === "web"` 且 `exports["./client"]` 存在（`clientExportOf`），否则忽略。bundle 缺失 → 激活期聚合抛 `MissingClientBundleError`（提示 `pnpm run build`）。
- `inject` 与 `external` 的区别：`inject` 是 Cordis 服务注入边（影响 fiber 激活顺序，等待服务）；`external` 是模块图边（约束代码到达顺序，require 同步）。`inject` 也进入 graph 的 `inject` 字段。
- 每个 entry 的浏览器激活体是 `{ apply(ctx), inject }`（Cordis 插件形状），bundle 以 lazy-CJS factory 形式注册：`window.__ModuleLoader__.load({id, factory(require){...}})`，物化（materialize）时才执行副作用（含 CSS 注入）。

#### 1.2.2 槽位系统（slots）

- 核心：`ctx.slots`（`SlotRegistry`，`$P/dsh-client-runtime/lib/types/client/slots.d.ts`）。API：`register(...)`、`inject(key, callback)`、`entries(key)`、`entriesOfSlot(key)`（遮蔽赢家视图）、`getVersion(key)`、`subscribe(key, fn)`、`renderSlot('root', owner)`、`install(renderer)`、`installLocale(face)`、`onEntryError(fn)`、`spec(key)`、`snapshot(root?)`、`pruneStoreScope(sessionId)`。
- `register` 的声明选项（来自 dist bundle 中 SlotCore 代码 + 各插件实例）：
  ```ts
  ctx.slots.register({
    name: "settings.section",   // 槽位 id
    id: "models",               // list 槽位要求 id；keyed 槽位要求 key
    order: 10,                  // list 排序（同 priority 内）
    label: () => t("nav"),      // 列表条目文案（注册方本地化）
    locale: "ns",               // 可选的 locale 命名空间
    kind: "single" | "list" | "keyed" | "chain", // 未声明时继承槽位声明
    scope: "root" | "session" | "session-maybe",
    priority: number,           // 默认 0
    inject: (ownerShare) => props, // 向组件注入的数据（observable 等）
    children: { "child.slot": { kind, scope } }, // 声明子槽位
    store: createXxxStore       // 可选 per-entry 状态工厂
  }, SomeComponent);
  ```
- **声明（declaration）与注册（registration）分离**：父 entry 的 `children` 表声明子槽位；子槽位被声明之前 `register` 会抛错（"slot X is not declared"）。`ctx.slots.inject(key, callback)` 解决顺序问题：声明在场时同步执行回调，否则等待声明出现再执行；回调内做 `register` 即"依赖声明"的标准姿势（`$P/dsh-client-runtime/README.md` "Slot declaration injection"）。
- **优先级/遮蔽规则**（来自 dist bundle 中 SlotCore `register` 实现，未压缩）：
  - 条目按 `priority` 升序排序（list 槽位再按 `order`）；**single 槽位中"最低 priority 的条目渲染"**（错误文案：`register at a different priority to shadow it (lowest renders)`），同一 priority 的 single 槽位重复注册抛错；
  - 这正是 `root` 槽位注释的机制：`root` 是 single 槽，ui-layout 的 AppFrame 占据它并声明 `sidebar/conversation/details/shell.overlay` 子槽；"a dynamically registered entry is assigned a lower priority than the shipped one, which makes it the winner: the page would render your component alone"（`$P/dsh-client-runtime/lib/types/client/slots.d.ts` 的 `'root'` 声明注释）。
  - list 槽位是叠加的（每个 entry 一个 `id`），渲染顺序 = priority 升序、同 priority 按 order 升序。
  - 崩溃（render 抛错）可 `abdicate`（退位，让位给同 cell 下一个），`onEntryError` 是监督缝。
- **槽位清单（从各 client bundle 实际提取）**，按声明者分组：
  - `ui-layout`：`root`（children: `sidebar`(single,root)、`conversation`(single,session-maybe)、`details`(single,session)、`shell.overlay`(list,root)）。
  - `ui-sidebar`：`sidebar`、`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.footer.action`、`sidebar.settings`、`sidebar.workspaces`。
  - `ui-settings`（基座声明，无展示）：`settings.trigger`(single)、`settings.header`(single)、`settings.close`(single)、`settings.action`(list)、`settings.section`(list，一 feature 一页)、`settings.plugins.tab`(list，Plugins 段内的页)、`settings.onboarding`(list)；`settings.general.item`(list，General 段内一行) 由 ui-settings-general 运行时声明。完整契约见 `$P/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`（含每个槽位的 owner props：`SettingsSectionOwnerProps.close`、`SettingsOnboardingOwnerProps.{stepId,complete,openSection}` 等）。
  - `ui-conversation`：`conversation`、`conversation.session`、`conversation.session.header(.actions|.lineage|.utilities)`、`conversation.view`、`conversation.composer(.bar|.dock)`、`conversation.input.(dock|left|right|model|plan|overlay|attachments)`、`conversation.chat.(node|commandview|turnTail|assistant-actions)`、`conversation.hero.(workspace|brand.mark|agentPreset)`、`conversation.message.images`、`conversation.details.tool`。
  - 其余：`ui-workspace` → `sidebar.workspaces(.directoryFlow)`、`conversation.hero.workspace(.directoryFlow)`；`ui-brand-official` → `sidebar.brand.mark/name`、`conversation.hero.brand.mark`；`ui-cordis` → `sidebar.footer.action`、`tool.call.toolview`；`ui-jobs` → `conversation.session.header.actions`；`ui-model-selection` → `conversation.input.model`；`ui-plan` → `conversation.input.plan`；`ui-commands`/`ui-input-trigger` → `conversation.input.overlay`；`ui-subagent` → `conversation.composer`、`conversation.session.header.lineage`；`ui-user-questions` → `conversation.composer`；`ui-trajectory` → `conversation.view`；`ui-goal` → `conversation.input.dock`、`conversation.chat.node`；`ui-deliverables` → `conversation.chat.turnTail`；`ui-permission-presets`/`ui-theme`/`ui-agent-preset`/`ui-conversation` → `settings.general.item`；`ui-settings-plugin-inventory`/`ui-settings-plugins` → `settings.plugins.tab`；`ui-settings-plugins` 还声明 `settings.plugin.item`（按 settings 命名空间 keyed 的卡片槽）。
- **settings 页注册范例**（`$P/dsh-client-ui-settings-models/lib/client.js`）：
  ```js
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "models", order: 10,
    label: () => t("nav"), inject: injected
  }, ModelsSection));
  ```

#### 1.2.3 React 版本与样式

- **React 18**：`dsh-web-frontend/package.json` devDeps `react ^18.2.0`、`@types/react ~18.3.1`；静态模块表 seed 的 `react/react-dom` 即 shell 内 bundle 的 React。插件 bundle 通过 `external`/静态表共享同一 React 实例，**不可自行打包 React**（bundle-purity gate）。
- **样式 = CSS Modules + 设计 token**：
  - CSS Modules：构建把 `*.module.css` 编译为哈希类名，CSS 文本在物化时以 `<style data-plugin-css="<pkg>/<file>">` 注入（证据：`$P/dsh-client-ui-sidebar/lib/client.js` 中 `\0dsh-css:...SidebarRoot.module.css.mjs`，类名形如 `hHd-Xa_root`，导出映射对象 `SidebarRoot_module_css_default`）。
  - token：`--dsw-*` 全局 CSS 变量（`--dsw-static-*` 基础刻度，如 `--dsw-static-neutral-bluish-00`；`--dsw-alias-*` 语义层，如 `--dsw-alias-bg-base`；`--dsw-specific-*` 具体用途，如 `--dsw-specific-login-input`），由 `ui-theme` 的 client bundle 编译注入 5 张样式表（`base.css`、`design-platform.css`、`scrollbar.css`、`gradient-shadow-text.css`、`shiki.css`）。组件局部变量用 `--dsh-*`（如 `--dsh-sidebar-inline-padding`）。
  - 工具函数（如 `clsx`）由各 bundle 内联自带。

---

### 1.3 Q3：登录门禁 / 管理控制台的抓手

**结论：现体系"可行但需要自己搭"。没有任何登录/身份/角色概念；唯一的门禁是 /api 的浏览器信任栅栏（loopback/trustedHosts，防 DNS rebinding），README 明确写着 "The fence is a reachability policy, not authentication; the Web carrier provides no authentication layer"。连接只有 connected/reconnecting 两种状态；UI 侧没有 guard/重定向机制，没有客户端路由。** 抓手如下：

1. **连接就绪状态（不是身份）**：
   - `ConnectionState = 'connected' | 'reconnecting'`（`$P/dsh-client-connection/lib/types/client/connection.d.ts`）；初始 pre-connect 阶段不报状态（"the UI treats 'no state yet' as connecting"）。
   - 就绪握手 = 两条 WS（`/api/events.mux`、`/api/events.host`）onOpen + `host.describe({})` HTTP unary 成功，然后 `onConnected(description)`；`host.describe` 值 schema（`$P/dsh-client-connection/lib/client.js`）：`{version, cwd, provider?, model?, attachedSessions, home, canOpenPath}`。
   - `ctx.connection.hostDescription` 是可观察对象（`getSnapshot(): HostDescription | undefined` / `subscribe`），连接建立后发布、`reconnecting` 时清空——**"未就绪"的可观察信号就在这里**。
   - **未就绪时 UI 显示什么**：没有任何连接态 UI。boot 页（"Loading plugins…"/"Failed to load plugins"）只在插件激活失败时出现；应用挂载后即渲染空列表（sessions/workspaces baseline 未到）。"在哪段代码决定"：渲染器在**全部 client entry 激活后**才 `mount`（`dsh-client-ui-renderer` README："The first application frame waits for every client entry... Per-region readiness remains deferred"），连接失败不阻塞激活（连接循环是异步运行时的）。
2. **登录门禁（全屏、在聊天 UI 之前）的可选实现路径**：
   - **路径 A（推荐，不改 shell）**：用 `shell.overlay`（list 槽、root 作用域）注册一个全屏覆盖组件；在该组件内部读取 `ctx.connection.hostDescription`/自建 auth 状态，未认证时渲染登录表单并阻止点击穿透（slot 注释明确说 overlay 默认 click-through，需要组件自己 opt-in pointer events）。聊天 UI 照常挂载在底下，视觉上被全屏登录层盖住。风险：插件 bundle 在登录前就已全部加载（信息面），且 overlay 是"叠加"不是"替换"。
   - **路径 B（硬门禁，改 shell/宿主）**：`dsh-web-frontend` dist 是构建产物、`apps/web` 源码未随安装发布 → 需要 fork/重建 shell，在 `Yd.run()` 的 `runPluginBoot` 与 `mountApp` 之间插入认证判定，或直接改 boot 页。成本高。
   - **路径 C（服务端门禁）**：在 webserver 路由层加 HTTP 中间件（`ctx.webServer.register({kind:'exact'|'prefix', path, handler})` 或把 index 响应换成登录页），对 `/api` 与 WS 升级做 token 校验。注意 `/api` 由 connection 插件以 prefix 路由注册、WS 升级是独立 upgrade 路由，**路由匹配顺序 exact → 最长 prefix → fallback**；加自己的 auth 路由要挂在更优先的位置（prefix 长度/顺序规则见 `$P/dsh-host-webserver/README.md`）。这是唯一能真正挡住未认证请求的层。
3. **管理控制台页面**：
   - **无客户端路由**：`dsh-host-frontend-static/README.md` 明确 "the current client enters through the root or configured index path and has **no History API pathname routes**. Adding one requires an explicit server rule..."。→ 要么用设置页模式（注册一个 `settings.section`，入口天然在侧边栏底部 Settings），要么自己实现视图切换（state 驱动的"页面"组件，注册到 `sidebar.footer.action` 或新增槽位）。
   - **角色化界面**：现体系没有 role 概念，但有两个现成的、语义相近的机制可借用：
     - `dsh-permission-presets`（`ctx.permissionPresets`，`$P/dsh-permission-presets/README.md`）：把 `sandbox/mode` + `approval/policy` 打包成命名预设（`workspace-write`/`danger-full-access`），是**权限策略**不是用户角色；其 `permissions` session 投影给 UI 提供选项。
     - `dsh-settings` 命名空间（`ctx.settings`，`$P/dsh-settings/README.md`）：**每个宿主插件可注册自己的设置命名空间**（schema 校验、base/user 分层、revision 乐观锁、`settings.describe`/`mutate`/`replace`），`ui-settings-plugins` 的 "Plugin configuration" tab 正是"命名空间 ↔ 浏览器卡片"的配对机制——**管理控制台最自然的落点就是注册一个新 settings 命名空间 + 一个 `settings.section` 页面 + 可选 `settings.plugins.tab` 卡片**。但注意：settings 的写 RPC 被 `/api` 栅栏 pin 在 **loopback-only**（`$P/dsh-client-connection/README.md` 的 privileged 方法集：`settings.*`、`credentials.*`、`agentPreset.*`），远程浏览器不可写——多租户远程管理需要新建自己的命名空间/通道，而不是复用 settings 写路径。
   - **"guard/重定向/启动钩子"**：客户端无路由 → 无 guard。宿主侧有启动钩子（`boot()` 的 `prepare`、`web-runtime` 的 `apply`、patch 层 insert/disable 任意行、`ctx.on("webserver/index-inject")`）。客户端插件激活即执行 `apply(ctx)`，可在此"钩住"启动时刻。

---

### 1.4 Q4：动态双半插件 vs 静态 client-ui 插件

**结论：动态双半插件（cordis 系列）是"模型通过工具即时定义并运行一个插件"的自举机制，服务端验证/权限模型完全不同，不适合做生产级控制台 UI；管理控制台应该用静态 client-ui 插件（1.2 的机制）。**

- **静态 client-ui 插件**：编译期打包、随 web-app bundle 名录（`cordis.patch.yml` 的 `dsh.client` 行）固定装载；代码经过正常构建管线（tsdown + TS 类型），可安全地 import 共享库（`external`/静态表）、声明服务、注册槽位。
- **动态双半插件**（`dsh-cordis-host-runner` + `dsh-cordis-client-runner` + `dsh-client-ui-cordis`）：
  - 宿主半（`$P/dsh-cordis-host-runner/README.md`）：`ctx.dynamicCordisRunner` —— `define/run/stop/inventory/invoke`；定义存进程内存，`node:vm` 沙箱执行宿主半；**"The vm sandbox isolates globals but is not a security boundary... Treat a dynamic package like bash access"**（信任模型 = 用户点批准）。
  - 浏览器半（`$P/dsh-cordis-client-runner/README.md`）：订阅 `cordis/request-run` 等转发事件（走 `ctx.remote.$on` 的 allowlist），源码以"异步函数体"形式下发（**无 JSX、无 TS、无 import**），`apply` 拿到的是白名单代理 ctx；通过 `ctx.slots` 注册即遮蔽，**"newest run wins"**。
  - 通信：包的浏览器半 → 自己宿主半用 `host.call` → `dynamicCordisRunner` Remote namespace 的 `invoke`。
  - **选择建议**：控制台 UI 需要类型安全、可测试、可维护 → 静态 client-ui 插件 + 宿主侧（同包 node 半或独立宿主插件）注册服务/RPC。动态机制留给"模型/用户在运行时写 UI"的场景（它甚至能注册 `settings.section` 等槽位——`dsh-client-ui-cordis` 的 README 提到 slot admission allow/deny 列表尚无载体，风险点）。
- 另一个区别：静态包可以有自己的 **host 半**（`lib/index.js`）与浏览器半（`lib/client.js`）——"dual-face"，但这是**编译期固定**的双半（如 `dsh-client-modules`、`dsh-api-remotes`、`dsh-client-connection` 都是 node+client 双半包），不是动态的。多租户插件应做成这种静态双半包：node 半跑在宿主进程（鉴权、配额、RPC 端点），client 半跑在浏览器（UI）。

---

### 1.5 Q5：前端与 host 通信

**结论：HTTP POST 一元 RPC + 两条下行 WebSocket；Remote（`ctx.remote`）是类型化 BFF 层，其调用最终落到 Connection 的 `/api` 通道；客户端插件不能运行时注册 host RPC，但宿主插件可以通过 Connection 通道 API 注册自定义通道/拦截器，或通过 Typert 生成描述符（构建期）挂进 api-remotes 装配。**

1. **物理传输**（`$P/dsh-client-connection/README.md` + `lib/types/client/`）：
   - unary/respond：`HTTP POST /api`（浏览器 fetch 桥，node 半 `bridge`；body 上限 `maxRequestBodyBytes` 默认 300MiB）；
   - 下行事件：`/api/events.mux`（会话事件流）与 `/api/events.host`（宿主事件流）各一条**纯下行** WebSocket（客户端不发应用数据）；任一条断开 → 当前 generation 失败 → 指数退避重连；
   - 就绪 = 两条 WS onOpen + `host.describe` 成功；
   - 替代传输：`window.__DSH_TRANSPORT__`（`ClientTransportHooks`：`createApiClient`/`fetch`/`loadBundle`）可整体替换浏览器 carrier（worker preview 的 postMessage 隧道就是这么做的）。
2. **/api 信任栅栏**（`src/api-request-trust.ts`，见 README）：校验 `Host` 头 ∈ loopback ∪ `trustedHosts`（WHATWG 规范化比较，防 DNS rebinding）、`Origin` 必须等于 Host authority、拒绝 `sec-fetch-site: cross-site`；**无认证层**；`dsh web --host 0.0.0.0` 被明确禁止。
3. **Remote 命名空间（类型化 BFF）**：
   - 客户端服务 `ctx.remote`（`$P/dsh-api-gateway/README.md` 的 "Client service: `ClientRemote`"）：
     - `$mount(contribution)`：校验并注册一份生成的 Host→Client 贡献（描述符 `{package, descriptors: [{id, service, namespace, method, invocation:{kind:'direct'|...}, parameters, result:{mode:'strict', typeSymbol, schema}, scope?, cancellation?}]}`，见 `$P/dsh-api-remotes/lib/client.js` 中内嵌的 `TYPERT_REMOTE*` 对象）；
     - 每个 namespace 是 `remote.<ns>` 子服务，方法为具体函数：`ctx.remote.goals.edit(sessionId, ref, {objective})`、`ctx.remote.messageFeedback.put({...})`、`ctx.remote.pluginInventory.list()`；
     - 每次调用 → `ctx.connection.rpc.call('/api', '<ns>/<method>', payload)` → 宿主 `ctx.typertGateway.invoke()` 解析描述符与 Cordis 服务（宿主业务服务 `extends TypertRemoteService`，方法标 `@Remote`/`@RemoteScope`）→ 返回 `RpcResult`；
     - `$on(event, listener)`：订阅**转发宿主事件**，合法 key = api-remotes 的 allowlist `API_REMOTE_FORWARDED_EVENTS`（`$P/dsh-api-remotes/lib/index.js`：`agent-preset/selected`、`commands/change`、`credentials/reference-updated`、`cordis/request-run`、`cordis/request-run-resolved`、`cordis/dynamic-package`、`cordis/dynamic-retract`、`cordis/inspect-query`、`cordis/inspect-query-resolved`、`llm/adapters-updated`、`settings/document-updated`）；
     - `$dispatch(event, args)`：宿主帧到达侧调用（runtime 的 host sink）。
   - 当前装配的 namespace：`goals`、`messageFeedback`、`pluginInventory`、`commands`、`dynamicCordisRunner`、`fileReferences`、`sessionReferenceResolver`（来自 `$P/dsh-api-remotes/lib/client.js` 的 `apply`，7 个贡献逐个 `$mount`）。
4. **客户端插件能否自注册远程调用面**：
   - **不能**在运行时把新的 Typert namespace 挂进 `ctx.remote`（api-remotes README："The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime. Additional capabilities require an explicit `/remote` value import and mount in this assembly"）——需要改 api-remotes 装配（构建期）。
   - **能**通过底层 Connection 通道 API 自建 RPC：
     - 宿主半：`ctx.connection.rpc.handle(channel, handler, {authority: 'trusted-host'|'loopback'})` 注册一条新逻辑通道（会在 webserver 上挂一条 `prefix` 路由，同样过信任栅栏；`$P/dsh-client-connection/lib/index.js` 的 `HostConnectionService.register`）；或 `ctx.connection.rpc.intercept('/api', matches, handler, options)` 抢占 /api 上未声明的 endpoint（注意 /api 共享通道**同一时刻只允许一个 interceptor**，目前被 Typert gateway 占用，`registerInterceptor` 对第二个抛错）；
     - 客户端半：`ctx.connection.rpc.call(channel, endpoint, payload, signal?)`（`ClientConnectionRpc`，`$P/dsh-client-connection/lib/types/rpc.d.ts`）。
   - 另：动态双半包的 `host.call` 走 `dynamicCordisRunner` namespace 的 `invoke` 路由到**自己包的宿主半**（运行时注册的 handler 表 `harness.handle`）。
5. **下行事件消费者**：业务 UI 通过 `ctx.remote.$on(...)`（allowlist 事件）或运行时对象层的投影（`ctx.sessions`/`ctx.workspaces` 的 observable、`session/projection` 帧）拿实时数据；`host/remote-event` 帧 → `ctx.remote.$dispatch`。

---

### 1.6 Q6：i18n 与主题

- **i18n**（`$P/dsh-client-locale/README.md`）：
  - 服务 `ctx.locale`：`register(ns, {zh, en})`（受 `LocaleNamespaceMap` 类型约束）、`bind(ns)` → 类型化翻译函数 `t`（查找链 ns → common → en → key）；
  - 语言偏好持久化在 `$DSH_HOME/settings.yaml` 的 `locale.preference`；首次以浏览器 `navigator` 语言为准（primary-subtag 匹配，未知 → en）；`locale/change` 事件；把 `<html lang>` 指向 `zh-CN`/`en`；
  - 通过 `ctx.slots.installLocale(face)` 接入槽位系统，槽位组件获得标准 `t` seat；**新 UI 接法**：`apply(ctx)` 里 `ctx.effect(() => ctx.locale.register(NS, {zh, en}), "...")`，组件内 `const t = ctx.locale.bind(NS)`；列表槽位条目把 `label: () => t("nav")` 作为函数传入（重新注册时更新，shell 不订阅 locale）。
  - 远程浏览器（非 loopback）拿不到持久化（settings API loopback-only），只保留进程内选择。
- **主题**（`$P/dsh-client-ui-theme/README.md`）：
  - 服务 `ctx.theme`：`getTheme()` 返回不可变 `ThemeSnapshot`，`theme/change` 事件；偏好 `light|dark|system`，`system` 走 `prefers-color-scheme`；持久化在 `ui-theme.preference` settings 命名空间；
  - **token 是全局 CSS 变量**：`--dsw-static-*`（基础刻度）→ `--dsw-alias-*`（语义层，如 `--dsw-alias-bg-base`、`--dsw-alias-label-primary-*`）→ `--dsw-specific-*`（具体用途，如 `--dsw-specific-login-input`）；暗色由 ui-layout 的 presenter 应用（`html { color-scheme }`、`body[data-ds-dark-theme]`、内联 alias token）；
  - **新 UI 接法**：CSS Module 里直接用 `var(--dsw-alias-*)`；宿主还在 index 的 `<body>` 后注入 bootstrap（读 `ui-theme.preference`，首帧即正确色系）。组件局部变量用 `--dsh-*`。第三方主题可注册 override 层（需自己保证完整，无校验）。

---

### 1.7 Q7：客户端插件如何构建

**结论：标准构建是 `tsdown`（脚本 `"bundle": "tsdown"`、`"watch": "tsdown --watch"`），产出 `lib/index.js`（node 半）+ `lib/client.js`（浏览器半，lazy-CJS factory 格式）；浏览器半必须满足 bundle-purity 约束。**

- 证据：所有 `dsh-client-ui-*`、`dsh-client-runtime`、`dsh-cordis-client-runner` 等 client 包的 `scripts` 均为 `{"bundle": "tsdown", "watch": "tsdown --watch"}`；`dsh-api-remotes` README 提到 `clientBundle(..., { hostPhase: true })` 区分宿主/浏览器两次构建（双面包特殊处理），以及普通 client 插件在 client tsdown 里同时产出 node loader entry 和 browser bundle。
- **浏览器半产物格式**：每个 `lib/client.js` 形如：
  ```js
  window.__ModuleLoader__.load({
    id: "@deepseek-ai/dsh-xxx",
    factory: (require) => { /* 整个 bundle 体，含内联依赖与 CSS */ return module.exports; }
  });
  ```
  （证据：`$P/dsh-api-remotes/lib/client.js` 开头、`$P/dsh-client-runtime/lib/client.js` 结尾。）
- **共享模块不打包**：React/Cordis/ui-slots/ui-primitives 走 shell 静态表（`Jd()`）；同仓库 client 包走 `dsh.client.external` 请求 + 模块图排序（graph row 先于消费者注册）；**value import 必须走 `/client` 子路径**（`$P/dsh-client-runtime/README.md` "Known Limitations"：裸包名不在 loader externals 表，会内联第二个模块实例，导致 scope-tag Symbol 不匹配）。
- **构建期门禁**：bundle-purity gate（README 提到 "the runtime mirror of the build-time bundle purity gate"）禁止 bundle 引用静态表/外部表之外的东西；`ui-settings-plugins` README 补充：发出该格式的 `clientBundle` preset 在仓库 `packages/client/tsdown.client.ts`（**未随安装发布**），仓库外插件要自己复刻该构建。
- **装配**：构建产物由 node 半（dsh-client-modules）扫描装载进 `__DSH_BOOT__` 图并 serve `/plugins/<id>/client.js?rev=<sha1-12>`；无需注册清单文件——**package.json 的 `dsh.client` + `exports["./client"]` 就是"注册"**。开发时 `pnpm run dev:web`（vite build --watch + tsdown watch）触发 client-hmr 热更。
- **web shell 本身**：`dsh-web-frontend` 用 Vite 构建（`"build": "vite build"`），入口在 `apps/web`（仓库），devDeps `vite ^6`、`@vitejs/plugin-react ^4`、react 18。

---

## 2. 对多租户插件的可行性判断（结论摘要）

**可行**，推荐组合：

1. **登录门禁**：浏览器侧用 `shell.overlay` 全屏登录层（基于 `ctx.connection.hostDescription`/自建 auth 状态），**同时**在宿主侧给 webserver 加认证中间件（`ctx.webServer.register` prefix 路由或对 `/api` 的拦截）才能真正拦住未认证流量；`/api` 信任栅栏保留作为第一道（loopback/LAN），在其上加 token 校验（需要给 connection 的 `/api` 桥或自建通道加）。现状"无认证层"是明确写死的（`--host 0.0.0.0` 被禁），多租户远程访问必然要动宿主层。
2. **管理控制台**：静态双半包——node 半注册设置命名空间/自建 RPC 通道（`ctx.connection.rpc.handle('/tenant-admin', ...)`，loopback 或认证后）；client 半注册 `settings.section` 页面（或新增 `sidebar.footer.action` 入口）展示配额/用量；角色（admin/auditor/user）在宿主侧建模，通过 RPC 下发，UI 按角色渲染。
3. **动态双半插件不适合**做控制台（安全模型是"用户批准即运行"，无类型/构建门禁）。
4. **主要改造点**（需 repo 源码或宿主补丁层）：`cordis.patch.yml`（补丁层，可 insert/disable 行，**无需改源码即可加插件行**）；若需"登录页先于插件加载"，只能动 `apps/web` shell 或 index 注入（`webserver/index-inject` 可注入登录页脚本/样式，但插件 bundle 仍会加载）。

---

## 3. 不确定性 / 风险

1. **apps/web 源码与 `dsh-client-web` shell 库未随安装发布**（`dsh-web-frontend` 只含 dist；`dsh-client-web`、`dsh-client-ui-slots`、`dsh-client-ui-primitives` 是 devDeps，本机 node_modules 中不存在）。→ 未确认项：shell 源码细节（boot 页 DOM、`Yd` 的 seams 参数来源、`dsh-client-web` 的确切 API）。需要 repo checkout（github.com/deepseek-ai/deepseek-harness，`apps/web` + `packages/client/web`）才能验证。
2. **tsdown 配置（tsdown.config.ts / tsdown.client.ts preset）未随安装发布**。→ 未确认项：仓库外包如何精确复刻 client bundle 构建（dsh-client-modules README 只描述产物格式与纯度门禁，未给配置）。构建时会话需以 `dsh-client-ui-sidebar` 等已装包的 `lib/client.js` 为基准样例。
3. **SlotCore 的 `scope` 语义（root/session/session-maybe）只看到声明与使用**，运行时 store 生命周期细节（handle×scope 缓存、pruneStoreScope）在 `$P/dsh-client-runtime/lib/types/client/slots.d.ts` 有注释但实现未逐行验证（ui-slots 未安装）。
4. **`dynamicCordisRunner` 的 Remote namespace 由宿主运行器在运行时注册**（`$P/dsh-cordis-host-runner/README.md` 提到 "the plugin declares `remote.dynamic`, so it stays parked until the host-side namespace exists"），其注册机制未在已装产物中逐行确认；但这不影响静态方案。
5. **多租户需要"身份"概念，现体系完全没有**：`host.describe` 只返回 `{version, cwd, provider?, model?, attachedSessions, home, canOpenPath}`，无用户/租户字段；`/api` 栅栏无认证；settings 写路径 loopback-only。远程管理必须新建鉴权层（token/session cookie + 宿主中间件），这是本项目最大的自定义面，且会与"无认证层"的既有安全假设（`--host 0.0.0.0` 被禁）直接冲突——需要设计文档确认边界。
6. **`ctx.connection.rpc.handle` 新通道的信任策略只有 `trusted-host`/`loopback` 两档**，无"已认证"档位；认证后的授权（admin/auditor/user）需要在宿主 handler 内自建。
7. **Vite/vendor 细节**：dist bundle 是 minified，`Jd()` 静态表与 boot 逻辑从产物反推，可能与 `apps/web` 源码存在偏差（逻辑等价，命名不同）；`Yd`/`Gd` 等类名是压缩产物名。
8. **客户端"连接未就绪"没有用户可见提示**：即使加了登录层，也需要自建"连接中/重连中"状态展示；`hostDescription` 的 subscribe 是唯一现成信号。
9. 版本：本报告基于 **0.1.1-rc.2** 安装产物；`cordis.patch.yml`、`__DSH_BOOT__` 载荷、slot 清单均可能随版本演进。

---

## 4. 证据文件索引（关键路径）

| 主题 | 文件 |
|---|---|
| 启动装配（patch、roster、注入） | `$P/dsh-web-app/cordis.patch.yml`、`$P/dsh-web-app/lib/index.js`、`$P/dsh-web-app/lib/startup.js` |
| profile/boot 机制 | `$P/dsh-app-boot/README.md`、`$P/dsh-app-boot/lib/index.js`（`PROFILE_TEMPLATES.web`） |
| `__DSH_BOOT__` 注入与载荷 | `$P/dsh-client-modules/lib/index.js`（`bootInjections`/`ClientModuleRegistry`）、`$P/dsh-client-modules/lib/types/client/manifest.d.ts` |
| 浏览器端 boot | `$P/dsh-web-frontend/dist/index.html`、`dist/assets/index-*.js`（`Yd`/`Jd()`/`Gd`） |
| 静态服务与 index 注入 | `$P/dsh-host-frontend-static/README.md`、`$P/dsh-host-webserver/README.md`、`$P/dsh-host-webserver/lib/types/{index,injections}.d.ts` |
| 槽位系统 | `$P/dsh-client-runtime/lib/types/client/slots.d.ts`、`$P/dsh-client-runtime/README.md`、`$P/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` |
| 连接/传输/信任栅栏 | `$P/dsh-client-connection/README.md`、`lib/types/client/{connection,index}.d.ts`、`lib/types/rpc.d.ts`、`lib/index.js`（`HostConnectionService.register`） |
| Remote BFF | `$P/dsh-api-remotes/README.md`、`$P/dsh-api-remotes/lib/index.js`（`API_REMOTE_FORWARDED_EVENTS`）、`$P/dsh-api-remotes/lib/client.js`（`TYPERT_REMOTE*`/`$mount`）、`$P/dsh-api-gateway/README.md` |
| 动态双半插件 | `$P/dsh-cordis-host-runner/README.md`、`$P/dsh-cordis-client-runner/README.md`、`$P/dsh-client-ui-cordis/README.md` |
| i18n/主题 | `$P/dsh-client-locale/README.md`、`$P/dsh-client-ui-theme/README.md`、`$P/dsh-client-ui-theme/lib/client.js`（token 定义） |
| 权限/设置（可借用机制） | `$P/dsh-permission-presets/README.md`、`$P/dsh-settings/README.md`、`$P/dsh-client-ui-settings-plugins/README.md` |
| 构建 | 各 client 包 `package.json`（`"bundle": "tsdown"`）、`$P/dsh-web-frontend/package.json`（vite/react 版本）、`$P/dsh-client-hmr/README.md` |

（`$P` = `/Users/robinddu/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`）
