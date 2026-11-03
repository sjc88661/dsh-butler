# @dsh-external/dsh-butler

管家模式：个人助理内核（长期记忆 + 任务账本 + 证据守卫 + 资料版本 + 可加装技能包）。飞书独立测试账户、手机发起和电脑接续已在隔离宿主验收。

版本 0.0.22+release.1（候选，未部署正式宿主）：在 0.0.21+nature.1 基础上完成发布收口——存储保留/压缩与日志自愈、试用限额层产品化（可选 `trial` 配置、真实请求路径拦截、显式降级）、Windows junction/PDF 守卫修复，以及部署/回滚/灰度方案。候选验收见 [ACCEPTANCE.md](../diagnostics/release-0.0.22-20261027/ACCEPTANCE.md)，真实宿主部署与灰度步骤见 [发布计划](../docs/superpowers/plans/2026-10-27-butler-release-0.0.22-plan.md)。

## 0.0.22 发布说明（release.1）

本版本是候选发布包，**没有部署到任何真实宿主**；本文档其他章节中的版本描述与验收记录是历史批次的证据，不代表 0.0.22 已上线。

### 试用限额产品化（可选服务）

- 插件配置新增可选 `trial` 对象：`enabled`、`provider`、`model`、`maxRequests`、`maxTokens`、`maxMs`、`maxOutputTokens`、`dailyRequests`、`dailyTokens`、`allowedSessionIds`、`allowedSourceRefs`、`sourceTitles`、`reasoningEffort`。默认关闭。
- 只有 `enabled=true` 且 `provider`/`model`/`allowedSessionIds`（非空）完整时，才通过 `butlerDailyTrial` 服务发布真实限额并安装 4 个钩子：`agent/pre-step`（任务窗口）、`agent/request`（路由/输出上限）、`llm/stream`（下游调用前拦截：请求/tokens/时长/每日预算）、`tools/pre-execute`（来源门控）。
- 超限抛 `TrialDenied`（`TRIAL_RUN_REQUESTS`/`TRIAL_RUN_TOKENS`/`TRIAL_TIME_EXCEEDED`/`TRIAL_DAILY_REQUESTS`/`TRIAL_DAILY_TOKENS` 等），下游模型流不会被调用；拿到 provider `usage` 后结算，缺 usage 保留预留上界。
- 未启用/禁用/配置不完整时**不发布服务、不安装拦截**，工作台返回 `available:false` 与 `trial-not-configured`/`trial-disabled`/`trial-config-incomplete` 及原因，不显示任何假限额；计数文件损坏时故障关闭（拒绝重置并阻止模型请求）。
- 计数持久化在 `state/trial-budget.json`，按北京时间自然日切分，重启不清零、在途预留不退还。

### 存储保留/压缩（行为变化）

- 操作日志 `store-operations.jsonl` 超过阈值（默认 **8MB**，`DSH_BUTLER_JOURNAL_COMPACT_BYTES`）且无 pending 操作时，在同一把物理锁内原子压缩为 `phase:"checkpoint"` 记录（保留最近 **5000** 条已提交 identity，`DSH_BUTLER_JOURNAL_KEEP_COMMITTED`，更老的 operationId 失去幂等重放）。
- **首次启动会把现有 101,977,166 B 日志压缩到 MB 级**（102MB 实日志副本演练：**234,297 B / 851ms**），并强制保留 102MB 原件 `state/store-compactions/backup-<sha>.jsonl` 与 `compaction-<sha>.json` 审计（前/后字节、kept/dropped）。
- 末尾半行（掉电/崩溃）先保存完整字节证据到 `state/store-failures/`，再截断到最后完整行并写 `state/store-repairs/` 审计；中间行损坏仍 fail-closed、原始字节不动。
- execution-context 每次保存前裁剪（sessions ≤200、steps ≤120、calls ≤100、users ≤20，用户原文 ≤2000 字符，可用 `DSH_BUTLER_CONTEXT_MAX_*` 覆盖）；receipts 追加改为 append+fsync。
- **兼容性**：新 journal 含 checkpoint 记录，**0.0.21 及更早版本读不了**（会 fail-closed 保留字节）。回滚到旧版本前必须恢复升级前 state（安装备份或 `store-compactions/backup-*.jsonl`）；升级方向兼容旧文件。

### 已知边界（0.0.22 候选）

- 未部署真实宿主；真实启动后的插件加载、客户端 UI、journal 首启压缩与 7 天稳定性都**未验证**。
- PDF 解析/缓存只有本地能力边界测试；junction 真实路径守卫已修复（Windows `realpathSync.native`），但链接/Junction 场景只在本机验证。
- 无人民币硬限额：`deepseek-account/deepseek-flash` 等线路未定价时仍显示“未计价，费用未知”，不套用其他线路价表；硬限额是请求次数/tokens/时长/输出。
- 联网、飞书正式接入、手机入站、Python/R、PPTX、Codex 专属 MCP 等外部能力不随安装获得权限；Nature 技能包也不附带这些工具。
- 灰度只建议单主题/单会话，参数与观察窗口见 `docs/deployment-plan.md`。

## 隔离日常试用（trial.1）

19394 的「日常试用 · 学习与安排」可以通过原生输入框连续接收新的普通任务，不需要一次性验收口令。右侧“隔离日常试用范围与限额”展示当前开放状态、飞书实际连接状态、来源及剩余额度。其他旧主题保持可读，不自动恢复旧任务。

