/**
 * Capability packs: the butler's "everything else".
 *
 * The kernel owns exactly three jobs - remember the owner, track the work, hold
 * the evidence. Every other ability is a **pack**: a declared contract, not
 * more kernel code. A pack says what it is triggered by, what it tells the
 * model to do, which tools it leans on, what evidence it must produce, which
 * steps should seek approval, a suggested retry count, and an expected service
 * cost class. These fields neither grant permissions nor enforce budgets.
 *
 * Two kinds live side by side:
 *
 * - **built-in** packs, shipped in this file, because they are the abilities
 *   every owner needs before writing anything (daily, life, documents, study,
 *   research, nature);
 * - **user** packs, markdown files in `vault/packs/<id>.md`, because the point
 *   of packs is that adding an ability is editing one file the owner can open -
 *   not a release. Front matter carries the contract fields; the body is the
 *   instruction text verbatim. `butler_pack {action:'scaffold'}` writes one to
 *   start from.
 *
 * A third kind joins them at runtime: **extension** packs registered by another
 * bundle through the `butlerExtensions` service (`schemaVersion: 1`, see
 * `docs/extension-api.md`). They are merged in this read model through
 * {@link setExtensionPackSource}; their lifetime follows the registration, not
 * `state/packs.json`. Precedence when ids collide is
 * **user markdown > extension > builtin**: a user file overrides both a shipped
 * pack and an extension pack with the same id, and registering an extension
 * pack under a built-in id is rejected during validation instead of silently
 * replacing it.
 *
 * Honesty rules this module keeps:
 *
 * - A pack's `permissions` line is *displayed to the model*, but approval itself
 *   stays a kernel gate (external actions never run from a pack's say-so).
 * - `enabled` state is stored, not guessed, and a pack that fails to parse is
 *   reported as broken rather than silently dropped.
 * - Extension packs are always enabled while registered; `setPackEnabled` refuses
 *   to pretend otherwise (the owner can override one only with a same-id user
 *   file).
 * - `matchPacks` is keyword matching and says so: it returns the triggers that
 *   literally hit, never an "intent" verdict.
 *
 * @module @dsh-external/dsh-butler/host/packs
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readText, statePath, vaultPath, writeText } from './vault.ts'
import { PACK_BOUNDARY, PACK_BOUNDARY_DESCRIPTION, packCostLabel, type PackBoundary, type PackCostClass, type PackGuidance, type PackSource, type PackSummary } from '../shared/packs.ts'
import type { ExtensionPackEntry } from '../shared/extension.ts'

export type { PackCostClass, PackSource } from '../shared/packs.ts'

/** The pack contract, exactly as declared. */
export interface PackContract {
  /** Stable id used by tools, storage and user files. */
  id: string
  /** Human title shown in the workbench and the prompt. */
  title: string
  /** Literal words that mark a request as this pack's business. */
  triggers: string[]
  /** What the model should do when this pack is in play. */
  instructions: string
  /** Recommended tool names, not an executable allowlist. */
  tools: string[]
  /** The evidence this pack's claims must be backed by. */
  evidence: string
  /** Approval guidance, never an approval grant. */
  permissions: string
  /** Retry advice, never a separate runtime hard budget. */
  budget: { maxAttempts?: number; note?: string }
  /** Declared service class, never total model cost or a money cap. */
  cost_class: PackCostClass
}

/** A pack with everything the caller needs to display it. */
export interface PackView extends PackContract {
  /** Kernel-derived semantics, independent of declared pack text. */
  boundary: PackBoundary
  /** Where it came from: shipped, owner-written, or registered by a bundle. */
  source: PackSource
  /** Absolute path of the user file, when it is a user pack. */
  path?: string
  /** Whether it applies right now. */
  enabled: boolean
  /** Set when the file exists but could not be read as a pack. */
  broken?: string
}

/** Persisted enable/disable decisions. */
interface PackState {
  /** Explicitly switched on. */
  enabled: string[]
  /** Explicitly switched off. */
  disabled: string[]
  /** When the file was last written. */
  updatedAt?: string
}

/** File holding the owner's decisions. */
const STATE_FILE = (): string => statePath('packs.json')

/** Directory holding user packs. */
const PACK_DIR = (): string => vaultPath('packs')

/**
 * The packs that ship with the butler.
 *
 * Each one is written as an instruction an agent can follow, because that is
 * all a pack really is: a short, checkable standing order plus the evidence
 * rule that keeps it honest.
 */
