import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const preset = join(root, 'preset')
const composition = readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')
const metadata = readFileSync(join(preset, 'preset.yml'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundlePatch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const bundleInstaller = readFileSync(join(root, 'index.mjs'), 'utf8')
const lock = JSON.parse(readFileSync(join(root, 'upstream-lock.json'), 'utf8'))

assert.equal(packageJson.name, 'dsh-adaptive-native-standard')
assert.equal(packageJson.version, '0.2.0')
assert.equal(packageJson.main, './index.mjs')
assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml')
assert.ok(packageJson.files.includes('preset/'))
assert.match(bundlePatch, /- id: adaptive-native-standard-installer\s+name: dsh-adaptive-native-standard/)
assert.match(bundleInstaller, /export async function installPreset/)
assert.match(bundleInstaller, /\.dsh-preset-owner\.json/)
assert.match(metadata, /^name: Adaptive Native Standard$/m)
assert.match(composition, /bootstrapTools: \[pwsh, read, write, edit, glob, grep\]/)
assert.match(composition, /compactionTools: \[pwsh, read, write, edit, glob, grep\]/)
assert.match(composition, /suppressedContextSources: \[\]/)
assert.match(composition, /bootstrapAnchor: minimal-persona/)
assert.match(composition, /residentTools: \[dev_tool_search, skill_search, skill_load, dev_adaptive_status, dev_adaptive_mode\]/)
assert.match(composition, /- id: direct-bash\s+name: \.\/direct-bash\.mjs/)
assert.match(composition, /managedSessionEnv: true/)
assert.match(composition, /includeSessionJsonl: false/)
assert.match(composition, /- id: tool-jobs\s+name: '@deepseek-ai\/dsh-tool-jobs'/)
assert.equal([...composition.matchAll(/backgroundMode: continuable/g)].length, 2)
assert.doesNotMatch(composition, /adaptive-native-direct-v2|direct-bash-v2|custom-bash|gitbash-executor|gitbash-prompt-parity/)
assert.doesNotMatch(composition, /^\s*complete:\s*true\s*$/m, 'a complete base persona would erase dynamic routing')
assert.equal([...composition.matchAll(/^\s*name:\s+\.\.\/\S+/gm)].length, 0, 'preset must be self-contained')

const referenced = [...composition.matchAll(/^\s*name:\s+(\.\/\S+)\s*$/gm)]
  .map(match => match[1].slice(2))
  .sort()
for (const relative of referenced) {
  assert.ok(existsSync(join(preset, relative)), `missing relative plugin: ${relative}`)
}
const pluginFiles = readdirSync(preset).filter(file => file.endsWith('.mjs')).sort()
assert.deepEqual(pluginFiles, [
  'adaptive-router.mjs',
  'compaction-epoch.mjs',
  'dev-tool-search.mjs',
  'direct-bash.mjs',
  'instruction-hint.mjs',
  'router-core.mjs',
  'skill-search.mjs',
  'tool-bootstrap.mjs',
], 'preset contains an unexpected or missing local plugin')
for (const relative of referenced) assert.ok(pluginFiles.includes(relative), `composition references non-plugin file: ${relative}`)
assert.equal(lock.deepseekHarness.commit, '47f943859bef60e4160492346772ded9b24f765a')

console.log(`preset verification: ok (Adaptive Native Standard; ${pluginFiles.length} local plugins)`)