本轮正文仅允许此前批准的 DSH 科研结论（消息 118）和 Codex 管家 UI 方案（指定消息），加上用户在试用主题及绑定测试私聊中新提供的内容。界面搜索、原文读取、选取和模型工具共用此边界；整段会话选择收窄为指定消息，停止试用也不会恢复全局读取。

每任务最多 6 次请求、160000 tokens、3 分钟，输出不超过 1536 tokens；北京时间每日合计最多 20 次请求、480000 tokens，含缓存读取及辅助模型请求。请求发出前持久预留，缺 usage 或重启时未结算的请求保守占用额度。试用计数单列，旧任务预算不清零。提醒另有原生独立任务预算，仍受本轮每日上限约束。

仅允许指定来源、本地新笔记、整理草稿和用户明确请求的提醒；原生记忆、审批、程序执行、其他网络来源和文件外发未开放。飞书只绑定既有独立测试应用/私聊，禁止群聊、附件及机器人自发输入。提醒继续使用现有组合模块及未知投递保护，平台收到与用户已读分开记录。

用量按 provider/model 显示真实输入、输出、缓存、计价覆盖与原始估价依据。`deepseek-account/deepseek-flash` 未获得可适用的账户价格，继续显示“未计价，费用未知”，不能套用 `deepseek-official` 表，也不承诺人民币金额硬限额。当前硬限额是请求次数、tokens、时长和输出。

实现与证据见[试用实施计划](../docs/superpowers/plans/2026-10-22-butler-daily-trial-plan.md)及[隔离试用报告](../diagnostics/daily-trial-20261022/completion.md)。试用组合层位于 diagnostics/daily-trial-20261022，不会被普通插件安装自动启用。

## 日常整理与待办接续（UI.2）

来源页单独列出本次参考的精确消息与整段对话，支持逐项查看、移除；来源列表识别已选的指定消息，移除对话不会扩大为整段读取。搜索条件和分页在页签往返中按主题保留，最多缓存 32 个主题的界面条件，不缓存原文正文。

“准备整理指令”重新核对当前参考范围，只生成未发送草稿；由用户核对、加入原生输入框并发送。已有未发送指令会保留，普通对话的“交给管家整理”也不会覆盖它。索引、浏览和准备指令不触发模型请求。

整理结果中的正式待办显示账本最新状态，可直接打开对应任务；任务丢失、归属不符或读取失败时保持未知。笔记仍是生成时快照，不为更新待办状态改写历史文件。切换主题或关闭页面会废弃旧界面请求，元数据刷新保持当前页面，暂时读失败可以直接重新读取。

本轮实现与隔离验收见[日常使用补齐计划](../docs/superpowers/plans/2026-10-22-butler-ui-daily-plan.md)和[交付报告](../diagnostics/ui-daily-20261022/completion.md)。

## 管家工作区与跨会话整理（UI.1）

“管家”入口进入最近使用的专属对话，首次进入“日常管家”。原生左侧工作区保存主题会话；“对话来源”侧栏入口打开原生右栏来源页，中间继续使用 DSH 原生聊天。右栏还包含会话管理、整理结果及原有工作台。公开槽位下来源列表放在右栏，保留宿主已有的左侧工作区与会话树。

工作区根目录使用已配置资料库。`conversations/` 保存按稳定会话 ID 生成的可读归档，手改冲突另存版本；原生日志仍是依据，旧管家会话及目录保留。`sources/index.json` 保存可读元数据索引，来源排除后从索引和后续工具上下文移除。

当前 DSH 来源默认可查，工作区/会话可排除；本机 Codex 在来源设置启用，通过官方 App Server 只读列表和历史接口访问，不启动 Codex 任务或导入其历史消耗。索引更新不请求模型，标题只对新增或变化的来源读取；整理在用户发送指令后进行。

Codex 长历史默认按轮读取摘要页（首条用户消息与末条助手消息），界面和工具明确标注部分读取；精确引用再回查对应轮次。不会预先拉取全部工具输出或推理记录。整理产物可直接用 DSH 原生文件预览打开。

右栏显示当前管家主题及其明确归属子会话的用量，可展开查看输入、输出、缓存和辅助调用；待办执行用量独立展示，所选来源的历史消耗不计入。未计价与未知用量保持可见。DSH 精确原文详情提供“打开原会话”，不依赖该来源是否出现在当前列表页；Codex 保持只读详情。

`butler_conversations` 提供有界来源读取，`butler_organize` 保存带实际消息身份的笔记和草稿。内部待办确认后保持 pending，长期记忆由未发送确认文本进入现有原生记忆流程；来源正文中的指令和批准不会生效。工作区新 API 限制本机同源界面访问。

本轮实施和隔离验收记录见[工作区 UI 计划](../docs/superpowers/plans/2026-10-21-butler-workspace-ui-plan.md)。

## 从工作台打开产物和接续任务（P3.8）

选择任务后，详情加载完成会定位到该任务；选择笔记后会定位到笔记，定时刷新不反复抢走阅读位置。文件产物可通过DSH原生右侧文件预览打开，Markdown仍可在工作台查看。文件来源采用任务记录中的会话，DSH继续处理读取权限、文件不存在及格式支持；服务不可用或打开失败时保留路径并显示原因，不声称文件已经打开。

