/**
 * Post-anchor task router for Adaptive Native Standard.
 *
 * tool-bootstrap.mjs exclusively owns the request-phase tool catalog. This
 * plugin leaves the persona-only bootstrap request untouched, then appends
 * spec/react/weak guidance to the selected base preset persona after a durable
 * promotion signal. Failures are fail-open and trip a small circuit breaker.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import {
  BASE_PERSONA,
  MODE_AUTO,
  MODE_CHAT,
  MODE_WEAK,
  WE_NEED_NEAR_FIELD,
  applyPersona,
  extractText,
  firstRealUserText,
  guideFor,
  isChatTask,
  isComplexTask,
  isRealUserMessage,
  parseMode,
  personaFor,
  resolveMode,
} from './router-core.mjs'

export const name = 'adaptive-router'
export const inject = ['systemPrompt', 'tools']

const TOOL_STATUS = 'dev_adaptive_status'
const TOOL_MODE = 'dev_adaptive_mode'
const PERSONA_SECTION = 'deployment:persona'
const BOOTSTRAP_MINIMAL_EXACT = 'minimal-exact'
const BOOTSTRAP_MINIMAL_PERSONA = 'minimal-persona'
const ALLOWED_KEYS = new Set([
  'defaultMode',
  'reasoningStyle',
  'nearFieldGuidance',
  'maxFaults',
  'bootstrapAnchor',
])

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec ?? {})) {
    const property = { type: meta.type }
    if (Array.isArray(meta.enum)) property.enum = meta.enum
    if (meta.description) property.description = meta.description
    properties[key] = property
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

function parseConfig(config) {
  const source = config ?? {}
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) throw new TypeError(`${name}: unknown config key(s): ${unknown.join(', ')}`)

  const defaultMode = source.defaultMode === undefined ? MODE_AUTO : parseMode(source.defaultMode)
  if (defaultMode === null) throw new TypeError(`${name}: defaultMode must be auto, spec, react, or weak`)

  const reasoningStyle = source.reasoningStyle ?? 'we-need'
  if (reasoningStyle !== 'we-need' && reasoningStyle !== 'native') {
    throw new TypeError(`${name}: reasoningStyle must be "we-need" or "native"`)
  }
  if (source.nearFieldGuidance !== undefined && typeof source.nearFieldGuidance !== 'boolean') {
    throw new TypeError(`${name}: nearFieldGuidance must be boolean`)
  }
  const maxFaults = source.maxFaults ?? 3
  if (!Number.isSafeInteger(maxFaults) || maxFaults < 1 || maxFaults > 100) {
    throw new TypeError(`${name}: maxFaults must be an integer from 1 to 100`)
  }
  const bootstrapAnchor = source.bootstrapAnchor ?? BOOTSTRAP_MINIMAL_EXACT
  if (bootstrapAnchor !== BOOTSTRAP_MINIMAL_EXACT && bootstrapAnchor !== BOOTSTRAP_MINIMAL_PERSONA) {
    throw new TypeError(`${name}: bootstrapAnchor must be "minimal-exact" or "minimal-persona"`)
  }
  return {
    defaultMode,
    reasoningStyle,
    nearFieldGuidance: source.nearFieldGuidance ?? true,
    maxFaults,
    bootstrapAnchor,
  }
}

function anchorPersonaOnly(sections) {
  let replaced = false
  const anchored = (Array.isArray(sections) ? sections : []).map((section) => {
    if (section?.name !== PERSONA_SECTION) return section
    replaced = true
    return { ...section, text: BASE_PERSONA }
  })
  if (!replaced) throw new Error(`assembled prompt has no ${PERSONA_SECTION} section`)
  return anchored
}

function modeFromArguments(raw) {
  try {
    const args = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parseMode(args?.mode)
  } catch {
    return null
  }
}

/** Last durable manual mode command; `auto` intentionally clears the lock. */
function durableOverride(session) {
  let selected
  for (const event of session?.events ?? []) {
    if (event.type !== 'tool/call' || event.data?.name !== TOOL_MODE) continue
    const parsed = modeFromArguments(event.data.arguments)
    if (parsed !== null) selected = parsed === MODE_AUTO ? undefined : parsed
  }
  return selected
}

function phaseLabel(status) {
  if (status.promoted) return 'resident'
  return status.boundary >= 0 ? 'post-compaction recovery' : 'bootstrap'
}

