// Video host packaging: exact peers share the installed DSH runtime; source stays in this fork.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = dirname(pluginRoot)
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || `${command} failed`)
  return result.stdout.trim()
}

// Reading package metadata through resolution paths also covers packages without a package.json export.
export function packageRoot(name, anchors) {
  for (const anchor of anchors) {
    for (const directory of createRequire(anchor).resolve.paths(name) ?? []) {
      const candidate = join(directory, name)
      if (!existsSync(join(candidate, 'package.json'))) continue
      const root = realpathSync(candidate)
      assert.equal(readJson(join(root, 'package.json')).name, name, `Unexpected package at ${candidate}`)
      return root
    }
  }
  throw new Error(`Missing host package: ${name}`)
}

export function inspectHost(hostManifest, peers, hostVersion) {
  const manifest = realpathSync(hostManifest)
  const installed = readJson(manifest)
  assert.equal(installed.name, '@deepseek-ai/dsh', '--host must be the installed DSH CLI package.json')
  assert.equal(installed.version, hostVersion, 'DSH host version differs from the fixed artifact')
  const anchors = [manifest]
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const file = join(packageRoot(name, anchors), 'package.json')
    assert.equal(readJson(file).version, hostVersion, `Mixed DSH family: ${name}`)
    anchors.push(file)
  }
  const roots = {}
  for (const [name, expected] of Object.entries(peers)) {
    assert.match(expected, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `Unpinned host peer: ${name}`)
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(expected, hostVersion, `Mixed DSH peer: ${name}`)
    const directory = packageRoot(name, anchors)
    assert.equal(readJson(join(directory, 'package.json')).version, expected, `Host peer version drift: ${name}`)
    roots[name] = directory
  }
  return roots
}

/** Verify a normal package-manager install uses exactly the host's peer modules. */
export function verifyHostPackage(pluginDirectory, hostManifest) {
  const directory = realpathSync(pluginDirectory)
  const manifest = readJson(join(directory, 'package.json'))
  const binding = readJson(join(directory, 'host-package.json'))
  assert.equal(manifest.name, 'ds-bot')
  assert.equal(binding.schemaVersion, 1)
  assert.equal(binding.version, manifest.version)
  assert.match(binding.sourceCommit, /^[a-f0-9]{40}$/)
  assert.deepEqual(binding.packages, manifest.peerDependencies, 'Host binding differs from the package peers')
  const roots = inspectHost(hostManifest, binding.packages, binding.hostVersion)
  for (const [name, expectedRoot] of Object.entries(roots)) {
    assert.equal(packageRoot(name, [join(directory, 'package.json')]), expectedRoot, `Duplicate host runtime: ${name}`)
  }
  return { version: manifest.version, hostVersion: binding.hostVersion, peers: Object.keys(roots).length }
}

