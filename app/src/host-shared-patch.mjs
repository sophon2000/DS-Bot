// The fixed DSH source applies these same patches through pnpm.patchedDependencies.
// npm has no equivalent, so this installer accepts only its reviewed input/output bytes.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const metadataURL = new URL('./patches/shared-runtime.json', import.meta.url)
const metadataSha256 = '50f8d3d01fb02f06a067676b0c6fc0c2dbbb70df5a018d37b14c0b0aec3adcae'
const sourceCommit = '3400c4a11043fbd0ab486561edc23d6309f41463'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const within = (root, path) => { const key = relative(root, path); return key !== '..' && !key.startsWith(`..${sep}`) && !isAbsolute(key) }

function binding() {
  const bytes = readFileSync(metadataURL)
  assert.equal(hash(bytes), metadataSha256, 'The reviewed DSH patch metadata changed')
  const metadata = JSON.parse(bytes)
  assert.equal(metadata.source.commit, sourceCommit)
  const policy = readFileSync(new URL('./patches/dsh-runtime-patch-policy.txt', import.meta.url))
  assert.equal(hash(policy), metadata.source.runtimePatchPolicySha256, 'The frozen DSH shared patch policy changed')
  const shared = [...policy.toString('utf8').matchAll(/^\s*'([^']+)': \{ scope: 'shared'/gmu)].map(match => match[1]).sort()
  assert.deepEqual(metadata.patches.map(entry => `${entry.package.name}@${entry.package.version}`).sort(), shared, 'Cover every shared patch, not just a version pin')
  assert.equal(shared.length, 2)
  return metadata.patches.map(entry => {
    assert.match(entry.file, /^[a-z0-9.-]+\.patch$/u)
    const patch = readFileSync(new URL(`./patches/${entry.file}`, import.meta.url))
    assert.equal(hash(patch), entry.patchSha256, 'The canonical DSH patch changed')
    assert.deepEqual(Object.keys(entry.before), Object.keys(entry.after))
    return { ...entry, patch: patch.toString('utf8') }
  })
}

function installation(anchor, expected) {
  const manifest = realpathSync(anchor), owner = dirname(manifest)
  assert.ok(['deepseek-bot', 'ds-bot-test-harness'].includes(json(manifest).name), 'Patch only the app or its default test harness')
  const modules = realpathSync(join(owner, 'node_modules')), require = createRequire(manifest)
  const manifests = (resolver, name) => (resolver.resolve.paths(name) ?? [])
    .map(directory => join(directory, name, 'package.json'))
    .filter(path => { try { return lstatSync(path).isFile() } catch { return false } })
  const adapters = expected.lookupAnchors.flatMap(name => manifests(require, name))
  const candidates = [...manifests(require, expected.name),
    ...adapters.flatMap(adapter => manifests(createRequire(adapter), expected.name))]
  const found = [...new Set(candidates.map(path => realpathSync(path)))]
  assert.equal(found.length, 1, `Require exactly one local ${expected.name} instance`)
  assert.ok(within(modules, found[0]), 'The patch target escapes this installation')
  const packageRoot = dirname(found[0]), pkg = json(found[0])
  assert.equal(pkg.name, expected.name)
  assert.equal(pkg.version, expected.version, `The shared DSH patch requires ${expected.name} ${expected.version}`)
  assert.equal(pkg.main, expected.main, 'Unexpected shared dependency entry point')
  if (expected.importEntry) assert.equal(pkg.exports?.['.']?.import, expected.importEntry, 'Unexpected shared dependency import entry point')
  assert.ok(within(packageRoot, realpathSync(join(packageRoot, expected.main))))
  return packageRoot
}

