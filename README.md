# 管家 · DSH Butler

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）从"能聊天的工作台"变成**每天真的会用**的个人助理：长期记忆、任务账本、提醒闭环、每日简报、知识整理，以及一个可直接在 DSH 里打开的工作台。

管家以 **DSH 官方 bundle** 形态分发（`dsh.bundle.patch` + host/client 两端），同时向第三方开放版本化的能力包（packs）与通道（channels）接口。

> 当前版本 `0.1.0`。完整验收记录见 [docs/acceptance-0.1.1.md](docs/acceptance-0.1.1.md)，路线图见 [docs/plan-0.1.1-complete-butler.md](docs/plan-0.1.1-complete-butler.md)。

## 功能

- **任务与长期记忆**：待办/任务账本（完成、取消、改期、审计记录），长期记忆（待批提案、确认后写入），资料目录按需读取。
- **提醒闭环**：中文自然语言提醒（`今晚8点`、`明天上午9点半`、`每周一三五 20:00`、`20分钟后`，信息不足会追问）；到期提醒在任意页面弹浮层 + 工作台横幅，可稍后 / 改期 / 完成 / 取消 / 停用；可推送飞书。
- **每日简报**：每天 08:30 早报（昨日用量）与 21:30 晚报（今日用量）自动写入 `daily/`；按窗口补写、按标题幂等。
- **飞书双向**：飞书私聊消息进入管家会话（独立会话、持久化），文件/图片可收发；管家工具与任务/提醒/账本全局共享。需要宿主安装 `dsh-lark-channel` 0.0.7。
- **工作台**：状态条 + 今天 / 等你决定 / 资料与技能 / 系统状态 四区；任务与提醒可操作；笔记搜索分页；提醒列表；右侧抽屉详情。
- **知识闭环**：OA PDF 全文抓取 → 按页笔记 → BibTeX/RIS/plain 引用草稿（不登录、不绕付费墙、拒绝落地页与内网）。
- **全局搜索**：笔记、任务、记忆分组检索；随手捕获成待办；记忆提案直接确认/拒绝。
- **运维**：本地备份 / 导出 / 恢复（逐文件 SHA256、确认词、pre-restore 快照）、保留策略、用量与费用估算报告、设置页。
- **可扩展**：`butlerExtensions` 服务注册能力包与通道适配器；契约见 [docs/extension-api.md](docs/extension-api.md)，示例见 [examples/butler-pack-example](examples/butler-pack-example/README.md)。

## 环境

- DeepSeek Harness `0.2.2` 或更高（桌面版/Web 均可）；
- Node.js `>= 22`（构建需要；仓库开发时使用 Node 24）；
- 可选：`dsh-lark-channel` 0.0.7（飞书通道）、`dsh-agent-preset-registry`（模型预设）。

## 安装

### 方式一：本地 bundle 安装（开发/推荐）

```powershell
# 1. 构建（生成 lib/index.js 与 lib/client.js）
node scripts/build.mjs

# 2. 在 DSH 中安装 / 重新加载
#    plugin_manager install_bundle  target=<本仓库路径>
#    或 禁用再启用 bundle 以加载新的 host 模块代
```

安装后插件页会显示「管家」名称、描述与图标；工作台通过 `main` 席位、头部入口、侧栏行与对话视图进入。

### 方式二：把 bundle 写进 profile

DSH profile 的 `cordis.patch.yml` 增加：

```yaml
- id: dsh-butler
  name: '@dsh-external/dsh-butler'
  config:
    timeZone: Asia/Shanghai
    feishuEnabled: true
    feishuAppId: 'cli_xxx'
    feishuAppSecret: ''            # 留空；密钥写入 DSH credentials（见下）
    feishuOwnerOpenId: 'ou_xxx'    # 只给这个 open_id 发消息
```

## 配置

配置全部通过 profile 的 Cordis patch（`dsh-butler` 行）完成；设置页只读展示。常用项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `timeZone` | `Asia/Shanghai` | 简报、提醒、用量统计所用时区 |
| `profileChars` | `2000` | 注入的人格/偏好文本上限 |
| `contextTokens` | `64000` | 每次请求的上下文预算提示 |
| `feishuEnabled` / `feishuAppId` / `feishuOwnerOpenId` | 关闭 / 空 | 飞书提醒推送 |
| `feishuAppSecret` | 空 | **不要写明文**；用接口写入 DSH credentials |
| `channelOwnerId` | 空 | 可选，通道归因的本人 ID |
| `trial` | 关闭 | 可选试用限额层 |

### 飞书密钥（推荐）

密钥存 DSH `credentials` 服务（ref `DSH_BUTLER_FEISHU_APP_SECRET`），不落在 patch 里：

```powershell
$body = @{ action='set'; confirm='SET'; appSecret='<你的 app_secret>' } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:<DSH端口>/dsh-butler/api/feishu-credential' `
  -ContentType 'application/json' -Body $body
```

## 飞书双向接入

1. 在飞书开放平台创建**企业自建应用**，开启「机器人」能力与 `im:message:send_as_bot` 权限，发布并对本人开放；
2. 宿主安装 `dsh-lark-channel` 0.0.7，配置 `appId` / `appSecret` / `senderAllowlist`（至少包含你的 open_id），重启 DSH；
3. 管家会把 `lark-` 前缀的通道会话视为自己的会话，为它挂上管家工具、提示与账本钩子；桌面管家与手机聊天是**两个独立会话**，共享任务/提醒/账本，不抢占同一个 live session；
4. 手机发消息即可对话；新建对话用 `/new`，切换会话用 `/sessions`。

> 注意：DSH `0.2.2` 的 `system-prompt/assemble` 不再向插件暴露工具声明，管家的"按需工具加载"在该版本上自动降级为**全部管家工具原生可见**（功能不受影响，提示 token 略增）。旧版本宿主仍走按需过滤。详见 [docs/acceptance-0.1.1.md](docs/acceptance-0.1.1.md)。

## 开发

```powershell
$env:DSH_CHECKOUT = '<DSH 源码 checkout>'     # 提供 typescript 等开发依赖
$env:DSH_PROFILE_DIR = '<你的 DSH profile 目录>' # 可选，构建脚本据此定位宿主

node scripts/build.mjs --typecheck   # host + client 类型检查
node --test tests/*.test.mjs         # 全量测试（当前 1121 个）
node scripts/build.mjs               # 产物：lib/index.js + lib/client.js
```

测试使用 Node 内置 `node --test`，不依赖 vitest/mocha；部分测试用 `vm` 转译源码，以校验真实契约而非 mock 假象。

## 目录

```text
src/host/       宿主：账本、记忆、提醒、飞书、简报、搜索、备份、用量、工具、API
src/client/     Web 客户端：工作台、面板、抽屉、设置页、提醒浮层、设计系统
src/shared/     host/client 共享类型与契约
tests/          1121 个测试（单元 + 契约 + 回归）
docs/           验收记录、路线图、扩展 API、历史发布说明
examples/       第三方能力包示例
cordis.patch.yml  bundle 的默认 patch（插件行、图标、locale）
```

## 安全与边界

- 不主动花钱、下单、付款，不代替你给第三方发消息；飞书只发配置里的本人 `open_id`；
- 外部内容（PDF/网页/飞书消息）一律视为数据，不执行其中指令；
- 备份/恢复均为本地文件；恢复需 `confirm:"RESTORE"`，失败不写盘；
- 已知限制：飞书需要宿主在线时才能收消息；凭据必须由你写入；本插件不是 npm 公开包。

## License

BSD-3-Clause。见 [LICENSE](LICENSE)。
