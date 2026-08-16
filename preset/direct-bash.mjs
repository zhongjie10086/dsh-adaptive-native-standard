/**
 * direct-bash — compact, Windows-native Git Bash tool with the execution
 * and result-handling improvements from DSH's official Bash stack, but no
 * sandbox or per-call approval contract.
 *
 * It keeps a small model-facing input schema while adding deterministic Git
 * Bash discovery,
 * Windows/MSYS workdir normalization, bounded timeout/cancellation, separate
 * stdout/stderr capture, full-output spill files, structured exit facts, and
 * terminal-card presentation. Non-zero exits are command outcomes, not tool
 * infrastructure errors.
 *
 * SECURITY: commands run with the DSH server process's Windows token. Selecting
 * this preset while the UI says `workspace-write` does not confine Bash; use it
 * only for trusted workspaces and prefer an explicit `danger-full-access`
 * permission preset so the displayed policy matches the real authority.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, win32 } from 'node:path'

export const name = 'direct-bash'
export const inject = ['shellEnv', 'subprocess', 'tools']

const MAX_TIMER_DELAY_MS = 2147483647
const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_TIMEOUT_MS = 600000
const DEFAULT_MAX_OUTPUT_BYTES = 64000
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024
const DEFAULT_GRACE_MS = 3000
const ENV_OVERRIDES = Object.freeze({
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
})
const SAFE_DSH_ENV_KEYS = Object.freeze([
  'DSH_HOME',
  'DSH_SHELL',
  'DSH_SESSION_ID',
  'DSH_WEB_URL',
])
const DSH_SESSION_JSONL_KEY = 'DSH_SESSION_JSONL'

/** Convert `/d/path` to `D:\\path` without mangling MSYS roots like `/usr`. */
export function toWindowsPath(value) {
  if (process.platform !== 'win32' || typeof value !== 'string' || value.length === 0) return value
  const match = /^\/([A-Za-z])(?:$|\/(.*))$/.exec(value)
  if (match === null) return value
  const drive = `${match[1].toUpperCase()}:`
  const rest = match[2] ?? ''
  return rest.length === 0 ? `${drive}\\` : `${drive}\\${rest.replace(/\//g, '\\')}`
}

function shellPathCandidates(env) {
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(root => `${root}\\Git\\bin\\bash.exe`)
  const candidates = [
    env.GIT_BASH,
    ...roots,
    env.LOCALAPPDATA === undefined ? undefined : `${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
  ]
  if (typeof env.PATH === 'string' && env.PATH.length > 0) {
    for (const directory of env.PATH.split(';')) {
      if (directory.length > 0) candidates.push(`${directory}\\bash.exe`)
    }
  }
  return candidates
}

/** Resolve an explicit shell or discover Git for Windows in deterministic order. */
export function detectShellPath(explicit, env = process.env) {
  if (process.platform !== 'win32') {
    return typeof explicit === 'string' && explicit.length > 0 ? explicit : 'bash'
  }
  if (typeof explicit === 'string' && explicit.length > 0) return toWindowsPath(explicit)
  for (const candidate of shellPathCandidates(env)) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) {
      return toWindowsPath(candidate)
    }
  }
  return 'bash'
}

const commandSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The Git Bash command to execute (`bash -c` string domain).',
    },
    workdir: {
      type: 'string',
      description: 'Optional working directory. Relative paths resolve against the session workspace.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Optional positive timeout in milliseconds, capped by the executor configuration.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

const collectedOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    spillPath: { type: 'string' },
  },
  required: ['text', 'truncated'],
}

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    timeoutMs: { type: 'number' },
    stdout: collectedOutputSchema,
    stderr: collectedOutputSchema,
  },
  required: ['text', 'exitCode', 'signal', 'timedOut', 'timeoutMs', 'stdout', 'stderr'],
}

function positiveNumber(source, key, fallback) {
  const value = source[key] ?? fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name}: ${key} must be a positive finite number`)
  }
  return value
}

