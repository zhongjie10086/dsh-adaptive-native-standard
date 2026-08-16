import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  apply,
  detectShellPath,
  inject,
  name,
  renderDirectResult,
  resolveDirectConfig,
  resolveDirectWorkdir,
  selectDirectSessionEnvironment,
  toWindowsPath,
} from '../preset/direct-bash.mjs'

function reader(text, options = {}) {
  return {
    readFrom(offset) {
      return {
        text: offset === 0 ? text : '',
        lossy: options.lossy === true,
        nextOffset: text.length,
        ...(options.spillPath === undefined ? {} : { spillPath: options.spillPath }),
      }
    },
  }
}

function setup(options = {}) {
  const registered = []
  const spawnCalls = []
  const shellEnvCalls = []
  const ctx = {
    shellEnv: {
      collect(exec) {
        shellEnvCalls.push(exec)
        const defaults = {
          DSH_HOME: 'C:\\Users\\test\\.dsh',
          DSH_SHELL: '1',
          DSH_SESSION_ID: exec.agent?.session?.header?.id ?? 'unowned',
          DSH_SESSION_JSONL: `C:\\Users\\test\\.dsh\\sessions\\${exec.agent?.session?.header?.id ?? 'unowned'}.jsonl`,
          DSH_WEB_URL: 'http://127.0.0.1:3080',
          DSH_PRIVATE_CONTRIBUTOR: 'must-not-forward',
        }
        return typeof options.managedEnv === 'function'
          ? options.managedEnv(exec)
          : options.managedEnv ?? defaults
      },
    },
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn(spec) {
        spawnCalls.push(spec)
        if (options.spawnError !== undefined) throw options.spawnError
        if (typeof options.spawn === 'function') return options.spawn(spec)
        return {
          done: Promise.resolve(options.outcome ?? { exitCode: 0, signal: null }),
          collected: {
            stdout: reader(options.stdout ?? 'ok\n', options.stdoutOptions),
            stderr: reader(options.stderr ?? '', options.stderrOptions),
          },
        }
      },
    },
    tools: {
      register(tool) { registered.push(tool) },
    },
  }
  apply(ctx, { bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe', ...options.config })
  return { tool: registered[0], spawnCalls, shellEnvCalls }
}

function execution(overrides = {}) {
  return {
    agent: { session: { header: { id: 'direct-bash-test', cwd: 'C:\\work' } } },
    ...overrides,
  }
}

test('exports the compact Direct Bash Cordis contract', () => {
  assert.equal(name, 'direct-bash')
  assert.deepEqual([...inject].sort(), ['shellEnv', 'subprocess', 'tools'])
  const { tool } = setup()
  assert.equal(tool.name, 'bash')
  assert.deepEqual(tool.parameters.required, ['command'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['command', 'timeoutMs', 'workdir'])
  assert.doesNotMatch(tool.description, /sandbox_permissions/)
  assert.match(tool.description, /NOT OS-sandboxed/)
})

test('validates bounded execution config and honors an explicit Git Bash path', () => {
  const resolved = resolveDirectConfig({
    bashPath: 'C:\\Custom\\bash.exe',
    timeoutMs: 25,
    maxTimeoutMs: 50,
    maxOutputBytes: 100,
    maxSpillBytes: 1000,
    graceMs: 10,
  }, {})
  assert.equal(resolved.bashPath, 'C:\\Custom\\bash.exe')
  assert.equal(resolved.timeoutMs, 25)
  assert.equal(resolved.maxTimeoutMs, 50)
  assert.equal(resolved.managedSessionEnv, true)
  assert.equal(resolved.includeSessionJsonl, false)
  assert.throws(() => resolveDirectConfig({ timeoutMs: 51, maxTimeoutMs: 50 }, {}), /no greater/)
  assert.throws(() => resolveDirectConfig({ maxSpillBytes: 0 }, {}), /positive/)
  assert.throws(() => resolveDirectConfig({ managedSessionEnv: 'yes' }, {}), /must be a boolean/)
  assert.throws(() => resolveDirectConfig({ includeSessionJsonl: 1 }, {}), /must be a boolean/)
})

test('discovers Git Bash deterministically and converts only MSYS drive paths', () => {
  const winDrive = process.platform === 'win32' ? 'D:\\repo\\src' : '/d/repo/src'
  assert.equal(toWindowsPath('/d/repo/src'), winDrive)
  assert.equal(toWindowsPath('/usr/bin'), '/usr/bin')
  assert.equal(detectShellPath('C:\\Custom\\bash.exe', {}), 'C:\\Custom\\bash.exe')
  assert.equal(detectShellPath(undefined, {}), 'bash')
})

test('selects only the safe managed DSH environment and keeps JSONL opt-in', () => {
  const snapshot = {
    DSH_HOME: 'C:\\dsh',
    DSH_SHELL: '1',
    DSH_SESSION_ID: 'session-a',
    DSH_SESSION_JSONL: 'C:\\dsh\\sessions\\a.jsonl',
    DSH_WEB_URL: 'http://127.0.0.1:3080',
    DSH_PRIVATE_CONTRIBUTOR: 'secret',
    ORDINARY_KEY: 'ignored',
  }
  assert.deepEqual(selectDirectSessionEnvironment(snapshot), {
    DSH_HOME: 'C:\\dsh',
    DSH_SHELL: '1',
    DSH_SESSION_ID: 'session-a',
    DSH_WEB_URL: 'http://127.0.0.1:3080',
  })
  assert.equal(
    selectDirectSessionEnvironment(snapshot, true).DSH_SESSION_JSONL,
    'C:\\dsh\\sessions\\a.jsonl',
  )
  assert.throws(() => selectDirectSessionEnvironment(null), /must be an object/)
})

test('normalizes MSYS workdirs and resolves relative workdirs against the session workspace', () => {
  const msys = process.platform === 'win32' ? 'D:\\repo\\src' : '/d/repo/src'
  assert.equal(resolveDirectWorkdir('/d/repo/src', 'C:\\work'), msys)
  assert.equal(resolveDirectWorkdir('src', 'C:\\work'), resolve('C:\\work', 'src'))
  assert.equal(resolveDirectWorkdir(undefined, 'C:\\work'), 'C:\\work')
})

test('spawns a fresh bounded Git Bash process with normalized cwd and quiet environment', async () => {
  const { tool, spawnCalls } = setup()
  const result = await tool.execute({ command: 'printf ok', workdir: 'src', timeoutMs: 5000 }, execution())
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].argv, ['C:\\Program Files\\Git\\bin\\bash.exe', '-c', 'printf ok'])
  assert.equal(spawnCalls[0].cwd, resolve('C:\\work', 'src'))
  assert.equal(spawnCalls[0].stdio.stdout.maxBytes, 64000)
  assert.equal(spawnCalls[0].stdio.stdout.spill.maxBytes, 64 * 1024 * 1024)
  assert.equal(spawnCalls[0].env.NO_COLOR, '1')
  assert.equal(spawnCalls[0].env.GIT_PAGER, 'cat')
  assert.equal(spawnCalls[0].env.DSH_HOME, 'C:\\Users\\test\\.dsh')
  assert.equal(spawnCalls[0].env.DSH_SHELL, '1')
  assert.equal(spawnCalls[0].env.DSH_SESSION_ID, 'direct-bash-test')
  assert.equal(spawnCalls[0].env.DSH_WEB_URL, 'http://127.0.0.1:3080')
  assert.equal(spawnCalls[0].env.DSH_SESSION_JSONL, undefined)
  assert.equal(spawnCalls[0].env.DSH_PRIVATE_CONTRIBUTOR, undefined)
  assert.equal(result.exitCode, 0)
  assert.equal(result.text, 'ok\n')
})

