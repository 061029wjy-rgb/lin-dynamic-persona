import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
for (const path of ['index.js', ...((await readdir('src')).filter(p => p.endsWith('.js')).map(p => 'src/' + p))]) {
    const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const source = await readFile(path, 'utf8');
    assert.equal(/writeExtensionField|saveWorldInfo|writePresetExtensionField|CHAT_COMPLETION_SETTINGS_READY|\.reasoning\s*=/.test(source), false, `Forbidden host mutation in ${path}`);
    // Strict Browser ESM Guard: forbid any node: builtin or non-relative module specifier in browser runtime code!
    const imports = [...source.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for (const m of imports) {
        const spec = m[1] || m[2] || '';
        assert.equal(spec.startsWith('./') || spec.startsWith('../'), true, `Browser-incompatible module specifier "${spec}" in ${path}`);
    }
}
assert.equal(manifest.js, 'index.js');
assert.equal(manifest.css, 'style.css');
assert.equal(manifest.generate_interceptor, 'linDynamicPersonaIntercept');
const entry = await readFile('index.js', 'utf8');
assert.match(entry, /linDynamicPersonaIntercept\s*=\s*async\s*\(chat, contextSize, abort, type\)/, 'Interceptor must declare the four ST host parameters');
const runtime = (await Promise.all((await readdir('src')).filter(p => p.endsWith('.js')).map(p => readFile('src/' + p, 'utf8')))).join('\n');
assert.equal(/semanticConceptVector|embeddingURL|\/embeddings\b|new\s+Embeddings\b/i.test(runtime), false, 'No vector or embedding execution path may remain');
assert.equal(JSON.parse(await readFile('package.json', 'utf8')).version, manifest.version);
console.log('Syntax, browser ESM specifier, manifest, version and host-mutation checks passed.');