const BUILTIN: readonly (PackContract & { defaultEnabled: boolean })[] = [
  {
    id: 'daily',
    title: '日常包',
    triggers: ['提醒', '待办', '别忘了', '记得', '今天', '明天', '后天', '安排', '日程', '跟进', '概览', '这周', '下周'],
    instructions: [
      '把"说过要做的事"变成账本里的一条，而不是留在对话里：开任务要写清标题、类型与到期时间。',
      '时间不明确就先问（"周末"要问周六还是周日、几点），问清楚再建提醒。',
      '每次开工先看总览：有没有上次没做完的、有没有等用户点头的、有没有重启被打断的。',
    ].join('\n'),
    tools: ['butler_overview', 'butler_task', 'butler_remind'],
    evidence: '提醒必须给回执（schedule id + 到期时间）；任务标 done 必须带工具结果或落盘文件。',
    permissions: '账本、笔记与提醒按用户已明确的请求处理；含糊的时间或时区先确认。外发提醒、第三方消息和其他有后果动作仍须核对具体授权与原生权限，包不提供授权。',
    budget: { maxAttempts: 3, note: '同一个任务连续 3 次没进展就停下来问，别反复试。' },
    cost_class: 'free',
    defaultEnabled: true,
  },
  {
    id: 'life',
    title: '生活包',
    triggers: ['买', '购', '订', '价格', '多少钱', '报价', '比价', '优惠', '快递', '物流', '账单', '缴费', '机票', '火车', '酒店', '挂号', '预约', '路线', '几点到'],
    instructions: [
      '先确认需求、预算与币种、约束（日期/地点/人数/隐私/可退改）；缺少会影响方案的输入就先补齐。交付可核查的选项比较、推荐理由与待确认事项。',
      '通过当前可用的原生检索/浏览工具核对官方页面；能力未加载先用 butler_tools 搜索并加载实际 schema。记录链接、查询日期、总价（含税费/运费）、库存/时效和退改/续费条款；缺项标未知，摘要与打开过的页面分清。给备选及取舍，不编报价。',
      '用 butler_task open 建方案任务（kind=todo），butler_note write 保存需求、来源与比较表；用户选择后更新具体方案，涉及支付、下单、预约、提交个人信息或第三方消息时，保持 waiting_review，等待具体动作授权。',
      '后续只在对应原生工具可用、权限与精确动作审批满足时执行；butler_approve 只处理记忆决定，不能批准交易。依赖用户操作或缺少能力时写清下一步，不能声称代办完成。',
      '计划、点击、用户选择和审批都不是已支付/已下单/已预约；必须核对真实工具或平台回执、目标、金额、时间及订单/预约状态，失败或响应丢失保留待核对，勿重复提交。方案笔记完成不代表交易完成。',
    ].join('\n'),
    tools: ['butler_task', 'butler_note', 'butler_tools'],
    evidence: '比较表需官方来源链接、查询日期、币种与含附加费总价、条款和未知项；完成真实动作必须有对应实际回执，模型描述或方案文件不能充当交易凭证。',
    permissions: '查公开资料与写方案遵循用户请求和现有文件权限；支付、下单、预约、提交个人信息及第三方消息须得到针对具体动作的明确授权，仍经过实际注册生效的原生权限/精确审批，不由包授予。',
    budget: { maxAttempts: 3 },
    cost_class: 'free',
    defaultEnabled: true,
  },
  {
    id: 'documents',
    title: '文书包',
    triggers: ['pdf', '文档', '文件', '总结', '摘要', '报告', '表格', '合同', '简历', '说明', '整理成', '翻译'],
    instructions: [
      '先落原件再谈内容：PDF 用 butler_pdf ingest 存进 vault 并算 SHA256，再读它的文本层。',
      '总结按"研究问题/目的、方法、主要结果、局限"四段写，关键结论带页码或章节锚点。',
      '读不出就说读不出：扫描件没有文本层、图表、公式、手写批注都可能解析不了，如实写进限制。',
    ].join('\n'),
    tools: ['butler_pdf', 'butler_note', 'butler_task'],
    evidence: '声称读了全文，必须有落盘原件（SHA256）与页码/章节锚点；只看了摘要就写 abstract。解析失败也必须留痕。',
    permissions: '仅在用户请求和原生文件权限范围内读取原件、写笔记；覆盖或改动原有文件、外部上传/分享和使用账号需先核对具体授权，包不提供文件或网络权限。',
    budget: { maxAttempts: 2 },
    cost_class: 'free',
    defaultEnabled: true,
  },
  {
    id: 'study',
    title: '学习包',
    triggers: ['学习', '复习', '讲解', '讲一下', '概念', '原理', '练习', '题目', '考试', '单词', '入门', '教程'],
    instructions: [
      '先确认学习目标、当前水平、截止日期与每次/每周可用时间，必要时补教材或考试范围；交付分段计划、讲解与练习、纠错笔记及复习待办。',
      '按基线→讲解→练习→检查→纠错→复习推进：先用一个小问题了解基础；按已观察水平先给结论、再拆步骤和例子；让用户实际作答后逐项检查，解释错因并给一道变式题。',
      '不得虚构用户答题、分数或掌握程度；没有作答就标待作答，评分须说明题目、实际答案与标准，复习/后测须等待用户参与；完成计划或笔记不等于已学会。事实、版本或教材结论带来源，无可靠出处说明限制，推论单列。',
      '用 butler_task open（kind=todo）记录可检查的小目标；butler_note write/append 保存实际答案、检查依据、纠错与下一步，用其返回的 evidenceIds 更新已完成产物。依赖用户的学习任务保持 pending 或 waiting_review，别代答后标 done。',
      '复习提醒只在用户明确同意且确认日期、时刻和时区后创建；用 butler_remind create 的 title + at/when（按实际 schema），不能把时区当未提供的参数。未约定就只留待办；创建回执仅证明已排程，送达或完成看真实历史。',
    ].join('\n'),
    tools: ['butler_note', 'butler_remind', 'butler_task'],
    evidence: '学习记录需目标、已观察基线、题目/用户原答/检查依据、纠错、待复习项及来源；只凭真实笔记/工具 evidenceIds 证明产物，不凭计划断言成绩或掌握；提醒需真实 schedule id、时间和已确认时区。',
    permissions: '讲解和本地笔记按用户请求及原生权限处理；提醒时间/时区与外发渠道须明确约定，付费课程、账号使用、上传学习资料或第三方消息需针对具体动作授权。',
    budget: { maxAttempts: 3 },
    cost_class: 'free',
    defaultEnabled: true,
  },
  {
    id: 'research',
    title: '科研包',
    triggers: ['论文', '文献', '研究', '综述', '期刊', 'doi', 'arxiv', 'pubmed', '预印本', '实验', '引用'],
    instructions: [
      '先明确研究问题、检索式/同义词、时间范围、文献类型与纳入/排除标准，必要时限定人群或方法；交付检索记录、去重题录、核实状态、证据提取比较表与限制。用 butler_task open（kind=research）追踪。',
      'butler_literature search接收query、rows（每库默认4条），通过Crossref + arXiv + PubMed检索。完整记录本地保存，默认仅返回精简预览及resultSet.id；page + resultSetId + offset读取后续题录，read + index + field读取完整record/abstract/metadata片段，按nextOffset继续。保留providers、limitations、duplicatesRemoved与conflictCount。强标识冲突不擅自合并；可用verify + records区分verified/unconfirmed/conflict，核实存在性不等于结论正确。入门推荐已有足够合适文献即可组织答案和学习顺序，不需穷尽搜索或读取全文。',
      '零基础入门应优先查tutorial/introduction或经典文章的具体标题，可把几条聚焦检索并行执行；首批结果噪声高时不要穷尽同一宽泛关键词。直接交付实际命中文献、推荐阅读顺序和可调整的本周学习安排；未给时间偏好时可明确按每天30–60分钟安排，不因可选偏好阻塞交付。准确标注题录/摘要读取范围，不把保存题录说成读过全文。',
      '题录无摘要时写未取得摘要；只读摘要标 abstract。PDF 工具只接收已有本地 path，不会自动下载；拿到合法原件才 butler_pdf ingest，并 read 请求 pages 或 fullText，依据真实返回的 readLevel/fullTextAvailable、SHA256 与页码锚点报告阅读范围，存了PDF不等于读过全文。',
      '按纳入标准提取研究问题、样本/方法、结果与局限，逐项注明来源与实际阅读层级；缺失不推断，摘要信息不伪装正文。比较一致/冲突与适用范围，未检索到不说不存在，失败与未核实项保留。',
      '用 butler_note write（markdown、sources、limitations）保存可读 Markdown 题录/比较表。引用文件用 butler_literature {action:"export", format:"ris" 或 "bibtex", slug:"my-references", records:[...]}：离线写入 vault/references 的 .ris/.bib，并返回实际 path、sha256、recordCount、limitations 与 evidenceIds；不需 web 或模型。slug 只用安全 ASCII 字母数字、下划线、短横线；1–100 条带 title 的题录，缺失字段不补造，不自动去重，已有不同内容不覆盖。',
      '导出仅保留输入 title/authors/year/venue/doi/arxivId/pmid/url/abstract/source/sources/verified/verificationNote；输入核验状态标作输入资料，本轮未重新验证，未读全文，不推断同行评审；RIS 用 GEN，BibTeX 用 @misc，作者按原姓名保留。只有最终原生 tools/result 确认的文件 evidenceIds 才能关闭本任务的导出工作，不能借此声称论文全文已验证。PDF 获取仍需用户提供合法本地原件，不会自动下载；扫描件无文本层时明确需要 OCR，本工具不做 OCR。',
    ].join('\n'),
    tools: ['butler_literature', 'butler_pdf', 'butler_note', 'butler_task'],
    evidence: '记录检索范围/日期、纳排依据、来源URL、核实状态、实际摘要/全文阅读范围和限制；全文声明需真实原件 SHA256、页码锚点与实际完整返回，题录核实不能替代全文证据。',
    permissions: '公开接口检索和本地整理遵循用户请求及原生权限；不得未经明确授权使用付费/机构账号、购买文献或上传未发表数据，外部分享/投稿等动作仍须具体授权与实际原生审批。',
    budget: { maxAttempts: 3, note: '检索为空不等于不存在，如实报告并写进"限制与冲突"。' },
    cost_class: 'free',
    defaultEnabled: true,
  },
  {
    id: 'nature',
    title: 'Nature 科研技能包',
    triggers: ['nature', 'cns', '论文', '文献', '学术', '科研', '引文', '审稿', '数据可用性', '代码可用性', '科学图表', '双语精读'],
    instructions: [
      '本包按任务路由：先用 butler_skills 检索摘要，再用原生 skill(name) 加载所需正文；用户 /name 已注入 skill_content 时直接遵循，不重复加载。',
      '路由：文献检索/引文核验 → nature-academic-search；Nature/CNS支持引用 → nature-citation；数据/代码可用性 → nature-data；科学图表 → nature-figure；文献汇报PPT → nature-paper2ppt；润色翻译 → nature-polishing；双语精读 → nature-reader；审稿回复 → nature-response；论文起草 → nature-writing。',
      '只按技能要求读取 manifest、core、片段及 ../nature-shared 的所需文件；nature-shared 仅为共享资源，不是独立技能，不预读整库。已启用只表示可发现和选用，不等于全文常驻或自动执行；已加载正文可能在会话历史保留。',
      '复用 DSH 原生工具以及 butler_literature / butler_pdf / butler_note；先用 butler_tools 核对实际工具 schema、技能工具依赖与原生权限，不能假定 Codex MCP、Python 或 PPTX 工具在 DSH 可用。缺少工具或权限如实标未执行，保留限制与失败。',
      '权限、成本和预算仍由现有原生控制与用户授权决定，不因 skill 授予；未计价不代表免费，加载和后续模型/提供方调用的未知成本保持未知。',
    ].join('\n'),
    tools: ['butler_skills', 'skill', 'butler_tools', 'butler_literature', 'butler_pdf', 'butler_note', 'butler_task'],
    evidence: '记录实际工具回执、来源与阅读层级、产物路径和限制；缺失依赖、未执行步骤与失败如实保存，技能声明不能充当执行证明。',
    permissions: '按用户请求与现有原生权限处理；付费服务、上传未发表数据、外部分享或投稿仍须具体授权及实际原生审批，技能与包不授予权限。',
    budget: { maxAttempts: 3, note: '沿用任务与运行时预算；缺少工具或权限时保留未执行与失败，不反复加载。' },
    cost_class: 'unknown',
    defaultEnabled: true,
  },
]

