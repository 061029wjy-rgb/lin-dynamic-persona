import {VERSION,id,clone,Fingerprints,effective,hash,legacySignature,visible} from './util.js';
import {emptyState,migrateState,tick} from './model.js';
export function chatOwner(c){const group=c?.groupId!=null&&c.groupId!=='',name=c?.chatId||c?.getCurrentChatId?.(),card=c?.characters?.[c?.characterId];return name&&(group||card?.avatar)?JSON.stringify([group?'group:'+c.groupId:'character:'+card.avatar,String(name)]):null;}
export function actors(c){const g=c.groupId!=null&&c.groupId!=='',group=c.groups?.find(k=>String(k.id)===String(c.groupId));return (c.characters||[]).filter((x,i)=>x?.avatar&&(g?group?.members?.includes(x.avatar):i===Number(c.characterId))).map(x=>({id:x.avatar,name:x.name,baseline:[x.description||x.data?.description,x.personality||x.data?.personality,x.scenario||x.data?.scenario].filter(Boolean).join('\n')}));}
export function messageActor(m,cast){if(!m||m.is_user||m.is_system)return null;if(m.original_avatar)return cast.find(a=>a.id===m.original_avatar)?.id||null;const same=cast.filter(x=>x.name===m.name);return same.length===1?same[0].id:null;}
export function remapTree(x,map){if(typeof x==='string'){if(map.has(x))return map.get(x);const i=x.indexOf('@');return i>0&&map.has(x.slice(0,i))?map.get(x.slice(0,i))+x.slice(i):x;}if(Array.isArray(x))return x.map(v=>remapTree(v,map));if(!x||typeof x!=='object')return x;return Object.fromEntries(Object.entries(x).map(([k,v])=>[map.get(k)||k,remapTree(v,map)]));}
export function quarantine(st){const s=migrateState(st);for(const x of s.influences){if(x.managedBy!=='user'&&!x.frozen){x.reviewState='legacy';x.legacyEnabled=x.enabled;x.enabled=false;}}for(const e of s.experiences){if(!e.userCorrected)e.reviewState='legacy';}s.processed={};return s;}
const emptyNode=(stream,r)=>({stream:stream.id,key:stream.id+':'+r.hash,hash:r.hash,parent:r.parent,length:r.index+1,revision:0,history:[]});
// Store an actor receipt per saved response. Full snapshots are written for user decisions;
// a receipt without edits never duplicates the growing evidence/persona tables.
function fold(stream,path,map){let state=emptyState(),stamp='root',base='root',node,prior;for(let i=0;i<path.length;i++){
 const row=path[i],rec=map.get(row.hash);base=stamp;
 if(i===path.length-1&&i>0)prior={state:clone(state),row:path[i-1],stamp};
 if(rec?.receipt?.ok){state=tick(state,rec.receipt.actor,true);if(rec.receipt.carry){const a=rec.receipt.actor;state.emotionState[a]=clone(rec.receipt.carry);}}
 if(rec?.state&&rec.base===base){state=migrateState(rec.state);stamp=rec.hash+':'+rec.revision;}
 if(i===path.length-1)node={...emptyNode(stream,row),...rec,state};}
 return {node,prior,base,stamp};}
