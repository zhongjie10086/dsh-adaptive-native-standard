import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { installPreset } from '../index.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'preset')

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-adaptive-native-standard-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const messages = { info: [], warn: [] }
  const log = {
    info(message) { messages.info.push(message) },
    warn(message) { messages.warn.push(message) },
  }
  return { home, log, messages, target: join(home, '.agent-presets', 'adaptive-native-standard') }
}

test('bundle installer deploys the complete preset and is idempotent', async t => {
  const { home, log, target } = await fixture(t)

  const first = await installPreset({ dshHome: home, log })
  assert.equal(first.action, 'installed')
  assert.match(await readFile(join(target, 'preset.yml'), 'utf8'), /^name: Adaptive Native Standard$/m)
  const owner = JSON.parse(await readFile(join(target, '.dsh-preset-owner.json'), 'utf8'))
  assert.equal(owner.package, 'dsh-adaptive-native-standard')
  assert.equal(owner.preset, 'adaptive-native-standard')

  const second = await installPreset({ dshHome: home, log })
  assert.equal(second.action, 'unchanged')
})

test('bundle installer safely adopts an identical manual installation', async t => {
  const { home, log, target } = await fixture(t)
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true })

  const result = await installPreset({ dshHome: home, log })
  assert.equal(result.action, 'adopted')
  const owner = JSON.parse(await readFile(join(target, '.dsh-preset-owner.json'), 'utf8'))
  assert.equal(owner.package, 'dsh-adaptive-native-standard')
})

test('bundle installer preserves a conflicting unowned preset', async t => {
  const { home, log, messages, target } = await fixture(t)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'preset.yml'), 'name: Local Custom Preset\n', 'utf8')

  const result = await installPreset({ dshHome: home, log })
  assert.equal(result.action, 'skipped')
  assert.equal(await readFile(join(target, 'preset.yml'), 'utf8'), 'name: Local Custom Preset\n')
  await assert.rejects(readFile(join(target, '.dsh-preset-owner.json'), 'utf8'), { code: 'ENOENT' })
  assert.equal(messages.warn.length, 1)
})

test('bundle installer updates owned content with a recoverable backup', async t => {
  const { home, log, target } = await fixture(t)
  await installPreset({ dshHome: home, log })
  await writeFile(join(target, 'preset.yml'), 'name: Managed Local Edit\n', 'utf8')

  const result = await installPreset({ dshHome: home, log })
  assert.equal(result.action, 'updated')
  assert.ok(result.backup)
  assert.equal(await readFile(join(result.backup, 'preset.yml'), 'utf8'), 'name: Managed Local Edit\n')
  assert.match(await readFile(join(target, 'preset.yml'), 'utf8'), /^name: Adaptive Native Standard$/m)
  assert.ok((await readdir(join(home, '.preset-backups'))).length >= 1)
})
