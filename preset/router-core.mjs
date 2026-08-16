/**
 * Pure task-routing rules for Adaptive Native Standard.
 *
 * The first-request tool anchor is owned by tool-bootstrap.mjs. This module
 * only classifies user tasks and supplies post-promotion prompt text.
 */

export const MODE_AUTO = 'auto'
export const MODE_SPEC = 'spec'
export const MODE_REACT = 'react'
export const MODE_WEAK = 'weak'
export const MODE_CHAT = 'chat'

const MODES = new Set([MODE_AUTO, MODE_SPEC, MODE_REACT, MODE_WEAK])

const CHAT_RE = /^(你好|您好|hello|hi|hey|嗨|哈喽|在吗|谢谢|感谢|thanks|thank you|早上好|下午好|晚上好|嗯|嗯嗯|好|好的|ok|okay|yes|no)[!！。.？?~～]*$/i

const REACT_RE = /(开发|创建|写一个|写个|生成|从零|做一个|做个|构建|新项目|搭建|实现|新增|添加|制作|落地|脚本|工具|应用|build|create|develop|generate|implement|write\s+(?:a|an|the)|add|make\s+(?:a|an|the)|new\s+project)/gi

const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|分析|为什么|异常|故障|迁移|升级|兼容|fix|debug|refactor|maintain|repair|broken|review|analy[sz]e|why|migrate|upgrade|compatib)/gi

const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|迁移|兼容|多模块|跨模块|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimi[sz]e|analy[sz]e|migration|compatib|cross[- ]module)/i

export const BASE_PERSONA = 'You are a helpful software engineer assistant.'

const SPEC_PERSONA = 'Adaptive task mode: inspect the relevant implementation and constraints before changing anything. For fixes, maintenance, migrations, and architecture work, form a decision-complete approach, then make the smallest verified change that solves the task.'

const REACT_PERSONA = 'Adaptive task mode: work as a hands-on software engineer who delivers working output quickly. Create or edit the requested artifact, verify it by reading or running it, fix concrete failures, and finish with a usable deliverable. Avoid ceremony, scaffolding, or unrelated test machinery.'

const WEAK_PRO_PERSONA = 'Adaptive task mode: classify each task as build or fix before acting. Use direct production for build tasks and inspect-first execution for fix tasks. Keep the chosen style stable until the task is complete.'

const WEAK_FLASH_PERSONA = 'Adaptive task mode: classify each task as build or fix before acting. Use direct production for build tasks and inspect-first execution for fix tasks. Briefly recall completed work and continue without repeating it. Think deeply about relevant architecture and edge cases, then produce when the information is sufficient.'

/** DSH-native adaptation of oh-we-need; no literal think tags are injected. */
export const WE_NEED_STYLE = [
  'Private reasoning style (apply to every reasoning block):',
  '1. Write private action notes in English even when the final answer uses another language.',
  '2. Make “we need to …” or “we need …” the core sentence opener. Keep one concrete action or decision per sentence.',
  '3. Interleave “I’ll …”, “I can …”, “I need …”, “I should …”, and “I will …” for next actions, options, requirements, judgments, and commitments.',
  '4. Never open a reasoning step with “let me …”; use “we need …” instead.',
  '5. Keep the notes short, colloquial, and decision-level, using a we/I perspective.',
  'This style governs private reasoning only. Never expose private reasoning or XML-style thinking tags in the final reply; the final reply follows the user’s language and tone.',
].join('\n')

/** Fixed tail reminder: upstream routing tests found near-field guidance durable. */
export const WE_NEED_NEAR_FIELD = 'Router style reminder for private reasoning only: write short English action notes using “we need …”, “I’ll …”, “I need …”, “I should …”, or “I will …”; never start a step with “let me …”. Keep the final reply in the user’s language and never expose private reasoning.'