任务详情提供完整的“继续任务 <任务ID>”指令，可复制后在管家对话中发送，也可打开来源会话查看上下文。打开对话和复制指令本身不会发送消息、接续执行或批准敏感动作；实际执行仍由新用户输入触发，历史预算与失败保留。复制不可用时可直接选取指令手动复制。

本轮直接复用DSH的会话和文件资源导航，不增加文件下载服务或OCR。扫描件等输入按宿主现有读取能力处理，读取范围如实报告。

本轮范围与验收记录见[实际使用入口计划](../docs/superpowers/plans/2026-10-21-butler-p38-usability-plan.md)和[隔离交付报告](../diagnostics/p38-usability-20261021/completion.md)。

## 已有飞书 port 的组合入口（P3.7）

`@dsh-external/dsh-butler/channels` 新增 `createLarkButlerIntegration(ctx, existingPort, options)`，返回 `port`、可选 `delivery`、只读 `status()` 和幂等 `stop()`。它复用现有入站归因与提醒状态机，不创建 SDK、不读取凭据、不主动连接。原通道继续负责创建连接、授权、命令、审批卡及 `installBridge`。普通安装和未明确 `enabled:true` 时不增加归因 hooks、连接监听或外发能力。

启用时必须显式提供 `accountId`、`ownerId`、与主管家配置一致的 `channelOwnerId` 和个人私聊 `bindings`。`authorize(identity,user)` 是宿主对具体原生用户决定的目标解析函数；没有此函数便不发布提醒外发服务。目标只可来自匹配的明确绑定，不自动选择首个账户或聊天。

主管家的业务流程把严格绑定的原生 `user` 作为 `destinationFor(identity,user)` 的第二个可选参数传入，包含真实原生消息、会话及 RPC 或平台来源。工厂先核对这些证明，再调用 `authorize`；模型填写的 `originalText`、owner 或聊天参数不能代替真实用户决定。原有单参数服务继续兼容。

宿主最小接线如下；`resolveApprovedReminderDestination`、`readActualMessage` 来自宿主已有的原生决定与平台只读接口，不是模型工具参数：

```js
import { Service } from '@deepseek-ai/cordis'
import { createLarkButlerIntegration } from '@dsh-external/dsh-butler/channels'

const integration = createLarkButlerIntegration(ctx, existingPort, {
  enabled: hostConfig.enableButlerLark === true,
  accountId: hostConfig.accountId,
  ownerId: hostConfig.ownerId,
  channelOwnerId: butlerConfig.channelOwnerId,
  bindings: hostConfig.verifiedPersonalBindings,
  authorize: resolveApprovedReminderDestination,
  readMessage: readActualMessage,
})
const implementation = integration.delivery
if (implementation) {
  class Delivery extends Service {
    constructor() { super(ctx, 'butlerReminderDelivery') }
    destinationFor(...args) { return implementation.destinationFor(...args) }
    send(...args) { return implementation.send(...args) }
    isReady(...args) { return implementation.isReady(...args) }
    onReady(...args) { return implementation.onReady(...args) }
    reconcile(...args) { return implementation.reconcile(...args) }
  }
  new Delivery()
}
// 使用原通道已有的函数和参数；工厂不导入通道的内部模块。
installBridge(ctx, larkConfig, integration.port, notify, authorization)
ctx.effect(() => () => integration.stop(), 'butler lark composition')
```

`readActualMessage(messageId)` 仅按先前真实 SDK 回执读取，返回 `{messageId,chatId,type:'text',text}`，其中 `text` 必须是完整原文。模块按发生项 `(scheduleId,occurrenceMessageId)` 保存真实回执、固定目标及摘要到 `lark-reminder-receipts.json`，不存正文或凭据；重载后仍可核对。查无真实 ID、正文或目标不匹配、分片无法完整核实均保持未知，不重发。当前组合只支持明确绑定个人私聊的纯文本；线程目标拒绝。

初次连接成功和原通道 `reconnected` 都通知待发恢复，每次发送仍检查实际连接状态。`stop()` 释放本模块订阅、归因和 ready listeners，阻止旧服务发送，原连接的断开仍由原通道负责。工作台分别显示已接收、回调返回、已关联原生输入与未关联数；未关联可能是命令，不能直接视为失败，归因已配置也不等于平台在线。

## 科研引用文件（P3.7）

`butler_literature {action:'export',format:'ris'|'bibtex',slug:'my-references',records:[...]}` 在本地资料库生成引用文件，返回真实路径、SHA256、格式、记录数及限制。无需 web 服务，不重复检索或调用模型。相同名称和内容可幂等返回；同名不同内容拒绝覆盖，手改原件保留。只接受安全文件名，字段按格式转义并有数量和字节上限。

导出使用传入题录的标题、作者、年份、来源与标识，缺失字段留缺；输入核验标记只是输入资料，不会被导出升级为本次官方核验或全文阅读证明。文件本身可由现有原生最终工具结果登记为实际产物，完成“导出引用文件”等任务；不能据此宣称已读或验证论文内容。

0.0.16+p3.7已在绑定测试账户完成新工厂真实接线、手机发起、电脑同任务接续、原生RIS/BibTeX导出及一次实时提醒送达，见[真实组合验收](../diagnostics/p37-live-20261021/completion.md)。两份文件及文件证据、SHA256、平台完整正文/目标和回执均核对；导出由验收流程驱动，提醒新增一次真实模型，未核实用户已读。工作台产物重复计数已修复，25项相关API回归通过；旧数据、预算和失败保留，未上线。

