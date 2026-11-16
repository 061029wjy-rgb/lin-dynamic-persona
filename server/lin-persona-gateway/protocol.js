// Transport only. No settings storage, retry, source selection or logging in this module.
const str=(v,n=256)=>String(v??'').trim().slice(0,n);
const num=(v,d,l,h)=>Number.isFinite(Number(v))?Math.max(l,Math.min(h,Math.trunc(Number(v)))):d;
export const KINDS={st:'酒馆当前模型',openai:'OpenAI Chat Completions',deepseek:'DeepSeek',compat:'自定义 Chat Completions',router:'OpenRouter',gemini:'Gemini AI Studio 原生',vertex:'Vertex Gemini 原生',claude:'Claude Messages 原生',ollama:'Ollama 原生 /api/chat'};
export const BASE={openai:'https://api.openai.com/v1',deepseek:'https://api.deepseek.com/v1',router:'https://openrouter.ai/api/v1',gemini:'https://generativelanguage.googleapis.com',claude:'https://api.anthropic.com',ollama:'http://localhost:11434'};
const okId=s=>/^[a-zA-Z0-9_-]{1,80}$/.test(String(s||''))&&!['__proto__','constructor','prototype'].includes(s);
export function profile(v={}){
 const kind=Object.hasOwn(KINDS,v.kind)?v.kind:'st';return {id:okId(v.id)?v.id:'main',name:str(v.name||KINDS[kind],70),kind,
 enabled:v.enabled!==false,transport:kind==='st'?'st':kind==='vertex'?(v.transport==='remote'?'remote':'server'):['server','remote','direct'].includes(v.transport)?v.transport:'server',
 url:str(v.url||BASE[kind]||'',420),urlMode:v.urlMode==='endpoint'?'endpoint':'base',model:str(v.model,160),project:str(v.project,64),region:str(v.region||'global',40),apiVersion:str(v.apiVersion||(kind==='gemini'?'v1beta':kind==='claude'?'2023-06-01':'v1'),22),
 serverId:okId(v.serverId)?v.serverId:'analysis',gateway:str(v.gateway,360),pin:str(v.pin,90),fallback:v.fallback===true,allowLAN:v.allowLAN===true,sendBaseline:v.sendBaseline===true,
 output:num(v.output,2100,32,16000),input:num(v.input,12000,512,64000),timeout:num(v.timeout,45,2,180),json:['text','json','schema'].includes(v.json)?v.json:'text',
 header:['X-Client-Id','X-Api-Version','OpenAI-Organization','OpenAI-Project'].includes(v.header)?v.header:'',
 contract:v.contract==='focused'?'focused':'full',daily:num(v.daily,8,0,300),total:num(v.total,80,0,20000),actorLimit:num(v.actorLimit,8,0,300),sessionLimit:num(v.sessionLimit,8,0,300),interval:num(v.interval,15,0,3600),allowSend:v.allowSend===true};}
export const caps=k=>({schema:['st','openai','compat','router','gemini','vertex','ollama'].includes(k),json:!['st','claude'].includes(k),usage:k!=='st'});
const lan=h=>/^(localhost|127(?:\.\d+){3}|\[::1\]|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(1[6-9]|2\d|3[01])(?:\.\d+){2})$/i.test(h);
export function safeUrl(value,allowLAN=false){let u;try{u=new URL(value);}catch{throw Error('请输入含协议的完整地址。');}
 if(u.username||u.password||u.search||u.hash||u.protocol!=='https:'&&!(u.protocol==='http:'&&allowLAN&&lan(u.hostname)))throw Error('地址需为 HTTPS，不接受 URL 密钥或查询参数；本地明文仅限显式许可的局域网。');return u.href.replace(/\/+$/,'');}