function inspect(anchor) {
  return binding().map(metadata => {
    const root = installation(anchor, metadata.package), files = []
    for (const name of Object.keys(metadata.before)) {
      assert.match(name, /^(?:dist\/api\/[a-z-]+|lib\/[a-zA-Z]+)\.js$/u)
      const path = join(root, name), stat = lstatSync(path)
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Linked or non-file patch target: ${name}`)
      assert.ok(within(root, realpathSync(path)), `Patch target escapes ${metadata.package.name}: ${name}`)
      const bytes = readFileSync(path), sha256 = hash(bytes)
      assert.ok(sha256 === metadata.before[name] || sha256 === metadata.after[name], `Dirty shared dependency file; reinstall before applying the DSH patch: ${metadata.package.name}/${name}`)
      files.push({ name, path, bytes, mode: stat.mode, patched: sha256 === metadata.after[name] })
    }
    const patched = files.filter(file => file.patched).length
    assert.ok(patched === 0 || patched === files.length, 'Partially patched dependency; reinstall before applying the DSH patch')
    return { metadata, files, patched: patched === files.length }
  })
}

function hunks(patch) {
  const result = new Map(), lines = patch.split('\n')
  let file, body
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(\S+) b\/\1$/u.exec(line)
      assert.ok(match, 'Unsupported canonical diff path')
      file = match[1]; assert.equal(result.has(file), false); result.set(file, []); body = undefined
    } else if (line.startsWith('@@ ')) {
      assert.ok(file)
      const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line)
      assert.ok(match, 'Unsupported canonical diff hunk')
      body = { oldCount: Number(match[1] ?? 1), newCount: Number(match[2] ?? 1), lines: [] }
      result.get(file).push(body)
    } else if (body && /^[ +\-]/u.test(line)) body.lines.push(line)
    else assert.ok(line === '' || /^(?:index |--- |\+\+\+ )/u.test(line), 'Unsupported canonical diff syntax')
  }
  for (const entries of result.values()) for (const entry of entries) {
    assert.equal(entry.lines.filter(line => line[0] !== '+').length, entry.oldCount)
    assert.equal(entry.lines.filter(line => line[0] !== '-').length, entry.newCount)
  }
  return result
}

/** Verify bytes without modifying the dependency tree. Safe at build and Host startup. */
export function verifyHostSharedPatch(anchor) {
  const states = inspect(anchor)
  assert.ok(states.every(state => state.patched), 'A shared DSH runtime patch is missing; run npm run patch:host after an ignore-scripts install')
  return { status: 'verified', sourceCommit, patches: states.map(({ metadata }) => ({ package: metadata.package.name, version: metadata.package.version, patchSha256: metadata.patchSha256 })), files: states.reduce((sum, state) => sum + state.files.length, 0) }
}

/** Apply only the exact canonical hunks to one installation, never a global npm store. */
export function applyHostSharedPatch(anchor) {
  const states = inspect(anchor)
  if (states.every(state => state.patched)) return { ...verifyHostSharedPatch(anchor), status: 'already-patched' }
  const outputs = states.filter(state => !state.patched).flatMap(state => {
    const changes = hunks(state.metadata.patch)
    assert.deepEqual([...changes.keys()], state.files.map(file => file.name))
    return state.files.map(file => {
      const original = file.bytes.toString('utf8'); let cursor = 0, output = ''
      for (const hunk of changes.get(file.name)) {
        const before = hunk.lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n'
        const after = hunk.lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n'
        const index = original.indexOf(before, cursor)
        assert.ok(index >= cursor && original.indexOf(before, index + 1) < 0, `Canonical hunk context must match exactly once: ${file.name}`)
        output += original.slice(cursor, index) + after; cursor = index + before.length
      }
      const bytes = Buffer.from(output + original.slice(cursor))
      assert.equal(hash(bytes), state.metadata.after[file.name], `Canonical patch output differs from DSH: ${file.name}`)
      return { ...file, bytes, temporary: `${file.path}.dsh-patch-${randomUUID()}.tmp` }
    })
  })
  try {
    for (const file of outputs) writeFileSync(file.temporary, file.bytes, { flag: 'wx', mode: file.mode })
    // All inputs and outputs have passed before any original file is replaced.
    // Rename rather than overwrite avoids modifying npm cache hardlinks.
    for (const file of outputs) renameSync(file.temporary, file.path)
  } finally { for (const file of outputs) rmSync(file.temporary, { force: true }) }
  return { ...verifyHostSharedPatch(anchor), status: 'applied' }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const anchor = resolve('package.json')
  const check = process.argv.slice(2)
  assert.ok(check.length === 0 || (check.length === 1 && check[0] === '--check'), 'Use --check or no arguments')
  console.log(JSON.stringify(check.length ? verifyHostSharedPatch(anchor) : applyHostSharedPatch(anchor)))
}