## 辅助用量与科研核验（P3.6）

助手回复继续使用原生 `assistant/message` 与会话历史回填；原生 `llm/stream` 的 `session-title` 和 `compaction` 调用另以独立调用标识落入同一追加账本。每次流只保留提供方最后一次 usage 快照，不把多个累计快照相加；失败、取消和缺少 usage 仍保留。命名只归属其明确的会话，不套用该会话后来打开的业务任务；压缩仅在原生执行者与请求会话一致时采用当次执行快照。

工作台展示两类调用与各用途的 tokens、缺用量、未计价及失败/取消数。金额仍是有来源的估算，部分计价会标出覆盖调用数；账户模型没有适用价表时显示未计价。预算预留不是实际消耗，也不是人民币账单。其他或未标记的辅助用途尚不保证覆盖，升级前没有保存 usage 的命名历史不能仅从命名请求日志推算恢复。

文献核验读取官方题录的标识与标题；arXiv HTML 不再按 JSON 解析。`10.48550/arXiv.*` 需要官方题录上的匹配 DOI 链接，不把 Crossref 查不到当成论文不存在。多标识冲突保持冲突，HTTP 失败或缺少可核对元数据保持未确认；核验题录不代表读过全文。复核结果另存，旧未确认回执与原排除项保留。隔离范围及验证见[本批记录](../diagnostics/p3-aux-usage-20261021/completion.md)。

## 学习、科研和生活能力包（P3.5）

学习包从目标、水平和时间约束进入讲解、练习、实际作答检查、错题与复习；没有作答就不声称已掌握。科研包从问题和纳排条件进入现有文献检索、核验、去重、材料提取与对照，保留摘要/全文层级、来源和局限。生活包从需求、金额及时间约束进入官方来源比较、总费用与条件整理，再由用户选择；实际下单、支付、预约等必须以真实动作和回执报告结果。

这些包通过现有原生工具完成任务和笔记，不会独立运行。工作台可展开查看做法、交付物、证据和边界；也可调用 `butler_pack {action:"show",id:"study"}`，将 id 换成 `research` 或 `life`。用户原有同 id 的 Markdown 仍优先，启停选择不改变；新默认做法不会覆盖自建包。

包内 `tools` 是推荐工具，`permissions` 是做事规范，`max_attempts` 是尝试建议。它们不授予权限，不建立硬白名单，也不创建独立硬预算。实际动作受宿主已启用的原生权限及精确审批守卫约束，硬预算及停止状态以运行控制报告为准。

`cost_class` 只记录包声明的外部服务或本地资源类别。`free` 不代表模型免费、总费用为零或消费限额；模型、外部服务和本地资源可能分别产生费用。实际 usage、未报告用量和未计价状态继续使用原账本口径。本批没有增加人民币硬限额。

本批范围、必要验证和数据保留见[隔离验收记录](../diagnostics/p3-packs-20261021/completion.md)。

三个能力包的真实模型接续验收见[真实模型验收记录](../diagnostics/p3-packs-model-20261021/completion.md)。该批旧版账本仅覆盖原生助手回复，三次命名的真实用量在当时审计中单列；本版开始自动记录已识别的辅助流，不伪造旧账或按零费用处理。

## 飞书通道与跨端归因（P3.1）

隔离 profile 已组合 `dsh-lark-channel` 0.0.7 并通过官方扫码建立独立测试应用，注册账户与实际私聊来源已匹配。手机消息、电脑明确任务 ID 接续及真实消息本地重放去重已经验收；原生工具验收与真实模型自主任务分别记录。正式 profile 未安装该组合。

宿主组合层可从 `@dsh-external/dsh-butler/channels` 导入 `adaptLarkChannelPort(ctx, existingPort, { accountId, bindings })`，把返回的 `port` 交给现有通道的 `installBridge`，并在卸载时调用 `stop()`。`existingPort` 仍由原通道提供；该入站适配器不创建连接、不读取凭据、不增加外发方法或批准权限。0.0.16 起可使用前述组合工厂一并装配提醒投递；仍由宿主显式提供 port、绑定和原生决定策略，普通安装不自动绑定或启用外发。

`bindings` 逐项明确 `{ accountId, senderId, chatId, ownerId }`，只接受已绑定个人私聊，机器人、群聊、缺失或冲突身份拒绝。管家配置 `channelOwnerId` 必须与这位个人的 `ownerId` 一致；默认空值不把本机用户与任何飞书人自动关联。桌面用户来源由宿主 session-controller 的原生 `source.kind=user` 与 `rpcId` 识别；不会占用 rpcId 填入飞书消息 ID，也不从显示名或文本解析身份。

去重键为平台、账户和平台消息 ID，跨聊天/线程的身份或内容冲突会拒绝。调用原通道回调前先写入本地接收意图，原生入队时保存准确的 session/message 别名，进入模型前再核对。并发与重启重放不会再次入队；进程中断、异常或未知接收结果保留 pending/uncertain，不自动重试。`accepted` 只表示通道回调已返回：命令或问答可能不创建新输入，它不证明模型完成或外部送达。

