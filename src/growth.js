import {clone,id,text} from './util.js';
import {decide,reviewEvent,validateLive,occasionIdentity} from './analysis.js';
import {computeStateDiff} from './model.js';
import {detectPromptInjection} from './prompt.js';
const close=x=>String(x||'').normalize('NFKC').replace(/[\s，,。.!！?？“”「」"']/gu,'').toLowerCase();
const date=s=>{const m=String(s||'').match(/^(?:(\d{4})[-./年])?(\d{1,2})[-./月](\d{1,2})[日号]?$/);return m&&+m[2]>0&&+m[2]<13&&+m[3]>0&&+m[3]<32?[m[1]||'?',+m[2],+m[3]].join('-'):null;};
const indepKey=e=>date(e?.time)||date(e?.occasion)||(e?.occasion&&e.occasion!=='同一次'?'occ:'+e.occasion:null)||(e?.place&&e?.quotes?.some(q=>q.quote.includes(e.place))?'place:'+e.place:null);
// Match the form of a self-report, never turn a word into an emotion/fact.
const cue=/^(?:[“「『"]?我(?:现在|当下|今天|此刻|仍然|还是|其实|已经|暂时|不再|为.{1,16})?(?:感到|感觉|觉得|心里|有点|有些|很|挺|既|又|松了|对.{1,16}感到|决定|打算|完成|做完|交接完|放弃)|[“"]?I (?:feel|am feeling|am both|feel both|felt|have finished|have completed)\b)/i;
const contrast=/但|也|却|又|仍|还|不|没|并非|并不|只是|虽|不过|同时|\b(?:not|never|yet|but|although|still|and)\b/i;
const controls=/[<>]|\{\{|\[\/?(?:system|assistant|user)\]|忽略.{0,8}(?:指令|设定)|替(?:玩家|user)(?:决定|发言)|ignore (?:all|previous)/i;
export function selfDelta(src,field){const str=String(src||'').trim();if(!field||str.length>110||/[：:「『“]/u.test(str.slice(1))||controls.test(str)||detectPromptInjection(str)||detectPromptInjection(field)||!cue.test(str)||!str.includes(field))return null;
 const normalized=str.replace(/^[“「『"]?我(?:感到|感觉到|觉得)?|^[“"]?I (?:am feeling|feel) /i,'').replace(/[。.!！？”」』"]+$/u,'').trim();
 // Preserve qualifiers and mixed affect. Never turn “我没有原谅” into “原谅”.
 return normalized&&normalized.length<=105?(contrast.test(str)?normalized:field):null;}
function hasProposalInjection(p){
 const candidates=[p?.description,p?.reason,p?.psyche?.felt_state,p?.psyche?.appraisal,p?.psyche?.coping,p?.psyche?.habit,p?.psyche?.self_view,p?.psyche?.observed_behavior,p?.goal?.purpose,p?.goal?.step,p?.goal?.blockers];
 return candidates.some(v=>v&&detectPromptInjection(v));
}
function synth(p,es){const prior=es.filter(e=>e?.reviewState==='approved'&&e.reviewedBy!=='policy'&&e.modality==='actual'&&occasionIdentity(e));return p.layer==='acquired'&&p.basis==='observed'&&prior.length>=2&&new Set(prior.map(occasionIdentity)).size>=2&&new Set(prior.map(e=>e.quotes?.[0]?.node)).size>=2&&es.filter(e=>!prior.includes(e)).every(e=>e?.agent===p.owner&&e.quotes.every(q=>q.speakerId===p.owner)&&!e.hints?.length)&&!controls.test(p.description)&&!hasProposalInjection(p)&&p.description.length<=120;}
function pickGroundedField(p,excerpt){
 if(p.layer==='goal')return [p.goal?.step,p.goal?.purpose,p.description].find(f=>f&&excerpt.includes(f))||(p.goal?.purpose||p.goal?.step);
 if(p.layer==='acquired')return [p.psyche?.habit,p.psyche?.coping,p.description].find(f=>f&&excerpt.includes(f))||(p.psyche?.habit||p.psyche?.coping);
 return [p.psyche?.felt_state,p.psyche?.coping,p.description].find(f=>f&&excerpt.includes(f))||p.psyche?.felt_state;
}
function decidePolicy(p,es,counterEs,s,live,mode){
 if(hasProposalInjection(p))return '含疑似越权指令或控制边界，已隔离转人工审核';
 if(!['conservative','auto'].includes(mode))return '手动审核';if(!p.psyche||!p.basis||(!p.basisQuote&&!synth(p,es)))return p.basis==='observed'||p.basis==='inference'?'行为观察推断作为心理假设留待玩家审阅':'没有可核实的本人表述';
 if(['unknown','conflict'].includes(p.baselineFit)||p.major||p.alternative||(p.counter.length&&p.action!=='weaken')||p.basis==='unknown'||p.basis==='inference'||(p.basis==='observed'&&!synth(p,es)))return '行为观察、重大变化、替代解释或反例需要复核';
 const allEs=[...es,...counterEs];
 const corroborated=mode==='auto'&&synth(p,es);if(!es.length||allEs.some(e=>!e||e.actorId!==live.actorId||e.mergedInto||e.reviewState==='rejected'||e.agent!==live.actorId||
 e.hints?.length||!['actual','claim','unknown'].includes(e.modality)||!corroborated&&e.quotes.some(q=>q.speakerId!==live.actorId)))return '本人、知情或现实模态不足';
 const over=p.person&&p.person!==live.actorId&&!allEs.every(e=>e.recipient===p.person||e.agent===p.person);if(over)return '影响对象不一致';
 const old=p.targetRecord?s.influences.find(x=>x.id===p.targetRecord&&x.actorId===live.actorId&&x.enabled&&x.status==='active'&&!x.frozen&&x.managedBy!=='user'):null;
 if(p.goal&&!['active','paused'].includes(p.goal.status)){
  const verifiedOutcome=es.some(e=>e.reviewState==='approved'&&e.reviewedBy!=='policy'&&e.modality==='actual')||(mode==='auto'&&p.basis==='explicit_outcome'&&!!p.basisQuote&&es.every(e=>e.agent===live.actorId&&!e.hints?.length&&e.quotes.every(q=>q.speakerId===live.actorId)));
  if(mode!=='auto'||p.basis!=='explicit_outcome'||!old||!verifiedOutcome)return '目标结果须有现行目标及经核实的本人完成表述或行动';}
 if(p.layer==='goal'&&!['explicit_plan','explicit_outcome'].includes(p.basis))return '没有明确本人计划';
 if(p.layer==='acquired'&&mode!=='auto')return '长期人格由玩家审核';
 if(!['create','revise','reinforce','weaken','keep'].includes(p.action)&&!(p.action==='retire'&&(corroborated||p.layer==='goal'&&mode==='auto'&&p.basis==='explicit_outcome'&&old)))return '退役或重大改写需要玩家处理';
 const keys=Object.keys(p.psyche);if(!keys.length)return '无心理材料';
 if(corroborated)return null;const excerpt=p.basisQuote.trim();if(excerpt.length<2||excerpt.length>125||!allEs.some(e=>e.quotes.some(q=>q.quote.includes(excerpt))))return '心理依据必须逐字对应本人原文';
 const field=pickGroundedField(p,excerpt);
 const source=allEs.flatMap(e=>e.quotes).map(q=>live.byId.get(q.key)?.text).find(t=>t?.includes(excerpt));if(['short','immediate'].includes(p.layer)&&p.action!=='weaken'&&!selfDelta(source,field))return '没有边界清楚的本人感受自述，留待人工审核';if(!field||!excerpt.includes(field)||String(field).length>110)return '缺少逐字可核实的感受、习惯或计划；解释留待审核';
 if(p.layer==='acquired'){
  if(old&&(p.action==='revise'||p.action==='weaken')){
   if(!allEs.some(e=>e.sourceKeys.some(k=>!(old.sourceKeys||[]).includes(k))))return '修订或削弱长期倾向须有异于原记录的新证据';
   return null;
  }
  const d=es.map(indepKey);if(es.length<2||d.some(v=>!v)||new Set(d).size!==es.length||new Set(es.map(e=>e.quotes[0].node)).size!==es.length)return '没有两个可区分日期或独立场次的经历';
  if(new Set(es.map(e=>close(e.action))).size===1&&es.some(e=>!e.quotes.some(q=>q.quote.includes(e.time||e.place||e.occasion||''))))return '可能复述了同一事件';}
 return null;
}
export function applyPolicy(base,staged,live,options={}){
 const mode=options.mode||'manual',prior=new Set(base.proposals.map(p=>p.id));let state=staged;const opportunities=staged.proposals.filter(p=>p.reviewState==='pending'&&!prior.has(p.id));let adopted=0;
 for(const p of opportunities){const es=p.support.map(k=>state.occurrences.find(e=>e.id===k)),counterEs=p.counter.map(k=>state.occurrences.find(e=>e.id===k));let why=decidePolicy(p,es,counterEs,state,live,mode);
 if(!why&&p.layer==='acquired'&&!options.baselineChecked)why='长期自动采用须授权本次分析核对基线';if(!why&&p.action==='keep'){const q=state.proposals.find(x=>x.id===p.id);q.reviewState='approved';q.committedBy=mode;continue;}if(!why)try{let draft=clone(state);for(const e of [...es,...counterEs]){validateLive(e,live);if(e.reviewState==='approved')continue;
 // A direct statement is only a statement. Do not label model-read text an objective fact.
 draft=reviewEvent(draft,live.actorId,e.id,{modality:'claim',occasion:p.layer==='acquired'?indepKey(e):null},live);
 const e2=draft.occurrences.find(a=>a.id===e.id);e2.reviewedBy='policy';const x=draft.experiences.find(a=>a.occurrenceId===e.id);if(x)x.userCorrected=false;}
 const allEs=[...es,...counterEs],excerpt=(p.basisQuote||'').trim();
 const source=allEs.flatMap(e=>e.quotes).map(q=>live.byId.get(q.key)?.text).find(t=>t?.includes(excerpt));
 const field=pickGroundedField(p,excerpt);
 const grounded=synth(p,es)?p.description:p.layer==='goal'||p.layer==='acquired'||p.action==='weaken'?field:selfDelta(source,field);
 // Only the literal, bounded self-described delta can be auto-projected. Other fields stay proposals.
 const target=draft.proposals.find(z=>z.id===p.id),reviewCopy=clone(target);target.psyche={...target.psyche,self_view:null,observed_behavior:null};if(target.goal)target.goal={...target.goal,step:target.goal.step&&p.basisQuote?.includes(target.goal.step)?target.goal.step:null,blockers:null,nextReview:null};
 draft=decide(draft,live.actorId,p.id,'approve',{description:grounded,remaining:Math.max(1,Math.min(p.layer==='short'?15:3,Number(p.remaining)||(p.layer==='short'?8:2))),verifiedIndependent:p.layer==='acquired'},live);
 const pp=draft.proposals.find(q=>q.id===p.id);pp.psyche=reviewCopy.psyche;pp.goal=reviewCopy.goal;pp.committedBy=mode;pp.originalProposal=reviewCopy.description;
 draft.adoptions||=[];draft.adoptions.push({id:id(),actor:live.actorId,room:options.room,branch:live.path.at(-1).hash,at:Date.now(),mode,profile:options.profile,model:options.model,revision:options.revision,proposal:p.id,record:pp.recordId,before:clone(state.influences.find(x=>x.id===pp.recordId)||null),after:clone(draft.influences.find(x=>x.id===pp.recordId)||null),born:draft.turns[live.actorId]||0,support:p.support,counter:p.counter,sources:p.sourceKeys,description:text(grounded,140)});state=draft;adopted++;
 }catch(e){why=e.message;}if(why){const q=state.proposals.find(z=>z.id===p.id);q.reviewReason=text(why,160);q.pendingReason=q.reviewReason;}}
 return {state,adopted,pending:opportunities.length-adopted};}
export function previewProposalDiff(state,owner,pid,optsOrLive={},maybeLive=null){
 const isLiveFourth=optsOrLive&&typeof optsOrLive==='object'&&Array.isArray(optsOrLive.chat)&&Array.isArray(optsOrLive.path);
 const opts=isLiveFourth?{}:(optsOrLive||{});
 const live=isLiveFourth?optsOrLive:maybeLive;
 let draft=clone(state);const p=draft.proposals.find(x=>x.id===pid&&x.owner===owner);if(!p)throw Error('未找到该提案。');
 const beforeRec=p.targetRecord?state.influences.find(x=>x.id===p.targetRecord&&x.actorId===owner)||null:null;
 for(const eid of [...p.support,...p.counter]){const e=draft.occurrences.find(x=>x.id===eid);if(e&&e.reviewState!=='approved')draft=reviewEvent(draft,owner,e.id,{modality:e.modality==='actual'?'actual':'claim',occasion:e.occasion||e.time||e.place||'预览场次',overrideMode:true},live);}
 const next=decide(draft,owner,pid,'approve',{...opts,verifiedIndependent:opts.exception||p.layer==='acquired'},live);
 const recId=next.proposals.find(x=>x.id===pid)?.recordId;
 const afterRec=next.influences.find(x=>x.id===recId)||null;
 const summarize=r=>r?{id:r.id,layer:r.layer,description:r.description,intensity:r.intensity,status:r.status,selfView:r.selfView||p.psyche?.self_view||null,observedBehavior:r.behavior||p.psyche?.observed_behavior||null,actionDecision:r.actionDecision||p.psyche?.coping||null}:null;
 const baseDiff=computeStateDiff(state,next);
 return {canApprove:true,diff:{...baseDiff,before:summarize(beforeRec),after:summarize(afterRec)},record:afterRec};
}
export function undoAdoption(raw,owner,entry,block=true){const s=clone(raw),a=s.adoptions.find(v=>v.id===entry&&v.actor===owner);if(!a||a.undone||!a.record||!a.after)throw Error('这条采用没有可撤销的记录。');
 const i=s.influences.findIndex(x=>x.id===a.record&&x.actorId===owner),cur=s.influences[i];if(!cur||cur.frozen||cur.managedBy==='user'||cur.description!==a.after.description||cur.enabled!==a.after.enabled||cur.reviewState!==a.after.reviewState||cur.evolutionLog?.at(-1)?.id!==a.after.evolutionLog?.at(-1)?.id)throw Error('之后已有人工编辑或新演化，请先核对修订。');
 if(a.before){const v=clone(a.before);if(v.duration?.mode==='turns')v.duration.remaining=Math.max(0,v.duration.remaining-((s.turns[owner]||0)-a.born));s.influences[i]=v;}else s.influences.splice(i,1);
 const p=s.proposals.find(x=>x.id===a.proposal);if(p)p.reviewState='rejected';if(block)s.blocks.push({id:id(),actorId:owner,concept:'',evidence:[...a.sources],reason:'玩家撤销自动采用'});a.undone=Date.now();return s;}
