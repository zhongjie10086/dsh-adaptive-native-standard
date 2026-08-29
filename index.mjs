import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'adaptive-native-standard-installer'

const PACKAGE_NAME = 'dsh-adaptive-native-standard'
const STANDARD_PRESET_ID = 'adaptive-native-standard'
const MINIMAL_PRESET_ID = 'adaptive-native-minimal'
const OWNER_FILE = '.dsh-preset-owner.json'
const packageRoot = dirname(fileURLToPath(import.meta.url))
const sharedPluginRoot = join(packageRoot, 'preset')
const PRESETS = new Map([
  [STANDARD_PRESET_ID, {
    id: STANDARD_PRESET_ID,
    sourceRoot: sharedPluginRoot,
    inheritSharedPlugins: false,
  }],
  [MINIMAL_PRESET_ID, {
    id: MINIMAL_PRESET_ID,
    sourceRoot: join(packageRoot, 'preset-minimal'),
    inheritSharedPlugins: true,
  }],
])
const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const PACKAGE_VERSION = packageManifest.version

function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

async function pathType(path) {
  try {
    const entry = await lstat(path)
    if (entry.isDirectory()) return 'directory'
    if (entry.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function ownerOf(target) {
  try {
    return JSON.parse(await readFile(join(target, OWNER_FILE), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function digestTree(root) {
  const hash = createHash('sha256')

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const key = relative(root, absolute).replaceAll('\\', '/')
      if (key === OWNER_FILE) continue
      if (entry.isDirectory()) {
        hash.update(`d\0${key}\0`)
        await visit(absolute)
      } else if (entry.isFile()) {
        hash.update(`f\0${key}\0`)
        hash.update(await readFile(absolute))
        hash.update('\0')
      } else {
        hash.update(`o\0${key}\0`)
      }
    }
  }

  await visit(root)
  return hash.digest('hex')
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z')
}

function resolvePaths(dshHome, presetId) {
  const home = resolve(dshHome)
  const targetRoot = resolve(home, '.agent-presets')
  const target = resolve(targetRoot, presetId)
  if (dirname(target) !== targetRoot) throw new Error(`refusing to install outside preset root: ${target}`)
  return {
    targetRoot,
    target,
    backupRoot: resolve(home, '.preset-backups'),
  }
}

async function writeOwner(target, presetId) {
  await writeFile(join(target, OWNER_FILE), `${JSON.stringify({
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    preset: presetId,
  }, null, 2)}\n`, 'utf8')
}

async function materializePreset(definition, staging) {
  await cp(definition.sourceRoot, staging, { recursive: true, errorOnExist: true, force: false })
  if (definition.inheritSharedPlugins) {
    const entries = await readdir(sharedPluginRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
      await cp(join(sharedPluginRoot, entry.name), join(staging, entry.name), {
        errorOnExist: true,
        force: false,
      })
    }
  }
  await writeOwner(staging, definition.id)
}

/**
 * Deploy the packaged preset. Exported so the zero-dependency test suite can
 * verify installation without booting a full Harness profile.
 */
export async function installPreset({
  dshHome = defaultDshHome(),
  log = console,
  presetId = STANDARD_PRESET_ID,
} = {}) {
  const definition = PRESETS.get(presetId)
  if (definition === undefined) throw new Error(`unknown bundled preset: ${presetId}`)
  const sourceType = await pathType(definition.sourceRoot)
  if (sourceType !== 'directory') throw new Error(`bundled preset source is missing: ${definition.sourceRoot}`)

  const { targetRoot, target, backupRoot } = resolvePaths(dshHome, presetId)
  await mkdir(targetRoot, { recursive: true })

  const targetType = await pathType(target)
  if (targetType !== 'missing' && targetType !== 'directory') {
    log.warn?.(`[${PACKAGE_NAME}] skipped preset: target is not a directory: ${target}`)
    return { action: 'skipped', target }
  }

  const staging = resolve(targetRoot, `.${presetId}.installing-${process.pid}-${randomUUID()}`)
  if (dirname(staging) !== targetRoot) throw new Error(`refusing to stage outside preset root: ${staging}`)

  let backup
  try {
    await materializePreset(definition, staging)
    const sourceDigest = await digestTree(staging)
    if (targetType === 'directory') {
      const owner = await ownerOf(target)
      const targetDigest = await digestTree(target)

      if (owner?.package !== undefined && owner.package !== PACKAGE_NAME) {
        log.warn?.(`[${PACKAGE_NAME}] skipped preset: ${target} is managed by ${owner.package}`)
        return { action: 'skipped', target }
      }
      if (owner?.package === undefined && targetDigest !== sourceDigest) {
        log.warn?.(`[${PACKAGE_NAME}] skipped preset: ${target} exists with unowned or locally modified content`)
        return { action: 'skipped', target }
      }
      if (targetDigest === sourceDigest) {
        await writeOwner(target, presetId)
        const action = owner?.package === PACKAGE_NAME ? 'unchanged' : 'adopted'
        log.info?.(`[${PACKAGE_NAME}] preset ${action} at ${target}`)
        return { action, target }
      }
    }

    if (targetType === 'directory') {
      await mkdir(backupRoot, { recursive: true })
      backup = resolve(backupRoot, `${presetId}-bundle-${timestamp()}-${randomUUID().slice(0, 8)}`)
      if (dirname(backup) !== backupRoot) throw new Error(`refusing to back up outside backup root: ${backup}`)
      await rename(target, backup)
    }

    await rename(staging, target)
  } catch (error) {
    if (backup !== undefined && await pathType(target) === 'missing' && await pathType(backup) === 'directory') {
      await rename(backup, target)
      backup = undefined
    }
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  const action = targetType === 'missing' ? 'installed' : 'updated'
  log.info?.(`[${PACKAGE_NAME}] preset ${action} at ${target}`)
  if (backup !== undefined) log.info?.(`[${PACKAGE_NAME}] previous managed preset backed up at ${backup}`)
  return { action, target, backup }
}

/** Install both user-visible presets from one bundle mount. */
export async function installPresets(options = {}) {
  const results = []
  for (const presetId of PRESETS.keys()) {
    results.push(await installPreset({ ...options, presetId }))
  }
  return results
}

export async function apply(ctx) {
  const log = {
    info(message) {
      try {
        if (typeof ctx?.logger?.info === 'function') ctx.logger.info(message)
        else console.info(message)
      } catch { console.info(message) }
    },
    warn(message) {
      try {
        if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
        else console.warn(message)
      } catch { console.warn(message) }
    },
  }

  try {
    await installPresets({ log })
  } catch (error) {
    log.warn(`${name}: preset install failed; bundle remains loaded: ${String(error?.message ?? error)}`)
  }
}
