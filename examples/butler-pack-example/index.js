/**
 * 示例 bundle：通过管家的对外接口注册一个能力包与一个通道适配器。
 *
 * 这个文件只做三件事，全部可核查：
 * 1. 用宽松查找拿到 `butlerExtensions` 服务（管家没装/没激活时得到 undefined，
 *    只记一条 warn，绝不能让宿主或别的插件跟着失败）；
 * 2. 调用 `registerPack` / `registerChannel`，由管家做 `schemaVersion: 1` 校验，
 *    校验失败会抛错（错误信息以「管家扩展：」开头），这里清掉半注册状态后放弃；
 * 3. 用 `ctx.effect` 登记清理函数：卸载本 bundle 时释放注册，包立刻从
 *    `listPacks()` / `packsSummary()` / 指令段中消失。
 *
 * 它**不**做的事：不连任何平台、不读凭据、不选投递目标、不调用 send、
 * 不授予权限、不写管家资料目录。通道适配器只是“声明存在”，且 isReady 恒为
 * false、send 明确返回失败——注册不等于接管投递。
 *
 * 字段上限、错误语义、优先级与生命周期见管家仓库 `docs/extension-api.md`。
 */

export const name = '@dsh-external/butler-pack-example'

/** 声明依赖的服务：管家激活后才有；没有时 Cordis 不会调用 apply。 */
export const inject = ['butlerExtensions']

/**
 * 能力包声明（`schemaVersion: 1`）。
 *
 * - id：小写字母开头的 2..32 位小写字母/数字/短横线，且不能复用内核内置 id；
 * - triggers：字面关键词，命中才会把 instructions 展开进提示词；
 * - tools / permissions / budget / cost_class 都只是声明：不是白名单、不是批准、
 *   不是硬预算、不是费用上限。
 */
export const pack = {
  schemaVersion: 1,
  id: 'example-weekly-review',
  title: '示例：每周回顾',
  triggers: ['每周回顾', '周复盘', 'weekly review'],
  instructions: [
    '每周回顾按四步做：1) 列出本周实际完成与未完成（引用任务或笔记回执，不凭印象）；',
    '2) 写明卡住的原因与下周要改的一件事；3) 需要用户决定的事项列成清单；',
    '4) 把结论写成一条可读的笔记，并给它来源。没有证据的部分标未知，不要补造。',
  ].join('\n'),
  evidence: '每条结论引用本周的任务/笔记路径或工具回执；没有回执的标为待核对。',
  permissions: '写本地笔记按用户请求处理；外发消息、删改文件等有后果动作仍须用户对具体动作的明确授权。',
  tools: ['butler_note', 'butler_task'],
  budget: { maxAttempts: 2, note: '回顾没有进展就停下来问用户，别反复重试。' },
  cost_class: 'free',
}

/**
 * 通道适配器声明（`schemaVersion: 1`）。
 *
 * 这是一个诚实的占位实现：什么都不连、永远“未就绪”，send 明确返回失败。
 * 它演示的是**注册契约**，不是投递能力；真正接平台时需要用户自己的凭据与授权。
 * `limits` 只是声明，内核不会解释或执行它。
 */
export const channel = {
  schemaVersion: 1,
  id: 'example-outbox',
  title: '示例：本地不投递通道',
  isReady: () => false,
  async send(destination, payload) {
    return {
      ok: false,
      reason: `示例通道不做真实投递（目标 ${String(destination?.id)} / ${String(destination?.kind)}，正文 ${String(payload?.text ?? '').length} 字符）。`,
    }
  },
  limits: { note: '纯声明：内核不解释也不执行；真实通道须自行执行。', maxPayloadChars: 4000 },
}

/**
 * Cordis 插件入口。
 * @param {object} ctx 宿主上下文（本示例只用到 get / effect / logger）。
 */
export function apply(ctx) {
  let extensions
  try {
    extensions = ctx.get('butlerExtensions', false)
  } catch {
    extensions = undefined
  }
  if (extensions === undefined || extensions === null) {
    ctx.logger?.warn?.('[butler-pack-example] butlerExtensions 服务不可用：先安装并激活 @dsh-external/dsh-butler 0.1.0+。本示例不生效。')
    return
  }
  const disposers = []
  try {
    disposers.push(extensions.registerPack(pack))
    disposers.push(extensions.registerChannel(channel))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    ctx.logger?.error?.('[butler-pack-example] 注册失败，本示例本次不生效：%s', error instanceof Error ? error.message : String(error))
    return
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) dispose()
  }, 'butler-pack-example: extension registrations')
  ctx.logger?.info?.('[butler-pack-example] 已注册 1 个能力包与 1 个通道适配器（只注册，不投递）。')
}