新任务保存个人、平台消息、发送者和聊天来源；后续调用仍分别记录实际会话、原生消息、预算 run 与业务 task ID。跨端继续已有任务必须由同一已绑定个人明确输入 `继续任务 <完整任务ID>` 或 `接续任务 <完整任务ID>`，再执行已有 `butler_task activate`；“继续刚才那个”不能据此猜测归属。旧无来源任务只能由可信本地输入明确绑定，不能由飞书消息认领。新的人类输入沿用原预算规则创建新 run；历史 run、停止原因、失败与预留保留，同一飞书消息重放不会重置预算。

身份与去重记录保存在独立 `channel-ingress.json`，使用现有事务与冲突保护；只保存身份、内容摘要和状态，不复制完整消息或密钥。查询不恢复待处理事务。工作台只读 API 的 `runtimeControls.channels` 给出计数与可用性，具体任务、回执及用量携带各自来源，历史用量回填不能覆盖实时来源。

普通安装不会自动绑定账户或启用外发。每个新宿主仍须分别核验完整飞书链路。2026-10-21 已在独立测试应用完成受控断连恢复、未知回执只读核对及本人跨端一次性批准，见[隔离验收记录](../diagnostics/p3-recovery-20261021/completion.md)；正式宿主未上线。

## 提醒最终回复投递（P3.2）

宿主可选发布 `butlerReminderDelivery` 服务，类型从 `@dsh-external/dsh-butler/reminder-delivery` 导入。创建时由 `destinationFor(identity)` 核验真实用户决定并返回已绑定目标；目标快照同时保存在提醒操作和任务中。没有服务或可信目标时沿用内部提醒，不自动选择聊天。

独立提醒会话必须对应唯一已提交规则、同一 owner 和原生 history 中的精确 occurrence message ID。只有该轮 `completed` 的最终助手正文可交给 `send(destination,text,identity)`；中间工具说明、失败、截断和其他用户输入不能外发。宿主自动注入的 runtime-context 快照不改变真实提醒归属。

宿主可选提供同步 `isReady(destination,identity)` 和可释放的 `onReady(listener)`。发送前明确离线或服务暂不可用时，`reminder-outbound.json` 以 waiting 保存完整正文及 SHA-256；连接恢复后重新核验原生 occurrence、业务任务、owner 与固定目标，再持久认领为 pending，才允许调用一次 send。正文摘要或任一绑定变化都会停止外发。原生通道已有连接重连与退避机制，本插件只订阅就绪通知。旧服务不提供新钩子时保持原投递行为。

send 已调用后的任何异常保留 uncertain；进程中断留下的 pending 也永不重发。宿主可选提供只读 `reconcile(destination,identity)`，返回实际平台消息的 `{ destination, textSha256, receipt }`：仅完整目标与正文摘要完全匹配、且有真实 messageId 时补记 delivered。查无、错误或不匹配保持未知。原 reason 与追加审计一并保留，不能靠异常自述“未发送”来重试，也不承诺平台端严格 exactly-once。

启动、Cordis `internal/service` 变化或 `onReady` 通知触发恢复；宿主也可显式调用 `ReminderOperations.recoverOutbound()`。服务生命周期按 Cordis 原始实现身份判定，反复读取的代理不会重订阅；恢复中到达的就绪通知合并补扫，不使用连接轮询。停止或服务切换会释放旧订阅，热重载时未结束的 send 不参与并发核对。status 与 HTTP 工作台只读快照不检查连接、不查平台、不恢复 WAL、不发送消息。只读投影显式排除目标、等待正文和原始异常，提供安全审计代码、时间及宿主记录索引用于追溯。

`when` 支持明确数字的秒、分钟、小时后；宿主按该原生调用身份冻结第一次确定的 ISO 时间，同调用重放复用，改变时长拒绝。未解析时间仍需澄清，非法时间在写入或调度前拒绝；保存失败保留真实原因，不激活预生成但不存在的任务。

专属会话创建、恢复时复用原生 preset 和模型选择，并保留保存的选择投影；现存会话没有实际挂载 preset 时不报告就绪。宿主需提供当前版本 `@deepseek-ai/dsh-agent` 的 `installModelSelection` 导出，隔离组合入口显式绑定当前官方内置模块。按需加载的管家工具若已从本轮参数列表卸载，旧历史调用会提示先 load，再以新参数定义执行。

2026-10-21 隔离验收：真实模型自主统计、笔记与有据完成已通过，见[前批记录](../diagnostics/p3-real-20261021/completion.md)。本批新建一次性提醒经原生调度、真实模型最终回复和实时外发，飞书平台成功回执及消息读回一致；不是旧记录补投。首轮未外发记录仍保留。新发生项仅调用模型一次，外部发送一次，用户已读未核验，见[实时送达证据](../diagnostics/p3-live-delivery-20261021/live-verification.json)。

工作台将“已入提醒会话”“已记录助手完成”“飞书平台已收到”分开呈现，并显示保存的真实平台回执及回执保存时间。waiting 明确显示尚未调用发送；pending/uncertain 不宣称成功、不自动重发；核对结果和原失败索引持续可追溯。任务工具与工作台共享实际 usage 口径，已关联执行/预算请求单列；未报告、未关联及未计价值保持未知。旧数据、预算及失败记录保留，正式环境未上线。

## 数据保护与任务归因

