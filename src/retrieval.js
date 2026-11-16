import {text} from './util.js';
const seg=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh',{granularity:'word'}):null;
const nav=[['约定','邀约','赴约','约好','爽约','失约','放鸽子'],['修稿','改稿','返工','修改稿','修改要求'],['乐谱','总谱','曲谱'],['行李','箱子','旅行箱'],['道歉','赔不是','致歉'],['交接','移交','收尾','清单','台账']];
export const RETRIEVAL_CAPABILITY_MODES={local:'本地中文全文 · BM25＋原文及摘要导航'};
export function terms(value){const s=String(value||'').normalize('NFKC').toLowerCase(),t=[];for(const m of s.matchAll(/[a-z0-9]+|[\p{Script=Han}]+/gu)){
 const v=m[0];if(!/^\p{Script=Han}/u.test(v)){t.push(v);continue;}if(seg){for(const e of seg.segment(v))if(e.isWordLike)t.push(e.segment);}
 const chars=Array.from(v);if(chars.length===1)t.push(v);for(let i=0;i<chars.length-1;i++){t.push(chars.slice(i,i+2).join(''));if(i+2<chars.length)t.push(chars.slice(i,i+3).join(''));}}
 for(const g of nav)if(g.some(x=>s.includes(x)))t.push('topic:'+g[0]);for(const m of s.matchAll(/(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})(?:日|号)?/g))t.push('date:'+(m[1]||'')+':'+Number(m[2])+':'+Number(m[3]));return t;}
export function lexical(a,b){const q=new Set(terms(a)),d=new Set(terms(b));let n=0;for(const x of q)if(d.has(x))n++;return n/Math.max(1,Math.sqrt(q.size*d.size));}
export class TextIndex{
 constructor(){this.docs=new Map();this.postings=new Map();this.total=0;this.dedupedOccurrences=[];}
 remove(id){const d=this.docs.get(id);if(!d)return;for(const x of d.tf.keys()){const p=this.postings.get(x);p.delete(id);if(!p.size)this.postings.delete(x);}this.total-=d.length;this.docs.delete(id);}
 put(d,termList){this.remove(d.id);const ts=termList||terms(d.search||d.text),tf=new Map();for(const tok of ts)tf.set(tok,(tf.get(tok)||0)+1);this.docs.set(d.id,{...d,tf,length:ts.length});this.total+=ts.length;for(const [w,n] of tf){if(!this.postings.has(w))this.postings.set(w,new Map());this.postings.get(w).set(d.id,n);}}
 search(q,{limit=3,skip=new Set(),before=Infinity,aliases={},pin=true}={}){let query=String(q||'');for(const [word,options] of Object.entries(aliases))if(Array.isArray(options)&&[word,...options].some(x=>x&&query.includes(x)))query+=' '+word+' '+options.join(' ');
 const N=this.docs.size,avg=this.total/Math.max(1,N),scores=new Map(),k=1.3,b=.72;
 for(const term of new Set(terms(query))){const posting=this.postings.get(term);if(!posting)continue;const idf=Math.log1p((N-posting.size+.5)/(posting.size+.5));
 for(const [id,tf] of posting){const d=this.docs.get(id);if(d.index>=before||d.nodes?.some(n=>skip.has(n)))continue;scores.set(id,(scores.get(id)||0)+idf*tf*(k+1)/(tf+k*(1-b+b*d.length/(avg||1))));}}
 const arr=[...scores].map(([id,score])=>{const d=this.docs.get(id);return {d,score:score*(1+Math.min(.12,(d.salience||0)*.12))+((pin&&d.pinned) ? .5 : 0)+.07/(1+Math.max(0,(Number.isFinite(before)?before:N)-d.index)/200)};}).sort((a,b)=>b.score-a.score||a.d.id.localeCompare(b.d.id));const seen=new Set(),seenSig=new Set(),out=[];for(const {d,score} of arr){if(d.nodes?.some(n=>seen.has(n))||d.eventSignature&&seenSig.has(d.eventSignature))continue;out.push({...d,score});for(const n of d.nodes||[])seen.add(n);if(d.eventSignature)seenSig.add(d.eventSignature);if(out.length===limit)break;}return out;}
}
export function documents(actor,state,sources){const valid=new Map(sources.map(s=>[s.id,s])),nodes=new Set(sources.map(s=>s.node)),out=[],seenExpSig=new Set();
 for(const s of sources)out.push({id:s.id,index:s.index,nodes:[s.node],text:s.text,search:[s.speaker,s.at,s.text].filter(Boolean).join(' '),kind:'原文提及',ambiguous:s.hints?.length>0,sourceIds:[s.id]});
 for(const e of state.experiences||[]){if(e.reviewState==='legacy'||e.reviewState==='invalid'||e.actorId!==actor.id||!e.knownTo.includes(actor.id)||e.excludedFrom.includes(actor.id)||!e.sources.length||!e.sources.every(s=>nodes.has(s.node)&&sourcesAtQuote(s,valid,sources)))continue;
 const sigKey=e.occurrenceId||e.eventSignature||e.id;if(seenExpSig.has(sigKey))continue;seenExpSig.add(sigKey);
 out.push({id:e.id,index:e.sources[0].index,nodes:e.sources.map(s=>s.node),text:e.appraisal||e.summary,eventSignature:sigKey,search:[e.summary,e.appraisal,e.themeKey,...(e.participants||[]),...(e.sources.map(s=>s.quote))].join(' '),kind:'已审视角经历',sourceIds:e.sources.map(s=>s.key),salience:e.salience});}
 for(const s of state.summaries||[]){if(s.actorId!==actor.id||s.reviewState!=='approved'||!s.sourceIds.length||!s.sourceIds.every(i=>valid.has(i)))continue;const rr=s.sourceIds.map(k=>valid.get(k));out.push({id:s.id,index:rr[0].index,nodes:rr.map(v=>v.node),text:s.text,search:[s.text,...s.tags,s.place,s.time].filter(Boolean).join(' '),kind:s.level==='chapter'?'篇章导航':'场景导航',sourceIds:s.sourceIds});}
 for(const x of state.influences||[]){if(x.actorId!==actor.id||!['acquired','goal','short'].includes(x.layer)||x.enabled===false||x.reviewState!=='approved'&&x.managedBy!=='user'&&!x.frozen||x.status==='retired')continue;
  if(x.sourceKeys?.length&&!x.sourceKeys.every(k=>valid.has(k)))continue;
  const kindLabel=x.layer==='acquired'?'已批准人格':x.layer==='goal'?'当前自主目标':'近期心理状态';
  out.push({id:x.id,index:-1,nodes:[],text:x.description,layer:x.layer,kindLabel,search:[x.description,x.concept,x.selfView,x.behavior,x.actionDecision,x.currentStep,...(x.scope?.people||[]),...(x.scope?.topics||[]),...(x.scope?.scenes||[])].filter(Boolean).join(' '),kind:'influence',pinned:!!x.pinned,salience:x.intensity,sourceIds:x.sourceKeys||[]});}
 out.push(...segmentsFor(sources,actor.id));
 for(const x of state.notes||[]){if(x.owner!==actor.id||!valid.has(x.sourceId))continue;const s=valid.get(x.sourceId);out.push({id:x.id,index:s.index,nodes:[s.node],sourceIds:[s.id],text:x.text,kind:'玩家钉住的原文',pinned:true});}return out;}
