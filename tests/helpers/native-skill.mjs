// Execute the exact shipped hook bodies. Only service/module boundaries are faked.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../fixtures/native-tool-skill.mjs', import.meta.url), 'utf8')
const provenance = JSON.parse(readFileSync(new URL('../fixtures/skill-provenance.json', import.meta.url), 'utf8'))
if (createHash('sha256').update(source).digest('hex') !== provenance.sha256) throw new Error('Native skill fixture was modified')
const body = source.replace(/^import .+;\r?$/gm, '').replace(/^export \{[^\n]+\};\r?$/gm, '')
const factory = new Function('createHash', 'z', 'defineTool', 'createUserMessage', 'escapeText', 'isModelInvocable', 'isSkillName', 'isUserInvocable', 'renderSkillContent', `${body}\nreturn {apply};`)
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
const render = skill => `<skill_content name="${skill.name}">\n<skill_resources>${JSON.stringify(skill.resourceBase ?? {})}</skill_resources>\n<skill_instructions>${skill.content}</skill_instructions>\n</skill_content>`
export const nativeSkill = factory(createHash, { object: value => value, number: () => ({ default: value => value }) }, value => value,
  value => freeze({ id: randomUUID(), role: 'user', ...value }),
  text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  skill => skill.invocation.modelInvocable, name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name),
  skill => skill.invocation.userInvocable, render)

export function skillEnvironment(install, options = {}) {
  const recorded = JSON.parse(readFileSync(new URL('../fixtures/skills-64.json', import.meta.url), 'utf8'))
  const definitions = new Map(recorded.map(summary => [summary.name, { ...summary, provider: 'fixture',
    invocation: { modelInvocable: true, userInvocable: true }, content: `FULL_BODY_${summary.name}`,
    resourceBase: { kind: 'directory', path: `E:/skills/${summary.name}` } }]))
  const hooks = new Map(), registrations = new Map(), agents = [], gets = [], snapshots = [], nativeDecisions = []
  const entries = agent => [...definitions.values(), ...(agent?.additions ?? [])].reduce((all, skill) => all.set(skill.name, skill), new Map())
  const skills = {
    async snapshot(lookup) { snapshots.push(lookup); return { skills: [...entries(lookup.scope).values()].map(({ content, ...summary }) => summary), complete: lookup.scope?.complete !== false } },
    async list(lookup) { return (await this.snapshot(lookup)).skills },
    async get(name, lookup) { gets.push({ name, ...lookup }); return entries(lookup.scope).get(name) },
  }
  const tools = {
    register(tool) { if (options.failRegistration && tool.name === 'butler_skills') throw new Error('simulated registration failure'); registrations.set(tool.name, tool); return () => registrations.delete(tool.name) },
    get: (name, agent) => agent?.hidden?.has(name) ? undefined : agent?.overrides?.get(name) ?? (name === 'skill' && agent?.shadow ? agent.shadow : registrations.get(name)),
  }
  const ctx = { tools, skills, logger: { warn() {} },
    get: name => name === 'tools' ? tools : name === 'skills' ? skills : name === 'agents' ? { list: () => agents, isOwnedBy: (id, owner) => agents.some(a => a.id === id && a.parent === owner) } : undefined,
    on(name, fn, settings) { const list = hooks.get(name) ?? []; settings?.prepend ? list.unshift(fn) : list.push(fn); hooks.set(name, list); return () => list.splice(list.indexOf(fn), 1) },
  }
  nativeSkill.apply(ctx)
  const originalSkill = registrations.get('skill')
  ctx.on('agent/pre-step', async (_payload, next) => { const decision = await next(); nativeDecisions.push(decision); return decision }, { prepend: true })
  let loading = install?.(ctx)
  function agent(id = 'normal', parent) {
    const events = [], surface = { nodes: [] }
    const session = { id, header: { cwd: `E:/workspace/${id}` }, surface,
      get seq() { return events.length }, eventAt: seq => events[seq], snapshotEvents: () => [...events] }
    const a = { id, parent, session, events, ctx: { get: name => ctx.get(name) } }; agents.push(a); return a
  }
  async function step(a, messages = [], reject = false) {
    const payload = { agent: a, messages, signal: new AbortController().signal, turn: 1, step: 1 }
    const queue = [...hooks.get('agent/pre-step') ?? [], () => ({ kind: reject ? 'reject' : 'enter', messages })]
    const next = () => queue.shift()(payload, next)
    return next()
  }
  function commit(a, decision) {
    for (const message of decision.messages ?? []) { const seq = a.events.length; a.events.push({ seq, type: 'user/message', data: message }); a.session.surface.nodes.push(seq) }
  }
  const search = (a, args) => registrations.get('butler_skills').execute(args, { agent: a, id: 'skill-search', signal: new AbortController().signal })
  return { ctx, tools, skills, definitions, registrations, agents, gets, snapshots, nativeDecisions, originalSkill,
    loading, agent, step, commit, search, reload() { loading.stop(); loading = install(ctx); this.loading = loading } }
}
