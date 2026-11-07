/**
 * 本地备份 / 导出 / 恢复。
 *
 * 设计取舍：
 * - **快照式目录**而不是压缩包：没有新增依赖，任何文件管理器都能打开、核对；
 * - 每个文件都记 SHA256，恢复前逐个校验，损坏的备份能明确报出来而不是写坏数据；
 * - 备份只覆盖"不可再生成"的部分：vault（笔记/账本/画像）与 state 的 JSON 状态；
 *   `cache/`、`logs/`、`store-compactions/` 这些可再生或纯诊断目录不进备份；
 * - 恢复是破坏性操作：必须显式 `confirm: 'RESTORE'`，并且先自动做一次当前状态
 *   的 pre-restore 备份；任何校验失败都在写盘前中止。
 *
 * @module @dsh-external/dsh-butler/host/backup
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { STATE_HOME, VAULT_HOME } from './vault.ts'

/** One backed-up file record. */
export interface BackupFile {
  /** Path relative to the corresponding root (vault or state). */
  path: string
  root: 'vault' | 'state'
  bytes: number
  sha256: string
}

/** The manifest written next to every snapshot. */
export interface BackupManifest {
  version: 1
  id: string
  createdAt: string
  roots: { vault: string; state: string }
  files: BackupFile[]
  bytes: number
  counts: { vault: number; state: number }
  /** Directories excluded by policy, stated so a restore expectation is explicit. */
  excluded: string[]
  limitations: string[]
}

/** One backup as a listing sees it. */
export interface BackupSummary {
  id: string
  directory: string
  createdAt?: string
  bytes?: number
  files?: number
  broken?: string
}

/** Result of a completed backup. */
export interface BackupResult {
  id: string
  directory: string
  manifest: BackupManifest
}

/** Options for backup/restore paths; defaults point at the real homes. */
export interface BackupOptions {
  vaultHome?: string
  stateHome?: string
  backupHome?: string
  now?: () => Date
  maxBackups?: number
}

const MANIFEST = 'manifest.json'
const MAX_FILES = 5000
const MAX_BYTES = 200 * 1024 * 1024
/** Regenerable or purely diagnostic directories stay out of the snapshot. */
const EXCLUDED = ['cache', 'logs', 'store-compactions', '.tmp']
const EXCLUDED_LABEL = ['state/cache', 'state/logs', 'state/store-compactions', 'state/.tmp']

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function roots(options: BackupOptions): { vault: string; state: string; backup: string } {
  return {
    vault: resolve(options.vaultHome ?? VAULT_HOME),
    state: resolve(options.stateHome ?? STATE_HOME),
    backup: resolve(options.backupHome ?? join(options.stateHome ?? STATE_HOME, 'backups')),
  }
}

/** Recursively list files under one root, applying policy exclusions and caps. */
function collectFiles(root: string, kind: 'vault' | 'state', excluded: string[]): BackupFile[] {
  const out: BackupFile[] = []
  let bytes = 0
  const walk = (directory: string): void => {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (kind === 'state' && (excluded.includes(entry.name) || entry.name === 'backups')) continue
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) continue
      if (out.length >= MAX_FILES) return
      let size = 0
      try { size = statSync(full).size } catch { continue }
      if (bytes + size > MAX_BYTES) continue
      let hash = ''
      try { hash = sha256File(full) } catch { continue }
      out.push({ path: rel, root: kind, bytes: size, sha256: hash })
      bytes += size
    }
  }
  walk(root)
  return out
}

