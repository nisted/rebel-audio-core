// Runs test/all.test.ts: bundles it with esbuild (so the TypeScript sources run as they are), then node --test.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

await import('./embed-page.mjs')
const out = join(mkdtempSync(join(tmpdir(), 'rebel-audio-core-test-')), 'all.test.mjs')
await build({
	entryPoints: [new URL('../test/all.test.ts', import.meta.url).pathname],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: out,
	banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
	logLevel: 'warning',
})
const r = spawnSync(process.execPath, ['--test', out], { stdio: 'inherit' })
process.exit(r.status ?? 1)
