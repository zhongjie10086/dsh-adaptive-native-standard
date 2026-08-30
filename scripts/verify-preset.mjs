import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const preset = join(root, 'preset')
const minimalPreset = join(root, 'preset-minimal')
const composition = readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')
const minimalComposition = readFileSync(join(minimalPreset, 'agent.cordis.yml'), 'utf8')
const metadata = readFileSync(join(preset, 'preset.yml'), 'utf8')
const minimalMetadata = readFileSync(join(minimalPreset, 'preset.yml'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundlePatch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const bundleInstaller = readFileSync(join(root, 'index.mjs'), 'utf8')
const lock = JSON.parse(readFileSync(join(root, 'upstream-lock.json'), 'utf8'))

assert.equal(packageJson.name, 'dsh-adaptive-native-standard')
assert.equal(packageJson.version, '0.3.0')
assert.equal(packageJson.main, './index.mjs')
assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml')
assert.ok(packageJson.files.includes('preset/'))
assert.ok(packageJson.files.includes('preset-minimal/'))
assert.match(bundlePatch, /- id: adaptive-native-standard-installer\s+name: dsh-adaptive-native-standard/)
assert.match(bundleInstaller, /export async function installPreset/)
assert.match(bundleInstaller, /export async function installPresets/)
assert.match(bundleInstaller, /\.dsh-preset-owner\.json/)
assert.match(metadata, /^name: Adaptive Native Standard$/m)
assert.match(minimalMetadata, /^name: Adaptive Native Minimal$/m)
assert.match(composition, /bootstrapTools: \[pwsh, read, write, edit, glob, grep\]/)
assert.match(composition, /compactionTools: \[pwsh, read, write, edit, glob, grep\]/)
assert.match(composition, /suppressedContextSources: \[\]/)
assert.match(composition, /bootstrapAnchor: minimal-persona/)
assert.match(composition, /residentTools: \[dev_tool_search, skill_search, skill_load, dev_adaptive_status, dev_adaptive_mode\]/)
assert.match(composition, /- id: direct-bash\s+name: \.\/direct-bash\.mjs/)
assert.match(composition, /managedSessionEnv: true/)
assert.match(composition, /includeSessionJsonl: false/)
assert.match(composition, /- id: tool-jobs\s+name: '@deepseek-ai\/dsh-tool-jobs'/)
assert.match(composition, /^\s*fetch:\s*true\s*$/m)
assert.doesNotMatch(composition, /fetchEnabled|dsh-unified-search/)
assert.equal([...composition.matchAll(/backgroundMode: continuable/g)].length, 2)
assert.doesNotMatch(composition, /adaptive-native-direct-v2|direct-bash-v2|custom-bash|gitbash-executor|gitbash-prompt-parity/)
assert.doesNotMatch(composition, /^\s*complete:\s*true\s*$/m, 'a complete base persona would erase dynamic routing')
assert.equal([...composition.matchAll(/^\s*name:\s+\.\.\/\S+/gm)].length, 0, 'preset must be self-contained')

assert.match(minimalComposition, /bootstrapTools: \[read, dev_tool_search\]/)
assert.match(minimalComposition, /residentTools: \[pwsh, write, edit, glob, grep, dev_tool_search\]/)
assert.match(minimalComposition, /suppressedContextSources: \[skill-catalog, agent-instructions\]/)
assert.match(minimalComposition, /bootstrapAnchor: minimal-first/)
assert.match(minimalComposition, /reasoningStyle: native/)
assert.match(minimalComposition, /nearFieldGuidance: true/)
assert.equal([...minimalComposition.matchAll(/resetOnCompaction: false/g)].length, 3)
assert.match(minimalComposition, /compactionTools: \[read, dev_tool_search\]/)
assert.match(minimalComposition, /^\s*fetch:\s*true\s*$/m)
assert.doesNotMatch(minimalComposition, /fetchEnabled|dsh-unified-search/)
assert.doesNotMatch(minimalComposition, /str-replace-editor|tool-str-replace-editor/)
assert.doesNotMatch(minimalComposition, /bootstrapTools: \[[^\]]*(?:pwsh|write|edit|glob|grep)/)
assert.equal([...minimalComposition.matchAll(/^\s*name:\s+\.\.\/\S+/gm)].length, 0, 'minimal preset must be self-contained after materialization')

const referenced = [...composition.matchAll(/^\s*name:\s+(\.\/\S+)\s*$/gm)]
  .map(match => match[1].slice(2))
  .sort()
for (const relative of referenced) {
  assert.ok(existsSync(join(preset, relative)), `missing relative plugin: ${relative}`)
}
const minimalReferenced = [...minimalComposition.matchAll(/^\s*name:\s+(\.\/\S+)\s*$/gm)]
  .map(match => match[1].slice(2))
  .sort()
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
for (const relative of minimalReferenced) {
  assert.ok(pluginFiles.includes(relative), `minimal composition references missing shared plugin: ${relative}`)
}
assert.equal(lock.deepseekHarness.commit, 'cd5ef8148158c3a752a658978873241fdf8e2bbc')

console.log(`preset verification: ok (Adaptive Native Standard + Minimal; ${pluginFiles.length} shared local plugins)`)
