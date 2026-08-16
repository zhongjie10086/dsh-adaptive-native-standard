import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MODE_CHAT,
  MODE_REACT,
  MODE_SPEC,
  MODE_WEAK,
  WE_NEED_STYLE,
  applyPersona,
  classifyTask,
  firstRealUserText,
  guideFor,
  parseMode,
  personaFor,
} from '../preset/router-core.mjs'

test('classifies stable build, fix, weak, and chat bands', () => {
  assert.equal(classifyTask('请从零实现一个文件搜索工具'), MODE_REACT)
  assert.equal(classifyTask('修复这个模块的兼容问题'), MODE_SPEC)
  assert.equal(classifyTask('比较这两个方案'), MODE_WEAK)
  assert.equal(classifyTask('你好！'), MODE_CHAT)
})

test('unknown short tasks route weak instead of being mistaken for chat', () => {
  assert.equal(classifyTask('怎么用？'), MODE_WEAK)
  assert.equal(classifyTask('看一下'), MODE_WEAK)
})

test('first real user text ignores plugin messages and nested payloads', () => {
  const session = {
    events: [
      { type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'anchor' }] } },
      { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'real task' }] } } },
    ],
  }
  assert.equal(firstRealUserText(session), 'real task')
})

test('persona style is optional and never asks for literal think tags', () => {
  const styled = personaFor(MODE_REACT, 'deepseek-v4-pro', 'we-need')
  assert.ok(styled.includes(WE_NEED_STYLE))
  assert.ok(styled.includes('we need'))
  assert.ok(!styled.includes('<think>'))

  const native = personaFor(MODE_REACT, 'deepseek-v4-pro', 'native')
  assert.ok(!native.includes(WE_NEED_STYLE))
})

test('adaptive guidance preserves the selected base persona and unrelated sections', () => {
  const sections = [
    { name: 'persona', text: 'old' },
    { name: 'plan-mode', text: 'stay in plan mode' },
    { name: 'safety', text: 'safe' },
  ]
  const result = applyPersona(sections, 'new')
  assert.deepEqual(result.map((section) => section.name), ['persona', 'plan-mode', 'safety', 'adaptive-persona'])
  assert.equal(result[0].text, 'old')
  assert.equal(result.at(-1).text, 'new')
})

test('public mode parser rejects transition and unknown modes', () => {
  assert.equal(parseMode('spec'), MODE_SPEC)
  assert.equal(parseMode('REACT'), MODE_REACT)
  assert.equal(parseMode('weak'), MODE_WEAK)
  assert.equal(parseMode('mixed'), null)
  assert.equal(parseMode('0.3'), null)
})

test('near-field guidance is depth-adaptive and round-aware', () => {
  const simple = guideFor(1, 'compare these options', 'deepseek-v4-flash')
  assert.match(simple, /classify this task/i)
  assert.doesNotMatch(simple, /architecture/i)

  const complex = guideFor(3, '请全面分析这个跨模块架构迁移以及兼容边界', 'deepseek-v4-pro')
  assert.match(complex, /new user task/i)
  assert.match(complex, /architecture/i)
  assert.match(complex, /information need/i)
})
