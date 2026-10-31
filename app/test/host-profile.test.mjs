// The application Host against its actual installed public profile-boot, without Electron,
// a model request, inherited credentials or any existing user profile.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HostProcess } from '../src/host-process.mjs'

test('the actual Host renders Peer-scoped injections only through its authenticated index request', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-app-public-profile-'))
  const app = fileURLToPath(new URL('..', import.meta.url))
  const home = join(root, 'home'), workspace = join(root, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, {
    DSH_HOME: home, DS_BOT_APP: '1', DS_BOT_PORT: '0', DS_BOT_WORKSPACE: workspace,
    DS_BOT_USER_DSH_HOME: join(root, 'excluded-user-home'),
  })
  const failures = []
  const host = new HostProcess({
    entry: join(app, 'src', 'host.mjs'), cwd: root, env,
    pnpm: join(app, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    onFailure: error => { failures.push(error.message) },
  })
  let acknowledged = false, timer
  host.onMessage(message => { if (message?.type === 'shutdown-complete') acknowledged = true })
  const request = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) })
  try {
    const ready = await Promise.race([
      host.start(),
      new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('The public Host did not become ready')) }, 40_000) }),
    ])
    clearTimeout(timer)
    assert.deepEqual(Object.keys(ready), ['url'], 'the shell receives no identity-free injection table')
    const url = new URL(ready.url)
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal((await request(url.origin)).status, 401)
    assert.equal((await request(`${url.origin}/?token=invalid`, { redirect: 'manual' })).status, 401)
    const admitted = await request(url, { redirect: 'manual' })
    assert.equal(admitted.status, 303)
    const cookie = admitted.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, 'the real admission endpoint must issue a browser cookie')
    const page = await request(new URL(admitted.headers.get('location'), url), { headers: { cookie } })
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /globalThis\["__DSH_REMOTE_ACCESS__"\] = \{"type":"baseline","owner":true\}/u)
    assert.match(html, /<base href="\.\/">/u)
    assert.equal((await request(url.origin)).status, 401, 'another unauthenticated client has no owner admission')
    await host.stop()
    assert.equal(acknowledged, true, 'the actual profile must acknowledge cooperative shutdown')
    assert.deepEqual(failures, [])
  } finally {
    clearTimeout(timer)
    await host.stop()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
