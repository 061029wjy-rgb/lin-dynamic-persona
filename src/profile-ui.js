import {id} from './util.js';
import {KINDS,BASE,profile} from './providers.js';
import {preview,sandbox} from './lab.js';

export function profilesPanel(panel,u){
 const {el,field,input,textarea,select,toggle,button,modal,download}=u,c=panel.c,svc=c.analyzer;
 modal('副 API 与自动成长',(body,close)=>{
 const catchHere=fn=>async()=>{try{await fn();}catch(e){result.textContent=e.message;}},result=el('pre',{class:'ldp-wrap','aria-live':'polite'}),sheet=el('div');
 const choose=select(Object.fromEntries(svc.profiles.map(x=>[x.id,x.name])),c.settings().activeProfile);
 const editor=(p)=>{sheet.replaceChildren();let enabled=p.enabled,consent=p.allowSend,card=p.sendBaseline,lan=p.allowLAN,fallback=p.fallback,forget=false,newConsent=false;
 const vals={},row=(k,name,n)=>{vals[k]=n;return field(name,n);},t=(k,name,type='text')=>row(k,name,input(p[k],type));
 const name=t('name','配置名称'),kind=select(KINDS,p.kind),transport=select({server:'当前 ST 的安全网关',remote:'独立 HTTPS 网关（可用于 Tauri）',direct:'浏览器直连；密钥仅本次打开页面有效'},p.transport==='st'?'server':p.transport),url=input(p.url),model=input(p.model),apiVersion=input(p.apiVersion),serverId=input(p.serverId),gateway=input(p.gateway),project=input(p.project),region=input(p.region),pin=input(p.pin),secret=input('','password'),headerVal=input('','password'),gatewayKey=input('','password');for(const n of [secret,headerVal,gatewayKey])n.autocomplete='off';
 const authBox=el('div'),budget=el('details',{},el('summary',{},'单档预算、间隔与高级请求参数')),apiBox=el('section'),route=el('div');
 const num=(k,label)=>budget.append(t(k,label,'number'));for(const [k,label]of Object.entries({input:'单次输入硬上限（UTF-8 字节，保守限制）',output:'最大输出 tokens（ST 当前模型沿用宿主）',timeout:'超时秒数',interval:'两次请求最短间隔（秒）',total:'本配置累计上限',daily:'每日上限（UTC）',sessionLimit:'本页会话上限',actorLimit:'每角色每日上限'}))num(k,label);
 const urlMode=select({base:'Base URL（不含操作路径）',endpoint:'完整 endpoint'},p.urlMode),json=select({text:'提示要求 JSON，本地严格校验',json:'原生 JSON（支持时）',schema:'原生 Schema（支持时）'},p.json),header=select({'':'无','X-Client-Id':'X-Client-Id','X-Api-Version':'X-Api-Version','OpenAI-Organization':'OpenAI-Organization','OpenAI-Project':'OpenAI-Project'},p.header);
 function paint(){const k=kind.value,d=transport.value;route.replaceChildren();authBox.replaceChildren();apiBox.replaceChildren();
 if(k==='st')apiBox.append(el('p',{},'使用当前酒馆连接；仍会发起独立请求。宿主不能保证提供结束原因或真实用量。'));
 else{if(k==='vertex'&&d==='direct')transport.value='server';apiBox.append(field('连接方式',transport),field('实际模型 ID',model));
 if(transport.value==='direct'){route.append(field('地址类型',urlMode),field('请求地址',url),toggle('允许直接连接本机或局域网 HTTP（手机 localhost 指手机）',lan,v=>lan=v));authBox.append(field('API Key · 仅内存',secret),field('允许的额外 Header 名',header),field('Header 值 · 仅内存',headerVal));}
 else{route.append(field('管理员分配的配置槽',serverId));if(transport.value==='remote'){route.append(field('独立网关 HTTPS 根地址',gateway));authBox.append(field('网关登录令牌 · 仅内存',gatewayKey));}else authBox.append(el('p',{},'供应商凭证由酒馆服务器管理员设置；本页不接收服务账号私钥。'));}
 if(k==='vertex')route.append(field('Google Cloud 项目 ID',project),field('地域（或 global）',region));
 if(['gemini','claude','vertex'].includes(k))route.append(field('供应商 API 版本',apiVersion));
 if(k==='router')route.append(field('固定供应商标识（默认必填）',pin),toggle('明确允许 OpenRouter 供应商回退',fallback,v=>fallback=v));
 apiBox.append(route,authBox);}}
 for(const n of [url,urlMode,model,transport,apiVersion,serverId,gateway,project,region,pin,header])n.addEventListener('input',()=>{consent=false;newConsent=false;consentBox.querySelector('input').checked=false;});
 kind.onchange=()=>{const def=profile({kind:kind.value});url.value=def.url;apiVersion.value=def.apiVersion;model.value='';secret.value='';gatewayKey.value='';consent=false;consentBox.querySelector('input').checked=false;paint();};transport.onchange=paint;
 const consentBox=toggle('允许本配置接收当前角色可见的选中剧情及必要人格；可能收费',consent,v=>{consent=v;newConsent=v;});
 const get=()=>({...p,...Object.fromEntries(Object.entries(vals).map(([k,n])=>[k,n.value])),kind:kind.value,transport:transport.value,url:url.value,urlMode:urlMode.value,model:model.value,apiVersion:apiVersion.value,serverId:serverId.value,gateway:gateway.value,project:project.value,region:region.value,pin:pin.value,header:header.value,json:json.value,enabled,allowSend:consent,sendBaseline:card,allowLAN:lan,fallback});
 function save(){const fields={};if(secret.value)fields.key=secret.value;if(headerVal.value)fields.header=headerVal.value;if(gatewayKey.value)fields.gatewayKey=gatewayKey.value;if(forget)svc.memory.delete(p.id);
 const obj=svc.save(get(),fields,false,newConsent);for(const n of [secret,headerVal,gatewayKey])n.value='';return obj;}
 const testPanel=el('details',{},el('summary',{},'连接测试、发送预览、模拟剧情')),sample=textarea('玩家：项目今天已经验收。\n角色：我有点释然，也舍不得这段合作。',3);
 testPanel.append(button('预览待分析数据（仅本地）',catchHere(()=>{const o=preview(c,panel.actorId,profile(get()));result.textContent=o?o.systemPrompt+'\n'+JSON.stringify(JSON.parse(o.prompt),null,2):'没有待分析原文。';})),
 button('保存并测试连接（1 次，无剧情）',catchHere(async()=>{const o=save();result.textContent=JSON.stringify(await svc.probe(o.id),null,2);})),field('模拟剧情（不读取本聊天、不写人格）',sample),
 button('保存并运行沙盒（1 次）',catchHere(async()=>{const o=save();result.textContent=JSON.stringify(await sandbox(c,o,sample.value,c.settings().approval),null,2); })));
 budget.append(row('contract','分析合同',select({full:'完整演化（人格、复杂情绪、目标、反证）',focused:'小模型精简：仅提议本人明确说出的即时感受'},p.contract)),field('结构化输出策略',json));sheet.append(name,field('协议',kind),apiBox,toggle('配置可用（取消即暂停）',enabled,v=>enabled=v),consentBox,toggle('额外发送角色卡基线节选（默认关）',card,v=>card=v),toggle('保存时清除该档会话凭证',false,v=>forget=v),budget,
 button('保存并选为日常分析',catchHere(()=>{const o=save();c.changeSettings({activeProfile:o.id});refresh(o.id);result.textContent='已保存；只有启用 AI 后才会发送。';})),
 button('设为单独复核档',catchHere(()=>{const o=save();c.changeSettings({reviewProfile:o.id});refresh(o.id);result.textContent='仅点“请求第二意见”时调用。';})),button('删除本档',catchHere(()=>{if(!confirm('删除本档及本页认证？其他档不会接手队列。'))return;svc.drop(p.id);refresh();})),testPanel);paint();}
 function refresh(key){const opts=svc.profiles;choose.replaceChildren(...opts.map(v=>el('option',{value:v.id,selected:v.id===key},v.name)));if(opts.length)editor(opts.find(v=>v.id===key)||opts[0]);else sheet.replaceChildren(el('p',{},'尚无配置。请新建。'));}
 choose.onchange=()=>editor(svc.getProfile(choose.value));const approval=select({manual:'A 手工审核全部',conservative:'B 自动保守（明确心理与本人计划）',auto:'C 自动成长（可采用有独立证据的长期倾向）'},c.settings().approval);approval.onchange=()=>c.changeSettings({approval:approval.value});
 const ai=toggle('允许额外模型请求（默认关闭）',c.settings().analysisEnabled,v=>{c.changeSettings({analysisEnabled:v});if(!v)autoCtl.querySelector('input').checked=false;});
 const autoCtl=toggle('在有效回复保存后自动排队',c.settings().autoAnalyze,v=>{if(v&&!c.settings().analysisEnabled){autoCtl.querySelector('input').checked=false;result.textContent='请先允许额外请求。';return;}c.changeSettings({autoAnalyze:v});});
 body.append(ai,autoCtl,field('采用提案策略',approval),el('p',{},'纯本地可检索、到期和人工编辑。OpenAI Responses 暂不支持。直连密钥会在浏览器内存和浏览器请求中可见；服务端凭证不回传。'),field('编辑的配置档',choose),
 button('新建配置',()=>editor(profile({id:'p-'+id(),name:'新副接口',kind:'openai',allowSend:false}))),sheet,
 button('暂停自动队列并取消当前分析',()=>{c.changeSettings({autoAnalyze:false});c.sessions.clear();autoCtl.querySelector('input').checked=false;result.textContent='停止派发；已发送的调用可能计费。';}),
 button('导出非敏感配置',()=>download('lin-analysis-profiles.json',JSON.stringify(svc.profiles.map(v=>({...v,allowSend:false})),null,2))),
 button('导入非敏感配置',()=>{const file=input('','file');file.accept='.json';file.onchange=catchHere(async()=>{const f=file.files[0];if(!f||f.size>128000)throw Error('文件过大。');const rows=JSON.parse(await f.text());if(!Array.isArray(rows)||rows.length>24)throw Error('不是配置档列表。');for(const v of rows)svc.save({...v,id:'p-'+id(),enabled:false},{},true);refresh();result.textContent='已导入为停用的新档；需重新授权。';});file.click();}),
 button('查看调用账本',catchHere(async()=>{const a=(await c.db.all('usage')).filter(v=>v.key.startsWith('job:')).sort((a,b)=>b.at-a.at).slice(0,35);result.textContent=JSON.stringify(a.map(({pid,kind,result,at,http,model,finish,usage,provider,cost,estimate})=>({配置:pid,类型:kind,时间:new Date(at).toLocaleString(),结果:result,http,模型:model,供应商:provider,结束:finish,已报告用量:usage||'未知',费用:cost,输入估算:estimate})),null,2);})),result);refresh(c.settings().activeProfile);});}
