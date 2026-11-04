// Runs the core's tests: bundles each test file with esbuild (so the TypeScript sources run as they are), then node --test.
// test/all.test.ts: the engine, page and joining. test/recordings/recordings.test.ts: the recordings library.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

await import('./embed-page.mjs')
const dir = mkdtempSync(join(tmpdir(), 'rebel-audio-core-test-'))
const files = []
for (const [name, entry] of [
	['all.test.mjs', '../test/all.test.ts'],
	['joining.test.mjs', '../test/joining.test.ts'],
	['recordings.test.mjs', '../test/recordings/recordings.test.ts'],
]) {
	const outfile = join(dir, name)
	await build({
		entryPoints: [new URL(entry, import.meta.url).pathname],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		outfile,
		banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
		logLevel: 'warning',
	})
	files.push(outfile)
}
// the recordings tests use UK dates and times
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, TZ: process.env.TZ ?? 'Europe/London' } })
process.exit(r.status ?? 1)