任务、审批和记忆在写入前校验原始数据。损坏时保留字节并报告 degraded，不会清空重建；首次变更保存迁移备份与 SHA-256 清单。本地操作日志支持中断恢复和 operationId 幂等，恢复只修改配置 vault/state 内的文件，遇到人工编辑冲突或备份损坏会停止。提交和恢复按日志真实路径共用互斥，覆盖模块重复加载及多个进程；占用返回 STORAGE_BUSY，不等待或重试，也不标记为日志损坏。只有确认原进程已退出才回收其唯一所有者标记；未知所有者保留现场。

操作日志逐行解析；已提交操作只保留身份和幂等返回结果，未提交操作保留恢复所需的写入快照。最近一个日志的校验索引通过完整文件 SHA-256 验证后复用，重复读取以固定大小的缓冲区计算哈希，不依赖文件时间戳，也不同时保留整份历史正文和所有已提交快照。0.0.22 起日志超过阈值（默认 8MB）且无 pending 时在同一把锁内压缩为 checkpoint（保留最近 5000 条已提交身份，更老的 operationId 失去幂等重放），首次压缩强制保留原件备份与审计；**旧版本 0.0.21 及更早无法读取含 checkpoint 的新日志**，回滚旧版本前必须恢复升级前 state。末尾半行（torn-tail）先保存完整字节证据再截断到最后完整行并写审计，中间行损坏仍 fail-closed；语义错误仍保存当次读取的完整字节证据。

业务任务 ID、预算执行 run ID、会话和原生调用位置分开记录。`butler_task open` 关联新任务，`activate` 显式选择已有任务；新的人类任务清空旧选择。子代理保留所属执行，旧子代理不能进入父会话的新预算。回执使用原生最终 `tools/result`，保存必要摘要和产物引用，避免把被后续权限拦截的调用记为成功。

账本不可用时 overview 返回 ledgerError，面板明确显示不可用；预算与提醒守卫仍保持安装。已结束任务只能在新的用户工作输入下重新打开，插件不会因恢复而自动重放外部操作。

## 真实完成、记忆和提醒

`butler_task update status=done` 只接受宿主登记的 `evidenceIds`，会复验任务归属、最终工具结果、文件 SHA-256 和实际锚点。原生工具产物可通过 `butler_task action=evidence` 查询。模型填写的 URL、哈希或 `verified_by` 不能自行签发证据；历史证据保留为 legacy-unverified。校验保证来源和执行关联，不自动证明所有结论正确。

PDF 按真实页树读取物理页，支持 `pages=[4,5]` 读取后续页。默认前三页仅为部分内容；`fullText=true` 也只有在原件可解析且完整页文本确实返回时才算全文，返回内容上限 60,000 字符。扫描页、加密、对象流和复杂字体会明确报告限制，不生成虚构页码或全文声明。

解析文本缓存保存在 state/cache/pdf-text，按原件 SHA-256、固定解析器版本和物理页集合区分，最多 32 项/64 MiB。缓存摘要和本地完整性校验失败会重新解析；密钥丢失也不会阻止读原件。缓存不是完成证据的可信根，EvidenceStore 仍独立读取原件并核验实际内容；不提供 OCR 或同用户权限攻击防护。

记忆确认由真实用户原话或原生 `ask_user_question` 最终答案证明，`source=user`、`approved=true` 不能批准。待批结果包含原生问题；确认后将 memo、pending、profile 一次提交，拒绝会结清原提议。宿主要求批准的业务动作绑定工具、参数摘要、完整调用位置与有效期，并由原生 `tools.guard` 核验一次性许可；记忆决定不会变成外部操作权限。

提醒创建按完整原生调用身份持久化。重放返回同一规则和任务；创建结果不明时标 uncertain 并停止重试，不能保证跨调度服务的严格 exactly-once。取消和真实 history 与业务任务联动；独立目标的归属必须由保存的绑定证明。scheduled 只代表调度已接受，delivered 只代表真实投递事件或宿主历史，均不等于助手已处理完成。

## 资料与长期记忆维护

`butler_note` 的 write、append 和 restore 均保存完整版本、来源与 SHA-256。`history` 查询版本，`read revision=N` 读取旧正文，`restore revision=N` 将旧正文恢复为一个新版本，保留中间历史。旧笔记首次进入维护前也会保留原始字节。手改或过期 expectedSha256 导致冲突时，保存当前稿、拟写稿及差异，禁止静默覆盖。重新读取并明确提供当前 SHA 后，先将手改全文保存为独立版本，再生成新版；这不是外部动作批准。事务准备后再发生手改会使核心存储进入 degraded，等待核对双方文件。

文献去重使用 DOI、arXiv、PMID 等强身份；不同强 ID 保留为不同记录，相同身份合并来源。无强 ID 时才使用规范化标题辅助判断，首作者和年份不能单独作为删除条件；冲突的标识和元数据保留供核对。

profile 保留少量稳定偏好和重要边界，受管稳定偏好最多 12 项；项目背景和较长资料按主题写入 memory 文件与索引。本地文件仍可编辑，下一回合按当前问题选择少量相关主题并遵守 UTF-8 字节上限，不默认注入完整资料库。未完成事项先按过期、24 小时内到期、等待用户、最近活动排序，再应用数量与字节上限。

`butler_remember` 提供 read、search、correct、withdraw。更正保留旧值、来源与替代关系；撤回后停止检索原条目，审计记录仍保留。明确用户原话 `更正 <id>：<新内容>` / `撤回 <id>` 或绑定的原生问题最终答案才能生效。语言、回复长度、发送和花费边界按已知偏好槽防止相反值同时确认；其他事实使用明确 key 或 correct，不承诺任意自然语言的语义矛盾识别。模型提案不能遮掉本地手写边界。

