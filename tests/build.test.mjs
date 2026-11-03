import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
const script = resolve('scripts/build.mjs')
const fixtureRoot = resolve('tests/.tmp')
mkdirSync(fixtureRoot, { recursive: true })

test('native preflight resolves the pinned compiler and bundler without repairing dependencies', () => {
  const before = existsSync('node_modules')
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /typescript.*6\.0\.3/)
  assert.match(result.stdout, /tsdown.*0\.22\.2/)
  assert.equal(existsSync('node_modules'), before)
})

test('an explicit missing checkout produces one actionable preflight failure', () => {
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', env: { ...process.env, DSH_CHECKOUT: resolve('tests/.tmp/missing-checkout') } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /preflight.*DSH_CHECKOUT|DSH_CHECKOUT.*not found/)
  assert.equal(existsSync('tests/.tmp/missing-checkout'), false)
})

test('a different compiler version is rejected before compiling or modifying the checkout', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'toolchain-'))
  try {
    mkdirSync(join(dir, 'node_modules/typescript/bin'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"local-toolchain-test"}')
    writeFileSync(join(dir, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"0.0.0","bin":{"tsc":"./bin/tsc"}}')
    writeFileSync(join(dir, 'node_modules/typescript/bin/tsc'), 'throw new Error("compiler must not run")')
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', env: { ...process.env, DSH_CHECKOUT: dir } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /typescript.*version.*6\.0\.3.*0\.0\.0/)
    assert.equal(readFileSync(join(dir, 'node_modules/typescript/bin/tsc'), 'utf8'), 'throw new Error("compiler must not run")')
  } finally {
    assert.ok(realpathSync(dir).startsWith(realpathSync(fixtureRoot) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a clean offline build emits every declared package export, including browser type declarations', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'clean-build-'))
  try {
    // 0.1.0 起包内还有官方 bundle 的静态资源（patch + locale + icon），
    // 它们是包的声明产物，不是构建产物，但同样必须出现在干净副本里。
    for (const path of ['src', 'types', 'scripts', 'package.json', 'toolchain.lock.json', 'tsconfig.json', 'tsconfig.client.json', 'tsdown.config.mjs', 'cordis.patch.yml', 'locale', 'icon.svg']) {
      cpSync(resolve(path), join(dir, path), { recursive: true })
    }
    const result = spawnSync(process.execPath, [join(dir, 'scripts/build.mjs'), '--no-pack'], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const [entry, value] of Object.entries(pkg.exports)) for (const target of typeof value === 'string' ? [value] : Object.values(value)) {
      // 通配导出（./locale/*.json）按目录展开后至少命中一个文件。
      if (target.includes('*')) {
        const [prefix, suffix] = target.split('*')
        const base = join(dir, prefix)
        const tail = suffix.slice(suffix.lastIndexOf('/') + 1)
        assert.ok(existsSync(base) && readdirSync(base).some(name => name.endsWith(tail)), `${entry} declares a missing built export glob: ${target}`)
      } else {
        assert.ok(existsSync(join(dir, target)), `${entry} declares a missing built export: ${target}`)
      }
    }
    assert.equal(existsSync(join(dir, 'node_modules')), false, 'A clean build must not install or repair dependencies')
  } finally {
    assert.ok(realpathSync(dir).startsWith(realpathSync(fixtureRoot) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})
