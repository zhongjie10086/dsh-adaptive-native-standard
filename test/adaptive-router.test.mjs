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

function claim(harness, agent, message, turn = 1) {
  harness.listeners['agent/inbox/claimed']({ agent, message, turn })
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

test('minimal-first keeps the base and selected Adaptive persona from request one', async () => {
  const harness = register({
    bootstrapAnchor: 'minimal-first',
    resetOnCompaction: false,
    reasoningStyle: 'native',
    nearFieldGuidance: true,
  })
  assert.equal(harness.runtimeSuppressed, false)
  const firstAgent = makeAgent([userEvent('修复这个仓库')])
  const first = await assemble(harness, firstAgent)
  assert.deepEqual(first.sections.map(section => section.name), [
    'adaptive-bootstrap-persona',
    'adaptive-persona',
  ])
  assert.equal(first.sections[0].text, 'You are a helpful software engineer assistant.')
  assert.match(first.sections[1].text, /inspect the relevant implementation/i)
  assert.doesNotMatch(first.sections[1].text, /we need/i)
  assert.deepEqual(first.contexts, [])

  const promotedAgent = makeAgent([
    userEvent('修复这个仓库'),
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
  ])
  const promoted = await assemble(harness, promotedAgent)
  assert.deepEqual(promoted.contexts, [{ text: 'context' }])
  assert.ok(!promoted.sections.some(section => section.name === 'harness:identity'))
  assert.ok(!promoted.sections.some(section => section.name === 'deployment:persona'))
  assert.equal(promoted.sections[0].name, 'adaptive-minimal-persona')
  assert.ok(promoted.sections.some(section => section.name === 'plan-mode'))
  const adaptive = promoted.sections.find(section => section.name === 'adaptive-persona')
  assert.ok(adaptive)
  assert.match(adaptive.text, /inspect the relevant implementation/i)
  assert.doesNotMatch(adaptive.text, /we need/i)
})

test('minimal-first routes the real first request from the claimed inbox message before it is durable', async () => {
  const harness = register({
    bootstrapAnchor: 'minimal-first',
    resetOnCompaction: false,
    reasoningStyle: 'native',
    nearFieldGuidance: true,
  })
  const agent = makeAgent([])
  const message = userEvent('修复这个仓库', 'claimed-first').data

  // Production order: claim, assemble, pre-step, then append user/message.
  claim(harness, agent, message)
  const assembled = await assemble(harness, agent)
  const adaptive = assembled.sections.find(section => section.name === 'adaptive-persona')
  assert.ok(adaptive)
  assert.match(adaptive.text, /inspect the relevant implementation/i)
  assert.deepEqual(assembled.contexts, [])

  const decision = await preStep(harness, agent, [message])
  assert.deepEqual(decision.messages, [message])
})

test('claimed Weak request receives both its first-request persona and near-field guide', async () => {
  const harness = register({
    bootstrapAnchor: 'minimal-first',
    resetOnCompaction: false,
    reasoningStyle: 'native',
    nearFieldGuidance: true,
  })
  const agent = makeAgent([], 'deepseek-v4-pro')
  const message = userEvent('比较这两个架构方案的边界', 'claimed-weak').data
  claim(harness, agent, message)

  const assembled = await assemble(harness, agent)
  assert.match(
    assembled.sections.find(section => section.name === 'adaptive-persona').text,
    /keep the chosen style stable/i,
  )
  const decision = await preStep(harness, agent, [message])
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.form, 'near-field-guide')
  assert.match(decision.messages[1].content[0].text, /architecture, edge cases, and integration points/i)
})

test('minimal-first classifies React, Weak Pro, Weak Flash, and chat on request one', async () => {
  const config = {
    bootstrapAnchor: 'minimal-first',
    resetOnCompaction: false,
    reasoningStyle: 'native',
    nearFieldGuidance: true,
  }
  const cases = [
    { task: '创建一个小工具', model: 'deepseek-v4-pro', pattern: /hands-on software engineer/i },
    { task: '比较这两个方案', model: 'deepseek-v4-pro', pattern: /keep the chosen style stable/i },
    { task: '比较这两个方案', model: 'deepseek-v4-flash', pattern: /architecture and edge cases/i },
  ]
  for (const { task, model, pattern } of cases) {
    const harness = register(config)
    const result = await assemble(harness, makeAgent([userEvent(task)], model))
    const adaptive = result.sections.find(section => section.name === 'adaptive-persona')
    assert.ok(adaptive, `${task} should receive one Adaptive persona`)
    assert.match(adaptive.text, pattern)
    assert.doesNotMatch(adaptive.text, /we need/i)
    assert.deepEqual(result.contexts, [])
  }

  const chatHarness = register(config)
  const chat = await assemble(chatHarness, makeAgent([userEvent('你好')]))
  assert.deepEqual(chat.sections, [{
    name: 'adaptive-bootstrap-persona',
    text: 'You are a helpful software engineer assistant.',
  }])
  assert.deepEqual(chat.contexts, [])
})

