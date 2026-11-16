import {active,inScope,detectWorldContext} from './model.js';
import {legacyEnabled,arbitrateLegacyPlugin,sampleEmotionDirective} from './emotion-engine.js';
import { lexical } from './retrieval.js';
import {deadline,text} from './util.js';
export {legacyEnabled,arbitrateLegacyPlugin,sampleEmotionDirective};
const bytes=s=>new TextEncoder().encode(s).length;
export const CONTRACT='projection/5.0';

// P0-01: Separate untrusted command-boundary injection detection from natural-language text sanitization.
// NEVER delete natural-language negations, conditions, modals, or boundaries (e.g. "绝对不能", "不愿", "只有...才", "不再", "自认为").
const INJECTION_PATTERNS=[
 [/(?:^|[\s；;，,。])###\s*(?:system|assistant|user|instruction|prompt)\b/i,'包含伪造 Markdown 角色指令头（### System/Assistant）'],
 [/\[\/?(?:system|inst|assistant|user|prompt)\]/i,'包含伪造方括号指令边界标签'],
 [/<\/?(?:system|assistant|user|prompt|instruction|tool_call)\b[^>]*>/i,'包含伪造 XML/HTML 模型控制标签'],
 [/\b(?:ignore|disregard|forget|override)\s+(?:all\s+|previous\s+|above\s+|prior\s+)?(?:instructions|rules|prompts|constraints|boundaries)\b/i,'包含英文越权忽略指令（ignore previous instructions）'],
 [/(?:忽略|无视|跳过|作废|取消|覆盖)(?:以上|上述|之前|前面|所有|全部|系统|原有).{0,8}(?:规则|指令|设定|限制|提示|约束)/u,'包含中文越权忽略指令'],
 [/(?:现在起|从现在开始|立即切换为)你(?:是|扮演|必须服从|不再是)/u,'包含越权身份重置指令'],
 [/替(?:玩家|user)(?:发言|做决定|回复|输入)|代写(?:玩家|user)/i,'包含越权代写玩家指令']
];

export function detectPromptInjection(value){
 const s=String(value??'');
 if(!s)return null;
 for(const [rx,reason] of INJECTION_PATTERNS){
  if(rx.test(s))return reason;
 }
 return null;
}

// Pure, non-destructive field formatter: preserves all negations, conditions, quantifiers, and objects.
// Only strips control characters, normalizes whitespace, escapes ST macros/angle brackets, and strips standalone debug tokens.
export const clean=(v,n=150)=>text(v||'',n)
 .replace(/\bL[0-4](?:层|级)?\b\s*[:：]?/g,'')
 .replace(/[\r\n\t\u0000-\u001f]+/g,' ')
 .replace(/\{\{/g,'｛｛').replace(/\}\}/g,'｝｝')
 .replace(/</g,'＜').replace(/>/g,'＞')
 .replace(/\s{2,}/g,' ')
 .trim();

export function inspectRecordSafety(x){
 const fields={
  description:x?.description||'',
  concept:x?.concept||'',
  selfView:x?.selfView||x?.psyche?.self_view||'',
  observedBehavior:x?.observedBehavior||x?.psyche?.observed_behavior||x?.behavior||'',
  actionDecision:x?.actionDecision||x?.psyche?.coping||'',
  blockers:x?.blockers||'',
  currentStep:x?.currentStep||'',
  triggerCondition:x?.triggerCondition||'',
  people:(x?.scope?.people||[]).join('、'),
  topics:(x?.scope?.topics||[]).join('、'),
  scenes:(x?.scope?.scenes||[]).join('、')
 };
 for(const [fieldName,val] of Object.entries(fields)){
  const hit=detectPromptInjection(val);
  if(hit)return {safe:false,field:fieldName,blocked_reason:`字段「${fieldName}」${hit}`,rawFields:fields};
 }
 return {safe:true,field:null,blocked_reason:null,rawFields:fields};
}

const NEGATION_TOKENS=['绝对不能','绝不能','绝不','不能','不可','切勿','禁止','不愿','不愿意','不想','不会','不再','不曾','从未','并未','并非','没有','没法','尚未','还没','未','不','没','无','别','莫','never','not','cannot'];
const CONDITION_TOKENS=['只有','除非','仅当','一旦','在确认','确认','之后才','后才','之前先','前先','否则','如果','假如','若是','当且仅当'];

export function verifySemanticPreservation(rawText,projectedText){
 const src=String(rawText||''),out=String(projectedText||'');
 const missingNegations=[];
 for(const tok of NEGATION_TOKENS){
  if(src.includes(tok)){
   const core=tok==='绝对不能'?['绝对不能','不能']:tok==='不愿意'?['不愿意','不愿']:[tok];
   if(!core.some(c=>out.includes(c)))missingNegations.push(tok);
  }
 }
 const missingConditions=[];
 for(const tok of CONDITION_TOKENS){
  if(src.includes(tok)&&!out.includes(tok))missingConditions.push(tok);
 }
 const subjectivePreserved=!src.includes('自认为')||out.includes('自认为');
 return {
  ok:missingNegations.length===0&&missingConditions.length===0&&subjectivePreserved,
  missingNegations,
  missingConditions,
  subjectivePreserved
 };
}

const tag={acquired:'处理倾向',short:'近期心理',immediate:'当下感受',goal:'个人打算'};
const baseWeight=x=>Number(!!x.pinned)*45+Number(!!x.frozen||x.managedBy==='user')*60+({high:9,medium:5,low:1}[x.priority]||0);
export async function compose({actor,state,settings,legacy=false,chat=[],cast=[],seed='',swipeOffset=0,countTokens,report={},diagnostics=null,world=null,sample=null,memories=[],persons={}}){
 const rep=diagnostics||report;
 Object.assign(rep,{contract:CONTRACT,actor:actor?.id,slot:'IN_PROMPT/SYSTEM',included:[],candidates:[],skipped:[],fieldAudit:[],tokens:0,method:'无注入',budget:Math.min(4000,Math.max(0,Number(settings?.promptBudget??700)))});
 if(!actor||state?.disabled||!settings?.enabled||settings.inject===false||legacy&&['pause','takeover'].includes(settings.conflictMode))return '';
 const scene=world||detectWorldContext({chat,cast,state}),rank=new Set(memories.map(m=>m.id)),by={acquired:[],short:[],immediate:[],goal:[]};
 const queryText=String(scene?.query||scene?.recentText||chat.slice(-4).map(m=>m?.mes||'').join(' ')||'');
 const rel=x=>queryText?lexical(queryText,[x.description,x.concept,x.currentStep,x.actionDecision,x.triggerCondition,x.psyche?.coping,...(x.scope?.topics||[])].filter(Boolean).join(' ')):0;
 const score=x=>{const r=rel(x),rBonus=r>=0.08?Math.round(r*260)+(rank.has(x.id)?35:0):0;return baseWeight(x)+rBonus;};
 for(const x of state.influences){if(x.actorId!==actor.id)continue;
 const safety=inspectRecordSafety(x);
 if(!safety.safe){
  rep.skipped.push({key:x.id,why:'含越权指令或控制边界，已隔离待审',blocked_reason:safety.blocked_reason});
  rep.fieldAudit.push({id:x.id,layer:x.layer,status:'blocked',blocked_reason:safety.blocked_reason,raw:{description:text(x.description,120),actionDecision:text(x.actionDecision||'',80),selfView:text(x.selfView||'',80)},projected:null});
  continue;
 }
 const why=!active(x,scene)?'未生效、过期或待复核':!inScope(x,scene)?'当前人物／情境不适用':(x.layer==='immediate'&&settings.immediate===false)?'已关闭即时层':(x.reviewState!=='approved'&&x.managedBy!=='user'&&!x.frozen)?'未采用':!by[x.layer]?'不支持的层级':null;
 if(why){rep.skipped.push({key:x.id,why});continue;}
 const rVal=+rel(x).toFixed(3);
 rep.candidates.push({key:x.id,kind:x.layer,sources:x.sourceKeys||[],relevance:rVal,pinned:!!x.pinned,sourceKind:x.sourceKind||(x.managedBy==='user'?'user':'reviewed')});
 by[x.layer].push(x);}
 for(const a of Object.values(by))a.sort((x,y)=>score(y)-score(x)||Number(rank.has(y.id))-Number(rank.has(x.id))||(rel(y)-rel(x))||String(x.id).localeCompare(y.id));
 const chosen=[],put=x=>{if(x&&!chosen.includes(x))chosen.push(x);};
 put(by.immediate[0]||by.short[0]);put(by.goal[0]);put(by.acquired[0]);put(by.immediate[0]?by.short[0]||by.immediate[1]:by.short[1]);put(by.acquired[1]);
 const proposal=x=>{const scope=(x.scope.people||[]).map(k=>persons[k]||cast.find(a=>a.id===k)?.name||(k==='@user'?'玩家':(!/\.(png|webp|jpe?g)$/i.test(k)?k:null)));if(scope.some(n=>!n))return '';
 const people=scene.people||[];const rule=Object.entries(x.personRules||{}).find(([k])=>people.includes(k)||(persons[k]&&people.includes(persons[k])))?.[1];
 const custom=rule||x.actionDecision||x.psyche?.coping||(x.managedBy==='user'?x.behavior:'');const option=custom&&custom!==x.description&&!x.description.includes(custom)?'；可考虑：'+clean(custom,70):'';const targets=scope.length?'（仅对'+scope.map(v=>clean(v,24)).join('、')+'）':'';
 const trigger=x.triggerCondition&&!x.description.includes(x.triggerCondition)?'（当'+clean(x.triggerCondition,44)+'时）':'';
 const hint=x.layer==='goal'&&x.currentStep&&x.currentStep!==x.description?'；下一步：'+clean(x.currentStep,60):'';
 const blocker=x.blockers&&x.blockers!==x.description?'；受限于：'+clean(x.blockers,50):'';
 const selfRaw=x.selfView||x.psyche?.self_view||'';
 const cleanSelf=selfRaw&&selfRaw!==x.description?clean(selfRaw,60):'';
 const selfPrefix=cleanSelf?'；自认为：'+cleanSelf:'';
 const obsRaw=x.observedBehavior||x.psyche?.observed_behavior||(x.behavior&&x.behavior!==custom?x.behavior:'');
 const obsText=obsRaw&&obsRaw!==x.description&&obsRaw!==custom?'；外在常表现为：'+clean(obsRaw,60):'';
 return tag[x.layer]+targets+trigger+'：'+clean(x.description,160)+hint+blocker+option+selfPrefix+obsText;};
 const rows=[];
 for(const x of chosen){
  const line=proposal(x);
  const sem=verifySemanticPreservation([x.description,x.actionDecision,x.selfView,x.observedBehavior,x.blockers,x.currentStep].filter(Boolean).join(' '),line);
  if(!sem.ok){
   const bReason=`语义保真校验未通过（缺失否定/条件：${[...sem.missingNegations,...sem.missingConditions].join('、')}）`;
   rep.skipped.push({key:x.id,why:bReason,blocked_reason:bReason});
   rep.fieldAudit.push({id:x.id,layer:x.layer,status:'blocked_semantic',blocked_reason:bReason,raw:{description:x.description,actionDecision:x.actionDecision||'',selfView:x.selfView||''},projected:line});
   continue;
  }
  rows.push({id:x.id,layer:x.layer,line,rawRecord:x,reason:'已采用、在当前范围；'+tag[x.layer]+(rel(x)>=0.08?'（与本轮议题直接相关）':'')});
 }
 // Old histories and raw model output never cross this projection boundary.
 if(settings.expressive&&!legacy&&settings.conflictMode!=='growth'){const draw=sample||sampleEmotionDirective({actor,state,settings,seed,swipeOffset});const extra=[draw?.darkMotive?.desc,draw?.unpredictAction?.desc,draw?.lifeEpisode?.desc].filter(Boolean);
 const i=[...(draw?.seed||'')].reduce((h,c)=>(h*31+c.charCodeAt(0))>>>0,0),cue=[draw?.emotionCard?.direction,extra.length?extra[i%extra.length]:null,draw?.userAccess?.label?.split('（')[0]].filter(Boolean).map(v=>clean(v,70)).join('；');if(cue)rows.push({id:'draw',layer:'draw',line:'可略过的一时念头：'+cue,reason:'玩家开启的独立演出备选'});}
 if(settings.shareVariables)for(const v of state.variables?.[actor.id]||[])if(v.share&&v.source==='user'&&!detectPromptInjection(v.key)&&!detectPromptInjection(v.value))rows.push({id:v.id,layer:'var',line:'玩家指定的参考：'+clean(v.key,25)+'：'+clean(v.value,80),reason:'逐项授权的备注'});
 const name=clean(actor.name,32),head='【'+name+'的本轮权衡】';
 const hasActionLayer=rows.some(r=>r.line&&['acquired','goal'].includes(r.layer));
 const foot=hasActionLayer?'仅在当前情境涉及相关事务或对象时自然体现上述倾向与打算（若当前对话仅为日常寒暄、饮食、路况等无关话题，自然回应即可，不必刻意提及上述倾向或复述提示字面）；感受可以不外显，不替玩家作决定。':'可自行取舍，感受可以不外显；不替玩家作决定。';
 let tok=countTokens;const measure=async value=>{if(tok){const v=await deadline(Promise.resolve().then(()=>tok(value)).catch(()=>null),65,null);if(Number.isFinite(v)&&v>0){rep.method='酒馆分词器';return v;}tok=null;}rep.method='UTF-8 字节保守上界';return bytes(value);};
 const lines=[];let result='';for(const row of rows){if(!row.line||lines.length>=4){rep.skipped.push({key:row.id,why:!row.line?'人物身份未解析':'每轮最多四项'});continue;}
 const next=[head,...lines,row.line,foot].join('\n');const n=await measure(next);if(n>rep.budget){rep.skipped.push({key:row.id,why:'超出预算'});continue;}result=next;lines.push(row.line);rep.tokens=n;rep.included.push(row.id);const candidate=rep.candidates.find(c=>c.key===row.id);if(candidate)candidate.reason=row.reason;
 if(row.rawRecord){rep.fieldAudit.push({id:row.id,layer:row.layer,status:'projected',blocked_reason:null,raw:{description:text(row.rawRecord.description,160),actionDecision:text(row.rawRecord.actionDecision||row.rawRecord.psyche?.coping||'',80),selfView:text(row.rawRecord.selfView||row.rawRecord.psyche?.self_view||'',80),observedBehavior:text(row.rawRecord.observedBehavior||row.rawRecord.behavior||'',80),blockers:text(row.rawRecord.blockers||'',80)},projected:row.line});}}
 for(const x of rep.candidates)if(!rep.included.includes(x.key)&&!rep.skipped.some(v=>v.key===x.key))rep.skipped.push({key:x.key,why:'同层已有更优先或更相关记录'});
 rep.promptPreview=result;
 return result;
}
export function scoreBehavioralContrast(paired=[],{actorName='',userName='',irrelevantScene=false,forbidden=['L1','L2','L3','L4','confidence','score','ignore previous instructions','### System','### Assistant','替玩家决定'],branchBKeywords=['核对','清单','确认','检查','暂缓','排期','周期','抱歉'],irrelevantKeywords=['清单','母带','排期表','古籍修复']}={}){
 const by=Object.fromEntries((paired||[]).map(x=>[x.branch,x])),off=by['关']||by.off,a=by.A,b=by.B,irr=by.irrelevant||by['无关'];
 const prompts=[off?.prompt||'',a?.prompt||'',b?.prompt||'',irr?.prompt||''].filter(Boolean);
 const responses=[off?.response||'',a?.response||'',b?.response||'',irr?.response||''].filter(Boolean);
 const noCoercion=prompts.every(p=>forbidden.every(w=>!p.includes(w))&&!detectPromptInjection(p));
 const noPlayerTakeover=responses.every(r=>!/^(?:玩家|你)[：:]|替玩家/.test(r)&&(!userName||!new RegExp(`^${userName}[：:]`).test(r)));
 const noPromptEcho=responses.every(r=>!/的本轮权衡】|处理倾向：|近期心理：|当下感受：|个人打算：/.test(r));
 const distinctAB=Boolean(a?.response&&b?.response&&a.response.trim()!==b.response.trim());
 const bReflectsCue=irrelevantScene?Boolean(b?.response&&irrelevantKeywords.every(k=>!b.response.includes(k))):Boolean(b?.response&&branchBKeywords.some(k=>b.response.includes(k)));
 const irrelevantClean=irrelevantScene?bReflectsCue:(!irr?.response||!irrelevantKeywords.length||irrelevantKeywords.every(k=>!irr.response.includes(k)));
 return {noCoercion,noPlayerTakeover,noPromptEcho,distinctAB,bReflectsCue,irrelevantClean,passed:noCoercion&&noPlayerTakeover&&noPromptEcho&&distinctAB&&bReflectsCue&&irrelevantClean};
}
export function exportInspectorSample(diag={},promptOrActor='',{redact=true}={}){
 const isActorObj=promptOrActor&&typeof promptOrActor==='object';
 const promptText=isActorObj?(diag.promptPreview||''):String(promptOrActor||'');
 const actorObj=isActorObj?{id:promptOrActor.id,name:promptOrActor.name}:{id:diag.actor||'',name:''};
 const scrub=s=>redact?String(s||'').replace(/([【\[])([^\]】]{1,24})(的本轮权衡[】\]])/g,'$1角色$3'):String(s||'');
 const chosen=(diag.candidates||[]).filter(c=>(diag.included||[]).includes(c.key)).map(c=>({...c,id:c.key}));
 return {
  contract:diag.contract||CONTRACT,
  actor:actorObj,
  slot:diag.slot||'IN_PROMPT/SYSTEM',
  turn:diag.turn||'normal',
  coop:diag.coop||'coexist',
  budget:diag.budget??700,
  tokens:diag.tokens??0,
  method:diag.method||'无注入',
  included:diag.included||[],
  chosen,
  candidates:(diag.candidates||[]).map(c=>({id:c.key,key:c.key,kind:c.kind,relevance:c.relevance,pinned:c.pinned,sourceKind:c.sourceKind,reason:c.reason})),
  skipped:(diag.skipped||[]).map(s=>({key:s.key,why:s.why,blocked_reason:s.blocked_reason||null})),
  fieldAudit:(diag.fieldAudit||[]).map(a=>({...a,projected:a.projected?scrub(a.projected):null})),
  promptPreview:scrub(promptText)
 };
}