function payloadFiles(manifest) {
  const files = []
  const visit = relative => {
    const absolute = join(pluginRoot, relative)
    const stat = lstatSync(absolute)
    assert.ok(!stat.isSymbolicLink(), `Payload cannot contain links: ${relative}`)
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${relative.replace(/\/$/, '')}/${name}`)
    } else {
      assert.ok(stat.isFile(), `Payload must contain regular files: ${relative}`)
      files.push(relative)
    }
  }
  for (const entry of manifest.files) if (entry !== 'host-package.json') visit(entry.replace(/\/$/, ''))
  return files.sort()
}

/** Hash the actual archive, including the packer's normalized package.json. */
export async function packedFileDigests(bytes, expectedFiles) {
  const { Parser } = await import('tar')
  const allowed = new Set(expectedFiles)
  const digests = new Map()
  let failure
  await new Promise((done, reject) => {
    const parser = new Parser({ strict: true, onReadEntry(entry) {
      if (entry.type === 'Directory') { entry.resume(); return }
      const name = entry.path.startsWith('package/') ? entry.path.slice(8) : ''
      if (entry.type !== 'File' || !allowed.has(name) || digests.has(name)) {
        failure = new Error(`Unexpected archive entry: ${entry.path}`)
        entry.resume()
        return
      }
      const digest = createHash('sha256')
      digests.set(name, digest)
      entry.on('data', bytes => digest.update(bytes))
    } })
    parser.on('error', reject)
    parser.on('end', () => failure ? reject(failure) : done())
    parser.end(bytes)
  })
  assert.deepEqual([...digests.keys()].sort(), [...allowed].sort(), 'Archive payload differs from the allowlist')
  return Object.fromEntries([...digests].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, digest]) => [name, digest.digest('hex')]))
}

export async function prepareHostPackage({ hostManifest, pnpmCli, output }) {
  const git = args => run('git', args, repositoryRoot)
  assert.equal(git(['status', '--porcelain', '--untracked-files=normal']), '', 'Commit source and rebuilt client.js before packing')
  const config = readJson(join(pluginRoot, 'host-artifact.json'))
  const template = readJson(join(pluginRoot, 'package.json'))
  assert.equal(config.schemaVersion, 1)
  assert.match(template.version, /^\d+\.\d+\.\d+-vh\.\d+$/, 'Use a new exact fork artifact version')
  assert.equal(readJson(resolve(pnpmCli, '../../package.json')).version, config.pnpmVersion, 'Use the pinned pnpm packer')
  inspectHost(hostManifest, template.peerDependencies, config.hostVersion)
  run(process.execPath, ['scripts/build-client.mjs', '--check'], pluginRoot)
  const binding = { schemaVersion: 1, version: template.version, hostVersion: config.hostVersion,
    repository: config.repository, sourceCommit: git(['rev-parse', 'HEAD']), upstreamCommit: config.upstreamCommit,
    packages: template.peerDependencies }
  const destination = resolve(output)
  const archive = `${template.name}-${template.version}.tgz`
  mkdirSync(destination, { recursive: true })
  assert.ok(!existsSync(join(destination, archive)) && !existsSync(join(destination, `${archive}.json`)), 'Refusing to overwrite a fixed artifact')
  const stage = mkdtempSync(join(tmpdir(), 'ds-bot-host-'))
  try {
    const files = payloadFiles(template)
    const tracked = new Set(git(['ls-files', '-z', 'ds-bot']).split('\0').map(file => file.replace(/^ds-bot\//, '')))
    for (const file of files) {
      assert.ok(tracked.has(file), `Payload must be tracked: ${file}`)
      mkdirSync(dirname(join(stage, file)), { recursive: true })
      writeFileSync(join(stage, file), readFileSync(join(pluginRoot, file)))
    }
    const manifest = { ...template }
    delete manifest.scripts
    delete manifest.devDependencies
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(stage, 'host-package.json'), `${JSON.stringify(binding, null, 2)}\n`)
    run(process.execPath, [resolve(pnpmCli), 'pack', '--pack-destination', destination], stage)
    const bytes = readFileSync(join(destination, archive))
    const receipt = { ...binding, archive, sha256: hash(bytes),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, bytes: bytes.length,
      files: await packedFileDigests(bytes, [...files, 'package.json', 'host-package.json']) }
    writeFileSync(join(destination, `${archive}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
    return receipt
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--host', '--pnpm-cli', '--output', '--plugin'].includes(args[i]) && args[i + 1] && !options[args[i]], 'Invalid or repeated option')
    options[args[i]] = args[i + 1]
  }
  assert.ok(options['--host'], 'An explicit --host is required')
  if (command === 'prepare') {
    assert.ok(options['--pnpm-cli'] && options['--output'], 'prepare requires --pnpm-cli and --output')
    console.log(JSON.stringify(await prepareHostPackage({ hostManifest: options['--host'], pnpmCli: options['--pnpm-cli'], output: options['--output'] }), null, 2))
  } else {
    assert.ok(command === 'verify' && options['--plugin'], 'Use prepare or verify --plugin')
    console.log(JSON.stringify(verifyHostPackage(options['--plugin'], options['--host'])))
  }
}
