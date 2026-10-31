import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { install, FEED_ROUTE } from '../../src/host/feed.js'
import { fakeContext } from '../fake-ctx.js'

assert.equal(typeof global.gc, 'function')
const ctx = fakeContext()
let route
ctx.connection.fetch.register = options => { if (options.path === FEED_ROUTE) route = options; return () => {} }
install({ ctx, state: { revision: 0, exchangeTurns: {} }, chatOwners: new Map(), selfOf: () => undefined })
const abort = new AbortController()
let request = new Request('http://localhost/api/bot/feed', { signal: abort.signal })
const weak = new WeakRef(request)
const response = await route.fetch(request)
request = undefined
const reader = response.body.getReader()
let next
const collect = async () => { for (let i = 0; i < 8; i++) { await setImmediate(); global.gc() } }
try {
  assert.equal((await reader.read()).done, false)
  await collect()
  let outcome = 'pending'
  next = reader.read().then(result => { outcome = result.done ? 'closed' : 'data'; return result })
  abort.abort()
  await setImmediate()
  await setImmediate()
  assert.equal(outcome, 'closed', 'Request abort must close the feed before teardown after forced GC')
  await ctx.dispose()
  await next
  await collect()
  assert.equal(weak.deref(), undefined, 'A closed feed must release its Request')
  console.log(JSON.stringify({ abortedBeforeCleanup: true, releasedAfterClose: true }))
} finally {
  await ctx.dispose()
  await next
}
