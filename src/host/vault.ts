/**
 * The butler's vault: the half of its state the OWNER can open in Notepad.
 *
 * Layout (under VAULT_HOME):
 *   profile.md            热记忆：时区、语言、称呼、偏好、边界。每回合注入。
 *   memory/index.md       温记忆索引：一行一条，指向 memory/*.md。
 *   memory/*.md           温记忆正文，按主题分文件。
 *   notes/*.md            可打开的笔记，正文首行带 rev 号与来源。
 *   daily/YYYY-MM-DD.md   当日日志（提醒、完成、失败）。
 *   uploads/              原件（PDF 等），落盘即算 SHA256。
 *   README.md             这个目录是什么、谁写的、能不能手改。
 *
 * Discipline: files here are plain text, UTF-8, no BOM, LF. Anything the
 * butler writes must survive being opened and edited by a human, so writes are
 * atomic (temp + rename) and never truncate a file another process is reading.
 *
 * @module @dsh-external/dsh-butler/host/vault
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { PACK_BOUNDARY_DESCRIPTION } from '../shared/packs.ts'
import { dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'

/** Absolute vault root: the owner-visible half of the butler's state. */
export const VAULT_HOME = process.env.DSH_BUTLER_VAULT
  || 'E:\\opendots\\.butler\\vault'

/** Absolute internal home: logs, ledger, cache the owner does not read by hand. */
export const STATE_HOME = process.env.DSH_BUTLER_HOME
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'butler')

/** All vault subdirectories, created on first use. */
const VAULT_DIRS = ['memory', 'notes', 'daily', 'uploads', 'ledger', 'packs'] as const

/** Local date parts for one IANA zone. */
export interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday … 6 = Saturday (the zone-local weekday). */
  weekday: number
}

/**
 * Read the parts of an instant in a given zone without pulling in a date library.
 * @param at - the instant.
 * @param timeZone - IANA zone name.
 * @returns the zone-local date and time parts.
 */
export function localParts(at: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  })
  const bag: Record<string, string> = {}
  for (const part of fmt.formatToParts(at)) bag[part.type] = part.value
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    year: Number(bag['year']),
    month: Number(bag['month']),
    day: Number(bag['day']),
    // Intl renders midnight as 24 in some zones; normalise to 0.
    hour: Number(bag['hour']) % 24,
    minute: Number(bag['minute']),
    second: Number(bag['second']),
    weekday: Math.max(0, weekdayNames.indexOf(bag['weekday'] ?? 'Sun')),
  }
}

/**
 * The zone-local calendar date as `YYYY-MM-DD`.
 * @param at - the instant.
 * @param timeZone - IANA zone name.
 * @returns the local date key.
 */