/** Ids owned by the kernel; an extension pack may not reuse one. */
export const BUILTIN_PACK_IDS: readonly string[] = Object.freeze(BUILTIN.map(pack => pack.id))

/**
 * Runtime source of extension packs, installed by the host extension registry.
 *
 * Kept as a hook because this module's read functions are called from tools,
 * prompts and HTTP routes without a Cordis context in hand; the registry is an
 * instance created during activation. `undefined` means "no extension surface",
 * which is exactly the pre-registry behavior.
 */
export type ExtensionPackSource = () => readonly ExtensionPackEntry[]

/** Currently installed extension-pack provider. */
let extensionPackSource: ExtensionPackSource | undefined

/**
 * Install the extension-pack provider consulted by {@link listPacks}.
 *
 * One provider is active at a time (one butler activation). The returned
 * disposer is idempotent and only clears the slot when it still owns it, so a
 * reloaded registry cannot detach a newer one.
 * @param source - reads the registry's current pack list.
 * @returns a disposer that restores the "no extension surface" state.
 */
export function setExtensionPackSource(source: ExtensionPackSource): () => void {
  extensionPackSource = source
  let installed = true
  return () => {
    if (!installed) return
    installed = false
    if (extensionPackSource === source) extensionPackSource = undefined
  }
}

