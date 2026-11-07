# 验收记录：完整管家 0.1.1（2026-11-07）

目标：把 `@dsh-external/dsh-butler` 从"技术可用"升级为"完整、每天真的会用"的个人助理。
基线：DSH `0.2.2-rc.1`，插件 0.1.0，仓库 HEAD `b3ae6db`；测试基线 1026 → 现在 **1118**。

## 总结论

P0–P3 计划内功能全部落地，真实宿主自检通过，测试全绿（1118/1118），typecheck 通过。
发现的唯一"外部依赖阻塞"（`dsh-lark-channel 0.0.7` 不实现管家提醒投递接口）已用宿主自带
飞书发送器绕开，并把 appSecret 迁入 DSH `credentials`。

## P0 清场与减负 ✅

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 激活持久化 | bundle 在 profile `dsh.bundles`，行无 `disabled` 覆盖 | profile package.json / patch；`overview` 200 |
| 10 月 fixture 归档 | 11 任务 / 5 提醒 / 5 操作 / 6 会话绑定 / 36 回执 → `vault/archive/2026-10-fixtures/` + `vault/archive/index.json`；账本 SHA 不变；工作台过滤 | `scripts/archive-fixtures.mjs --apply`；open 10→4、interrupted 2→0 |
| 105MB 旧备份 | 启动保留策略删除 101,977,166B，保留最新 8,463,950B，写 `retention-audit.jsonl` | state 108.6MB → 11.3MB |
| usage 轮转 | 热文件阈值轮转，归档仍计入总量；失败安全 | `tests/usage-rotation.test.mjs` 7 例 |
| daily 去噪 | 回填写 `state/logs/usage-backfill.log`；旧 30 条噪声清理并备份 `vault/archive/2026-11-daily-cleanup/` | 当前 daily 无回填行 |
| overview 性能 | 192KB→96.7KB；热 ~278ms；ETag/304（0 字节，~209ms）；轮询 15s→60s；ensureReady 5 分钟 TTL | 真实 HTTP 实测 |

## P1 日常可用 ✅

- **自然语言提醒**：今晚8点/明天上午9点半/周五晚上7点/11月8日/20分钟后/每天20:00/每周一三五；缺信息返回 `needsClarification`+`missing`；过去时间拒绝；相对秒/分/时保留。
- **提醒闭环**：到期浮层（任意页面 `shell.overlay`，60s 轮询、不可见不发、按 occurrence 记住已读）+ 工作台横幅；稍后10分/改期/完成/取消/停用/恢复（走 DSH `schedule.edit`，重复规则拒绝单次推迟）；关联账本任务同步。
- **飞书送达**：宿主自带发送器（token 缓存、只发本人 open_id、错误脱敏）；看门狗只推管家提醒会话、同一 occurrence 一次、失败最多 3 次 gave-up；密钥已迁 DSH `credentials`。
- **每日简报**：08:30 早报（昨日用量）/21:30 晚报（今日用量）自动写 daily；窗口补写、按标题幂等、归档 fixture 不进简报；真实 daily `2026-11-07.md` 已有早报。
- **工作台可操作**：任务一键完成/改期+24h/取消（`POST /api/action`，审计、归档 fixture 409）；到期提醒可稍后/完成；live region 反馈。

## P2 知识闭环 ✅

- **OA 全文抓取**：`butler_pdf action=fetch url=…`（http/https、30MB/30s、内网拒绝、只认 PDF 魔数/类型、落地页/付费墙明确拒绝）。
- **按页笔记→引用**：`note:true citation:{…}` 产出按物理页锚定的 markdown 草稿 + BibTeX/RIS/plain 引用；可直接 `butler_note write`。
- **记忆待批 UI**：工作台抽屉直接确认/拒绝（`POST /api/memo-action`，operationId 审计，重复 409）。
- **全局搜索**：`GET /api/search?q=` 查笔记/任务/记忆，分组限额/截断/片段；工作台输入框，命中打开对应抽屉。
- **随手捕获**：工作台「随手记成待办」→ `POST /api/capture` 写 pending 任务。

## P3 跨端与运维 ✅

- **备份/导出/恢复**：`GET/POST /api/backup` 快照 vault+state（排除 cache/logs/压缩备份，逐文件 SHA256，保留 5 份）；`POST /api/restore` 需 `confirm:"RESTORE"`、先校验哈希并生成 pre-restore 备份，失败不写盘。真实第一份：`butler-backup-20261107T053915`（116 文件/10.2MB）。
- **设置页**：`settings.section` 注册「管家」：时区、简报时段、飞书状态与密钥来源、数据目录、保留策略、备份列表 + 立即备份、近 14 天用量费用。
- **用量费用日报**：`GET /api/usage-report?days=N`（1..90，本地时区、补零、已计价/未计价/无用量分开）；真实 90 天：15,392 次调用 / 42.6 亿 tokens / 估算 ¥39.22（已计价 4,255、未计价 11,134）。
- **凭据迁移**：`POST /api/feishu-credential`（set/unset，confirm，只写不回显）；appSecret 已存入 DSH credentials（ref `DSH_BUTLER_FEISHU_APP_SECRET`），profile patch 明文已清空；重载后 `credentialSource:"credentials"`。

## 验证命令（可复跑）

```powershell
cd E:\opendots\dsh-butler
$env:DSH_CHECKOUT='C:\Users\申俊超\dsh-harness'
$env:DSH_PROFILE_DIR='C:\Users\申俊超\.dsh\profiles\desktop'
node scripts/build.mjs --typecheck          # 通过
node --test tests/*.test.mjs                # 1118/1118
node scripts/build.mjs                      # lib/index.js + lib/client.js
```

真实宿主（bundle 重载后）：`overview` 200 / `settings` 200 / `usage-report` 200 / `due` 200(140B) /
`search?q=酶` 200 / `backup` 200 / `reminder-action` 与 `memo-action` 错误路径 404/400/405 /
`overview.feishu={enabled:true,configured:true,credentialSource:"credentials"}`。

## 回滚路径

1. 设置页/接口层出问题：`plugin_manager set_bundle target=@dsh-external/dsh-butler enabled:false`
   可立即停用；重新启用即回到上一可用状态。
2. profile 配置：备份在
   - `cordis.patch.yml.bak-before-official-bundle-20261103-195342`
   - `cordis.patch.yml.bak-before-feishu-20261107-132414`
   - `cordis.patch.yml.bak-before-credential-migration-20261107-134816`
3. 数据恢复：`POST /api/restore {"id":"butler-backup-…","confirm":"RESTORE"}`（自动先做 pre-restore 快照）。
4. 完全移除：删除 profile patch 中 `butler-feishu-push` 段与 bundle 安装，删除 `link:` 依赖。

## 已知边界（未做/需你决定）

- 助手消息上的"随手捕获"入口（`conversation.chat.assistant-actions` 席位）未做：当前捕获在工作台输入框；如需要"任何回复一键记待办"，下一轮可加（需要读消息内容的能力）。
- 离线补发：宿主不在线时无法主动投递；当前兜底为下次打开（浮层/横幅立即显示到期项）+ 飞书看门狗（宿主在线时）。若要求"重启后把错过的提醒补投到提醒会话"，需再设计。
- 飞书目前用测试应用（`cli_aa52b8e22cb8dbfe`）；换正式应用只需改 appId/owner open_id 并重新 `POST /api/feishu-credential`。
- Zotero 只读来源未接（原为可选加分项）。
- 设置页为只读（配置仍在 profile Cordis patch），改配置后需重载 bundle。
