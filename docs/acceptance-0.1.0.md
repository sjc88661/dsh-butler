# 0.1.0 验收记录

状态：**代码、自动化与真实运行时验收全部完成**；仅剩用户侧 GUI 肉眼确认（本记录给出现场证据）。
日期：2026-11-03。版本：`@dsh-external/dsh-butler` 0.1.0（官方 bundle 形态，`link:` 安装到 `desktop` profile）。

> 重要事实：新 Host 模块代与新 Client bundle **无需重启**即已在运行中的宿主生效（bundle 禁用/启用后加载器取用了新模块代；浏览器侧已加载新 client bundle）。原计划的"必须重启"没有发生，验收直接在 18:37 启动的同一宿主进程（PID 32636）上完成。

## 一、已完成并可复现的验证

### 1. 官方 bundle 打包清单

`npm pack --dry-run --json --ignore-scripts`：116 个文件，逐项核对：

| 检查项 | 结果 |
| --- | --- |
| `cordis.patch.yml`（`dsh.bundle.patch` 目标） | ✅ |
| `locale/zh.json` + `locale/en.json`（`meta.title/description`） | ✅ |
| `icon.svg`（原创服务铃，553 B，XML 校验通过） | ✅ |
| `lib/index.js`（Host 入口）、`lib/client.js`（Client 入口） | ✅ |
| `lib/extension.js`（对外接口子路径） | ✅ |
| `lib/types/**`（声明） | ✅ |
| 无旧构建残留的 tsdown chunk | ✅（`build.mjs` 在 emit 前清理 `lib/`） |

### 2. Host 产物可加载性（独立 Node 进程）

`node --input-type=module -e "await import('./lib/index.js')"`：

- 导出 `name` / `inject`（10 个宿主服务）/ `apply` / `Config`。
- `Config` 是可调用 Schemastery schema：`Config({ timeZone: 'Asia/Shanghai' })` 得到默认值（`sessionTitleName: '管家'`、`taskMaxRequests: 50`、`trial.enabled: false` 等）；`Config({ profileChars: 1 })` 抛 `ValidationError: $.profileChars expected number >= 200`。
- 说明 Host bundle 自包含（只依赖 Node 内置），不再需要部署在 profile 目录内才能解析 `@deepseek-ai/schemastery`。

### 3. Client 产物冒烟（同测试机、无浏览器）

用 `vm` 提供 `window.__ModuleLoader__` 与 `react` 桩执行 `lib/client.js`：

- `load({ id: '@dsh-external/dsh-butler', factory })` 被调用，`factory(require)` 返回 `{ apply, inject: ['slots','layout'] }`。
- `apply(fakeCtx)` 注册 5 个席位（`conversation.session.header.actions` / `sidebar.panellist` / `main` / `conversation.view` / `conversation.input.dock`），组件均为函数；第 6 个注册（右栏页签）依赖宿主的 `sidebarRightTabs` 服务，冒烟环境未提供故跳过，符合设计。

### 4. 对外接口校验器（第三方视角）

通过公开子路径 `./lib/extension.js`：

- `BUTLER_EXTENSION_SCHEMA_VERSION === 1`；`EXTENSION_LIMITS` 含全部上限。
- `validatePackManifest(...)`：示例能力包通过并补全 `tools: []` / `budget: {}` / `cost_class: 'unknown'`；`schemaVersion: 2` 被拒（错误含 `schemaVersion`）；内核 id（`daily`）被拒。
- `validateChannelAdapter(...)`：示例通道通过；缺 `send`/`isReady` 拒绝。

### 5. 自动化回归

- `node scripts/build.mjs --typecheck`：通过（host + client）。
- `node --test tests/*.test.mjs`：**1017/1017 通过、0 失败**（新增 `tests/extensions.test.mjs` 22 组）。
- `tests/build.test.mjs` 扩展为：干净副本离线构建后，逐个导出目标存在、Host 产物可 import、`Config` 可校验、`./extension` 校验器可用。

### 6. 真实宿主安装态（未重启的旧 Host 模块代）

- Loader：`include:dsh-butler` 存在，`packageDir` 指向 profile 的 `link:` → `E:\opendots\dsh-butler`；Config schema 正常投影。
- 旧手注入行 `dsh-butler-0.0.22`：`inactive`（回滚路径保留）。
- `GET http://127.0.0.1:53210/dsh-butler/api/overview`：200，`reminders=6`，`remindersAvailable=true`，`packs=6`（扩展包还没有，符合预期），vault 正常。
- 插件页元数据：`exports` 的 `./locale/*.json`、`./icon` 均可解析（`createRequire` 从 profile 解析验证）。
- 客户端 UI 注册：对 `lib/client.js` 做无浏览器冒烟（见 §3），5 个席位会注册；右栏页签依赖宿主 `sidebarRightTabs`，由真实宿主提供。

### 7. 示例 bundle 真实安装 → 注册 → 卸载验收（已完成，无需重启）

1. `plugin_manager install_bundle target=E:\opendots\dsh-butler\examples\butler-pack-example` → `application: applied`、无 warning；profile 增加 `link:` 依赖并列入 `dsh.profile.bundles`；Config 目录出现 `include:butler-pack-example`。
2. 运行时：`plugin_manager list_plugins` 显示 `include:butler-pack-example` **`fiberPhase: "active"`**；`GET /dsh-butler/api/overview` 的能力包从 6 变 **7**，新增项：

   ```json
   { "id": "example-weekly-review", "source": "extension", "enabled": true, "cost_class": "free",
     "boundary": { "origin": "kernel", "mode": "guidance-only", ... }, "guidance": { ... } }
   ```

   说明：`butlerExtensions` 服务已由 butler 发布、示例插件的 `inject: ['butlerExtensions']` 满足、`registerPack` 校验通过、内核边界由内核注入（不是 manifest 文本）。
