import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { install, FEED_ROUTE } from '../src/host/feed.js'
import { fakeContext } from './fake-ctx.js'

function start(t) {
  const ctx = fakeContext()
  let route
  ctx.connection.fetch.register = options => { if (options.path === FEED_ROUTE) route = options; return () => {} }
  const rt = { ctx, state: { revision: 0, exchangeTurns: {} }, chatOwners: new Map(), selfOf: () => undefined }
  install(rt)
  t.after(() => ctx.dispose())
  return { ctx, rt, open: request => route.fetch(request) }
}

test('a feed retains its Request through GC until abort closes it, then releases it', () => {
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/feed-signal-gc.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(child.signal, null, `Owned GC fixture was terminated: ${child.error?.message ?? child.signal}`)
  assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stdout}\n${child.stderr}`)
  assert.deepEqual(JSON.parse(child.stdout), { abortedBeforeCleanup: true, releasedAfterClose: true })
})

test('cancelling a feed removes its abort listener', async t => {
  const { open } = start(t)
  const request = new Request('http://localhost/api/bot/feed')
  const baseline = getEventListeners(request.signal, 'abort').length
  const reader = (await open(request)).body.getReader()
  assert.equal((await reader.read()).done, false)
  assert.equal(getEventListeners(request.signal, 'abort').length, baseline + 1)
  await reader.cancel()
  assert.equal(getEventListeners(request.signal, 'abort').length, baseline)
})

test('an already aborted Request opens no live feed or abort subscription', async t => {
  const { open } = start(t)
  const abort = new AbortController()
  abort.abort()
  const request = new Request('http://localhost/api/bot/feed', { signal: abort.signal })
  const baseline = getEventListeners(request.signal, 'abort').length
  const reader = (await open(request)).body.getReader()
  assert.equal((await reader.read()).done, true)
  assert.equal(getEventListeners(request.signal, 'abort').length, baseline)
})

test('dropping a slow feed releases its listener while another feed stays active until disposal', async t => {
  const { ctx, rt, open } = start(t)
  const slow = new Request('http://localhost/api/bot/feed')
  const fast = new Request('http://localhost/api/bot/feed')
  const slowBaseline = getEventListeners(slow.signal, 'abort').length
  const fastBaseline = getEventListeners(fast.signal, 'abort').length
  await open(slow)
  const reader = (await open(fast)).body.getReader()
  assert.equal((await reader.read()).done, false)
  for (let i = 0; i < 1000; i++) {
    rt.state.revision++
    rt.stateSaved()
    assert.equal((await reader.read()).done, false)
  }
  assert.equal(getEventListeners(slow.signal, 'abort').length, slowBaseline)
  assert.equal(getEventListeners(fast.signal, 'abort').length, fastBaseline + 1)
  await ctx.dispose()
  assert.equal(getEventListeners(fast.signal, 'abort').length, fastBaseline)
  assert.equal((await reader.read()).done, true)
})