/** Why the state file could not be read, set by the most recent {@link readState}. */
let stateProblem: string | undefined

/** Why the state file could not be read, when that happened. */
export function packStateProblem(): string | undefined {
  return stateProblem
}

/**
 * Read the owner's enable/disable decisions.
 *
 * A missing file means "no decisions yet", which is not an error: pack defaults
 * still apply. A file that exists but does not parse is reported through
 * {@link packStateProblem} so the caller can say so instead of quietly ignoring
 * the owner's edits.
 * @returns the parsed decisions.
 */
function readState(): PackState {
  stateProblem = undefined
  const raw = readText(STATE_FILE())
  if (raw === undefined || raw.trim() === '') return { enabled: [], disabled: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<PackState>
    return {
      enabled: Array.isArray(parsed.enabled) ? parsed.enabled.filter((id): id is string => typeof id === 'string') : [],
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter((id): id is string => typeof id === 'string') : [],
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch (error) {
    stateProblem = `${STATE_FILE()} 读不出来（${error instanceof Error ? error.message : String(error)}），所以这次按默认开关处理。`
    return { enabled: [], disabled: [] }
  }
}

/** Write the decisions back, stamping the time. */
function writeState(state: PackState): void {
  writeText(STATE_FILE(), `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

/** True when the pack applies given the owner's decisions. */
function isEnabled(id: string, fallback: boolean, state: PackState): boolean {
  if (state.disabled.includes(id)) return false
  if (state.enabled.includes(id)) return true
  return fallback
}

/**
 * Parse a `key: value` line's list value.
 *
 * Both `a, b, c` and `a、b` are accepted because the packs are written by a
 * Chinese-speaking owner by hand.
 * @param value - the raw right-hand side.
 * @returns the trimmed items.
 */
function parseList(value: string): string[] {
  const seen = new Set<string>()
  const items: string[] = []
  for (const raw of value.split(/[,、，]/)) {
    const item = raw.trim()
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    items.push(item)
  }
  return items
}

/**
 * Whether a file name in `vault/packs/` is meant to be a pack.
 *
 * `README.md` is seeded by the plugin itself as documentation, and a name
 * starting with `_` is the conventional way to park a pack without deleting it
 * (and `.off` is described that way in that README). Neither is a pack, and
 * reporting them as broken files would train the owner to ignore the warning
 * that exists for real parse failures.
 * @param name - file name inside `vault/packs/`.
 * @returns true when the file should be read as a pack.
 */
function isPackFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.md')) return false
  if (lower === 'readme.md') return false
  if (name.startsWith('_')) return false
  return true
}

/**
 * Read one user pack file.
 * @param path - absolute path of the `.md` file.
 * @returns the contract, or a reason it could not be read.
 */
function readUserPack(path: string): PackContract | { broken: string } {
  const raw = readText(path)
  if (raw === undefined) return { broken: '文件读不出来。' }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^\uFEFF/, ''))
  if (match === null) {
    return { broken: '缺少 front matter：文件要以 --- 开头，里面写 id / title / triggers 等字段，--- 之后写正文。' }
  }
  const head = match[1] ?? ''
  const body = (match[2] ?? '').trim()
  const fields: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const hit = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim())
    if (hit !== null) fields[hit[1] as string] = (hit[2] as string).trim()
  }
  const id = fields['id'] ?? basename(path).replace(/\.md$/i, '')
  const title = fields['title'] ?? id
  const attempts = Number.parseInt(fields['max_attempts'] ?? fields['budget'] ?? '', 10)
  const cost = fields['cost'] ?? fields['cost_class']
  return {
    id,
    title,
    triggers: parseList(fields['triggers'] ?? ''),
    instructions: body === '' ? '（这个包还没写正文：打开文件把要做的事写清楚。）' : body,
    tools: parseList(fields['tools'] ?? ''),
    evidence: fields['evidence'] ?? '按内核纪律：说了就带来源，声称完成就带回执。',
    permissions: fields['permissions'] ?? '有后果的动作先问用户。',
    budget: { ...(Number.isFinite(attempts) ? { maxAttempts: attempts } : {}), ...(fields['budget_note'] === undefined ? {} : { note: fields['budget_note'] }) },
    cost_class: cost === 'free' || cost === 'paid' || cost === 'local' ? cost : 'unknown',
  }
}

/**
 * All packs: built-ins merged with extension registrations and user files.
 *
 * Precedence on an id collision is **user markdown > extension > builtin**. A
 * user file whose id matches a built-in or extension pack **replaces** it: that
 * is how an owner rewrites a pack without forking this plugin. Extension packs
 * never collide with built-ins (registration rejects those ids) and are always
 * enabled while registered; a same-id user file hides them.
 * @returns every pack, built-ins first, then extension packs, then user-only packs.
 */
export function listPacks(): PackView[] {
  const state = readState()
  const byId = new Map<string, PackView>()
  for (const pack of BUILTIN) {
    const { defaultEnabled, ...contract } = pack
    byId.set(pack.id, { ...contract, boundary: PACK_BOUNDARY, source: 'builtin', enabled: isEnabled(pack.id, defaultEnabled, state) })
  }

  // Extension packs sit between built-ins and user files: a registered pack is
  // not a shipped pack, but the owner's own markdown still wins.
  for (const pack of extensionPackSource?.() ?? []) {
    byId.set(pack.id, {
      ...pack,
      triggers: [...pack.triggers],
      tools: [...pack.tools],
      budget: { ...pack.budget },
      // Never trust a provider-supplied boundary: the read model regenerates it.
      boundary: PACK_BOUNDARY,
      source: 'extension',
      enabled: true,
    })
  }

  let files: string[] = []
  try {
    files = readdirSync(PACK_DIR()).filter((name) => isPackFileName(name))
  } catch {
    files = []
  }
  for (const name of files.sort()) {
    const path = join(PACK_DIR(), name)
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    const parsed = readUserPack(path)
    if ('broken' in parsed) {
      const id = basename(name).replace(/\.md$/i, '')
      byId.set(`file:${name}`, {
        id,
        title: id,
        triggers: [],
        instructions: '',
        tools: [],
        evidence: '',
        permissions: '',
        budget: {},
        cost_class: 'unknown',
        boundary: PACK_BOUNDARY,
        source: 'user',
        path,
        enabled: false,
        broken: parsed.broken,
      })
      continue
    }
    byId.set(parsed.id, {
      ...parsed,
      boundary: PACK_BOUNDARY,
      source: 'user',
      path,
      enabled: isEnabled(parsed.id, true, state),
    })
  }
  return [...byId.values()]
}

/** One pack by id. */
export function getPack(id: string): PackView | undefined {
  return listPacks().find((pack) => pack.id === id)
}

/** Packs that apply right now, in declaration order. */
export function enabledPacks(): PackView[] {
  return listPacks().filter((pack) => pack.enabled)
}

/**
 * Switch a pack on or off, recording the decision.
 *
 * Extension packs are exempt: their enabled state follows the registration
 * lifetime (a bundle that wants one off disposes its registration), so they are
 * not writeable through `state/packs.json`. Attempting it throws a clear error
 * instead of pretending the switch worked. To override an extension pack, the
 * owner writes a same-id markdown file under `vault/packs/`.
 * @param id - pack id.
 * @param enabled - desired state.
 * @returns the updated pack, or `undefined` when no such pack exists.
 */
export function setPackEnabled(id: string, enabled: boolean): PackView | undefined {
  const pack = getPack(id)
  if (pack === undefined) return undefined
  if (pack.source === 'extension') {
    throw new Error(`管家扩展：能力包 "${id}" 来自扩展注册（source: extension），启用状态跟随注册生命周期，不受用户开关控制；要停用它，请让注册方释放注册，或用同 id 的用户包（vault/packs/${id}.md）覆盖。`)
  }
  const state = readState()
  const on = new Set(state.enabled.filter((row) => row !== id))
  const off = new Set(state.disabled.filter((row) => row !== id))
  if (enabled) on.add(id)
  else off.add(id)
  writeState({ enabled: [...on], disabled: [...off], updatedAt: new Date().toISOString() })
  return getPack(id)
}

/**
 * Which packs a request looks like it belongs to.
 *
 * Keyword matching, deliberately: the caller gets the triggers that literally
 * appeared in the text, so a wrong guess is visible and correctable instead of
 * hiding behind an "intent" claim.
 * @param text - the owner's request, verbatim.
 * @param limit - how many packs to return at most.
 * @returns matches with their hit words, strongest first.
 */
export function matchPacks(text: string, limit = 3): Array<{ pack: PackView; hits: string[] }> {
  const haystack = text.toLowerCase()
  if (haystack.trim() === '') return []
  const scored = enabledPacks()
    .map((pack) => ({ pack, hits: pack.triggers.filter((trigger) => trigger !== '' && haystack.includes(trigger.toLowerCase())) }))
    .filter((row) => row.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length)
  return scored.slice(0, Math.max(1, limit))
}

/**
 * The instruction text for the prompt: what is on, and what each one demands.
 *
 * Kept terse on purpose - this rides in every request, so a pack that needs a
 * paragraph of justification belongs in a note, not here.
 * @returns the section text, or a line saying nothing is on.
 */
export function packInstructions(request?: string): string {
  const packs = enabledPacks()
  const broken = listPacks().filter((pack) => pack.broken !== undefined)
  const lines: string[] = [PACK_BOUNDARY_DESCRIPTION]
  const expanded: PackView[] = []
  if (packs.length === 0) {
    lines.push('当前没有启用的能力包：只用内核的三个本事（记住人 / 追踪事 / 守住证据）干活，遇到明显属于某个领域的请求，先问要不要装包。')
  } else {
    lines.push(`当前启用的能力包（${packs.length} 个）——按用户的请求选相关的照做；不相关的不要硬套：`)
    if (request !== undefined) {
      lines.push(`目录：${packs.map(pack => `${pack.id}=${pack.title}`).join('；')}。`)
      lines.push('下列只展开相关内置包、命中的扩展注册包及全部自建包；需要未展开领域时，先用butler_pack show读取完整指引，再执行。目录不替代证据、授权与运行时预算。')
    }
    for (const pack of packs) {
      // Core daily obligations and user-authored contracts remain unconditional.
      // No match count limit: a request can legitimately need several domains.
      // Extension packs are third-party text, so like built-ins they must earn
      // their prompt space with a literal trigger hit; the catalog line above
      // keeps the model able to find them by id.
      const text = request?.toLowerCase()
      if (text !== undefined && pack.source !== 'user' && pack.id !== 'daily'
        && !pack.triggers.some(trigger => trigger !== '' && text.includes(trigger.toLowerCase()))) continue
      expanded.push(pack)
      const origin = pack.source === 'user' ? '｜用户自建' : pack.source === 'extension' ? '｜扩展注册' : ''
      lines.push(`\n【${pack.title}】id=${pack.id}｜${packCostLabel(pack.cost_class)}${origin}`)
      lines.push(pack.instructions)
      lines.push(`证据：${pack.evidence}`)
      lines.push(`授权提示（非批准）：${pack.permissions}`)
      if (pack.budget.maxAttempts !== undefined || pack.budget.note !== undefined) {
        lines.push(`重试建议（非硬预算）：${pack.budget.maxAttempts === undefined ? '' : `${pack.budget.maxAttempts} 次`}${pack.budget.note === undefined ? '' : `；${pack.budget.note}`}`)
      }
    }
    lines.push('\n装/卸包用 butler_pack；不确定某个请求属于哪个包，就先 butler_pack {action:"match"} 看命中了什么。')
  }
  if (broken.length > 0) {
    lines.push(`\n注意：有 ${broken.length} 个包文件读不出来（${broken.map((pack) => `${pack.path ?? pack.id}：${pack.broken}`).join('；')}），它们没有生效——如实告诉用户，别当成没有这个包。`)
  }
  const problem = packStateProblem()
  if (problem !== undefined) lines.push(`\n注意：${problem}`)
  const rendered = lines.join('\n')
  if (rendered.length <= 12000) return rendered
  // An outer prompt slice must never silently discard a later pack's evidence
  // or approval guidance. Preserve ordinary declarations verbatim; overflow is
  // explicitly a non-executable preview with a mandatory complete-show step.
  const catalog = packs.map(pack => `${pack.id}=${pack.title}`).join('；')
  const preview = expanded.map(pack => [
    `【${pack.id}】${packCostLabel(pack.cost_class)}`,
    `证据声明：${pack.evidence.slice(0, 250)}`,
    `授权提示（非批准）：${pack.permissions.slice(0, 250)}`,
    `重试建议（非硬预算）：${pack.budget.maxAttempts ?? '未声明'}；${pack.budget.note?.slice(0, 150) ?? ''}`,
  ].join('\n')).join('\n')
  return [PACK_BOUNDARY_DESCRIPTION,
    '完整能力包指引超过提示上限，本次仅展示可能截短的声明预览；执行相关领域前必须 butler_pack show 读取完整工作流、证据和授权提示。不能据预览执行，未列全的目录用 butler_pack list 查看。',
    `启用目录（预览）：${catalog.slice(0, 3000)}`,
    `相关声明（预览）：\n${preview.slice(0, 7000)}`,
    ...(broken.length ? [`另有 ${broken.length} 个包文件读不出来，未生效；用 butler_pack list 核对原因。`] : []),
    ...(problem === undefined ? [] : [`开关状态读取失败（预览）：${problem.slice(0, 500)}`]),
  ].join('\n')
}

/**
 * Write a starter pack file the owner can edit.
 * @param id - desired pack id (used as the file name).
 * @param title - human title; defaults to the id.
 * @returns the path written, or a refusal reason.
 */
export function scaffoldPack(id: string, title?: string): { path?: string; markdown?: string; refused?: string } {
  const clean = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (clean === '') return { refused: '包 id 只能用字母、数字、下划线、短横线。' }
  const path = join(PACK_DIR(), `${clean}.md`)
  if (readText(path) !== undefined) return { refused: `已经存在 ${path}，先改名或直接编辑它，别覆盖。` }
  const markdown = [
    '---',
    `id: ${clean}`,
    `title: ${title?.trim() === undefined || title.trim() === '' ? clean : title.trim()}`,
    'triggers: 关键词1, 关键词2, 关键词3',
    'tools: butler_task, butler_note',
    'evidence: 这个包下的结论必须带什么（来源链接？查询日期？落盘文件？）',
    'permissions: 授权提示（非批准）：哪些具体步骤要先问用户（花钱、发消息、改文件…）',
    'max_attempts: 3',
    'cost: unknown',
    ...PACK_BOUNDARY_DESCRIPTION.split('\n').map(line => `# ${line}`),
    '---',
    '',
    '这里写这个包的正式说明：什么时候用它、按什么步骤做、做完要留下什么。',
    '写给人看，也写给模型看；越具体越能照做，别写"尽力而为"这种没法检查的话。',
    '',
  ].join('\n')
  writeText(path, markdown)
  return { path, markdown }
}

/** Bounded read projection; show still returns the owner's complete declaration. */
function packGuidance(pack: PackView): PackGuidance {
  let truncated = false
  const clip = (text: string, limit: number): string => {
    if (text.length <= limit) return text
    truncated = true
    return text.slice(0, limit)
  }
  const workflow = clip(pack.instructions, 4000)
  const evidence = clip(pack.evidence, 1600)
  const permissions = clip(pack.permissions, 1600)
  const note = pack.budget.note === undefined ? undefined : clip(pack.budget.note, 800)
  if (pack.tools.length > 30) truncated = true
  const tools = pack.tools.slice(0, 30).map(name => clip(name, 160))
  return { workflow, tools, evidence, permissions,
    budget: { ...(pack.budget.maxAttempts === undefined ? {} : { maxAttempts: pack.budget.maxAttempts }), ...(note === undefined ? {} : { note }) },
    ...(truncated ? { truncated: true } : {}) }
}

/** Compact, read-only pack declarations without raw markdown or user file paths. */
export function packsSummary(): PackSummary[] {
  return listPacks().map((pack) => ({
    id: pack.id,
    title: pack.title,
    enabled: pack.enabled,
    source: pack.source,
    cost_class: pack.cost_class,
    boundary: PACK_BOUNDARY,
    guidance: packGuidance(pack),
    ...(pack.broken === undefined ? {} : { broken: pack.broken }),
  }))
}
