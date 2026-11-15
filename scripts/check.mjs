import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
for (const path of ['index.js', ...((await readdir('src')).filter(p => p.endsWith('.js')).map(p => 'src/' + p))]) {
 const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' }); assert.equal(check.status, 0, check.stderr);
 const source = await readFile(path, 'utf8');
 assert.equal(/writeExtensionField|saveWorldInfo|writePresetExtensionField|CHAT_COMPLETION_SETTINGS_READY|\.reasoning\s*=/.test(source), false, `Forbidden host mutation in ${path}`);
}
assert.equal(manifest.js, 'index.js'); assert.equal(manifest.css, 'style.css'); assert.equal(manifest.generate_interceptor, 'linDynamicPersonaIntercept');
assert.equal(JSON.parse(await readFile('package.json', 'utf8')).version, manifest.version);
console.log('Syntax, manifest, version and host-mutation checks passed.');