## 工作台

工作台显示运行保护、存储问题、待核对提醒操作、实际预算限额、剩余额度和停止原因。预算计数包括请求预留与无 usage 时的保守记账，提供方已报告用量单独展示；未计价和未知不会显示成零费用。

点击待办或任务记录可查看对应回执、产物路径、登记证据、各次已记录运行的预算与用量，以及提醒操作和原生投递历史。任务详情按业务 task ID 精确关联；同一会话的其他任务不会因时间相近被归入。首屏任务 50 项、各类详情最多 100 项；点击“浏览完整历史”可按页浏览全部保存记录，包括全局工具回执和未归属的旧回执。历史在翻页期间发生变化会明确提示刷新；工作台轮询不会重置正在浏览的页。

“运行保护与预算”保留当前运行的实际限额和剩余；完整历史另列所有保存的运行计数、预留、连续失败和停止原因。旧运行没有记录的当时限额、剩余额度和结束时间保持未知，历史预留不表示该运行仍在执行。读取历史不会恢复事务、重置预算或自动重试失败。

“本地提醒操作”展示每次已保存操作的请求时间、计划触发时间、当前快照、真实创建/取消回执与最近投递；待核对、取消未成功和本地拒绝分别显示。这些是已保存的最终快照，不补造未记录的状态迁移或接受时间。原生历史不可用时仍展示可读的本地记录；原生接口最多返回最近 20 条，不提供完整远端分页。调度接受、原生投递、助手完成和外部渠道送达独立判断，未核实项保持未知。

详情中的文件哈希表示登记时快照，打开面板不会重新批准、执行、重试或验证全部文件。原生历史查询使用已保存的 scheduleId 和目标会话，历史不可用就报告未知；“已投递”与“助手已完成”分别显示。界面保留只读，修改和决定继续经同一对话业务服务。

## 用量口径

实时与回填按会话内原生事件序号去重，无 usage 也保存 unknown 调用，后来取得的 usage 补到同一调用。管家、提醒和所属子代理可分别归因；未知调用不套用其他会话的模型路由。

启动回填分片让出事件循环，并复用一次读取的用量索引；单个大解压帧和冷索引仍同步处理，不保证严格的最大暂停时间。

旧记录仅在位置与时间可靠匹配时迁移，保留原任务归属和历史估价；无法对应的旧记录保留并报告可能重叠。未知 provider/model 不计价。费用使用仓库保存的价目版本，未在本轮联网更新；它是估价，预算预留、未知用量和提供方账单分别报告。

## 构建与注入

```powershell
$env:DSH_CHECKOUT = 'C:\Users\申俊超\dsh-harness'
node scripts/build.mjs --check     # 只检查版本和依赖，不修改它们
node --test tests/*.test.mjs      # 本地回归测试，不调用模型
node scripts/build.mjs           # 检查、编译、界面打包、离线 npm pack
```

`toolchain.lock.json` 固定 Node 24.15.0、TypeScript 6.0.3、tsdown 0.22.2。
编译器和打包器从已准备好的 DSH_CHECKOUT 解析；缺失或版本不符就停止并给出原因。
构建不安装依赖、不删除或重建 junction。`scripts/build.sh` 仅保留旧注入器的启动兼容层。
构建同时生成 host/client 类型声明并检查干净目录的公开导出目标；类型面向已配置 DSH 类型别名的宿主开发环境，不是脱离宿主的通用 npm SDK。

## 默认运行预算

| 项目 | 普通任务 | 提醒任务 |
|---|---:|---:|
| 模型请求上限 | 50 | 5 |
| 累计 token 上限（含缓存） | 2,000,000 | 64,000 |
| 时长上限 | 15 分钟 | 1 分钟 |
| 单次输出上限 | 8,192 | 1,024 |

预算在模型请求前进行准入检查，保守预留文本 UTF-8 字节数及有上限的输出，随后用提供方 usage 对账。
没有 usage 的失败请求保留其预留消耗；工具参数变化不重置失败计数，连续失败三次停止任务。
提供方报告的实际 token 若超出预留会立即阻止后续请求，已有请求不能撤销。
新的人类消息开始新任务；自动继续、子代理、重试、摘要及插件重载共享原任务预算。

普通任务可通过插件配置 `taskMaxRequests`、`taskMaxTokens`、`taskMaxMinutes` 调整。
预算状态与停止原因保存在 `~/.dsh/butler/task-budgets.json`，当前运行通过 overview 接口的 `runtimeControls` 展示，保存的历史通过只读 `GET /dsh-butler/api/history` 分页读取。历史查询不修改文件格式或当前运行指针。
不要删除该文件来恢复自动执行；损坏记录会拒绝自动重置。

每条提醒绑定新的 `session-butler-reminder-*` 会话，不复制开发历史。旧开发会话中的提醒投递也会在进入模型前转发。
提醒只允许 read/grep/glob、网页查询及文献查询；工具清单与执行入口都实施限制。取消时通过调度目录查找实际所属会话。
有副作用的工具和长任务应交给用户发起的普通任务。投递结果不明时不自动重放。

## 上下文