3. `plugin_manager remove_bundle target=@dsh-external/butler-pack-example` → `application: applied`；随后 overview 能力包回到 **6**、`source:'extension'` 计数 **0**；profile 依赖与 bundle 列表均已清理。证明注册表的 disposer 在卸载时真实执行。
4. 备注：`cordis_inspect_query Service.listService` 不列出 `ctx.provide` 形态的服务（这是检查工具的目录口径，不是服务缺失）；上面前两步是服务存在的运行时证据。

### 8. 客户端新 UI 已在运行页面生效（运行时证据）

对当前连接的页面做 live Slot 检查：

- `sidebar.panellist` occupants：`plugins`、`schedules`、**`butler`（order 30）** —— 只有一行「管家」，旧的 `butler-sources` 行已不存在；
- `main` occupants：`plugins`、`conversation`、`schedules`、**`butler`** —— 没有 `butler-sources` 键；
- `conversation.session.header.actions`：**`butler`（order 40）active** —— 新的「管家」主按钮 + 「⋯」菜单入口；
- `sidebar.right.pane.tab`：**`@dsh-external/dsh-butler/workspace` active** —— 右栏「管家资料」真页签。

以上四项与「入口收敛为 4 席位」的实现一一对应，说明浏览器端加载的是 0.1.0 的新 client bundle，而不是旧版 8 席位代码。

## 二、真实 GUI 视觉验收（已用窗口截图完成）

2026-11-03 21:0x 对运行中的 DeepSeek Harness 桌面窗口做了**只读窗口截图**（恢复窗口 → 校验前台窗口句柄与标题确为 DSH → `CopyFromScreen` 抓取窗口矩形 → 立即重新最小化，未在 DSH 内改动任何设置；截图存
`E:\opendots\diagnostics\ui-verify-20261103\gui-final.png`，另有一张 `gui-restored.png`）：

从截图逐项确认：

1. 会话头部：标题右侧有**「管家」主按钮（服务铃图标，深色 pill）**，紧邻**「⋯」菜单**——即入口收敛后的 1 按钮 + 1 菜单形态；
2. 会话视图页签：`对话 | 轨迹 | 管家 | ⋯`——工作台作为 Conversation View 页签存在；
3. 左侧栏：`插件 / 自动化任务 / 管家 / 更多`——只有一行「管家」，旧的「对话来源」行已消失；
4. 侧栏工作区列表与本会话内容正常渲染，未出现布局错乱或空白。

工作台四区、四个详情抽屉、右栏真 tablist 的**结构与交互契约**由自动化测试（`client-workbench-actions` 18 条、`client-workspace-review` 18 条、`client-layout-inject` 21 条）与 live Slot 证据覆盖（见 §8）；其像素级观感以截图为现场证据，若需要我再抓「管家工作台页」与「右栏」两张截图可继续（需前台无其它全屏窗口）。

> 过程说明（如实记录）：第一次尝试用鼠标点击侧栏「管家」导航时，前台被一个全屏游戏窗口占用，疑似有 2 次点击落在该游戏窗口上（DSH 窗口本身未被点击）；发现后立即停止所有输入自动化，并删除误截的屏幕截图。之后只做"前台校验 + 截图 + 恢复最小化"的只读操作。DSH 会话里可能残留一个由该轮操作打开的 diff 预览浮层，点窗口空白处即可关闭，不影响插件状态。

## 三、回滚

1. 编辑 `C:\Users\申俊超\.dsh\profiles\desktop\cordis.patch.yml`，删除 `# >>> dsh-butler-official 0.1.0 begin` 到 `# <<< dsh-butler-official 0.1.0 end` 之间的整段（该段把旧手注入行 `dsh-butler-0.0.22` 置为 `disabled: true`）。
2. `plugin_manager remove_bundle target=@dsh-external/dsh-butler`。
3. 重启宿主：回到 0.0.22 手注入形态（`butler-releases/0.0.22+layer.2`）。
4. 备份：改前已生成 `cordis.patch.yml.bak-before-official-bundle-20261103-195342` 与 `package.json.bak-before-official-bundle-20261103-195342`。

## 四、已知限制

1. `@deepseek-ai/dsh-agent` 的动态 import 仍是运行时可选路径（旧实现相同）；解析不到时只影响管家专属会话的模型选择安装步骤。
2. Drawer/Modal 无 portal（无 `react-dom` 依赖），按 `position: fixed` 渲染；挂载点约定位面板根，祖先不能有 `transform/filter/contain`。
3. 通道接口本轮只做"注册 + 校验 + 列举"：不调用 `send`/`isReady`、不选目标、不读凭据、不接管投递；真实投递仍由宿主组合负责。
4. 扩展注册不持久化：插件重载/宿主重启后由第三方 `apply` 重新注册；`state/packs.json` 不记录扩展包开关。
5. 客户端视觉验收与真实浏览器焦点陷阱（Tab 循环、Esc 冒泡顺序）需在 GUI 里确认；自动化用 fake-tree 载体只验证结构与行为契约。
6. 测试基线说明：本机（非沙箱子进程）1017/1017；历史审计中的环境性失败（沙箱禁子进程、Windows junction 等）不在本记录范围内。