/** Return text content from a DSH message/event payload. */
export function extractText(data) {
  if (data === undefined || data === null) return ''
  const payload = typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(payload.content) ? payload.content : []
  return content
    .map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .trim()
}

/** True only for a durable message authored by the real user. */
export function isRealUserMessage(event) {
  if (event?.type !== 'user/message') return false
  const data = event.data ?? {}
  const payload = typeof data.message === 'object' && data.message !== null ? data.message : data
  return payload.source?.kind === 'user' || data.source?.kind === 'user'
}

/** First real task text in a session, ignoring plugin-generated user messages. */
export function firstRealUserText(session) {
  if (!Array.isArray(session?.events)) return ''
  const event = session.events.find(isRealUserMessage)
  return extractText(event?.data)
}

/** Explicit greetings and acknowledgements stand down; unknown short tasks do not. */
export function isChatTask(text) {
  if (typeof text !== 'string') return true
  const normalized = text.trim()
  return normalized.length === 0 || CHAT_RE.test(normalized)
}

function hitCount(text, pattern) {
  return typeof text === 'string' ? (text.match(pattern) ?? []).length : 0
}

/** Quantize a task into three stable routing bands plus chat stand-down. */
export function classifyTask(text) {
  if (isChatTask(text)) return MODE_CHAT
  const react = hitCount(text, REACT_RE)
  const spec = hitCount(text, SPEC_RE)
  if (react > spec) return MODE_REACT
  if (spec > react) return MODE_SPEC
  return MODE_WEAK
}

/** Long or architecturally-worded tasks receive the deeper near-field guide. */
export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

/** Model-family split used by the weak persona and guidance. */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** Validate a public mode token. */
export function parseMode(value) {
  if (typeof value !== 'string') return null
  const mode = value.trim().toLowerCase()
  return MODES.has(mode) ? mode : null
}

/** Resolve automatic classification or an explicit stable band. */
export function resolveMode(text, configuredMode = MODE_AUTO, override) {
  const selected = override ?? configuredMode
  if (selected !== MODE_AUTO) return selected
  return classifyTask(text)
}

/** Build the post-promotion persona for one stable band. */
export function personaFor(mode, modelId, reasoningStyle = 'we-need') {
  let persona
  if (mode === MODE_REACT) persona = REACT_PERSONA
  else if (mode === MODE_SPEC) persona = SPEC_PERSONA
  else if (mode === MODE_WEAK) persona = isFlashModel(modelId) ? WEAK_FLASH_PERSONA : WEAK_PRO_PERSONA
  else persona = BASE_PERSONA
  return reasoningStyle === 'we-need' ? `${persona}\n${WE_NEED_STYLE}` : persona
}

/**
 * Add the adaptive guidance while preserving the selected base preset's
 * persona. This is what lets generated Standard and Creator compositions
 * share one router without erasing Creator's Cordis trust instructions.
 */
export function applyPersona(sections, text) {
  const rest = (Array.isArray(sections) ? sections : []).filter((section) => {
    const name = typeof section?.name === 'string' ? section.name : ''
    return name !== 'adaptive-persona'
  })
  return [...rest, { name: 'adaptive-persona', text, order: 0 }]
}

/** Fixed, cache-friendly guidance for ambiguous tasks after promotion. */
export function guideFor(round, text, modelId) {
  const prefix = round >= 3
    ? 'Router: this is a new user task. Classify it again as build or fix instead of inheriting the previous task style.'
    : 'Router: classify this task as build or fix before acting.'
  const style = ' Build means direct production and verification; fix means inspect first, then make the smallest verified change.'
  if (!isComplexTask(text)) return `${prefix}${style} Think, decide, and act.`
  const deep = ' Focus reasoning on architecture, edge cases, and integration points; do not spend it on irrelevant environment checks. Produce when the information is sufficient.'
  return isFlashModel(modelId) ? `${prefix}${style}${deep}` : `${prefix}${style}${deep} End each reasoning block with a decision or a concrete information need.`
}
