import assert from 'node:assert/strict'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(new URL('../package.json', import.meta.url))
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const binding = json(new URL('../../ds-bot/host-artifact.json', import.meta.url))
const manifest = json(new URL('../package.json', import.meta.url))

test('the standalone app resolves one fixed Host family through public package exports', () => {
  const cli = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
  assert.equal(json(cli.resolve('@deepseek-ai/dsh/package.json')).version, binding.hostVersion)
  for (const [name, expected] of Object.entries(manifest.dependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(expected, binding.hostVersion, name)
    assert.equal(json(require.resolve(`${name}/package.json`)).version, binding.hostVersion, name)
  }
  const plugin = dirname(require.resolve('ds-bot'))
  assert.equal(lstatSync(plugin).isSymbolicLink(), false, 'the repository plugin must be a package copy')
  const fromPlugin = createRequire(join(plugin, 'package.json'))
  for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-web']) {
    assert.equal(realpathSync(fromPlugin.resolve(peer)), realpathSync(cli.resolve(peer)), peer)
  }
})

test('the application lock contains no older DSH family or floating pi-ai runtime', () => {
  const lock = json(new URL('../package-lock.json', import.meta.url))
  let hostPackages = 0, piPackages = 0
  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      hostPackages++
      assert.equal(entry.version, binding.hostVersion, path)
      assert.notEqual(entry.peer, true, `${path} must be part of the application's runtime closure`)
    }
    if (name === '@earendil-works/pi-ai') {
      piPackages++
      assert.equal(entry.version, '1.3.0', path)
    }
  }
  assert.ok(hostPackages > 0)
  assert.ok(piPackages > 0)
})