/** Create one backup directory; returns its manifest. */
export function createBackup(options: BackupOptions = {}): BackupResult {
  const paths = roots(options)
  const now = options.now?.() ?? new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const id = `butler-backup-${stamp}`
  let directory = join(paths.backup, id)
  let uniqueId = id
  for (let suffix = 2; existsSync(directory); suffix += 1) {
    uniqueId = `${id}-${suffix}`
    directory = join(paths.backup, uniqueId)
  }
  mkdirSync(directory, { recursive: true })
  const files: BackupFile[] = []
  for (const [kind, root] of [['vault', paths.vault], ['state', paths.state]] as const) {
    if (!existsSync(root)) continue
    for (const file of collectFiles(root, kind, EXCLUDED)) {
      const target = join(directory, kind, file.path)
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(join(root, file.path), target)
      files.push(file)
    }
  }
  const manifest: BackupManifest = {
    version: 1, id: uniqueId, createdAt: now.toISOString(), roots: { vault: paths.vault, state: paths.state }, files,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    counts: { vault: files.filter(file => file.root === 'vault').length, state: files.filter(file => file.root === 'state').length },
    excluded: EXCLUDED_LABEL,
    limitations: ['备份不包含可再生成的 cache/logs/压缩备份目录；恢复前请确认快照时间。'],
  }
  writeFileSync(join(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  pruneBackups(paths.backup, Math.max(1, options.maxBackups ?? 5))
  return { id: uniqueId, directory, manifest }
}

/** Delete the oldest snapshots beyond `keep`; failures are ignored (next pass retries). */
function pruneBackups(backupHome: string, keep: number): void {
  const directories = listBackups(backupHome).filter(entry => entry.broken === undefined)
  for (const entry of directories.slice(keep)) {
    try { rmSync(entry.directory, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** List snapshots newest-first; a damaged manifest is marked `broken`, not hidden. */
export function listBackups(backupHome: string): BackupSummary[] {
  let names: string[]
  try { names = readdirSync(backupHome) } catch { return [] }
  const summaries: BackupSummary[] = []
  for (const name of names) {
    if (!name.startsWith('butler-backup-')) continue
    const directory = join(backupHome, name)
    try {
      const manifest = JSON.parse(readFileSync(join(directory, MANIFEST), 'utf8')) as BackupManifest
      summaries.push({ id: manifest.id, directory, createdAt: manifest.createdAt, bytes: manifest.bytes, files: manifest.files.length })
    } catch (error) {
      summaries.push({ id: name, directory, broken: error instanceof Error ? error.message : String(error) })
    }
  }
  return summaries.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || right.id.localeCompare(left.id))
}

/** Restore verification outcome, computed before anything is written. */
export interface RestorePlan {
  manifest: BackupManifest
  writes: Array<{ source: string; target: string; sha256: string }>
}

/** What one restore did. */
export interface RestoreResult {
  id: string
  restored: number
  /** The backup created from the pre-restore state. */
  preRestore: string
}

/**
 * Verify one snapshot and build the write plan without touching disk.
 * @param backupHome - snapshots directory.
 * @param id - snapshot id.
 * @returns the plan.
 * @throws when the manifest is missing or any file fails its SHA256 check.
 */
export function planRestore(backupHome: string, id: string): RestorePlan {
  const directory = join(backupHome, basename(id))
  const manifestPath = join(directory, MANIFEST)
  if (!existsSync(manifestPath)) throw new Error('没有这个备份（manifest 不存在）')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('备份 manifest 版本或结构不受支持')
  const writes: RestorePlan['writes'] = []
  for (const file of manifest.files) {
    const source = join(directory, file.root, file.path)
    if (!existsSync(source)) throw new Error(`备份缺少文件：${file.root}/${file.path}`)
    const actual = sha256File(source)
    if (actual !== file.sha256) throw new Error(`备份文件校验失败：${file.root}/${file.path}`)
    const target = join(file.root === 'vault' ? manifest.roots.vault : manifest.roots.state, file.path)
    writes.push({ source, target, sha256: file.sha256 })
  }
  return { manifest, writes }
}

/**
 * Restore one snapshot, guarded by an explicit confirmation phrase.
 * @param backupHome - snapshots directory.
 * @param id - snapshot id.
 * @param confirmation - must be exactly `RESTORE`.
 * @returns what was restored and the pre-restore backup id.
 */
export function restoreBackup(backupHome: string, id: string, confirmation: string): RestoreResult {
  if (confirmation !== 'RESTORE') throw new Error('恢复需要确认词 RESTORE')
  const plan = planRestore(backupHome, id)
  // The pre-restore snapshot is created before any write, so an interrupted
  // restore still leaves a recoverable copy of the state that was replaced.
  const preRestore = createBackup({ vaultHome: plan.manifest.roots.vault, stateHome: plan.manifest.roots.state,
    backupHome, maxBackups: 5 }).id
  let restored = 0
  for (const write of plan.writes) {
    mkdirSync(join(write.target, '..'), { recursive: true })
    copyFileSync(write.source, write.target)
    restored += 1
  }
  return { id: plan.manifest.id, restored, preRestore }
}

/** Default snapshots director for this host. */
export function defaultBackupHome(): string {
  return join(STATE_HOME, 'backups')
}