原生工具模式默认只发送基础工具（read/write/edit/glob/grep、平台 shell、ask_user_question、skill、butler_overview）与 `butler_tools`，不再每次全量发送所有 MCP 和开发工具的参数。
缺少能力时调用 `butler_tools(action="search", query="关键词")`，结果最多 8 条短摘要；用 `action="load", names=["精确名称"]` 后，下一次请求才带这些工具的完整原生参数。
每次最多加载 4 个，同时最多保留 8 个额外工具、24,000 字节额外定义；`action="unload"` 释放选择。
搜索和加载不会执行目标工具，也不会批准操作；原生权限、预算及工具执行路径继续生效。
发现工具注册失败、被当前作用域隐藏或同名覆盖时，提示明确降级并保留受限核心工具；不会继续指示调用不存在的发现入口。

工具选择按会话保存到 `~/.dsh/butler/tool-loads.json`，只存名称和任务来源 ID。新的人类输入或新提醒触发时，在提示组装前清空；同一任务继续与重载保留，其他会话和子代理不继承。
提醒初始仅列出 `butler_tools`，只允许发现和加载原有只读工具。选择存储损坏时退回基础目录并报告错误，不退回全量注入。
PTC 会话保留原生 `run_code` 传输；此次缩减针对原生工具模式。旧会话历史保留 DSH 的工具头更新与调用配对，已有历史不会因卸载选择而自动消失。
overview 的 `runtimeControls.toolLoading` 提供各会话可见数量、定义字节数及存储错误；字节数不等于提供方实际 token 消耗。

技能摘要也按需发现：基础工具新增 `butler_skills(query="主题或精确名称", limit=6)`，最多8条、每条160字符，不读取正文。查到后仍用原生 `skill(name="精确名称")` 取得完整指令与资源基址；已知名称可直接加载，用户显式 `/技能名` 的原生注入也保留。
新发布的全量技能摘要文本替换为短提示，原生目录 `source.entries` 校验元数据保持完整，保证连续步骤、目录更新、插件重载及压缩恢复沿用原生digest而不反复重发。DeepSeek仅序列化用户消息的role/content，这些宿主元数据不会发给模型。
搜索候选来自该会话的原生最终目录，并与当前cwd/作用域和modelInvocable策略复核；隐藏或同名shadow的加载器不会被搜索绕过。提醒保持现有工具执行白名单，不开放技能加载或技能搜索。`runtimeControls.skillLoading` 显示目录原始/可见字节及状态。原有长历史仍由原生压缩处理，不手动删除技能或工具消息。

Nature 科研技能包提供9项工作流的简短路由：文献检索、引用核验、数据可用性、科研绘图、论文转PPT、学术润色、双语精读、审稿回复和论文写作。通过 `butler_skills` 发现，再由原生 `skill` 读取单项正文，所需 manifest、片段和 `nature-shared` 依赖按需读取。此包仅在相关请求中展开；日常包和既有用户自建包仍沿用常驻兼容规则。已加载正文可能留在会话历史，不能承诺每轮自动卸载。

隔离部署使用原生 `@deepseek-ai/dsh-skill-filesystem` 的独立 `butler-nature` 提供方，挂载本机技能的带哈希副本；不修改原技能、旧会话或预算。资源读取仅开放到已加载技能及共享依赖的已登记只读文本。安装技能不代表已经具备其外部工具：DSH 未提供或当前未授权的联网、Python/R、PPTX、Codex 专属 MCP、外发与投稿等步骤必须标明未执行。技能发现不调用模型，加载后的上下文及生成沿用原任务预算；未知价格保持未计价。

通过 `agentPresets.serviceFor` 找到真实的隔离 preset 压缩实例，设置 64,000 token 压力阈值、最多 12,000 token 尾部及普通任务 8,192 token 摘要输出；提醒仍限制为 1,024 token。压缩失败会持久停止当前任务，禁止后续步骤反复压缩；新的人类输入可开启下一任务。任务请求数、累计 token 与时长硬预算保持不变。
摘要上限由普通会话和提醒共享，避免同一 preset 实例在并发任务之间反复切换配置。
这些是估计值和触发阈值，不能承诺每个提供方请求恰好小于 64k。保留运行时原有的工具调用配对和持久摘要机制。
插件自身能力包指令、档案和工作状态也有字符上限；提醒不注入其他工作的待办或开发指导。

加载后可用 `GET /dsh-butler/api/overview` 检查 `runtimeControls.version`、注册 hooks 和累计预算。
启动与读取面板不会主动发起模型调用。

## 验证记录

0.0.7 已完成真实宿主部署、原生工具与权限拒绝路径、模型修改与本地运行、原生提醒创建/取消/送达和隔离观察，19 项门槛通过。首轮验收器误拒导致的预算停止记录完整保留；剩余路径用新会话有界补验，没有清空失败预算。详见[真实宿主验收报告](../diagnostics/host-007-20261015-45f23c80/acceptance-report.md)。人类点击批准的正向交互仅有隔离回归，未虚报真实点击；安装模型未被锁定价目表覆盖，金额未计价。

P2 的 `tests/workflow.test.mjs` 使用合成宿主载体，业务服务、原生最终结果钩子、存储、工具与 HTTP 读取实现均为正式代码；覆盖记忆确认与重载、版本与证据完成、提醒重放与取消/投递、丢响应及失败停止后的状态。笔记掉电与事务冲突另有子进程故障测试。此验证不代表 0.0.8 已部署到真实宿主。