export function sourcesAtQuote(s,valid,all){const exact=(a)=>a&&Number.isInteger(s.rawStart)&&Number.isInteger(s.rawEnd)&&a.rawStart<=s.rawStart&&a.rawEnd>=s.rawEnd&&a.text.slice(s.rawStart-a.rawStart,s.rawEnd-a.rawStart)===s.quote;
 const a=valid.get(s.key);return a?exact(a):all.some(v=>v.node===s.node&&exact(v));}
export async function buildIndex(actor,state,sources,{old=null,cached=new Map(),save=()=>{},alive=()=>true}={}){const index=old||new TextIndex(),next=documents(actor,state,sources),keep=new Set(next.map(x=>x.id)),updates=[];
 const seenOcc=new Set();index.dedupedOccurrences=(state.occurrences||[]).filter(e=>{if(e.mergedInto||e.actorId!==actor.id||e.reviewState==='rejected')return false;const k=e.id;if(seenOcc.has(k))return false;seenOcc.add(k);return true;});
 for(const k of index.docs.keys())if(!keep.has(k))index.remove(k);for(let i=0;i<next.length;i++){if(!alive())return null;const d=next[i],txt=d.search||d.text;if(index.docs.get(d.id)?.search===d.search&&index.docs.get(d.id)?.text===d.text&&JSON.stringify(index.docs.get(d.id).sourceIds)===JSON.stringify(d.sourceIds))continue;
 let tokens=cached.get(d.id);if(tokens?.text!==txt){tokens={id:d.id,text:txt,tokens:terms(txt)};updates.push(tokens);}index.put(d,tokens.tokens);
 if(i&&i%80===0)await new Promise(r=>setTimeout(r,0));}if(alive()&&updates.length)await save(updates);return alive()?index:null;}
// Mechanical directories contain first-hand fragments, never invented scene explanations.
export function segmentsFor(sources,owner){
 const scenes=[],chapters=[];let buf=[],floors=new Set();const flush=()=>{if(!buf.length)return;const first=buf[0],last=buf.at(-1),samples=[...new Set([first,buf[Math.floor(buf.length/2)],last])];scenes.push({id:'nav:'+owner+':'+first.id,index:first.index,nodes:[...new Set(buf.map(x=>x.node))],sourceIds:buf.map(x=>x.id),kind:'场景段原文目录',text:'第'+(first.index+1)+'–'+(last.index+1)+'楼 · '+samples.map(x=>text(x.text,38)).join('／'),search:samples.map(x=>[x.speaker,x.at,x.text].filter(Boolean).join(' ')).join(' ')});buf=[];floors=new Set();};
 for(const s of sources){if(!floors.has(s.index)&&(floors.size>=18||floors.size>=5&&/^(?:【场景|第.{1,6}[章节幕]|第二天[，：])/.test(s.text)))flush();floors.add(s.index);buf.push(s);}flush();
 for(let i=0;i<scenes.length;i+=4){const group=scenes.slice(i,i+4);if(group.length<2)continue;const ids=group.flatMap(x=>x.sourceIds),nodes=group.flatMap(x=>x.nodes);chapters.push({id:'chapter:'+group[0].id,index:group[0].index,nodes,sourceIds:ids,kind:'篇章原文目录',text:group.map(x=>x.text.split(' · ')[0]).join('／'),search:group.map(x=>x.search).join(' ')});}return [...scenes,...chapters];
}
