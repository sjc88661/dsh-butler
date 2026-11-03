import { AsyncLocalStorage } from 'node:async_hooks'

/** Shapes transcribed from DSH runtime-extracted-20261013 agent-loop/tools events. */
export function contextHarness() {
  const hooks = new Map(), agents = [], initiator = new AsyncLocalStorage()
  const registry = {
    list: () => agents,
    currentInitiator: () => initiator.getStore(),
    isOwnedBy: (id, owner) => agents.some(agent => agent.id === id && agent.parent === owner),
  }
  const services = new Map([['agents', registry]])
  const ctx = {
    get: name => services.get(name),
    on(name, callback, settings) {
      const list = hooks.get(name) ?? []
      settings?.prepend ? list.unshift(callback) : list.push(callback)
      hooks.set(name, list)
      return () => { const index = list.indexOf(callback); if (index >= 0) list.splice(index, 1) }
    },
  }
  function dispatch(name, args, terminal = () => undefined) {
    const chain = [...(hooks.get(name) ?? []), terminal]
    const next = () => chain.shift()(...args, next)
    return next()
  }
  async function emit(name, ...args) {
    for (const callback of [...(hooks.get(name) ?? [])]) await callback(...args)
  }
  function agent(id, parent) {
    const value = { id, parent, session: { id } }
    agents.push(value)
    return value
  }
  async function request(agent, turn, step, messages = []) {
    return initiator.run(agent, async () => {
      await dispatch('agent/pre-step', [{ agent, turn, step, messages }], () => ({ kind: 'enter', messages }))
      return dispatch('agent/request', [{ agent, turn, step, signal: new AbortController().signal }], () => ({ provider: 'local-fixture', model: 'no-model-called' }))
    })
  }
  return { ctx, services, hooks, agent, request, dispatch, emit, run: (agent, fn) => initiator.run(agent, fn) }
}
