import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { create } from 'tar'
import { inspectHost, packedFileDigests, verifyHostPackage } from '../scripts/host-package.mjs'

const hostVersion = '0.2.2-alpha.2.vh.2.local.20261031.1'
const peers = { '@deepseek-ai/cordis': '4.0.6-alpha.1', '@deepseek-ai/dsh-llm': hostVersion, '@deepseek-ai/dsh-tools': hostVersion, '@deepseek-ai/dsh-web': hostVersion }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot host 中文 '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const modules = join(root, 'node_modules')
  const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value)}\n`) }
  const pkg = (name, version, where = modules) => {
    const file = join(where, name, 'package.json')
    write(file, { name, version })
    return file
  }
  const host = pkg('@deepseek-ai/dsh', hostVersion)
  pkg('@deepseek-ai/dsh-base', hostVersion)
  pkg('@deepseek-ai/dsh-web-app', hostVersion)
  for (const [name, version] of Object.entries(peers)) pkg(name, version)
  const plugin = join(modules, 'ds-bot')
  write(join(plugin, 'package.json'), { name: 'ds-bot', version: '0.2.3-vh.3', peerDependencies: peers })
  write(join(plugin, 'host-package.json'), { schemaVersion: 1, version: '0.2.3-vh.3', hostVersion, sourceCommit: 'a'.repeat(40), packages: peers })
  return { root, host, plugin, pkg, write }
}

test('the installed plugin reuses the pinned host modules', t => {
  const f = fixture(t)
  assert.deepEqual(verifyHostPackage(f.plugin, f.host), { version: '0.2.3-vh.3', hostVersion, peers: 4 })
})

test('a nested second runtime with the same version is rejected', t => {
  const f = fixture(t)
  f.pkg('@deepseek-ai/dsh-llm', hostVersion, join(f.plugin, 'node_modules'))
  assert.throws(() => verifyHostPackage(f.plugin, f.host), /Duplicate host runtime/)
})

test('host version drift and missing peers fail before packing', t => {
  const f = fixture(t)
  assert.throws(() => inspectHost(f.host, peers, '0.2.1-rc.2'), /host version differs/)
  f.pkg('@deepseek-ai/dsh-web', '0.2.1-rc.2')
  assert.throws(() => inspectHost(f.host, peers, hostVersion), /Host peer version drift/)
  rmSync(dirname(f.pkg('@deepseek-ai/dsh-web', hostVersion)), { recursive: true })
  assert.throws(() => inspectHost(f.host, peers, hostVersion), /Missing host package/)
})

test('a changed package peer cannot bypass the recorded binding', t => {
  const f = fixture(t)
  f.write(join(f.plugin, 'package.json'), { name: 'ds-bot', version: '0.2.3-vh.3', peerDependencies: { ...peers, '@deepseek-ai/cordis': '*' } })
  assert.throws(() => verifyHostPackage(f.plugin, f.host), /Host binding differs/)
})

test('receipt hashes actual packed files and rejects unexpected files', async t => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'package'))
  const contents = '{"name":"ds-bot"}\n'
  writeFileSync(join(f.root, 'package', 'package.json'), contents)
  const file = join(f.root, 'package.tgz')
  await create({ cwd: f.root, gzip: true, file, portable: true }, ['package/package.json'])
  const bytes = readFileSync(file)
  assert.deepEqual(await packedFileDigests(bytes, ['package.json']), { 'package.json': createHash('sha256').update(contents).digest('hex') })
  await assert.rejects(packedFileDigests(bytes, []), /Unexpected archive entry/)
  await assert.rejects(packedFileDigests(bytes, ['package.json', 'missing.js']), /Archive payload differs/)
})
