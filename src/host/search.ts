/**
 * 全局搜索：一个输入框查遍笔记、任务与记忆。
 *
 * 只读、限额、可解释：每组最多 N 条，超出显式 `truncated`；命中位置给出前后文
 * 片段而不是整篇正文；笔记按文件扫描（跳过超大文件），任务/记忆走账本读模型。
 * 不搜索用量、回执等纯运维数据 —— 那些有各自的页面，混进来只会稀释结果。
 *
 * @module @dsh-external/dsh-butler/host/search
 */
import { listFiles, readText, vaultPath } from './vault.ts'
import { listMemos, listTasks } from './ledger.ts'

/** One search hit. */
export interface SearchHit {
  kind: 'note' | 'task' | 'memory'
  /** Stable identity: note slug / task id / memo id. */
  id: string
  title: string
  /** Context around the first match, at most ~140 chars. */
  snippet: string
  /** Vault-relative path for notes. */
  path?: string
  updatedAt?: string
}

/** Grouped results. */
export interface SearchResult {
  query: string
  notes: SearchHit[]
  tasks: SearchHit[]
  memory: SearchHit[]
  total: number
  truncated: boolean
}

/** Options for {@link searchAll}. */
export interface SearchOptions {
  /** Hits per group (default 8). */
  limit?: number
  /** One note larger than this is not scanned (default 256 KiB). */
  maxNoteBytes?: number
}

/** Cap the snippet and keep the match centred. */
export function excerpt(text: string, query: string, radius = 60): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return text.slice(0, radius * 2).trim()
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + query.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}

/** Whether the text contains the query case-insensitively. */
function matches(text: string | undefined, query: string): boolean {
  return text !== undefined && text.toLowerCase().includes(query.toLowerCase())
}

/**
 * Search notes, tasks and memories.
 * @param rawQuery - user query; surrounding whitespace is ignored.
 * @param options - group cap and note size cap.
 * @returns grouped hits with an explicit truncation flag.
 */
export function searchAll(rawQuery: string, options: SearchOptions = {}): SearchResult {
  const query = rawQuery.trim()
  const limit = Math.max(1, Math.min(20, options.limit ?? 8))
  const maxNoteBytes = options.maxNoteBytes ?? 256 * 1024
  if (query === '') return { query, notes: [], tasks: [], memory: [], total: 0, truncated: false }

  const notes: SearchHit[] = []
  try {
    for (const file of listFiles('notes', 500)) {
      if (!/^notes\/[^/]+\.md$/.test(file.path) || file.size > maxNoteBytes) continue
      const slug = file.path.slice('notes/'.length, -'.md'.length)
      const text = readText(vaultPath('notes', `${slug}.md`))
      if (text === undefined) continue
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
      if (!matches(slug, query) && !matches(title, query) && !matches(text, query)) continue
      notes.push({ kind: 'note', id: slug, title: title ?? slug, snippet: excerpt(text, query), path: file.path,
        updatedAt: file.modified })
      if (notes.length >= limit) break
    }
  } catch { /* an unreadable note listing means no note hits, other groups still work */ }

  const tasks: SearchHit[] = []
  try {
    for (const task of listTasks({ recover: false }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
      if (!matches(task.title, query) && !matches(task.note, query)) continue
      tasks.push({ kind: 'task', id: task.id, title: task.title,
        snippet: task.note !== undefined && matches(task.note, query) ? excerpt(task.note, query) : `状态：${task.status}`,
        updatedAt: task.updatedAt })
      if (tasks.length >= limit) break
    }
  } catch { /* ledger unavailable · tasks group stays empty */ }

  const memory: SearchHit[] = []
  try {
    for (const memo of listMemos({ recover: false }).filter(row => row.status === 'confirmed' || row.status === 'proposed')) {
      if (!matches(memo.text, query)) continue
      memory.push({ kind: 'memory', id: memo.id, title: memo.status === 'proposed' ? '记忆提案' : '已确认记忆',
        snippet: excerpt(memo.text, query), updatedAt: memo.createdAt })
      if (memory.length >= limit) break
    }
  } catch { /* memory unavailable · memory group stays empty */ }

  const total = notes.length + tasks.length + memory.length
  return { query, notes, tasks, memory, total, truncated: notes.length >= limit || tasks.length >= limit || memory.length >= limit }
}
