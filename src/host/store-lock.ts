/** One synchronous journal transaction or recovery at a time, including other module copies/processes. */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class StorageBusyError extends Error {
  readonly code = 'STORAGE_BUSY'
  readonly path: string
  readonly ownerPid?: number
  constructor(path: string, reason: string, ownerPid?: number) {
    super(`存储正在使用：${path}（${reason}${ownerPid === undefined ? '' : `，pid=${ownerPid}`}）；本次未写入，请稍后再试`)
    this.name = 'StorageBusyError'
    this.path = path
    this.ownerPid = ownerPid
  }
}

interface Owner { version: 1; pid: number; token: string; time: string }
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const busy = (path: string, reason: string, pid?: number): never => { throw new StorageBusyError(path, reason, pid) }

function releaseOwned(directory: string, ownerName: string): void {
  // A unique filename is essential: never unlink a different/new owner's marker.
  try { unlinkSync(join(directory, ownerName)) } catch (error) { if (errno(error) !== 'ENOENT') throw error }
  try { rmdirSync(directory) } catch (error) {
    // An atomic publisher may already have installed a new, nonempty directory.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errno(error) ?? '')) throw error
  }
}

function removeDeadOwner(lock: string, journal: string, guard: (path: string) => unknown): void {
  guard(lock)
  let names: string[], owner: Owner
  try {
    const stat = lstatSync(lock)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return busy(journal, '锁目录身份无法确认')
    names = readdirSync(lock)
    if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(names[0] as string)) return busy(journal, '锁所有者无法确认；保留现场')
    const value = JSON.parse(readFileSync(join(lock, names[0] as string), 'utf8')) as Owner | null
    if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string'
      || names[0] !== `owner-${value.token}.json` || !Number.isFinite(Date.parse(value.time))) return busy(journal, '锁所有者记录无效；保留现场')
    owner = value
  } catch (error) {
    if (error instanceof StorageBusyError) throw error
    return busy(journal, '无法确认锁所有者；保留现场')
  }
  try { process.kill(owner.pid, 0) } catch (error) {
    // Age/mtime is never proof of death. EPERM and unknown errors also fail closed.
    if (errno(error) !== 'ESRCH') return busy(journal, '无法确认所有者已退出', owner.pid)
    guard(lock)
    try {
      // Only one reclaimer can delete this exact dead owner's unique filename.
      // A loser must stop here instead of unlinking/rmdir-ing a newer owner.
      unlinkSync(join(lock, names[0] as string))
      rmdirSync(lock)
    } catch {
      return busy(journal, '锁所有权已变化；本次停止', owner.pid)
    }
    return
  }
  return busy(journal, '另一个写入或恢复尚未完成', owner.pid)
}

/** Publish a fully identified, nonempty directory atomically. Never wait or retry the transaction. */
export function withJournalLock<T>(journal: string, guard: (path: string) => unknown, run: () => T): T {
  const lock = `${journal}.lock`, token = randomUUID(), ownerName = `owner-${token}.json`
  const candidate = `${lock}.${process.pid}-${token}.tmp`
  guard(lock); guard(candidate)
  mkdirSync(dirname(lock), { recursive: true })
  mkdirSync(candidate)
  let acquired = false
  try {
    writeFileSync(join(candidate, ownerName), JSON.stringify({ version: 1, pid: process.pid, token, time: new Date().toISOString() } satisfies Owner), { flag: 'wx' })
    // A guard failure is not a failed rename. Do not recover another owner or
    // continue publication after the observed path identity changed.
    guard(lock)
    try {
      renameSync(candidate, lock)
    } catch (error) {
      // A failed rename can also be an unrelated I/O failure, rather than contention.
      try { lstatSync(lock) } catch (missing) {
        if (errno(missing) !== 'ENOENT') throw missing
        // Windows reports EPERM for an occupied directory. Its owner can
        // release it between rename and this inspection; never replay a write.
        if (['EPERM', 'EEXIST', 'ENOTEMPTY', 'EBUSY'].includes(errno(error) ?? '')) return busy(journal, '锁已变化或暂时不可取得；本次停止')
        throw error
      }
      removeDeadOwner(lock, journal, guard)
      guard(lock)
      try { renameSync(candidate, lock) } catch {
        return busy(journal, '另一个写者已取得锁；本次停止')
      }
    }
    acquired = true
    return run()
  } finally {
    const ownedDirectory = acquired ? lock : candidate
    guard(ownedDirectory)
    releaseOwned(ownedDirectory, ownerName)
  }
}