export function localDate(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Create the vault and internal directories if they do not exist yet. */
export function ensureVault(): void {
  mkdirSync(VAULT_HOME, { recursive: true })
  for (const dir of VAULT_DIRS) mkdirSync(join(VAULT_HOME, dir), { recursive: true })
  mkdirSync(STATE_HOME, { recursive: true })
}

/**
 * Read a UTF-8 text file, returning `undefined` when it does not exist.
 * @param path - absolute path.
 * @returns file contents, or undefined.
 */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read a UTF-8 text file, throwing when it does not exist.
 * @param path - absolute path.
 * @returns file contents.
 */
export function readTextOrThrow(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * Write UTF-8 text atomically (temp file + rename), creating parent directories.
 * A crash mid-write leaves the previous content, never a half file.
 * @param path - absolute path.
 * @param content - text to write (LF endings, no BOM).
 */
export function writeText(path: string, content: string): void {
  writeBytes(path, Buffer.from(content, 'utf8'))
}

/**
 * Write raw bytes atomically (temp file + rename), creating parent directories.
 * Used for originals the owner hands over; the file lands before anything is
 * allowed to claim it was read.
 * @param path - absolute path.
 * @param bytes - the bytes to store.
 */
export function writeBytes(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  // Exclusive creation avoids replacing another writer's temporary file.
  const fd = openSync(tmp, 'wx')
  try {
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } finally {
    try { unlinkSync(tmp) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * Append one line to a text file, creating it when absent.
 * Appends in place (open/append/fsync) instead of rewriting the whole file, so
 * append-only ledgers stay O(1) per row. Rows stay newline terminated, and a
 * missing separator is inserted for externally edited files.
 * @param path - absolute path.
 * @param line - the line (no trailing newline required).
 */
export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true })
  let needsSeparator = false
  try {
    const size = statSync(path).size
    if (size > 0) {
      const fd = openSync(path, 'r')
      try {
        const last = Buffer.alloc(1)
        needsSeparator = readSync(fd, last, 0, 1, size - 1) !== 0 && last[0] !== 10
      } finally { closeSync(fd) }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  appendFileSync(path, `${needsSeparator ? '\n' : ''}${line}\n`, { encoding: 'utf8', flush: true })
}

/** SHA-256 of a byte buffer, lowercase hex. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** One file discovered under the vault. */
export interface VaultFile {
  /** Vault-relative path with forward slashes. */
  path: string
  /** Size in bytes. */
  size: number
  /** Last modification time, ISO string. */
  modified: string
}

/**
 * List files under the vault (or one subdirectory), newest first.
 * @param subdir - optional vault-relative subdirectory.
 * @param limit - maximum number of files to return.
 * @returns the matching files.
 */
export function listFiles(subdir?: string, limit = 200): VaultFile[] {
  const root = subdir === undefined ? VAULT_HOME : join(VAULT_HOME, subdir)
  return walk(root)
    .map((abs) => {
      const stat = statSync(abs)
      return {
        path: relative(VAULT_HOME, abs).replace(/\\/g, '/'),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      }
    })
    .sort((a, b) => (a.modified < b.modified ? 1 : -1))
    .slice(0, limit)
}

/** Recursively collect file paths under a directory (missing directory = none). */
function walk(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walk(abs))
    else if (entry.isFile()) out.push(abs)
  }
  return out
}

/** Absolute path of a vault-relative file. */
export function vaultPath(...segments: string[]): string {
  return join(VAULT_HOME, ...segments)
}

/** Absolute path of a state-relative file (ledger, cache, logs). */
export function statePath(...segments: string[]): string {
  return join(STATE_HOME, ...segments)
}

/** The one file the owner edits to change the butler's standing preferences. */
export const PROFILE_FILE = (): string => vaultPath('profile.md')

/** The warm-memory index the butler maintains. */
export const MEMORY_INDEX_FILE = (): string => vaultPath('memory', 'index.md')

/** Today's daily log. */
export function dailyFile(timeZone: string, at = new Date()): string {
  return vaultPath('daily', `${localDate(at, timeZone)}.md`)
}

/**
 * Seed the vault on first run: profile, memory index, README. Existing files
 * are never overwritten - the owner's edits win.
 * @param timeZone - the confirmed zone, written into the seeded profile.
 * @returns the list of files actually created.
 */
export function seedVault(timeZone: string): string[] {
  ensureVault()
  const created: string[] = []
  const put = (path: string, content: string): void => {
    if (existsSync(path)) return
    writeText(path, content)
    created.push(relative(VAULT_HOME, path).replace(/\\/g, '/'))
  }

  put(PROFILE_FILE(), [
    '# 管家档案（你可以直接改这个文件）',
    '',
    '- 时区：' + timeZone,
    '- 语言：中文',
    '- 称呼：',
    '- 说话风格：简洁、先给结论、不确定就说不确定',
    '- 禁止事项：花钱、下单、发消息给第三方、动系统盘 —— 一律先问',
    '',
    '## 备注（管家每次都会读这一段）',
    '',
    '- ',
    '',
  ].join('\n'))

  put(MEMORY_INDEX_FILE(), [
    '# 记忆索引',
    '',
    '每条一行：`- [主题](主题.md) — 一句话摘要`。管家只在得到你确认后才往这里加。',
    '',
  ].join('\n'))

  put(vaultPath('README.md'), [
    '# .butler/vault —— 管家看得见的资料',
    '',
    '这里是你和管家共用的目录，**都是普通文本文件，你能直接用记事本打开、修改**。',
    '',
    '| 目录/文件 | 放什么 |',
    '|---|---|',
    '| `profile.md` | 你的偏好与边界。管家每回合都读，改了立刻生效 |',
    '| `memory/index.md` | 记忆索引，一行一条，指向 `memory/*.md` |',
    '| `memory/` | 分主题记忆正文 |',
    '| `notes/` | 整理好的笔记（首行带 rev 号与来源） |',
    '| `daily/` | 每天一页：提醒、完成、失败 |',
    '| `uploads/` | 你给的原件（PDF 等），落盘时算 SHA256 |',
    '| `ledger/` | 账本（任务、回执、用量），只追加不重写 |',
    '| `packs/` | 你自己写的**能力包**（`<id>.md`）。同 id 会盖掉内置包 |',
    '',
    '内部状态（会话日志、索引、缓存）不在这个目录，在 `~/.dsh/butler/`。',
    '',
  ].join('\n'))

  put(vaultPath('packs', 'README.md'), [
    '# 能力包（capability packs）',
    '',
    '管家内核只做三件事：记住人 / 追踪事 / 守住证据。其余本事全部按"包"装，',
    '一个包就是这目录里的一个 `.md` 文件。',
    '',
    '**这里放的包会盖掉同 id 的内置包**（内置：`daily` 日常、`life` 生活、`documents` 文书、',
    '`study` 学习、`research` 科研）。所以你既可以加新包，也可以把内置包抄出来改成你自己的。',
    '',
    '## 格式',
    '',
    '```',
    '---',
    'id: 唯一英文 id（也是文件名）',
    'title: 中文标题',
    'triggers: 关键词1, 关键词2, 关键词3     # 用逗号顿号都行，命中的是字面词',
    'tools: butler_task, butler_note',
    'evidence: 这个包下的结论必须带什么证据',
    'permissions: 授权提示，哪些具体步骤要先问你（不是批准）',
    'max_attempts: 3',
    'cost: unknown',
    '---',
    '',
    '这里写正式说明：什么时候用、按什么步骤做、做完留什么。',
    '```',
    '',
    '## 改完要做什么',
    '',
    '- 保存文件就行，**下个回合生效**，不用重启。',
    '- 想临时关掉某个包：让管家执行 `butler_pack {action:"disable", id:"…"}`；',
    '  或者直接把这个文件改名成 `.md.off`，它就不算包了。',
    '- 想看现在有哪些包在生效：`butler_pack {action:"list"}`。',
    '',
    PACK_BOUNDARY_DESCRIPTION,
    '',
  ].join('\n'))

  return created
}

/** Summary of the vault for the overview surface. */
export interface VaultSummary {
  /** Vault root. */
  home: string
  /** Internal state root. */
  stateHome: string
  /** Whether the profile file exists. */
  hasProfile: boolean
  /** File counts per vault area. */
  counts: Record<string, number>
  /** Newest files across the vault. */
  recent: VaultFile[]
}

/**
 * Summarise the vault for the workbench's first paint.
 * @returns counts and the newest files.
 */
export function summariseVault(): VaultSummary {
  ensureVault()
  const counts: Record<string, number> = {}
  for (const dir of VAULT_DIRS) counts[dir] = walk(join(VAULT_HOME, dir)).length
  return {
    home: VAULT_HOME,
    stateHome: STATE_HOME,
    hasProfile: existsSync(PROFILE_FILE()),
    counts,
    recent: listFiles(undefined, 12),
  }
}
