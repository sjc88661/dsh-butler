# 完整管家优化路线（0.1.1 起）

状态：**进行中**。基线：`@dsh-external/dsh-butler` 0.1.0，DSH 0.2.2-rc.1，仓库 HEAD `953b1fc` + 本轮改动；测试基线 **1026/1026**。

## 目标

把管家从"技术可用"变成"每天真的会用、离开电脑也可靠"的个人助理。用户已确认的偏好与边界：

- 中文 / Asia/Shanghai；结论先行；在意 token 与费用透明。
- 禁止：花钱、下单、发消息给第三方、动系统盘 —— 需先问。
- 提醒/通知走三层：桌面 toast + 专属会话 + 飞书（先用现有测试应用验证链路）。
- 每日简报：**08:30 早报 + 21:30 晚报**，自动写入 daily。
- 文献：允许自动抓取 OA 全文（不下载付费、不绕权限），Zotero 只读接入；记忆提炼后经确认写入。
- 数据清场已授权：归档 10 月验收 fixture（不删真实数据）、删除 105MB 旧压缩备份（保留 1 份）、删除 6 条测试提醒（已完成）。

## 现状诊断（2026-11-07 审计）

| 项 | 现状 |
| --- | --- |
| 激活 | DSH 升级后 butler bundle 被禁用（profile patch 有 `disabled:true`）→ 已重新启用并持久化；overview 200、专属会话 live |
| 真实使用 | 近乎为零：memory 1 条、profile 半空、notes 停在 10-17、daily 只有回填流水、提醒全是测试、任务 7/10 是 fixture |
| 提醒 | 到期无前台通知/不可操作/离线不补发；且 **0.2.2 schedule 契约已变**，旧调用会失败（迁移中） |
| 存储 | state 108.6MB（105.3MB 是永远清不掉的压缩备份）；usage 5.57MB 无轮转 |
| 性能 | overview 192KB / 0.65–1.2s；15s 轮询 ≈1.06GB/天 + 1.1 CPU·h/天；每次轮询都跑 ensureReady |
| 交互 | 工作台只读；无每日简报、无全局搜索、无设置页/引导；飞书 `channels.enabled=false / bindings=0` |

## 阶段与任务

### P0 清场与减负（进行中）

- [x] 恢复 bundle（profile bundle 列表 + 移除 disabled 覆盖，持久化）
- [x] 删除 6 条测试提醒（DSH schedule 服务，reminders=0）
- [ ] 压缩备份保留策略（最新 1 份保留；超 7 天或超 64MB 删除；审计；env 可调）— `storage-hygiene`
- [ ] usage.jsonl 轮转（热文件阈值；归档仍计入总量；读路径扩展）— `storage-hygiene`
- [ ] daily 去噪（用量回填不再写入 daily）— `storage-hygiene`
- [ ] fixture 归档清单（`vault/archive/index.json` + `scripts/archive-fixtures.mjs`，dry-run 默认，不删账本）— `storage-hygiene`
- [ ] overview 拆分（轻摘要 ≤48KB + detail parts）+ ETag/304 + 轮询 60s + ensureReady TTL — `perf-overview`

### P1 日常可用（进行中）

- [ ] **提醒子系统迁移到 0.2.2 schedule 契约**（create(request, actorSessionId?)、timing 联合、edit delete、history 新形状、status 归一化）— `schedule-migration`（P1 前置阻塞项）
- [x] 自然语言时间解析模块 `src/host/time-parse.ts`（今天/明天/后天/周几/几号/相对时长/每天/每周；缺信息给 ambiguity + 缺失项；过去时间拒绝；时区按 IANA 解释；10 条测试）
- [ ] 提醒闭环：到期 toast（`shell.overlay`）+ 专属会话消息 + 飞书；完成/稍后/改期/取消；DSH 未运行则下次启动补发 overdue；重复提醒（daily/weekly）
- [ ] 每日简报 08:30 / 21:30（今天/逾期/等你决定/提醒；完成/未完成/建议），自动写 daily
- [ ] 工作台可操作：任务完成/改期/取消/继续；逾期进"等你决定"；提醒独立区 + 角标
- [ ] 飞书通道接线（测试应用先验证：channelOwnerId/bindings；提醒送达；手机问话）

### P2 知识闭环

- [ ] OA 全文 → 按页笔记 → 引用导出（不下载付费、不绕权限）
- [ ] 主题记忆提炼 + 待批/更正/撤回 UI；Zotero 只读来源
- [ ] 随手捕获（`conversation.chat.assistant-actions`：记待办/设提醒/存笔记）
- [ ] 全局搜索（笔记/记忆/任务/来源）

### P3 跨端与运维

- [ ] 飞书正式账户 + 凭据迁 credentials
- [ ] 设置页（`settings.section`：时区/简报时间/通道/保留策略/能力包）
- [ ] 备份/导出/恢复；用量费用日报 + 阈值告警；usage 未计价透明

## 验收与约束

- 每阶段：`node scripts/build.mjs --typecheck` + `node --test tests/*.test.mjs`（不新增失败）+ 真实宿主自检（overview/席位/操作）。
- 只通过官方 bundle `install_bundle` / `set_bundle` 管理安装；改动先进工作区，构建后由 bundle 禁用/启用加载新模块代（必要时重启）。
- 数据清理一律"先归档、可回滚"；不手改 append-only 账本；fixture 只做显示层归档 + 调度服务删除。
- 每阶段完成后更新 [acceptance-0.1.0.md](acceptance-0.1.0.md)/本文件，并记录实测数字。

## 本轮协调记录

- `storage-hygiene` 获准扩展 `ledger.ts` 的 `currentUsageIndex()` 只读路径以纳入 usage-archive（失败安全）。
- `schedule-migration` 获准只改 `api.ts` 的 `reminderSnapshot()` 中一处旧 `history` 调用（≤5 行），`perf-overview` 保留该行不覆盖。
- 写范围（task-1/2/3）：存储/数据卫生、性能、提醒契约三组文件互不重叠；共享 `tests/` 用新文件名。
