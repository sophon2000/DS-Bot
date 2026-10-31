import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyHostSharedPatch, verifyHostSharedPatch } from '../src/host-shared-patch.mjs'

const app = fileURLToPath(new URL('..', import.meta.url))
const contract = JSON.parse(readFileSync(new URL('../src/patches/shared-runtime.json', import.meta.url)))
const binding = contract.patches[0]
const installed = join(app, 'node_modules/@earendil-works/pi-ai')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(t, pristine = true) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-shared-patch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'deepseek-bot' }))
  for (const entry of contract.patches) {
    const dependency = join(root, 'node_modules', entry.package.name)
    mkdirSync(dependency, { recursive: true })
    cpSync(join(app, 'node_modules', entry.package.name, 'package.json'), join(dependency, 'package.json'))
    mkdirSync(dirname(join(dependency, entry.package.main)), { recursive: true })
    writeFileSync(join(dependency, entry.package.main), '')
    for (const name of Object.keys(entry.after)) {
      mkdirSync(dirname(join(dependency, name)), { recursive: true })
      cpSync(join(app, 'node_modules', entry.package.name, name), join(dependency, name))
    }
    if (pristine) execFileSync('git', ['apply', '--reverse', fileURLToPath(new URL('../src/patches/' + entry.file, import.meta.url))], { cwd: dependency })
  }
  const dependency = join(root, 'node_modules/@earendil-works/pi-ai')
  return { root, dependency, anchor: join(root, 'package.json') }
}

test('actual app and default helper cover both shared policies and all eight DSH3400 outputs', () => {
  for (const root of [app, fileURLToPath(new URL('../../ds-bot/dev/harness', import.meta.url))]) {
    assert.equal(verifyHostSharedPatch(join(root, 'package.json')).files, 8)
    for (const entry of contract.patches) for (const [name, expected] of Object.entries(entry.after)) assert.equal(hash(readFileSync(join(root, 'node_modules', entry.package.name, name))), expected)
  }
})

test('pristine dependency installs once and repeat execution leaves identical bytes', t => {
  const f = fixture(t)
  assert.throws(() => verifyHostSharedPatch(f.anchor), /patch is missing/u, 'an ignore-scripts install must not pass a build/runtime check')
  for (const [name, expected] of Object.entries(binding.before)) assert.equal(hash(readFileSync(join(f.dependency, name))), expected)
  assert.equal(applyHostSharedPatch(f.anchor).status, 'applied')
  const before = Object.fromEntries(Object.keys(binding.after).map(name => [name, lstatSync(join(f.dependency, name)).mtimeMs]))
  assert.equal(applyHostSharedPatch(f.anchor).status, 'already-patched')
  for (const [name, expected] of Object.entries(binding.after)) {
    assert.equal(hash(readFileSync(join(f.dependency, name))), expected)
    assert.equal(lstatSync(join(f.dependency, name)).mtimeMs, before[name])
  }
})

test('wrong version, missing files, dirty bytes and partial patches fail before writing', t => {
  for (const kind of ['version', 'missing', 'dirty', 'partial']) {
    const f = fixture(t), names = Object.keys(binding.before)
    if (kind === 'version') writeFileSync(join(f.dependency, 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(f.dependency, 'package.json'))), version: '1.4.0' }))
    if (kind === 'missing') rmSync(join(f.dependency, names[0]))
    if (kind === 'dirty') writeFileSync(join(f.dependency, names[0]), '// modified locally\n')
    if (kind === 'partial') cpSync(join(installed, names[0]), join(f.dependency, names[0]))
    const untouched = readFileSync(join(f.dependency, names.at(-1)))
    assert.throws(() => applyHostSharedPatch(f.anchor), /requires @earendil-works\/pi-ai 1\.3\.0|ENOENT|Dirty shared dependency|Partially patched/u, kind)
    assert.deepEqual(readFileSync(join(f.dependency, names.at(-1))), untouched, kind)
  }
})

test('linked target escape and an equal-version nested adapter copy are refused', t => {
  const f = fixture(t), outside = join(f.root, 'outside')
  cpSync(f.dependency, outside, { recursive: true })
  rmSync(f.dependency, { recursive: true })
  symlinkSync(outside, f.dependency, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => applyHostSharedPatch(f.anchor), /escapes this installation/u)
  rmSync(f.dependency)
  cpSync(outside, f.dependency, { recursive: true })
  const adapter = join(f.root, 'node_modules/@deepseek-ai/dsh-llm-pi-ai')
  mkdirSync(adapter, { recursive: true }); writeFileSync(join(adapter, 'package.json'), '{}')
  const nested = join(adapter, 'node_modules/@earendil-works/pi-ai')
  cpSync(outside, nested, { recursive: true })
  assert.notEqual(realpathSync(nested), realpathSync(f.dependency))
  assert.throws(() => applyHostSharedPatch(f.anchor), /exactly one local @earendil-works\/pi-ai/u)
})

