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

test('advertises native tools and on-demand legacy tools', () => {
  const tool = register()
  assert.match(tool.description, /pwsh, read, write, edit, glob, and grep/)
  assert.match(tool.description, /bash — Git Bash/)
  assert.match(tool.description, /str_replace_editor — legacy/)
  assert.match(tool.description, /do not emulate unavailable capabilities with the resident tools/)
  assert.doesNotMatch(tool.description, /work around them with bash/)
})
