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
- [x] 压缩备份保留策略实现挂在工作区（`store.ts`；等测试补齐后启用）
- [x] usage 轮转 + daily 去噪实现挂在工作区（`usage-rotation.ts`/`backfill.ts`/`ledger.ts` 读路径；等测试补齐）
- [x] fixture 归档清单（`vault/archive/index.json` + `scripts/archive-fixtures.mjs`，dry-run 默认，不删账本；等测试补齐）
- [x] overview ETag + 304：payload 稳定部分哈希、304 无 body；客户端 `getJson` 条件请求缓存并复用同一引用
- [x] 轮询 15s→60s（保持不可见不发、回到可见补一次）
- [x] ensureReady TTL 5 分钟（失败不缓存；`READY_CACHE_MS`，返回已缓存 ready 结果）
- [ ] overview 轻摘要 + detail 拆分（本轮暂缓：先靠 ETag/轮询降到 ~276MB/天 → 304 后接近 0；下一轮再做字段拆分）

### P1 日常可用（进行中）

- [x] **提醒子系统迁移到 0.2.2 schedule 契约**（产品代码完成、typecheck 通过；`projectReminder` 归一化、`edit delete` 取消、新 history 形状）
- [x] 迁移后测试适配（18 条提醒用例的 0.2.2 fake；全量 1066/1066）
- [x] 自然语言时间解析模块 `src/host/time-parse.ts`（10 测试）
- [x] 把 `time-parse` 接进 `butler_remind`：`when` 支持今晚8点/明天上午9点半/周五晚上7点/11月8日/20分钟后/每天20:00/每周一三五；缺信息返回 `needsClarification` + `missing`，不再只认数字相对时间；相对秒/分/小时保留
- [x] **每日简报** `src/host/brief.ts`：08:30 早报 + 21:30 晚报自动写 daily（今日到期/逾期/等你决定/提醒/建议；晚报完成/未完成/明日到期）；窗口外不写、重启幂等、归档 fixture 不进简报；插件激活时补写；已实测写入 `vault/daily/2026-11-07.md`
- [x] 工作台可操作（第一版）：任务行内「完成 / 改期 +24h / 取消」一键操作；宿主 `POST /api/action` 只改本地账本（operationId 审计），归档 fixture 拒绝修改（409）；客户端 live region 反馈成功/失败；成功即刷新
- [x] 到期提醒可见：工作台顶部「到期提醒 N 条」条（标题/计划时间/知道了/打开管家会话处理），重新加载仍可见（未处理），已确认的本会话隐藏
- [ ] 提醒闭环剩余：`shell.overlay` 级 toast、离线补发投递到专属会话、提醒规则本身的完成/稍后/改期、飞书送达
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

## 验证结果（2026-11-07 本轮，真实宿主 DSH 0.2.2-rc.1）

| 指标 | 之前 | 现在 |
| --- | --- | --- |
| state 目录 | 108.6MB | **11.3MB**（保留策略自动删除 101,977,166B 旧备份，保留最新 8,463,950B，写 `retention-audit.jsonl`） |
| overview 响应 | 192KB | **96.7KB**（fixture 归档后：open 10→4、interrupted 2→0、历史 51→16、提醒操作 5→0） |
| overview 热延迟 | 617–1231ms | **~278ms**（全量 96.7KB） |
| 条件请求 | 无 | **304 / 0 字节 / ~209ms**（ETag 对稳定内容哈希，排除 generatedAt 与 session.at） |
| 轮询 | 15s | **60s**（不可见不发） |
| 提醒目录 | 6 条测试提醒 | 0（调度服务已删；账本/回执原字节不动） |
| daily 噪声 | 30 条「[用量回填]」 | 0（旧行清理，原件备份 `vault/archive/2026-11-daily-cleanup/`；新回填写 `state/logs/usage-backfill.log`） |
| fixture 归档 | 无 | 11 任务 / 5 提醒 / 5 操作 / 6 会话绑定 / 36 回执 → `vault/archive/2026-10-fixtures/`，`vault/archive/index.json`（账本 SHA 不变） |
| 测试 | 1026/1026 | **1060/1060**（新增 34：time-parse 10、提醒迁移、存储/轮转/归档 24） |

验收命令：`node scripts/build.mjs` 通过；`node scripts/build.mjs --typecheck` 通过；`node --test tests/*.test.mjs` 1060/1060。

### P0 清场与减负：已完成 ✅

- [x] 恢复 bundle（profile bundle 列表 + 移除 disabled 覆盖，持久化）
- [x] 删除 6 条测试提醒（DSH schedule 服务，reminders=0）
- [x] 压缩备份保留策略（最新 1 份保留；超 7 天或超 64MB 删除；审计；env 可调；**启动时执行**，解决"等不到压缩就不清理"）
- [x] usage 轮转（热文件阈值；归档仍计入总量；读路径扩展；失败安全）
- [x] daily 去噪（新回填写 `state/logs/usage-backfill.log`；旧噪声已清理并备份）
- [x] fixture 归档清单（`vault/archive/index.json` + `scripts/archive-fixtures.mjs`，dry-run 默认；工作台宿主侧过滤，账本不删不改）
- [x] overview ETag + 304、轮询 60s、ensureReady 5 分钟 TTL
- [ ] overview 轻摘要 + detail 拆分（下一轮：把 ETag 计算改为缓存投影后 ≤48KB/≤100ms）

## 验收与约束

- 每阶段：`node scripts/build.mjs --typecheck` + `node --test tests/*.test.mjs`（不新增失败）+ 真实宿主自检（overview/席位/操作）。
- 只通过官方 bundle `install_bundle` / `set_bundle` 管理安装；改动先进工作区，构建后由 bundle 禁用/启用加载新模块代（必要时重启）。
- 数据清理一律"先归档、可回滚"；不手改 append-only 账本；fixture 只做显示层归档 + 调度服务删除。
- 每阶段完成后更新 [acceptance-0.1.0.md](acceptance-0.1.0.md)/本文件，并记录实测数字。

## 本轮协调记录

- `storage-hygiene` 获准扩展 `ledger.ts` 的 `currentUsageIndex()` 只读路径以纳入 usage-archive（失败安全）。
- `schedule-migration` 获准只改 `api.ts` 的 `reminderSnapshot()` 中一处旧 `history` 调用（≤5 行），`perf-overview` 保留该行不覆盖。
- 写范围（task-1/2/3）：存储/数据卫生、性能、提醒契约三组文件互不重叠；共享 `tests/` 用新文件名。