test('actual patched OpenAI-compatible stream defers argument parsing and replays Gemini signatures', async () => {
  const { stream, convertMessages } = await import(pathToFileURL(join(installed, 'dist/api/openai-completions.js')).href)
  const model = { id: 'm', name: 'm', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }
  const args = { file_path: 'notes.md', content: 'x'.repeat(64) }, fragments = JSON.stringify(args).match(/.{1,7}/gs)
  const events = [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '' }, extra_content: { google: { thought_signature: 'gemini-signature' } } }] }, finish_reason: null }] },
    ...fragments.map(fragment => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] }, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  ]
  let requests = 0, final
  const source = stream(model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, {
    apiKey: 'test-key', maxRetries: 0,
    fetch: async () => { requests++; return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) },
  })
  let deltas = 0
  for await (const event of source) {
    if (event.type === 'error') throw new Error(event.error.errorMessage)
    if (event.type === 'toolcall_delta' && event.delta.length) { deltas++; assert.deepEqual(event.partial.content[event.contentIndex].arguments, {}) }
    if (event.type === 'toolcall_end') { assert.deepEqual(event.toolCall.arguments, args); assert.equal(event.toolCall.thoughtSignature, 'gemini-signature') }
    if (event.type === 'done') final = event.message
  }
  assert.equal(requests, 1); assert.equal(deltas, fragments.length)
  const replay = convertMessages(model, { messages: [final] }, { supportsMidConvoSystemMessages: false })
  assert.equal(replay.find(message => message.role === 'assistant').tool_calls[0].extra_content.google.thought_signature, 'gemini-signature')
})

test('a dirty node-pty prevents pristine pi-ai writes and a shipped-src production installer needs no dev tools', t => {
  const dirty = fixture(t), first = Object.keys(binding.before)[0]
  writeFileSync(join(dirty.root, 'node_modules/node-pty/lib/unixTerminal.js'), '// dirty\n')
  const before = readFileSync(join(dirty.dependency, first))
  assert.throws(() => applyHostSharedPatch(dirty.anchor), /Dirty shared dependency/u)
  assert.deepEqual(readFileSync(join(dirty.dependency, first)), before)
  const production = fixture(t)
  mkdirSync(join(production.root, 'src'))
  cpSync(join(app, 'src/host-shared-patch.mjs'), join(production.root, 'src/host-shared-patch.mjs'))
  cpSync(join(app, 'src/patches'), join(production.root, 'src/patches'), { recursive: true })
  const output = execFileSync(process.execPath, [join(production.root, 'src/host-shared-patch.mjs')], { cwd: production.root, encoding: 'utf8' })
  assert.equal(JSON.parse(output).files, 8)
  assert.equal(verifyHostSharedPatch(production.anchor).files, 8)
})

function ptyModule(file, { env = {}, sibling = false } = {}) {
  const exports = {}, capture = {}, require = createRequire(import.meta.url)
  const stubs = {
    fs: { existsSync: value => sibling && value === '/runtime/node-spawn-helper' },
    tty: {}, './terminal': { Terminal: function Terminal() {} },
    './utils': { loadNativeModule: () => ({ module: {}, dir: '../prebuilds/darwin-arm64' }) },
    './windowsConoutConnection': { ConoutConnection: function ConoutConnection() {} },
    './eventEmitter2': { EventEmitter2: function EventEmitter2() {} },
  }
  const source = readFileSync(join(app, 'node_modules/node-pty/lib', file), 'utf8')
  runInNewContext(source + (file === 'unixTerminal.js' ? '\ncapture.helper = helperPath' : ''), {
    exports, capture, require: name => name in stubs ? stubs[name] : require(name),
    process: { env, execPath: '/runtime/node' }, __dirname: '/app.asar/node_modules/node-pty/lib',
    Buffer, console, setTimeout, clearTimeout,
  })
  return { exports, capture }
}

test('actual patched node-pty selects an explicit helper, executable sibling, then its legacy package helper', () => {
  assert.equal(ptyModule('unixTerminal.js', { env: { DSH_NODE_PTY_SPAWN_HELPER: '/external/owned-helper' }, sibling: true }).capture.helper, resolve('/external/owned-helper'))
  assert.equal(ptyModule('unixTerminal.js', { sibling: true }).capture.helper, '/runtime/node-spawn-helper')
  assert.equal(ptyModule('unixTerminal.js').capture.helper, resolve('/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'))
})

test('actual patched Windows disposal starts draining before any later output arrives', () => {
  const { exports } = ptyModule('windowsPtyAgent.js'), calls = []
  const instance = {
    _clearConnectionTimeout() {}, _useConptyDll: true, _pty: 7,
    _inSocket: { destroy() { calls.push('input-closed') } },
    _ptyNative: { kill() { calls.push('native-killed') } },
    _conoutSocketWorker: { dispose() { calls.push('draining') } },
    _outSocket: { on(event) { assert.equal(event, 'data'); calls.push('output-listener') } },
  }
  exports.WindowsPtyAgent.prototype.kill.call(instance)
  assert.deepEqual(calls, ['input-closed', 'native-killed', 'draining', 'output-listener'])
})
