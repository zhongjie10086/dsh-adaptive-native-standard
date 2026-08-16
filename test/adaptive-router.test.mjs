import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../preset/adaptive-router.mjs'

function userEvent(text, id = `u-${Math.random()}`) {
  return {
    type: 'user/message',
    id,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function register(config = {}) {
  const listeners = {}
  const tools = new Map()
  const warnings = []
  let currentAgent
  let runtimeSuppressed = false
  const ctx = {
    on(event, callback) { listeners[event] = callback },
    effect(setup) { setup() },
    get(service) { return service === 'agent' ? currentAgent : undefined },
    logger: { warn(message) { warnings.push(message) } },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    systemPrompt: {
      suppressRuntimeContext() {
        runtimeSuppressed = true
        return () => { runtimeSuppressed = false }
      },
    },
  }
  apply(ctx, config)
  return {
    listeners,
    tools,
    warnings,
    get runtimeSuppressed() { return runtimeSuppressed },
    setCurrent(agent) { currentAgent = agent },
  }
}

function makeAgent(events, model = 'deepseek-v4-pro') {
  const injected = []
  const session = { id: `s-${Math.random()}`, events, header: { delegationDepth: 0 } }
  return {
    session,
    options: { model },
    inbox: { append(lane, message) { injected.push({ lane, message }) } },
    injected,
  }
}

async function assemble(harness, agent) {
  const base = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona', text: 'BASE PRESET PERSONA', order: -900 },
      { name: 'plan-mode', text: 'plan rules' },
    ],
    contexts: harness.runtimeSuppressed ? [] : [{ text: 'context' }],
    tools: [{ name: 'bash' }],
  }
  return await harness.listeners['system-prompt/assemble'](undefined, { agent }, async () => base)
}

async function preStep(harness, agent, messages) {
  return await harness.listeners['agent/pre-step'](
    { agent },
    async () => ({ kind: 'enter', messages }),
  )
}

test('declares only the services it consumes', () => {
  assert.equal(name, 'adaptive-router')
  assert.deepEqual(inject, ['systemPrompt', 'tools'])
})

test('minimal-exact leaves persona ownership to the generated base and suppresses runtime context', () => {
  const harness = register()
  assert.equal(harness.runtimeSuppressed, true)
})

test('minimal-persona keeps runtime context and changes only the deployment persona before promotion', async () => {
  const harness = register({ bootstrapAnchor: 'minimal-persona' })
  assert.equal(harness.runtimeSuppressed, false)
  const agent = makeAgent([userEvent('实现一个小工具')])
  const result = await assemble(harness, agent)
  assert.deepEqual(result.sections, [
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
    { name: 'deployment:persona', text: 'You are a helpful software engineer assistant.', order: -900 },
    { name: 'plan-mode', text: 'plan rules' },
  ])
  assert.deepEqual(result.contexts, [{ text: 'context' }])
})

test('minimal-persona restores the base persona after promotion', async () => {
  const harness = register({ bootstrapAnchor: 'minimal-persona' })
  const agent = makeAgent([userEvent('实现一个小工具'), { type: 'assistant/message', seq: 2 }])
  const result = await assemble(harness, agent)
  assert.equal(
    result.sections.find(section => section.name === 'deployment:persona').text,
    'BASE PRESET PERSONA',
  )
  assert.ok(result.sections.some(section => section.name === 'adaptive-persona'))
})

test('leaves only the exact bootstrap persona before promotion', async () => {
  const harness = register()
  const agent = makeAgent([userEvent('实现一个小工具')])
  const result = await assemble(harness, agent)
  assert.deepEqual(result.sections, [{
    name: 'adaptive-bootstrap-persona',
    text: 'You are a helpful software engineer assistant.',
  }])
  assert.deepEqual(result.contexts, [])
})