test('minimal-first keeps the session route selected by the first real user message', async () => {
  const harness = register({
    bootstrapAnchor: 'minimal-first',
    resetOnCompaction: false,
    reasoningStyle: 'native',
    nearFieldGuidance: true,
  })
  const agent = makeAgent([
    userEvent('比较这两个架构方案的边界', 'u-first'),
    { type: 'assistant/message', seq: 2 },
    userEvent('现在直接创建并实现这个工具', 'u-later'),
  ], 'deepseek-v4-pro')

  const result = await assemble(harness, agent)
  const adaptive = result.sections.find(section => section.name === 'adaptive-persona')
  assert.ok(adaptive)
  assert.match(adaptive.text, /keep the chosen style stable/i)
  assert.doesNotMatch(adaptive.text, /hands-on software engineer/i)
})

test('minimal-first gives only Weak tasks their native near-field guide on request one', async () => {
  const harness = register({
    bootstrapAnchor: 'minimal-first',
    resetOnCompaction: false,
    reasoningStyle: 'native',
    nearFieldGuidance: true,
  })
  const weak = userEvent('比较这两个架构方案的边界', 'u-weak')
  const weakAgent = makeAgent([weak], 'deepseek-v4-pro')
  const guided = await preStep(harness, weakAgent, [weak.data])
  assert.equal(guided.messages.length, 2)
  assert.equal(guided.messages[1].source.form, 'near-field-guide')
  assert.match(guided.messages[1].content[0].text, /classify this task as build or fix/i)
  assert.match(guided.messages[1].content[0].text, /architecture, edge cases, and integration points/i)
  assert.doesNotMatch(guided.messages[1].content[0].text, /we need/i)

  for (const task of ['修复这个仓库', '创建一个小工具', '你好']) {
    const message = userEvent(task)
    const agent = makeAgent([message])
    const decision = await preStep(harness, agent, [message.data])
    assert.deepEqual(decision.messages, [message.data])
  }
})

test('minimal-first keeps its promoted surface after compaction and cold resume', async () => {
  const harness = register({ bootstrapAnchor: 'minimal-first', resetOnCompaction: false })
  const agent = makeAgent([
    userEvent('实现功能'),
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
    { type: 'compaction/end', seq: 3, data: {} },
  ])
  const result = await assemble(harness, agent)
  assert.equal(result.sections[0].name, 'adaptive-minimal-persona')
  assert.deepEqual(result.contexts, [{ text: 'context' }])
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

test('native reasoning keeps the weak task near-field guide without we-need', async () => {
  const harness = register({ reasoningStyle: 'native', nearFieldGuidance: true })
  const first = userEvent('比较这两个方案', 'u1')
  const agent = makeAgent([first, { type: 'assistant/message', seq: 2 }])
  await assemble(harness, agent)

  const followup = userEvent('再看看边界情况', 'u2')
  const decision = await preStep(harness, agent, [followup.data])
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.form, 'near-field-guide')
  assert.match(decision.messages[1].content[0].text, /classify/i)
  assert.doesNotMatch(decision.messages[1].content[0].text, /we need/i)
})

test('invalid configuration fails while mounting', () => {
  assert.throws(() => register({ defaultMode: 'mixed' }), /defaultMode/)
  assert.throws(() => register({ reasoningStyle: 'verbose' }), /reasoningStyle/)
  assert.throws(() => register({ nearFieldGuidance: 'yes' }), /nearFieldGuidance/)
  assert.throws(() => register({ maxFaults: 0 }), /maxFaults/)
  assert.throws(() => register({ bootstrapAnchor: 'whole-standard' }), /bootstrapAnchor/)
  assert.throws(() => register({ resetOnCompaction: 'sometimes' }), /resetOnCompaction/)
  assert.throws(() => register({ surprise: true }), /unknown config key/)
})