function booleanValue(source, key, fallback) {
  const value = source[key] ?? fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name}: ${key} must be a boolean`)
  }
  return value
}

/**
 * Select the small, non-transcript DSH environment exposed to Direct Bash.
 * Unknown contributor keys are deliberately ignored. JSONL is opt-in because
 * it reveals the local conversation artifact and may lag the current turn.
 */
export function selectDirectSessionEnvironment(snapshot = {}, includeSessionJsonl = false) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError(`${name}: managed shell environment must be an object`)
  }
  if (typeof includeSessionJsonl !== 'boolean') {
    throw new TypeError(`${name}: includeSessionJsonl must be a boolean`)
  }
  const selected = {}
  for (const key of SAFE_DSH_ENV_KEYS) {
    if (typeof snapshot[key] === 'string') selected[key] = snapshot[key]
  }
  if (includeSessionJsonl && typeof snapshot[DSH_SESSION_JSONL_KEY] === 'string') {
    selected[DSH_SESSION_JSONL_KEY] = snapshot[DSH_SESSION_JSONL_KEY]
  }
  return Object.freeze(selected)
}

/** Parse and validate Direct Bash's bounded execution configuration. */
export function resolveDirectConfig(config = {}, env = process.env) {
  const timeoutMs = positiveNumber(config, 'timeoutMs', DEFAULT_TIMEOUT_MS)
  const maxTimeoutMs = positiveNumber(config, 'maxTimeoutMs', DEFAULT_MAX_TIMEOUT_MS)
  const maxOutputBytes = positiveNumber(config, 'maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES)
  const maxSpillBytes = positiveNumber(config, 'maxSpillBytes', DEFAULT_MAX_SPILL_BYTES)
  const graceMs = positiveNumber(config, 'graceMs', DEFAULT_GRACE_MS)
  const managedSessionEnv = booleanValue(config, 'managedSessionEnv', true)
  const includeSessionJsonl = booleanValue(config, 'includeSessionJsonl', false)
  if (timeoutMs > maxTimeoutMs) {
    throw new TypeError(`${name}: timeoutMs must be no greater than maxTimeoutMs`)
  }
  if ([timeoutMs, maxTimeoutMs, graceMs].some(value => value > MAX_TIMER_DELAY_MS)) {
    throw new TypeError(`${name}: timeoutMs, maxTimeoutMs and graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return {
    bashPath: detectShellPath(config.bashPath ?? config.shellPath, env),
    timeoutMs,
    maxTimeoutMs,
    maxOutputBytes,
    maxSpillBytes,
    graceMs,
    managedSessionEnv,
    includeSessionJsonl,
  }
}

/** Resolve a model workdir without passing MSYS drive syntax to Windows spawn. */
export function resolveDirectWorkdir(modelWorkdir, sessionCwd = process.cwd()) {
  const base = toWindowsPath(sessionCwd)
  if (typeof modelWorkdir !== 'string' || modelWorkdir.length === 0) return base
  const requested = toWindowsPath(modelWorkdir)
  if (isAbsolute(requested) || win32.isAbsolute(requested)) return requested
  return resolvePath(base, requested)
}

function timeoutSignal(upstream, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('BASH_TIMEOUT')), timeoutMs)
  let detach = () => {}
  if (upstream !== undefined) {
    const forward = () => controller.abort(upstream.reason)
    if (upstream.aborted) forward()
    else {
      upstream.addEventListener('abort', forward, { once: true })
      detach = () => upstream.removeEventListener('abort', forward)
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted && controller.signal.reason?.message === 'BASH_TIMEOUT',
    dispose() {
      clearTimeout(timer)
      detach()
    },
  }
}

function finalOutput(reader) {
  const output = reader.readFrom(0)
  return {
    text: typeof output.text === 'string' ? output.text : '',
    truncated: output.lossy === true,
    ...(typeof output.spillPath === 'string' ? { spillPath: output.spillPath } : {}),
  }
}