export function routeFingerprint(p){return JSON.stringify([p.kind,p.transport,p.url,p.urlMode,p.model,p.serverId,p.gateway,p.project,p.region,p.apiVersion,p.header,p.pin,p.fallback,p.sendBaseline,p.allowLAN]);}
export function target(p){
 if(p.kind==='st')return 'SillyTavern';if(!p.model||!/^[-a-zA-Z0-9_:./@]+$/.test(p.model)||p.model.includes('..')||p.model.includes('//'))throw Error('请填写有效的实际模型 ID。');
 if(p.kind==='vertex'){if(!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(p.project)||!/^([a-z]+-[a-z]+[0-9]|global)$/.test(p.region)||!['v1','v1beta1'].includes(p.apiVersion)||!/^[-\w.@]+$/.test(p.model))throw Error('请核对 Vertex 项目、地域、版本和发布模型 ID。');
 return 'https://'+(p.region==='global'?'':p.region+'-')+'aiplatform.googleapis.com/'+p.apiVersion+'/projects/'+p.project+'/locations/'+p.region+'/publishers/google/models/'+p.model+':generateContent';}
 const base=safeUrl(p.url,p.allowLAN),path=new URL(base).pathname;
 if(p.kind==='gemini'&&(!/^v1(?:beta|alpha)?$/.test(p.apiVersion)||!/^[-\w.]+$/.test(p.model.replace(/^models\//,''))))throw Error('Gemini API 版本或模型 ID 不正确。');
 if(p.kind==='claude'&&!/^\d{4}-\d\d-\d\d$/.test(p.apiVersion))throw Error('Claude API 版本应为日期。');
 const suffix=p.kind==='gemini'?'/'+p.apiVersion+'/models/'+p.model.replace(/^models\//,'')+':generateContent':p.kind==='claude'?'/v1/messages':p.kind==='ollama'?'/api/chat':'/chat/completions';
 if(p.urlMode==='endpoint'){if(p.kind==='gemini'&&!path.endsWith('/models/'+p.model.replace(/^models\//,'')+':generateContent'))throw Error('Gemini endpoint 与模型 ID 不一致。');return base;}
 if(path.endsWith(suffix)||p.kind==='claude'&&path.endsWith('/messages')||p.kind==='gemini'&&path.endsWith(':generateContent'))throw Error('该地址已是完整 endpoint，请切换地址类型。');
 if(p.kind==='gemini'&&path.endsWith('/'+p.apiVersion))return base+suffix.slice(p.apiVersion.length+1);
 if(p.kind==='claude'&&path.endsWith('/v1'))return base+'/messages';if(p.kind==='ollama'&&path.endsWith('/api'))return base+'/chat';
 return base+suffix;}
export class TransportError extends Error{constructor(message,code=0,detail={}){super(message);this.status=code;this.detail=detail;}}
export function publicFailure(status){return ({400:'参数、模型或 JSON 能力不被接受',401:'认证失败；已暂停此档',402:'余额不足；已暂停此档',403:'无权限；已暂停此档',404:'模型、端点或服务端配置不存在',409:'配置或请求版本冲突',413:'输入超过限制',429:'限流或配额不足；不自动重试'})[status]||(status>=500?'服务暂时不可用':'请求失败');}
export function makeWire(p,r,auth={},server=false){
 const url=target(p);if(p.kind==='vertex'&&!server)throw Error('Vertex 凭证和 OAuth 仅在可信服务端使用。');
 if(p.kind==='router'&&!p.fallback&&(!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)?$/.test(p.pin)||/^openrouter\/(auto|free|bodybuilder)$/i.test(p.model)))throw Error('关闭自动路由时，请填单一供应商标识，使用明确的模型。');
 const headers={'Content-Type':'application/json'},key=auth.key||'',opt=r.json||p.json,sc=r.schema;
 if(p.kind!=='ollama'&&p.kind!=='compat'&&!key)throw Error('缺少此配置档的认证。');
 if(key){if(/[\r\n]/.test(key))throw Error('密钥格式错误。');if(p.kind==='gemini')headers['x-goog-api-key']=key;else if(p.kind==='claude')headers['x-api-key']=key;else headers.Authorization='Bearer '+key;}
 if(p.header&&auth.header){if(/[\r\n]/.test(auth.header))throw Error('Header 含换行。');headers[p.header]=auth.header;}
 const max=Math.min(p.output,Math.max(1,r.output||p.output)),messages=[{role:'system',content:r.system},{role:'user',content:r.prompt}];let body;
 if(['gemini','vertex'].includes(p.kind)){const c={maxOutputTokens:max};if(opt!=='text'){c.responseMimeType='application/json';if(opt==='schema'&&sc)c.responseJsonSchema=sc;}
 body={systemInstruction:{parts:[{text:r.system}]},contents:[{role:'user',parts:[{text:r.prompt}]}],generationConfig:c};}
 else if(p.kind==='claude'){headers['anthropic-version']=p.apiVersion;if(!server)headers['anthropic-dangerous-direct-browser-access']='true';body={model:p.model,system:r.system,messages:messages.slice(1),max_tokens:max,stream:false};}
 else if(p.kind==='ollama'){body={model:p.model,messages,stream:false,options:{num_predict:max}};if(opt!=='text')body.format=opt==='schema'&&sc?sc:'json';}
 else{body={model:p.model,messages,stream:false,[p.kind==='openai'?'max_completion_tokens':'max_tokens']:max};if(p.kind==='router')body.provider={allow_fallbacks:p.fallback,...(p.pin?(p.fallback?{order:[p.pin]}:{only:[p.pin]}):{})};if(opt!=='text')body.response_format=opt==='schema'&&sc&&caps(p.kind).schema?{type:'json_schema',json_schema:{name:'lin_psychology',strict:true,schema:sc}}:{type:'json_object'};}
 return {url,headers,body};}
const tiny=(v)=>typeof v==='string'?v.replace(/[^\w.:/@ -]/g,'').slice(0,128):undefined;
const usage=(a,b,t)=>{const n=x=>Number.isFinite(x)&&x>=0?x:undefined;return {input:n(a),output:n(b),total:n(t)??(n(a)!=null&&n(b)!=null?a+b:undefined)};};
export function unpack(p,j,status=200,reqId){
 if(!j||typeof j!=='object')throw new TransportError('响应不是 JSON 对象。',status);
 let body='',finish,model,provider,used,requestId,blocked=false;
 if(['gemini','vertex'].includes(p.kind)){const c=j.candidates?.[0],u=j.usageMetadata||{};finish=c?.finishReason||j.promptFeedback?.blockReason;blocked=!!j.promptFeedback?.blockReason||finish!=='STOP';
 body=(c?.content?.parts||[]).filter(z=>!z.thought&&typeof z.text==='string').map(z=>z.text).join('');model=j.modelVersion;requestId=j.responseId;used=usage(u.promptTokenCount,u.candidatesTokenCount,u.totalTokenCount);}
 else if(p.kind==='claude'){finish=j.stop_reason;blocked=finish!=='end_turn'&&finish!=='stop_sequence';body=(j.content||[]).filter(z=>z.type==='text').map(x=>x.text).join('');model=j.model;requestId=j.id;used=usage(j.usage?.input_tokens,j.usage?.output_tokens);}
 else if(p.kind==='ollama'){finish=j.done_reason||(j.done===true?'stop':undefined);blocked=!j.done||finish!=='stop'||!!j.message?.tool_calls?.length;body=j.message?.content;model=j.model;used=usage(j.prompt_eval_count,j.eval_count);}
 else{const c=j.choices?.[0];finish=c?.finish_reason;blocked=finish!=='stop'||!!c?.message?.refusal||!!c?.message?.tool_calls?.length;const content=c?.message?.content;body=Array.isArray(content)?content.filter(x=>x.type==='text').map(x=>x.text).join(''):content;model=j.model;provider=j.provider;used=usage(j.usage?.prompt_tokens,j.usage?.completion_tokens,j.usage?.total_tokens);requestId=j.id;}
 const meta={status,model:tiny(model),provider:tiny(provider),finish:tiny(finish),usage:used,requestId:tiny(reqId||requestId),cost:p.kind==='router'&&Number.isFinite(j.usage?.cost)?j.usage.cost:undefined};
 if(blocked||typeof body!=='string'||!body.trim())throw new TransportError('未取得完整可见文本（'+(meta.finish||'无候选或结束原因')+'）。',status,meta);
 return {...meta,text:body};}
export async function jsonResponse(res){if(!res.ok)throw new TransportError('HTTP '+res.status+'：'+publicFailure(res.status),res.status);
 if(Number(res.headers?.get('content-length'))>1048576)throw new TransportError('响应过大。',res.status);
 const reader=res.body?.getReader?.();let txt='';if(reader){let size=0;const dec=new TextDecoder();try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel();throw Error('响应过大。');}txt+=dec.decode(value,{stream:true});}txt+=dec.decode();}finally{reader.releaseLock();}}else txt=await res.text();
 try{return JSON.parse(txt);}catch{throw new TransportError('响应 JSON 不完整。',res.status);}}
export async function httpWire(p,r,auth,signal,fetcher=globalThis.fetch,server=false,wire=makeWire(p,r,auth,server)){
 const res=await fetcher(wire.url,{method:'POST',headers:wire.headers,body:JSON.stringify(wire.body),signal,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});return unpack(p,await jsonResponse(res),res.status,res.headers.get('x-request-id')||res.headers.get('request-id'));}
export function buildAdapter(p,ctx,{fetcher=globalThis.fetch,secrets={}}={}){
 const prepare=(r)=>{if(!p.enabled||!p.allowSend)throw Error('配置未启用或尚未授权发送。');if(!r?.prompt||!r.system)throw Error('缺少分析输入。');
 if(p.kind==='st'){if(typeof ctx.generateRaw!=='function')throw Error('宿主未提供当前模型分析。');return;}
 if(p.kind==='vertex')target(p);if(p.transport==='direct')return makeWire(p,r,secrets);if(p.transport==='remote'){safeUrl(p.gateway,false);if(!secrets.gatewayKey)throw Error('未填写可信网关会话令牌。');}else if(!ctx.getRequestHeaders)throw Error('ST 服务端网关入口不可用。');};
 const run=async (r,signal,wire)=>{if(p.kind==='st'){const args={prompt:r.prompt,systemPrompt:r.system};if(r.json==='schema'&&r.schema)args.jsonSchema={name:'lin_persona_review',strict:true,value:r.schema};const result=await ctx.generateRaw(args);
 if(typeof result!=='string'||!result.trim())throw Error('酒馆没有返回可见文本。');return {text:result,model:tiny(ctx.getChatCompletionModel?.()),finish:undefined,usage:{}};}
 if(p.transport==='direct')return httpWire(p,r,secrets,signal,fetcher,false,wire);
 const remote=p.transport==='remote',url=remote?safeUrl(p.gateway,false)+'/analyze':'/api/plugins/lin-persona-gateway/analyze';
 const expected={kind:p.kind,model:p.model,...(p.kind==='vertex'?{project:p.project,region:p.region,apiVersion:p.apiVersion}:{}),...(p.kind==='router'?{pin:p.pin,fallback:p.fallback}:{})};
 const res=await fetcher(url,{method:'POST',headers:remote?{'Content-Type':'application/json',Authorization:'Bearer '+secrets.gatewayKey}:ctx.getRequestHeaders(),credentials:remote?'omit':'same-origin',redirect:'error',referrerPolicy:'no-referrer',signal,body:JSON.stringify({slot:p.serverId,expected,request:{system:r.system,prompt:r.prompt,output:r.output,json:r.json,schema:r.schema}})});
 const obj=await jsonResponse(res);if(!obj.ok||typeof obj.response?.text!=='string')throw new TransportError(publicFailure(obj.status||502)+(obj.finish?' · '+tiny(obj.finish):''),obj.status||502,{usage:obj.usage,finish:tiny(obj.finish)});return obj.response;};
 return {capabilities:()=>caps(p.kind),prepare,analyze:run,testConnection:run};}
