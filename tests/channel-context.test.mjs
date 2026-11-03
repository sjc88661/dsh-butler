import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'channel-context-'))
process.env.DSH_BUTLER_HOME = home
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { channelContextPolicy } = await import('../src/host/channel-attribution.ts')
const origin = { provider: 'lark', accountId: 'test-app', senderId: 'ou-owner', chatId: 'oc-private', ownerId: 'personal-owner', messageId: 'om-mobile', nativeMessageId: 'native-mobile', sessionId: 'lark-private' }
const human = id => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: '继续任务 task-phone' }] })

test('exact native input provenance survives context reload and reaches origin evidence', () => {
  const file = join(home, 'context.json')
  const contexts = new ExecutionContexts({ file, resolveUserOrigin: (sessionId, message) => message.id === origin.nativeMessageId && sessionId === origin.sessionId ? { ownerId: origin.ownerId, channelOrigin: origin } : {} })
  const identity = contexts.bindUser(origin.sessionId, human(origin.nativeMessageId))
  assert.equal(identity.ownerId, origin.ownerId)
  assert.deepEqual(identity.channelOrigin, origin)
  const reloaded = new ExecutionContexts({ file })
  assert.deepEqual(reloaded.forAgent(origin.sessionId).channelOrigin, origin)
  assert.deepEqual(reloaded.originUser(identity).channelOrigin, origin)
})

test('a fresh local origin does not inherit the previous channel source', () => {
  const contexts = new ExecutionContexts({ resolveUserOrigin: (_session, message) => message.id === origin.nativeMessageId ? { ownerId: origin.ownerId, channelOrigin: origin } : { ownerId: origin.ownerId } })
  contexts.bindUser(origin.sessionId, human(origin.nativeMessageId))
  const next = contexts.bindUser(origin.sessionId, human('local-native-next'))
  assert.equal(next.ownerId, origin.ownerId)
  assert.equal(next.channelOrigin, undefined)
  assert.equal(contexts.originUser(next).channelOrigin, undefined)
})

test('task identity guard runs before a task or active call binding can change', () => {
  const contexts = new ExecutionContexts({ beforeActivate(taskId) { if (taskId === 'other-owner') throw new Error('TASK_OWNER_CONFLICT') } })
  contexts.bindUser('desktop', human('local-native'))
  contexts.activate('my-task', contexts.forAgent('desktop'))
  assert.throws(() => contexts.activate('other-owner', contexts.forAgent('desktop')), /TASK_OWNER_CONFLICT/)
  assert.equal(contexts.forAgent('desktop').taskId, 'my-task')
})

test('a verified schedule retains its task owner without gaining human proof or another task', () => {
  const task = { id: 'task-owned-reminder', title: '保留提醒归属', status: 'pending', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', sessionId: 'local-owner-session', originMessageId: 'native-local-reminder' }
  let contexts
  const policy = channelContextPolicy({ file: join(home, 'reminder-ownership.json'), localOwnerId: origin.ownerId,
    userFor: identity => contexts.originUser(identity), taskFor: id => ({ ...task, id }) })
  contexts = new ExecutionContexts({ file: join(home, 'schedule-context.json'), ...policy })
  contexts.bindUser(task.sessionId, { id: task.originMessageId, source: { kind: 'user', rpcId: 'local-reminder-request' }, content: [{ type: 'text', text: '创建本人的提醒' }] })
  contexts.activate(task.id, contexts.forAgent(task.sessionId))
  const schedule = contexts.bindSchedule('session-butler-reminder-owned', { id: 'native-occurrence', source: { kind: 'schedule', scheduleId: 'native-schedule' } }, task.id)
  assert.equal(schedule.ownerId, origin.ownerId)
  assert.equal(schedule.channelOrigin, undefined)
  assert.equal(contexts.originUser(schedule), undefined)
  assert.equal(contexts.activate(task.id, schedule).taskId, task.id)
  assert.throws(() => contexts.activate('task-other', schedule), /TASK_CONTINUATION_REQUIRES_ID/)
  const localNext = contexts.bindUser('session-butler-reminder-owned', { id: 'real-local-next', source: { kind: 'user', rpcId: 'local-next' }, content: [{ type: 'text', text: '新的用户输入' }] })
  assert.equal(localNext.scheduleTaskId, undefined)
})
