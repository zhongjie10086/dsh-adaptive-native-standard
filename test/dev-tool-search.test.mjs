import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../preset/dev-tool-search.mjs'

function register() {
  let registered
  const ctx = {
    tools: {
      register(tool) { registered = tool },
      schemas() { return [] },
    },
  }
  apply(ctx)
  return registered
}

test('advertises a preset-neutral resident surface and on-demand tools', () => {
  const tool = register()
  assert.match(tool.description, /visible catalog is intentionally small/i)
  assert.doesNotMatch(tool.description, /resident work set is: pwsh/i)
  assert.match(tool.description, /bash — Git Bash/)
  assert.match(tool.description, /str_replace_editor — legacy/)
  assert.match(tool.description, /web_fetch — retrieve a specific HTTP\(S\) URL when Fetch is enabled and registered/)
  assert.match(tool.description, /do not emulate unavailable capabilities with the resident tools/)
  assert.doesNotMatch(tool.description, /work around them with bash/)

  const indexLines = tool.description.split('\n').filter(line => line.startsWith('- '))
  const bashLine = '- bash — Git Bash for commands that genuinely require POSIX shell syntax'
  assert.equal(indexLines.length, 13)
  assert.equal(indexLines.at(-1), bashLine)
  assert.notEqual(indexLines[0], bashLine)
})