export class Timeline{
 constructor(db){this.db=db;this.fingerprints=new Fingerprints();this.path=[];this.map=new Map();this.stream=null;this.node=null;}
 async sync({owner,metadata,chat,cast,integrity='',parentName='',force=false}){
 const streams=await this.db.all('streams');const matches=s=>s.owner===owner&&!s.imported&&String(s.integrity||'')===String(integrity||'');
 const bound=streams.find(s=>s.id===metadata?.stream&&matches(s)),own=bound||streams.find(matches);
 const same=this.stream&&matches(this.stream)&&(!own||this.stream.id===own.id);const sid=id();
 const stream=own||(same?this.stream:{key:sid,id:sid,owner,integrity,head:'root',seq:0,createdAt:Date.now()});
 const path=await this.fingerprints.of(chat);const head=path.at(-1).hash;
 const map=same&&!force&&this.stream.seq===stream.seq?this.map:new Map((await this.db.all('nodes',stream.id)).map(n=>[n.hash,n]));
 const unchanged=same&&this.stream.seq===stream.seq&&this.path.at(-1)?.hash===head&&!force;
 if(!unchanged){Object.assign(this,fold(stream,path,map));}this.stream=stream;this.map=map;this.path=path;this.chat=chat;this.cast=cast;this.parentName=parentName;this.streams=streams;
 const hashes=new Set(path.map(r=>r.hash)),match=map.get(head),missing=!!metadata?.stream&&!bound;
 const revisionMismatch=!!(bound&&metadata.head===head&&metadata.revision!=null&&metadata.revision!==(match?.revision??0));const mismatch=missing||revisionMismatch||
 (!!metadata?.head&&!hashes.has(metadata.head))||(!metadata&&!!own?.head&&!hashes.has(own.head))||(!own&&(!!parentName||streams.some(s=>s.owner===owner)));
 return {missing,mismatch,revisionMismatch,exact:!!match,metadata:this.pointer(),priorStream:metadata?.stream,priorHead:metadata?.head,priorRevision:metadata?.revision};}
 pointer(){return this.stream&&this.node?{version:VERSION,owner:this.stream.owner,stream:this.stream.id,head:this.node.hash,revision:this.node.revision}:null;}
 token(){return this.node?{key:this.node.key,revision:this.node.revision,seq:this.stream.seq}:null;}
 matching(token){return !!token&&token.key===this.node?.key&&token.revision===this.node.revision&&token.seq===this.stream.seq;}
 async save(rec,label,guard){const result=await this.db.commit(this.stream,rec,this.map.get(rec.hash)?.revision??-1,label,guard);this.stream=result.stream;this.map.set(rec.hash,result.node);Object.assign(this,fold(this.stream,this.path,this.map));return true;}
 async confirm(index,actor,ok,{carry=null,from=null}={}){
 const row=this.path[index+1];if(!row||row.hash!==this.path.at(-1).hash||!actor)return false;const prev=this.map.get(row.hash);
 if(prev?.receipt)return false;const n={...(prev||emptyNode(this.stream,row)),revision:(prev?.revision??-1)+1,receipt:{ok:!!ok,actor,carry:ok?carry:null}};
 if(from&&ok&&from.parent===row.parent&&from.length===index+1&&from.hash!==row.hash){
  n.receipt.carry=null;n.base=this.base;n.state=remapTree(from.state,new Map([[from.hash,row.hash]]));if(!from.receipt?.ok)n.state=tick(n.state,actor);
  n.history=(from.history||[]).map(h=>({...h,state:remapTree(h.state,new Map([[from.hash,row.hash]]))}));n.continuedFrom=from.hash;
 }return this.save(n,ok?'有效发言':'不计入的输出');}
 async update(fn,label='编辑',expected,guard){if(!this.node)throw Error('请先打开聊天。');if(expected&&!this.matching(expected))return false;const old=this.node,n={...old,base:this.base,state:fn(clone(old.state)),revision:old.revision+1,history:[...old.history,{at:Date.now(),label,revision:old.revision,state:clone(old.state)}].slice(-40)};return this.save(n,label,guard);}
 async commitAnalysis(fn,label='剧情心理分析',expected,guard,opts={}){if(!this.node)throw Error('请先打开聊天。');if(expected&&!this.matching(expected))return false;const old=this.node,n={...old,base:this.base,state:fn(clone(old.state)),revision:old.revision+1,history:[...old.history,{at:Date.now(),label,revision:old.revision,state:clone(old.state)}].slice(-40)};
  const result=typeof this.db.commitAnalysis==='function'?await this.db.commitAnalysis(this.stream,n,this.map.get(n.hash)?.revision??-1,label,guard,opts):await this.db.commit(this.stream,n,this.map.get(n.hash)?.revision??-1,label,guard);
  this.stream=result.stream;this.map.set(n.hash,result.node);Object.assign(this,fold(this.stream,this.path,this.map));return true;}
 async undo(i=this.node.history.length-1){const h=this.node?.history[i];return h?this.update(()=>clone(h.state),'回退：'+h.label):false;}
 async rebuild(){return this.update(s=>{s.processed={};s.summaries=(s.summaries||[]).filter(x=>x.origin==='player');return s;},'重建导航；保留人工决定和屏蔽');}
 async legacyPath(){let prev='root';const refs=new Map([['root','root']]);for(const [i,m] of this.chat.entries()){if(Array.isArray(m.swipes)&&m.swipes.filter(v=>visible(v)===visible(m.mes)).length>1)break;prev=await hash(prev+'\n'+legacySignature(m));refs.set(prev,this.path[i+1].hash);}return refs;}
 eligibleStream(s){if(!s||!this.stream)return false;const a=JSON.parse(this.stream.owner);let b;try{b=JSON.parse(s.importedOwner||s.owner);}catch{return false;}return a[0]===b[0]&&(a[1]===b[1]||!!this.parentName&&b[1]===this.parentName);}
 async listSnapshotsForStream(streamId=this.stream?.id){const src=(await this.db.all('streams')).find(x=>x.id===streamId);if(!src||!this.eligibleStream(src))return [];
 const permitted=new Set(src.legacy?(await this.legacyPath()).keys():this.path.map(x=>x.hash));return (await this.db.all('nodes',src.id)).filter(n=>permitted.has(n.hash)&&(src.id===this.stream.id||n.hash!=='root')&&(n.state||n.receipt?.ok)).sort((a,b)=>b.length-a.length||b.revision-a.revision);}
 async adopt(sid,targetHash=null,revision=null){const src=(await this.db.all('streams')).find(x=>x.id===sid);if(!this.eligibleStream(src))throw Error('角色或存档来源不匹配。');
 const options=await this.listSnapshotsForStream(sid),which=targetHash||this.node.hash,source=options.find(x=>x.hash===which);if(!source)throw Error('不是当前世界线的共同历史，不能载入。');
 let state;if(src.legacy){const refs=await this.legacyPath();if(!refs.has(which))throw Error('旧 Swipe 身份存在歧义。');state=quarantine(remapTree(source.state,refs));}
 else {const idx=this.path.findIndex(p=>p.hash===which),all=new Map((await this.db.all('nodes',sid)).map(n=>[n.hash,n]));state=fold(src,this.path.slice(0,idx+1),all).node.state;
 if(revision!=null&&revision!==source.revision){const version=source.history.find(h=>h.revision===revision);if(!version)throw Error('未保存这个历史修订。');state=version.state;}}
 return this.update(()=>clone(state),'玩家载入共同历史上的快照');}
}
