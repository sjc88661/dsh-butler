/**
 * 飞书提醒：发送器（token 缓存/错误脱敏）+ 看门狗（只推管家提醒、一次 occurrence 一次、
 * 失败重试上限、落盘幂等）。
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readFileSync as read } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'))
const ts = createRequire(join(checkout, 'package.json'))('typescript')

/** Load one TS module with a stubbed `node:fs`/vault seam when needed. */
function loadModule(relative, imports = {}) {
  const file = join(root, relative)
  const compiled = ts.transpileModule(read(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console, process, JSON, Object, Array, Date, String, Number, Error, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval, URL, fetch, AbortController, Uint8Array, Response,
    require: id => imports[id] ?? requireImpl(id),
  }, { filename: file })
  return module.exports
}
const requireImpl = createRequire(import.meta.url)

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'feishu-'))
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')

const { createFeishuSender, formatDueReminderText } = loadModule('src/host/feishu.ts', {
  'node:fs': requireImpl('node:fs'),
})
const { createFeishuReminderWatcher } = loadModule('src/host/feishu-reminders.ts', {
  'node:fs': requireImpl('node:fs'),
  './vault.ts': {
    statePath: (...parts) => join(process.env.DSH_BUTLER_HOME, ...parts),
    writeText: (path, content) => requireImpl('node:fs').writeFileSync(path, content, 'utf8'),
  },
  './feishu.ts': { formatDueReminderText },
})

let server
let origin
let tokenRequests = 0
let messageRequests = []
let messageFailure = false

before(async () => {
  mkdirSync(join(process.env.DSH_BUTLER_HOME), { recursive: true })
  server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        tokenRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 'test-token', expire: 7200 }))
        return
      }
      if (request.url.startsWith('/open-apis/im/v1/messages')) {
        messageRequests.push({ body, authorization: request.headers.authorization })
        if (messageFailure) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 99991663, msg: 'invalid token' }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 0, msg: 'ok', data: { message_id: `om_${messageRequests.length}` } }))
        return
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
after(() => { server?.close?.() })

test('formatDueReminderText names the reminder and how late it is', () => {
  const late = formatDueReminderText({ title: ' 吃药 ', scheduledAt: '2026-11-07T11:00:00.000Z' }, new Date('2026-11-07T13:05:00.000Z'))
  assert.match(late, /【管家提醒】吃药/)
  assert.match(late, /已过 2 小时 5 分/)
  assert.match(formatDueReminderText({ title: '无时间' }), /【管家提醒】无时间/)
})

test('sender caches the tenant token and posts one text message to the configured owner', async () => {
  tokenRequests = 0
  messageRequests = []
  messageFailure = false
  const sender = createFeishuSender({ appId: 'cli_test', appSecret: 'secret-value', ownerOpenId: 'ou_owner', baseUrl: origin })
  const first = await sender.sendText('第一条提醒')
  const second = await sender.sendText('第二条提醒')
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { ok: true, messageId: 'om_1' })
  assert.equal(second.messageId, 'om_2')
  assert.equal(tokenRequests, 1, 'token is cached across sends')
  assert.equal(messageRequests.length, 2)
  assert.equal(messageRequests[0].body.receive_id, 'ou_owner')
  assert.equal(messageRequests[0].body.msg_type, 'text')
  assert.equal(JSON.parse(messageRequests[0].body.content).text, '第一条提醒')
  assert.equal(messageRequests[0].authorization, 'Bearer test-token')
  assert.equal(sender.status().sent, 2)
})

test('feishu refusals are reported by code/msg and never leak the secret', async () => {
  tokenRequests = 0
  messageRequests = []
  messageFailure = true
  const sender = createFeishuSender({ appId: 'cli_test', appSecret: 'super-secret', ownerOpenId: 'ou_owner', baseUrl: origin })
  const refused = await sender.sendText('会失败')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 99991663)
  assert.match(refused.error, /发送提醒失败.*99991663/)
  assert.doesNotMatch(String(refused.error), /super-secret/)
  assert.doesNotMatch(JSON.stringify(sender.status()), /super-secret/)
})

test('watcher pushes only butler reminders, once per occurrence, and persists across reloads', async () => {
  tokenRequests = 0
  messageRequests = []
  messageFailure = false
  const stateFile = join(home, 'state', 'feishu-reminders.json')
  const rows = [
    { id: 'butler-1', title: '吃药', scheduledAt: '2026-11-07T11:00:00.000Z', status: 'active', target: { kind: 'session', sessionId: 'session-butler-reminder-a' } },
    { id: 'native-1', title: '原生任务', scheduledAt: '2026-11-07T11:00:00.000Z', status: 'active', target: { kind: 'session', sessionId: 'session-other' } },
    { id: 'butler-future', title: '未来', scheduledAt: '2030-01-01T00:00:00.000Z', status: 'active', target: { kind: 'session', sessionId: 'session-butler-reminder-b' } },
  ]
  const sender = createFeishuSender({ appId: 'cli_test', appSecret: 's', ownerOpenId: 'ou_owner', baseUrl: origin })
  const watcher = createFeishuReminderWatcher({ sender, catalog: async () => rows, stateFile, now: () => new Date('2026-11-07T12:00:00.000Z') })
  const first = await watcher.tick()
  assert.deepEqual([...first.sent], ['butler-1'])
  assert.equal(messageRequests.length, 1)
  assert.match(JSON.parse(messageRequests[0].body.content).text, /吃药/)

  const second = await watcher.tick()
  assert.deepEqual([...second.sent], [], 'a sent occurrence is never repeated')
  assert.equal(messageRequests.length, 1)

  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(persisted.occurrences['butler-1@2026-11-07T11:00:00.000Z'].status, 'sent')

  const reloaded = createFeishuReminderWatcher({ sender, catalog: async () => rows, stateFile, now: () => new Date('2026-11-07T12:00:00.000Z') })
  assert.deepEqual([...(await reloaded.tick()).sent], [])
  assert.equal(reloaded.status().sent, 1)
})

test('a failing send is retried at most three times and then marked gave-up', async () => {
  messageFailure = true
  const stateFile = join(home, 'state', 'feishu-reminders-fail.json')
  const rows = [{ id: 'butler-fail', title: '失败的提醒', scheduledAt: '2026-11-07T11:00:00.000Z', status: 'active', target: { kind: 'session', sessionId: 'session-butler-reminder-c' } }]
  const sender = createFeishuSender({ appId: 'cli_test', appSecret: 's', ownerOpenId: 'ou_owner', baseUrl: origin })
  const watcher = createFeishuReminderWatcher({ sender, catalog: async () => rows, stateFile, now: () => new Date('2026-11-07T12:00:00.000Z') })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tick = await watcher.tick()
    assert.equal(tick.failed.length, 1, `attempt ${attempt}`)
  }
  const afterGaveUp = await watcher.tick()
  assert.deepEqual([...afterGaveUp.failed], [], 'gave-up occurrences stop retrying')
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(Object.values(persisted.occurrences)[0].status, 'gave-up')
  assert.equal(watcher.status().gaveUp, 1)
  messageFailure = false
})
