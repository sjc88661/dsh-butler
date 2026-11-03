# ADR 0002：官方 bundle 形态、入口收敛与对外插件接口

状态：已实施第 1–3 步（官方化 / 设计系统 / 入口收敛），第 4–7 步（工作台四区、三态与可访问性、私用体验、对外接口）进行中。版本 0.1.0。

## 背景

0.0.22 通过 profile `cordis.patch.yml` 里手写 `file://` 条目注入，profile 的 `package.json` 没有该依赖，插件页/`listBundles` 看不到管家；部署目录还必须落在 profile 内部，否则 `import '@deepseek-ai/schemastery'` 解析不到（该包的模块解析按真实路径走，不会进入 profile 的 `node_modules`）。同时 UI 有 265 处内联样式、8 个入口席位（含两个同样式、只差跳转目标的侧栏行）、工作台 footer 是 30+ 项 `' · '` 拼接文本、详情靠 `scrollIntoView` 抢滚动位置。

## 决定

### 1. 官方 bundle 形态

- 包名不变 `@dsh-external/dsh-butler`，版本升 `0.1.0`；`package.json` 增加 `dsh.bundle.patch` 指向随包的 `cordis.patch.yml`，`dsh.client` 声明 `platform/immediately/inject`，`exports` 增加 `./locale/*.json` 与 `./icon`，`files` 覆盖 `lib`、patch、locale、icon。
- 移除针对 dsh 自带包（`@deepseek-ai/dsh-agent`、`dsh-llm`、`dsh-tools`、`dsh-client-ui-slots` 等）的 `peerDependencies`：这些包由 DSH 安装提供，不需要、其中一个在 0.2.1-rc.5 根本不存在。
- `cordis.patch.yml` 只插入一行 `id: dsh-butler`（带灰度期配置默认值）；部署侧覆盖写在 profile 自己的 patch 层。
- 安装统一走 `plugin_manager` 的 `install_bundle`；本机以 `link:` 方式链到工作区。回滚 = 删除 profile patch 里 `dsh-butler-official 0.1.0` 段并移除 bundle，旧手注入行 `dsh-butler-0.0.22` 保留但停用。

### 2. Host 半自包含

Host 与 Client 两半都由 tsdown 打包：Host bundle 内联 `@deepseek-ai/schemastery`，只把 Node 内置外置；`tsc` 只输出类型声明。构建期从 `DSH_PROFILE_DIR`（其次 `DSH_CHECKOUT`）解析要内联的 dsh 包，找不到时构建明确失败。

原因：`link:` 安装的工作区包按自身真实路径做模块解析，看不到 profile 的 `node_modules`；0.0.22 之所以能跑，是因为它被复制进 profile 目录。自包含后包可以放在任何位置安装。

### 3. 入口收敛

注册数从 8 降到 6：4 个入口（`conversation.session.header.actions` 头部入口、`sidebar.panellist` 侧栏行、`main` 工作台页、`conversation.view` 对话视图）+ `conversation.input.dock` 参考范围条（仅管家主题会话渲染）+ `sidebar.right.pane.tab` 右栏页签。

- 去掉重复的「对话来源」侧栏行与它的 `main` 页，来源入口合并进工作台与右栏。
- `main` 页不再"挂载即跳转"，直接渲染管家工作台页；打开对话改由用户点「和管家说话」触发，失败留在页面上说明原因。
- 会话头部 4 个按钮收敛为 1 个「管家」主按钮 + 1 个「⋯」菜单（工作台 / 整理与资料 / 新建主题 / 交给管家整理）。
- 右栏内部 4 个按钮改为真 tablist（roving tabindex、方向键/Home/End），并记住最近一次视图。

### 4. 视觉系统

新建 `src/client/ui/`：`tokens`（只用 `--dsw-alias-*` 颜色角色）、`styles`（单 `<style>` 注入、260 条 `butler-*` 规则）、`components`（Button/Section/Card/Pill/Toolbar/EmptyState/ErrorState/Skeleton/Field/...）、`tablist`、`drawer`、`menu`、`notice`。品牌墨青 `#2E6B66` 只用于图标、区块标题竖线与选中标记；按钮/输入/卡片一律宿主 token。密度参照宿主管理页：正文 13/20、次要 12/18、区块标题 14/22。

### 5. 对外插件接口（范围）

先覆盖两类：**能力包（packs）** 与 **通道（channels）**。形式为：版本化 manifest（`schemaVersion: 1`）+ 运行时注册/校验 Service + 文档 + 一个示例 bundle。会话来源（sources）与 UI 插槽（slots）后置，不在 0.1.0 对外承诺内。

## 后果

- 插件在插件页/`listBundles` 可见、可停用、可卸载、可升级；安装不再依赖部署目录位置；回滚路径明确。
- 构建需要已安装 profile 或 DSH checkout 提供 `schemastery`；`@deepseek-ai/dsh-agent` 的动态 import 仍是可选的运行时路径（解析不到时该模型选择安装步骤不可用），后续步骤再收敛。
- "管家"侧栏行的默认落点从"最近的管家对话"变成"管家工作台页"；对话入口由头部主按钮承担，这是有意的行为改变。
- 对外接口扩大了维护面：`schemaVersion` 与校验失败诊断成为兼容契约。

## 验证

- 安装后：Host `Config` 目录出现 `include:dsh-butler`（`packageDir` 指向 profile 的 link）；旧 `dsh-butler-0.0.22` 为 inactive；`GET /dsh-butler/api/overview` 返回 200。
- `node scripts/build.mjs --typecheck` 通过；`node --test tests/*.test.mjs` 995/995 通过；`client-layout-inject`、`client-workbench-actions`、`client-workspace-review` 的入口/右栏契约断言已同步。
- 未验证/待补：真实 GUI 的肉眼验收需要用户刷新页面确认；第 4–7 步完成后再补一次完整验收记录。
