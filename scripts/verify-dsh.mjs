import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const lock = JSON.parse(readFileSync(new URL('../upstream-lock.json', import.meta.url), 'utf8'))
const checkout = resolve(process.argv[2] ?? 'C:/Dev/deepseek-harness')
const packageJson = JSON.parse(readFileSync(resolve(checkout, 'package.json'), 'utf8'))

const git = spawnSync('git', ['-c', `safe.directory=${checkout.replaceAll('\\', '/')}`, '-C', checkout, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
})
if (git.status !== 0) throw new Error(git.stderr || `cannot read git revision for ${checkout}`)

const actualCommit = git.stdout.trim()
const failures = []
if (actualCommit !== lock.deepseekHarness.commit) failures.push(`commit ${actualCommit} != ${lock.deepseekHarness.commit}`)
if (packageJson.version !== lock.deepseekHarness.version) failures.push(`version ${packageJson.version} != ${lock.deepseekHarness.version}`)
if (packageJson.packageManager !== 'pnpm@11.7.0') failures.push(`packageManager ${packageJson.packageManager} != pnpm@11.7.0`)

if (failures.length > 0) {
  console.error(`DSH compatibility check failed for ${checkout}:`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`DSH compatibility: ok (${packageJson.version}, ${actualCommit.slice(0, 8)})`)
  console.log(`Preset source: ${projectRoot}`)
}