test('adds the classified persona only after durable promotion', async () => {
  const harness = register()
  const agent = makeAgent([userEvent('实现一个小工具'), { type: 'assistant/message', seq: 2 }])
  const result = await assemble(harness, agent)
  const persona = result.sections.find((section) => section.name === 'adaptive-persona')
  assert.match(persona.text, /hands-on software engineer/)
  assert.match(persona.text, /we need/i)
  assert.equal(result.sections.find((section) => section.name === 'deployment:persona').text, 'BASE PRESET PERSONA')
  assert.ok(result.sections.some((section) => section.name === 'plan-mode'))
  assert.deepEqual(result.contexts, [])
})

test('chat sessions stand down after promotion', async () => {
  const harness = register()
  const agent = makeAgent([userEvent('你好'), { type: 'assistant/message', seq: 2 }])
  const result = await assemble(harness, agent)
  assert.ok(!result.sections.some((section) => section.name === 'adaptive-persona'))
})

test('manual mode tool locks and clears the live session', async () => {
  const harness = register({ reasoningStyle: 'native' })
  const agent = makeAgent([userEvent('实现并修复这个功能'), { type: 'assistant/message', seq: 2 }])
  harness.setCurrent(agent)
  const modeTool = harness.tools.get('dev_adaptive_mode')
  assert.ok(modeTool)

  assert.match(modeTool.execute({ mode: 'spec' }, { agent }), /locked to spec/)
  let result = await assemble(harness, agent)
  assert.match(result.sections.find((section) => section.name === 'adaptive-persona').text, /inspect the relevant implementation/i)

  assert.match(modeTool.execute({ mode: 'auto' }, { agent }), /cleared/)
  result = await assemble(harness, agent)
  assert.ok(result.sections.some((section) => section.name === 'adaptive-persona'))
})

test('weak sessions receive one post-promotion near-field guide', async () => {
  const harness = register()
  const first = userEvent('比较这两个方案', 'u1')
  const agent = makeAgent([first, { type: 'assistant/message', seq: 2 }], 'deepseek-v4-flash')
  await assemble(harness, agent)

  const followup = userEvent('再看看边界情况', 'u2')
  const decision = await preStep(harness, agent, [followup.data])
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.form, 'near-field-guide')
  assert.match(decision.messages[1].content[0].text, /classify/i)
  assert.match(decision.messages[1].content[0].text, /we need/i)
})

test('a claimed real user message receives a we-need tail reminder in react mode', async () => {
  const harness = register()
  const first = userEvent('实现一个小工具', 'u1')
  const agent = makeAgent([first, { type: 'assistant/message', seq: 2 }])
  await assemble(harness, agent)

  const followup = userEvent('继续实现')
  const decision = await preStep(harness, agent, [followup.data])
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.form, 'near-field-guide')
  assert.match(decision.messages[1].content[0].text, /we need/i)
  assert.doesNotMatch(decision.messages[1].content[0].text, /<think>/i)
})

test('native reasoning style does not add a react-mode style reminder', async () => {
  const harness = register({ reasoningStyle: 'native' })
  const first = userEvent('实现一个小工具', 'u1')
  const agent = makeAgent([first, { type: 'assistant/message', seq: 2 }])
  await assemble(harness, agent)

  const followup = userEvent('继续实现', 'u2')
  const decision = await preStep(harness, agent, [followup.data])
  assert.deepEqual(decision.messages, [followup.data])
})

test('invalid configuration fails while mounting', () => {
  assert.throws(() => register({ defaultMode: 'mixed' }), /defaultMode/)
  assert.throws(() => register({ reasoningStyle: 'verbose' }), /reasoningStyle/)
  assert.throws(() => register({ nearFieldGuidance: 'yes' }), /nearFieldGuidance/)
  assert.throws(() => register({ maxFaults: 0 }), /maxFaults/)
  assert.throws(() => register({ bootstrapAnchor: 'whole-standard' }), /bootstrapAnchor/)
  assert.throws(() => register({ surprise: true }), /unknown config key/)
})