test('keeps parent and child session identities isolated at execution time', async () => {
  const { tool, spawnCalls } = setup()
  for (const id of ['parent-session', 'child-session']) {
    await tool.execute(
      { command: 'printf "$DSH_SESSION_ID"' },
      execution({ agent: { session: { header: { id, cwd: 'C:\\work' } } } }),
    )
  }
  assert.deepEqual(spawnCalls.map(call => call.env.DSH_SESSION_ID), ['parent-session', 'child-session'])
  assert.ok(spawnCalls.every(call => call.env.DSH_SESSION_JSONL === undefined))
})

test('can explicitly include JSONL or disable all managed session variables', async () => {
  const included = setup({ config: { includeSessionJsonl: true } })
  await included.tool.execute({ command: 'true' }, execution())
  assert.equal(
    included.spawnCalls[0].env.DSH_SESSION_JSONL,
    'C:\\Users\\test\\.dsh\\sessions\\direct-bash-test.jsonl',
  )

  const disabled = setup({ config: { managedSessionEnv: false } })
  await disabled.tool.execute({ command: 'true' }, execution())
  assert.equal(disabled.spawnCalls[0].env.DSH_HOME, undefined)
  assert.equal(disabled.spawnCalls[0].env.DSH_SESSION_ID, undefined)
  assert.equal(disabled.shellEnvCalls.length, 0)
})