export function apply(ctx, config) {
  const options = parseConfig(config)
  const promotion = createEpochPromotion(['tool/call', 'assistant/message'])
  const agents = new Map()
  const liveOverrides = new Map()
  let faults = 0
  let disabled = false

  const warn = (message) => {
    try { ctx.logger.warn(message) } catch { /* logging is best-effort */ }
  }

  const trip = (where, error) => {
    faults += 1
    warn(`${name}: ${where} failed (${faults}/${options.maxFaults}); preserving the unmodified request: ${String(error?.message ?? error)}`)
    if (faults >= options.maxFaults) {
      disabled = true
      liveOverrides.clear()
      warn(`${name}: circuit breaker opened; restart the Harness after fixing the plugin`)
    }
  }

  const selectedMode = (session, taskText) => resolveMode(
    taskText,
    options.defaultMode,
    liveOverrides.has(session.id) ? liveOverrides.get(session.id) : durableOverride(session),
  )

  // The generated composition owns its real base persona (Standard or
  // Creator). We replace the assembled sections only for request #1, then
  // preserve that base persona and append adaptive guidance after promotion.
  // A static `complete: true` persona is intentionally forbidden because DSH
  // restores complete sections after the waterfall and would erase routing.
  if (options.bootstrapAnchor === BOOTSTRAP_MINIMAL_EXACT) {
    ctx.effect(
      () => ctx.systemPrompt.suppressRuntimeContext(),
      'adaptive-router.suppressRuntimeContext()',
    )
  }

  ctx.on('session/event', (session, event) => {
    promotion.observe(session, event)
    if (event.type === 'tool/call' && event.data?.name === TOOL_MODE) {
      const parsed = modeFromArguments(event.data.arguments)
      if (parsed === MODE_AUTO) liveOverrides.delete(session.id)
      else if (parsed !== null) liveOverrides.set(session.id, parsed)
    }
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    try {
      const agent = context.agent
      if (agent === undefined) return assembled
      const session = agent.session
      agents.set(session.id, agent)
      if (!promotion.status(agent).promoted) {
        if (options.bootstrapAnchor === BOOTSTRAP_MINIMAL_PERSONA) {
          return {
            ...assembled,
            sections: anchorPersonaOnly(assembled.sections),
          }
        }
        return {
          ...assembled,
          sections: [{ name: 'adaptive-bootstrap-persona', text: BASE_PERSONA }],
          contexts: [],
        }
      }
      if (disabled) return assembled

      const taskText = firstRealUserText(session)
      const mode = selectedMode(session, taskText)
      if (mode === MODE_CHAT || taskText.length === 0) return assembled
      const persona = personaFor(mode, agent.options?.model, options.reasoningStyle)
      return { ...assembled, sections: applyPersona(assembled.sections, persona) }
    } catch (error) {
      trip('prompt assembly', error)
      return assembled
    }
  })

  // `session/event` fires after a claimed inbox message becomes durable, too
  // late to add a companion to that same text-only model request. Transform
  // the claimed `agent/pre-step` messages instead: the fixed reminder lands
  // immediately after the real user message and is persisted with the step.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || disabled) return decision
    try {
      if (agent === undefined || !promotion.status(agent).promoted || !Array.isArray(decision.messages)) {
        return decision
      }
      if (decision.messages.some(message =>
        message?.source?.kind === 'plugin'
        && message.source.plugin === name
        && message.source.form === 'near-field-guide')) return decision
      const userMessage = decision.messages.findLast(message => message?.source?.kind === 'user')
      if (userMessage === undefined) return decision
      const text = extractText(userMessage)
      if (isChatTask(text)) return decision
      const session = agent.session
      const mode = selectedMode(session, firstRealUserText(session))
      const round = session.events.filter(isRealUserMessage).length + 1
      const guidance = []
      if (options.nearFieldGuidance && mode === MODE_WEAK) {
        guidance.push(guideFor(round, text, agent.options?.model))
      }
      if (options.reasoningStyle === 'we-need') guidance.push(WE_NEED_NEAR_FIELD)
      if (guidance.length === 0) return decision
      return {
        ...decision,
        messages: [...decision.messages, {
          id: `adaptive-guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          source: { kind: 'plugin', plugin: name, form: 'near-field-guide' },
          content: [{ type: 'text', text: guidance.join('\n\n') }],
        }],
      }
    } catch (error) {
      trip('near-field guidance', error)
      return decision
    }
  })

  const registerTool = (tool) => ctx.effect(() => ctx.tools.register({
    ...tool,
    parameters: toJsonSchema(tool.parameters),
  }))

  registerTool({
    name: TOOL_STATUS,
    description: 'Show this session’s Adaptive Native routing mode, anchor phase, model family, style, task classification, manual lock, and circuit-breaker state.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(_args, execution) {
      const agent = execution?.agent ?? [...agents.values()].at(-1)
      if (agent === undefined) return 'no agent session'
      const session = agent.session
      const taskText = firstRealUserText(session)
      const override = liveOverrides.has(session.id) ? liveOverrides.get(session.id) : durableOverride(session)
      const mode = selectedMode(session, taskText)
      const status = promotion.status(agent)
      return [
        `phase=${phaseLabel(status)}`,
        `mode=${mode}`,
        `override=${override ?? 'auto'}`,
        `model=${agent.options?.model ?? 'unknown'}`,
        `reasoning-style=${options.reasoningStyle}`,
        `bootstrap-anchor=${options.bootstrapAnchor}`,
        `near-field=${options.nearFieldGuidance ? 'on' : 'off'}`,
        `complex=${isComplexTask(taskText) ? 'yes' : 'no'}`,
        `task=${JSON.stringify(taskText.slice(0, 120))}`,
        `circuit=${disabled ? 'open' : 'closed'} (${faults}/${options.maxFaults})`,
      ].join('\n')
    },
  })

  registerTool({
    name: TOOL_MODE,
    description: 'Lock this session to a stable reasoning mode. spec=inspect-first, react=direct production, weak=model classifies each task, auto=clear the lock. The next request applies it.',
    parameters: {
      mode: {
        type: 'string',
        enum: ['spec', 'react', 'weak', 'auto'],
        required: true,
        description: 'spec, react, weak, or auto',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, execution) {
      const parsed = parseMode(args.mode)
      if (parsed === null) return `invalid mode ${JSON.stringify(args.mode)}`
      const session = execution?.agent?.session
      if (session === undefined) return 'no agent session'
      if (parsed === MODE_AUTO) liveOverrides.delete(session.id)
      else liveOverrides.set(session.id, parsed)
      const taskText = firstRealUserText(session)
      const resolved = selectedMode(session, taskText)
      return parsed === MODE_AUTO
        ? `mode lock cleared; automatic routing resolves to ${resolved}`
        : `mode locked to ${parsed}; the next request applies it`
    },
  })
}
