import {readFile,writeFile,rename} from 'node:fs/promises';
import {profile,target,httpWire,TransportError,publicFailure} from './protocol.js';
export const info={id:'lin-persona-gateway',name:'Lin Persona Analysis Gateway',description:'Optional per-user fixed-destination analysis gateway with server-only credentials.'};
export async function config(){if(!process.env.LDP_GATEWAY_CONFIG)return {slots:{},clients:{}};return JSON.parse(await readFile(process.env.LDP_GATEWAY_CONFIG,'utf8'));}
let g;async function accessToken(){if(!g){const {GoogleAuth}=await import('google-auth-library');g=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});}const tok=await g.getAccessToken();if(!tok)throw new TransportError('Vertex ADC 未就绪',401);return tok;}
const envKey=k=>/^LDP_[A-Z0-9_]+$/.test(k||'')?process.env[k]||'':'';
export function buildService({getConfig=config,token=accessToken,fetcher=globalThis.fetch,readKey=envKey,stateFile=process.env.LDP_GATEWAY_STATE||''}={}){
 const busy=new Set(),counts=new Map();let chain=Promise.resolve();
 async function reserveCount(file,k,day,limit){
  if(!file){const counter=counts.get(k),n=counter?.day===day?counter.count:0;if(n>=limit)throw new TransportError('服务端预算或并发上限',429);counts.set(k,{day,count:n+1});return;}
  const op=chain.then(async()=>{let data={};try{data=JSON.parse(await readFile(file,'utf8'));}catch{}
   const cur=data[k]?.day===day?Number(data[k].count)||0:0;if(cur>=limit)throw new TransportError('服务端预算或并发上限',429);
   data[k]={day,count:cur+1};counts.set(k,data[k]);const tmp=file+'.tmp.'+process.pid+'.'+Date.now();await writeFile(tmp,JSON.stringify(data),'utf8');await rename(tmp,file);});
  chain=op.catch(()=>{});return op;
 }
 return async function serve(account,packet,signal){
 const cfg=await getConfig(),slot=typeof packet?.slot==='string'&&Object.hasOwn(cfg.slots||{},packet.slot)?cfg.slots[packet.slot]:null;
 if(!account||!slot||!Array.isArray(slot.users)||!slot.users.includes(account))throw new TransportError('配置不存在或无权使用',403);
 const p=profile({...slot,allowSend:true});if(!p.enabled||p.kind==='st')throw new TransportError('配置已停用',403);
 const expected=packet.expected||{};if(p.kind!==expected.kind||p.model!==expected.model||p.kind==='vertex'&&['project','region','apiVersion'].some(k=>p[k]!==expected[k])||p.kind==='router'&&(p.pin!==expected.pin||p.fallback!==expected.fallback))throw new TransportError('客户端与管理员的目标不匹配',409);
 target(p);const r=packet.request;if(typeof r?.system!=='string'||!r.system||typeof r.prompt!=='string'||!r.prompt||!['text','json','schema'].includes(r.json)||!Number.isInteger(r.output)||r.output<1||r.output>16000)throw new TransportError('请求无效',400);
 if(Buffer.byteLength(r.system+r.prompt+(r.schema?JSON.stringify(r.schema):''))>Math.min((slot.byteLimit||96000),200000))throw new TransportError('输入过大',413);
 const k=account+'\n'+packet.slot,day=new Date().toISOString().slice(0,10),persistPath=stateFile||cfg.stateFile||'';
 if(busy.has(k))throw new TransportError('服务端预算或并发上限',429);busy.add(k);let tm;
 const ctrl=new AbortController(),cancel=()=>ctrl.abort();try{if(signal?.aborted)throw new TransportError('已取消',408);signal?.addEventListener('abort',cancel,{once:true});tm=setTimeout(cancel,p.timeout*1000);
 const key=p.kind==='vertex'?await token():readKey(slot.keyEnv);if(ctrl.signal.aborted)throw new TransportError('已取消',408);
 await reserveCount(persistPath,k,day,slot.serverDaily??100);
 const out=await httpWire(p,r,{key,header:readKey(slot.headerEnv)},ctrl.signal,fetcher,true);return {ok:true,response:out};
 }catch(e){if(e instanceof TransportError)throw e;throw new TransportError(ctrl.signal.aborted?'请求超时或取消':'网关上游或认证不可用',ctrl.signal.aborted?408:502);}finally{clearTimeout(tm);signal?.removeEventListener('abort',cancel);busy.delete(k);}
 };}
export const failure=e=>({ok:false,status:e.status||502,finish:e.detail?.finish,usage:e.detail?.usage,message:publicFailure(e.status||502)});
export async function init(router){const serve=buildService();router.post('/analyze',async(req,res)=>{const ctrl=new AbortController();res.on('close',()=>{if(!res.writableEnded)ctrl.abort();});res.set('Cache-Control','no-store');try{const val=await serve(req.user?.profile?.handle,req.body,ctrl.signal);res.json(val);}catch(e){/* Only bounded status metadata goes to the client; no provider body, credential or transcript logs. */const f=failure(e);res.status(200).json(f);}});}
