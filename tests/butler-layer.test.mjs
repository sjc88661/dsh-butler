import test from 'node:test'
import assert from 'node:assert/strict'
import { createButlerLayer } from '../src/host/butler-layer.ts'

function env() {
  const agents = [], hooks = new Map(), globals = new Map(), owned = new Set(['home']), reminders = new Set(['reminder'])
  const registry = { list: () => agents, isOwnedBy: (id, parent) => agents.some(a => a.id === id && a.parent === parent) }
  const ctx = { get: name => name === 'agents' ? registry : name === 'tools' ? { register: t => { globals.set(t.name, t); return () => globals.delete(t.name) } } : undefined,
    on(name, fn) { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); return () => list.splice(list.indexOf(fn), 1) } }
  function agent(id, parent) {
    const definitions = new Map(), tools = { register: t => { definitions.set(t.name, t); return () => definitions.delete(t.name) } }
    const a = { id, parent, definitions, session: { id }, ctx: { get: name => name === 'tools' ? tools : undefined } }; agents.push(a); return a
  }
  const layer = createButlerLayer(ctx, { ownsSession: id => owned.has(id), reminderSession: id => reminders.has(id) })
  return { agents, hooks, globals, owned, reminders, layer, agent }
}

test('dedicated registrations exist only in managed native agent scopes, including children', () => {
  const e = env(), home = e.agent('home'), child = e.agent('worker', home), zotero = e.agent('zotero'), otherChild = e.agent('other-child', zotero)
  const tool = { name: 'butler_example', execute() {} }
  e.layer.tools.register(tool)
  assert.equal(e.globals.size, 0)
  assert.equal(home.definitions.get(tool.name), tool)
  assert.equal(child.definitions.get(tool.name), tool)
  assert.equal(zotero.definitions.size, 0)
  assert.equal(otherChild.definitions.size, 0)
  assert.equal(e.layer.appliesTo(child), true)
  assert.equal(e.layer.appliesTo(otherChild), false)
  e.layer.stop(); assert.equal(home.definitions.size, 0); assert.equal(child.definitions.size, 0)
})

test('registry membership, not name prefix or stale task history, controls scope', () => {
  const e = env(), fake = e.agent('session-butler-topic-unregistered'), reminder = e.agent('reminder'), child = e.agent('reminder-child', reminder)
  assert.equal(e.layer.appliesTo(fake), false)
  assert.equal(e.layer.isReminder(child), true)
  e.owned.add(fake.id); assert.equal(e.layer.appliesTo(fake), true)
  e.owned.delete(fake.id); assert.equal(e.layer.appliesTo(fake), false)
  e.layer.stop()
})

test('late roots receive the same definitions once, foreign discovery stays native', () => {
  const e = env(), tool = { name: 'butler_example' }
  const dispose = e.layer.tools.register(tool)
  const home = e.agent('home'), other = e.agent('zotero')
  for (const fn of e.hooks.get('agent/created')) { fn({ agent: home }); fn({ agent: other }) }
  e.layer.refresh(); e.layer.refresh()
  assert.equal(home.definitions.size, 1); assert.equal(other.definitions.size, 0)
  assert.equal(e.layer.host.get('tools'), e.layer.tools)
  dispose(); assert.equal(home.definitions.size, 0); e.layer.stop()
})

test('loss of ownership removes scoped definitions without touching native tools', () => {
  const e = env(), home = e.agent('home')
  home.definitions.set('native', { name: 'native' })
  e.layer.tools.register({ name: 'butler_example' })
  e.owned.delete('home'); e.layer.refresh()
  assert.deepEqual([...home.definitions.keys()], ['native'])
  e.layer.stop()
})

test('new topics mount after registration but before first native schema collection', () => {
  const e = env(), topic = e.agent('new-topic')
  e.layer.tools.register({ name: 'butler_example' })
  for (const fn of e.hooks.get('agent/created')) fn({ agent: topic })
  assert.equal(topic.definitions.size, 0)
  e.owned.add(topic.id)
  for (const fn of e.hooks.get('agent/inbox/claimed')) fn({ agent: topic })
  assert.equal(topic.definitions.size, 1)
  for (const fn of e.hooks.get('agent/disposed')) fn({ agent: topic })
  assert.equal(topic.definitions.size, 0)
  assert.deepEqual(e.layer.status().sessions, [])
  e.layer.stop()
})
