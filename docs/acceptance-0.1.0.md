# 0.1.0 验收记录（自动化部分）

状态：代码与自动化验收完成；**真实宿主重启后的运行时验收待补**（见「待验收」）。
日期：2026-11-03。版本：`@dsh-external/dsh-butler` 0.1.0（官方 bundle 形态，`link:` 安装到 `desktop` profile）。

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

### 7. 示例 bundle 已"预装"（重启后激活）

`plugin_manager install_bundle target=E:\opendots\dsh-butler\examples\butler-pack-example`：

- 结果 `application: applied`，无 warning；`packageResult.exitCode=0`。
- profile `package.json`：`"@dsh-external/butler-pack-example": "link:E:/opendots/dsh-butler/examples/butler-pack-example"`，且列入 `dsh.profile.bundles`。
- profile `node_modules`：junction 指向示例目录，`locale/zh.json` 可读。
- Config 目录：`include:butler-pack-example` 存在，`packageDir` 指向 junction；`status: absent` 表示它的插件入口尚未激活 —— **这是预期**：示例声明了 `inject: ['butlerExtensions']`，而运行中的宿主仍是旧 Host 模块代、还没有该服务。重启后 butler 行先插入并发布服务，示例行随后激活。

## 二、待验收（需要重启 DSH 桌面应用）

Host 侧新代码（`butlerExtensions` 服务、扩展包并入读模型）需要新的 JS 模块代；运行中的宿主里尚不存在该服务（试过禁用/启用 bundle：Cordis 复用已缓存的模块代，不会加载新代码）。重启后按顺序验收：

1. `cordis_inspect_query` Host Service：`butlerExtensions` 出现，`schemaVersion: 1`。
2. `include:butler-pack-example` 从 `absent` 变为已激活；`GET /dsh-butler/api/overview` 的能力包列表出现 `example-weekly-review`（`source: 'extension'`、`enabled: true`、内核 `boundary`）。
3. 卸载示例 bundle：`plugin_manager remove_bundle target=@dsh-external/butler-pack-example`；确认能力包列表恢复 6 个、无残留。
4. GUI 肉眼验收：会话头部「管家 + ⋯」、侧栏单行「管家」→ 工作台页、工作台状态条与四区、任务/笔记/待批/提醒抽屉（Esc 关闭与焦点还原）、右栏真 tablist（方向键切换、记忆视图）、设置→插件「管家」条目（铃铛图标 + 描述）。

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