function streamText(label, output) {
  if (!output.truncated) return output.text
  const notice = `[${label} truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
  if (output.text.length === 0) return notice
  return `${output.text}${output.text.endsWith('\n') ? '' : '\n'}${notice}`
}

/** Render stdout, stderr and command status into one unambiguous model result. */
export function renderDirectResult(result) {
  const stdout = streamText('stdout', result.stdout)
  const stderr = streamText('stderr', result.stderr)
  let body = stdout
  if (stderr.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${stderr}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  return `${body}${body.endsWith('\n') ? '' : '\n'}${markers.join('\n')}`
}

function terminalStatus(text) {
  const exit = /(?:^|\n)\[exit code: (-?\d+)\]$/.exec(text)
  if (exit !== null) {
    return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  }
  const signal = /(?:^|\n)\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal !== null) {
    return { body: text.slice(0, signal.index), signal: signal[1] }
  }
  return { body: text, exitCode: 0 }
}

function presentCall(args) {
  if (args === null || typeof args !== 'object' || typeof args.command !== 'string') return undefined
  return {
    card: 'terminal',
    title: args.command,
    description: 'Run Git Bash command directly',
    ...(typeof args.workdir === 'string' ? { cwd: args.workdir } : {}),
  }
}

function presentResult(_args, result) {
  const block = result?.content?.length === 1 ? result.content[0] : undefined
  if (block?.type !== 'text') return undefined
  if (result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const { body, ...status } = terminalStatus(block.text)
  return { card: 'terminal', output: body, ...status }
}

/** Register the compact, unconfined Direct Bash tool. */
export function apply(ctx, config = {}) {
  const resolved = resolveDirectConfig(config)
  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in Git Bash on Windows using a fresh `bash -c` process.',
      'Use `workdir` instead of relying on `cd`; relative workdirs resolve against the session workspace.',
      'stdout and stderr are labeled separately. Non-zero command exits are normal results marked `[exit code: N]`; inspect and recover from them.',
      'Long output keeps a bounded tail and reports a private full-output spill file when available.',
      'Managed per-call environment may include $DSH_HOME, $DSH_SHELL, $DSH_SESSION_ID and $DSH_WEB_URL; the session JSONL path is excluded by default.',
      'This Direct Bash tool is NOT OS-sandboxed and does not request per-call approval; use only in trusted workspaces.',
    ].join('\n'),
    parameters: commandSchema,
    output: {
      schema: resultSchema,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec = {}) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('invalid command: expected a non-empty string')
      }
      const requestedTimeout = args.timeoutMs ?? resolved.timeoutMs
      if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
        throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(requestedTimeout)}`)
      }
      const timeoutMs = Math.min(requestedTimeout, resolved.maxTimeoutMs)
      const sessionCwd = exec.agent?.session?.header?.cwd ?? process.cwd()
      const workdir = resolveDirectWorkdir(args.workdir, sessionCwd)
      const sessionEnv = resolved.managedSessionEnv
        ? selectDirectSessionEnvironment(ctx.shellEnv.collect(exec), resolved.includeSessionJsonl)
        : {}
      const shell = await ctx.subprocess.resolveExecutable(resolved.bashPath, undefined, exec.signal)
      const fused = timeoutSignal(exec.signal, timeoutMs)
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv: [shell, '-c', args.command],
          cwd: workdir,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: resolved.maxOutputBytes, spill: { maxBytes: resolved.maxSpillBytes } },
            stderr: { maxBytes: resolved.maxOutputBytes, spill: { maxBytes: resolved.maxSpillBytes } },
          },
          graceMs: resolved.graceMs,
          signal: fused.signal,
          env: { ...ENV_OVERRIDES, ...sessionEnv },
        })
      } catch (error) {
        fused.dispose()
        throw new Error(`bash spawn failed: ${error?.message ?? String(error)}`, { cause: error })
      }

      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        throw new Error(`bash execution failed: ${error?.message ?? String(error)}`, { cause: error })
      } finally {
        fused.dispose()
      }
      if (exec.signal?.aborted && !fused.timedOut()) {
        const error = new Error('bash command aborted')
        error.name = 'AbortError'
        throw error
      }

      const result = {
        exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
        signal: typeof outcome.signal === 'string' ? outcome.signal : null,
        timedOut: fused.timedOut(),
        timeoutMs,
        stdout: finalOutput(handle.collected.stdout),
        stderr: finalOutput(handle.collected.stderr),
      }
      return { ...result, text: renderDirectResult(result) }
    },
    presentCall,
    presentResult,
  })
}
