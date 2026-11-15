import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
if (!process.argv[2] || !process.argv[3]) throw new Error('Provide local lin-prefill-guard and lin-emotional-control directories');
const { planInjection, LIN_24_PREFILL } = await import(pathToFileURL(resolve(process.argv[2], 'core.js')));
const { boundary } = await import(pathToFileURL(resolve(process.argv[3], 'controller.js')));
import { compose } from '../src/prompt.js';
import { emptyState, normalizeInfluence } from '../src/model.js';
import { DEFAULTS } from '../src/controller.js';
const state = emptyState();
state.influences = [normalizeInfluence({ layer:'acquired', description:'对承诺更谨慎，但能理解意外' }, 'fang'), normalizeInfluence({ layer:'immediate', description:'本插件即时情绪' }, 'fang')];
const prompt = await compose({ actor:{id:'fang',name:'方'}, state, settings:DEFAULTS, legacy:true, countTokens:s=>s.length, seed:'stable' });
assert.ok(prompt.includes('承诺更谨慎')); assert.ok(!prompt.includes('本插件即时情绪'));
const messages = [{role:'system',content:prompt},{role:'user',content:'开始剧情'}, {role:'assistant',content:LIN_24_PREFILL}, {role:'user',content:'继续'}];
const legacyNote = '〔人性阴暗面/情绪/随机性放大·角色演出〕只有一个旧情绪落点';
for (const mode of ['observe','gemini4','gemini4-story','enhance']) for (const legacyFirst of [true,false]) {
 const request={type:'normal', model:'gemini-4-argon', chat_completion_source:'vertexai', max_tokens:8000, reasoning_effort:'high',messages: legacyFirst ? boundary(messages,legacyNote) : messages};
 const original=structuredClone(request), planned=planInjection(request,{enabled:true,requestMode:mode});
 if (mode === 'enhance') assert.ok(planned.applied, planned.reason);
 const final=legacyFirst ? (planned.messages||request.messages) : boundary(planned.messages||request.messages,legacyNote);
 assert.equal(final.filter(m=>m.content===prompt).length,1); assert.equal(final.filter(m=>m.content===legacyNote).length,1);
 assert.deepEqual(request,original); // pure guard planner and personality composition do not touch transport.
 const noPersona=final.filter(m=>m.content!==prompt); assert.equal(noPersona.filter(m=>m.content===legacyNote).length,1);
}
assert.equal(planInjection({...{messages},type:'quiet'},{enabled:true}).reason,'quiet');
console.log('9 source compatibility cases passed: 4 guard modes × 2 legacy insertion orders + quiet exclusion.');