test('reports non-zero exits as normal structured outcomes instead of throwing', async () => {
  const { tool } = setup({ outcome: { exitCode: 2, signal: null }, stdout: '', stderr: 'syntax error\n' })
  const result = await tool.execute({ command: 'bad syntax' }, execution())
  assert.equal(result.exitCode, 2)
  assert.equal(result.stderr.text, 'syntax error\n')
  assert.match(result.text, /^\[stderr\]\nsyntax error\n\[exit code: 2\]$/)
})

test('labels streams separately and advertises complete spill files for truncated output', async () => {
  const { tool } = setup({
    stdout: 'tail-out',
    stderr: 'tail-err',
    stdoutOptions: { lossy: true, spillPath: 'C:\\Temp\\stdout.log' },
    stderrOptions: { lossy: true, spillPath: 'C:\\Temp\\stderr.log' },
  })
  const result = await tool.execute({ command: 'lots' }, execution())
  assert.equal(result.stdout.truncated, true)
  assert.equal(result.stderr.truncated, true)
  assert.match(result.text, /\[stdout truncated; full output: C:\\Temp\\stdout\.log\]/)
  assert.match(result.text, /\[stderr\]\ntail-err/)
  assert.match(result.text, /\[stderr truncated; full output: C:\\Temp\\stderr\.log\]/)
})

test('caps per-call timeout and reports timeout/signal markers', async () => {
  const { tool } = setup({
    config: { timeoutMs: 10, maxTimeoutMs: 15 },
    spawn(spec) {
      return {
        done: new Promise(resolveDone => {
          spec.signal.addEventListener('abort', () => resolveDone({ exitCode: null, signal: 'SIGTERM' }), { once: true })
        }),
        collected: { stdout: reader(''), stderr: reader('') },
      }
    },
  })
  const result = await tool.execute({ command: 'sleep 60', timeoutMs: 9999 }, execution())
  assert.equal(result.timeoutMs, 15)
  assert.equal(result.timedOut, true)
  assert.equal(result.signal, 'SIGTERM')
  assert.match(result.text, /\[timed out after 15ms\]\n\[killed by signal: SIGTERM\]$/)
})

test('propagates caller cancellation as an AbortError', async () => {
  const controller = new AbortController()
  const { tool } = setup({
    spawn(spec) {
      setTimeout(() => controller.abort(new Error('stop')), 5)
      return {
        done: new Promise(resolveDone => {
          spec.signal.addEventListener('abort', () => resolveDone({ exitCode: null, signal: 'SIGTERM' }), { once: true })
        }),
        collected: { stdout: reader(''), stderr: reader('') },
      }
    },
  })
  await assert.rejects(
    () => tool.execute({ command: 'sleep 60' }, execution({ signal: controller.signal })),
    error => error?.name === 'AbortError',
  )
})

test('only spawn/infrastructure failures become tool errors', async () => {
  const { tool } = setup({ spawnError: new Error('EPERM') })
  await assert.rejects(() => tool.execute({ command: 'pwd' }, execution()), /bash spawn failed: EPERM/)
})

test('presents calls and process outcomes as terminal cards', () => {
  const { tool } = setup()
  assert.deepEqual(
    tool.presentCall({ command: 'git status', workdir: 'repo' }),
    {
      card: 'terminal',
      title: 'git status',
      description: 'Run Git Bash command directly',
      cwd: 'repo',
    },
  )
  assert.deepEqual(
    tool.presentResult(
      { command: 'false' },
      { content: [{ type: 'text', text: 'failed\n[exit code: 1]' }], isError: false },
    ),
    { card: 'terminal', output: 'failed', exitCode: 1 },
  )
  assert.deepEqual(
    tool.presentResult(
      { command: 'x' },
      { content: [{ type: 'text', text: 'spawn failed' }], isError: true },
    ),
    { card: 'generic', content: [{ type: 'text', text: '```console\nspawn failed\n```' }] },
  )
})

test('pure renderer keeps a clean exit marker-free and makes stderr explicit', () => {
  assert.equal(renderDirectResult({
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutMs: 1000,
    stdout: { text: 'out', truncated: false },
    stderr: { text: 'warn', truncated: false },
  }), 'out\n[stderr]\nwarn')
})
