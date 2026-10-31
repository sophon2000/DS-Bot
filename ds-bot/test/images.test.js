import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { install, offloadTargets } from '../src/host/images.js'

async function imageRuntime(t, { botSessions = [], rooms = [] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-images-'))
  const listeners = new Map()
  const calls = { load: 0, model: [], catalog: 0, ocr: [], rewritten: [], next: 0, warnings: [] }
  let loaded = false
  const current = new Set(botSessions)
  const roomSessions = new Set(rooms)
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Synthetic image reading' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic image reading' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const rt = {
    home, config: {},
    async load() { calls.load += 1; loaded = true },
    isBotSession: id => loaded && current.has(id),
    roomOf: id => loaded && roomSessions.has(id) ? 'room' : undefined,
    ownRequest: options => options.own === true,
    tagUsage: messages => messages,
    defaultRef: () => 'fixture/vision',
    async catalog() {
      calls.catalog += 1
      return [{ ref: 'fixture/vision', name: 'Synthetic vision', input: ['text', 'image'] }]
    },
    warn: (...args) => calls.warnings.push(args),
    ctx: {
      on: (event, listener) => listeners.set(event, listener),
      llm: {
        async resolveModelInfo(provider, model) {
          calls.model.push({ provider, model })
          return { inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] }
        },
        async *stream(options) {
          if (options.model === 'vision') calls.ocr.push(options)
          else calls.rewritten.push(options)
          yield* chunks
        },
      },
    },
  }
  install(rt)
  const next = async function* () { calls.next += 1; yield { original: true } }
  const request = (sessionId, extra = {}) => ({
    provider: 'fixture', model: 'text', sessionId,
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'image-1', name: 'synthetic.png' } }] }],
    ...extra,
  })
  const dispatch = async options => {
    const output = []
    for await (const chunk of listeners.get('llm/stream')(options, next)) output.push(chunk)
    return output
  }
  const cache = async () => {
    const deadline = Date.now() + 3000
    while (true) {
      try { return JSON.parse(await readFile(join(home, 'ocr.json'), 'utf8')) } catch (error) {
        if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error
        await delay(5)
      }
    }
  }
  t.after(async () => {
    // A successful reading schedules an atomic rename without awaiting it.
    // Observe that rename before deleting the fixture, including on assertion failure.
    try { if (calls.ocr.length) await cache() } finally { await rm(home, { recursive: true, force: true }) }
  })
  return { calls, home, request, dispatch, cache }
}

test('image middleware leaves ordinary DSH Sessions and archived Bot segments untouched', async t => {
  const fixture = await imageRuntime(t, { botSessions: ['current-bot', 'group-member'], rooms: ['room-container'] })
  for (const sessionId of ['ordinary-video', 'archived-bot']) {
    const options = fixture.request(sessionId)
    const before = structuredClone(options)
    assert.deepEqual(await fixture.dispatch(options), [{ original: true }])
    assert.deepEqual(options, before)
  }
  assert.equal(fixture.calls.load, 2)
  assert.equal(fixture.calls.next, 2)
  assert.deepEqual(fixture.calls.model, [])
  assert.equal(fixture.calls.catalog, 0)
  assert.deepEqual(fixture.calls.ocr, [])
  assert.deepEqual(fixture.calls.rewritten, [])
  assert.deepEqual(fixture.calls.warnings, [])
  assert.deepEqual(await readdir(fixture.home), [])
})

for (const sessionId of ['current-bot', 'group-member']) test(`image middleware loads ${sessionId} ownership before OCR and reuses its attachment cache`, async t => {
  const fixture = await imageRuntime(t, { botSessions: ['current-bot', 'group-member'], rooms: ['room-container'] })
  const options = fixture.request(sessionId)
  const before = structuredClone(options)
  await fixture.dispatch(options)
  assert.equal(fixture.calls.load, 1)
  assert.equal(fixture.calls.next, 0)
  assert.equal(fixture.calls.ocr.length, 1)
  assert.equal(fixture.calls.ocr[0].sessionId, sessionId)
  assert.equal(fixture.calls.ocr[0].messages[0].content[0].type, 'image')
  assert.equal(fixture.calls.rewritten.length, 1)
  assert.equal(fixture.calls.rewritten[0].sessionId, sessionId)
  assert.equal(fixture.calls.rewritten[0].messages[0].content[0].type, 'text')
  assert.match(fixture.calls.rewritten[0].messages[0].content[0].text, /Synthetic image reading/)
  assert.deepEqual(options, before)
  assert.equal((await fixture.cache())['image-1'].text, 'Synthetic image reading')
  await fixture.dispatch(options)
  assert.equal(fixture.calls.ocr.length, 1)
  assert.equal(fixture.calls.rewritten.length, 2)
  assert.deepEqual(fixture.calls.warnings, [])
})

test('image middleware keeps room containers, vision routes and own requests on their existing bypasses', async t => {
  const fixture = await imageRuntime(t, { botSessions: ['current-bot', 'group-member'], rooms: ['room-container'] })
  for (const options of [
    fixture.request('current-bot', { own: true }),
    fixture.request(undefined),
    fixture.request('current-bot', { messages: [{ role: 'user', content: [{ type: 'text', text: 'no image' }] }] }),
    fixture.request('room-container'),
    fixture.request('current-bot', { model: 'vision' }),
  ]) assert.deepEqual(await fixture.dispatch(options), [{ original: true }])
  assert.equal(fixture.calls.load, 2)
  assert.equal(fixture.calls.next, 5)
  assert.deepEqual(fixture.calls.model, [{ provider: 'fixture', model: 'vision' }])
  assert.equal(fixture.calls.catalog, 0)
  assert.deepEqual(fixture.calls.ocr, [])
  assert.deepEqual(fixture.calls.rewritten, [])
  assert.deepEqual(await readdir(fixture.home), [])
})

test('offloadTargets selects live images from prior user and tool messages', () => {
  const events = [
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
    { type: 'user/message' },
    { type: 'user/message' },
  ]
  const messages = new Map([
    [events[0], { content: [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'image', offloaded: true, attachment: { attachmentId: 'b' } },
      { type: 'image', attachment: { attachmentId: 'c' } },
    ] }],
    [events[1], { content: [{ type: 'image', attachment: { attachmentId: 'ignored' } }] }],
    [events[2], { content: [{ type: 'image', attachment: { attachmentId: 'd' } }] }],
    [events[3], { content: [{ type: 'text', text: 'no image' }] }],
    [events[4], { content: [{ type: 'image', attachment: { attachmentId: 'new' } }] }],
  ])
  const session = {
    surface: { nodes: [0, 1, 2, 3, 4] },
    eventAt: seq => events[seq],
    deriveEventMessage: event => messages.get(event),
  }

  assert.deepEqual(offloadTargets(session, 4), [
    { seq: 0, imageIndexes: [0, 2] },
    { seq: 2, imageIndexes: [0] },
  ])
})
