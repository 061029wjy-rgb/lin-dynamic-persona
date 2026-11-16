import {visible,effective,ooc,text,fingerprintMessage} from './util.js';
import {messageActor,chatOwner} from './timeline.js';
const hidden=/<!--[\s\S]*?(?:-->|$)|<(think(?:ing)?|reasoning|analysis|lin_cot|details|script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<[^>]*>/gi;
export const USER='@user';
export function modalityHints(txt){
 const s=String(txt);return [...new Set([[/梦见|梦到|梦里|梦中|噩梦|in (?:a|my) dream/i,'dream'],[/如果|假如|要是|要不是|本可以|未必|差点|差一点|would have|what if/i,'hypothetical'],[/没有|并未|没去|没来|没迟到|从未|不曾|并非|did not|never/i,'negative'],[/听说|转述|传闻|据说|妹妹说|声称|说她|说他|听.{1,6}说|据.{1,6}所?说|转告|[“「][^”」]*[『‘][^』’]+[』’]|heard that/i,'reported'],[/演戏|排练(?!室|厅|房|场|日程)|台词|扮演|假装|pretend/i,'performed'],[/回忆|想起|那次|上回|那天|记得|remember/i,'remembered']].filter(([rx])=>rx.test(s)).map(([,k])=>k))];}
export function sourceSegments(m){
 const raw=String(m?.mes||'');let end=0,vpos=0;const parts=[];const emit=(a,b)=>{const t=raw.slice(a,b);for(const z of t.matchAll(/[^\n\r。！？!?；;]{1,440}[。！？!?；;”」』"]*|[。！？!?；;]+/gu)){
 const body=z[0].trim(),lead=z[0].indexOf(body);if(!body||!/[\p{L}\p{N}]/u.test(body))continue;const pos=z.index+lead;parts.push({text:body,start:vpos+pos,end:vpos+pos+body.length,rawStart:a+pos,rawEnd:a+pos+body.length});}vpos+=t.length;};
 for(const match of raw.matchAll(hidden)){emit(end,match.index);end=match.index+match[0].length;}emit(end,raw.length);return parts;
}
const secret=/全知旁白|上帝视角|独白|与此同时|无人知晓|不知情|不知道的是|心底|心想|内心|暗自|悄悄藏|背着|瞒着|私下对|私信|偷偷|无人听见|没说出口|心里/;
export function permittedParts(m,actor,cast,state,node,group,publicScene=false){
 if(!m||m.is_system||!m.is_user&&!effective(m)||ooc(m.mes)||state.revokes?.[node]?.includes(actor.id))return [];
 const speaker=m.is_user?USER:messageActor(m,cast);if(!speaker)return [];
 const grant=state.grants?.[node]?.includes(actor.id),own=speaker===actor.id,parts=sourceSegments(m),out=[];
 let offstage=false,privateParagraph=false,previousEnd=0,frame=[];const raw=String(m.mes);
 const esc=actor.name?actor.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'):'';
 for(const p of parts){const t=p.text;if(raw.slice(previousEnd,p.rawStart).includes('\n'))privateParagraph=false;previousEnd=p.rawEnd;
 if(/^(?:随后真的|实际上|醒来后|回到现实|现实中|事实上)/.test(t))frame=[];
 const hints=modalityHints(t);const contextHints=[...new Set([...hints,...frame])];if(hints.some(h=>['dream','hypothetical','performed','reported','remembered'].includes(h)))frame=contextHints;
 if(/与此同时|在另一个房间|他不知道的是|她不知道的是|切到另/.test(t))offstage=true;
 if(secret.test(t)&&!own)privateParagraph=true;
 const unquoted=t.replace(/[“"「『][^”"」』]*[”"」』]/g,' ');
 const directAddress=!!esc&&(t.startsWith('@'+actor.name+' ')||[actor.name+'，',actor.name+'：','我对'+actor.name+'说','我对'+actor.name+'道'].some(k=>t.startsWith(k))||new RegExp(`^[“「『"']\\s*@?${esc}\\s*[，,：:！!？?]|(?:^|[，,。；;\\s])(?:我|[\\p{Script=Han}A-Za-z0-9_]{1,10})?(?:对|向|朝|问|看向|转向|递给|交给)${esc}(?:说|道|问|开口|[，,：:—“「『"])`,'u').test(t));
 const publicAction=!!esc&&!directAddress&&new RegExp(`(?:(?:把|将)[^，,。！？；\\n]{1,18}(?:递给|交给|塞给|推给|拿给|扔给|放在|摆在)${esc}|(?:走向|走到|来到|走近|靠近|拍了拍|拉住|扶住|拦住|接过|递给|交给|塞给|推给|望向|看向|转向)${esc}(?:的?(?:肩膀|手|面前|身边|桌上|怀里)|[，,。！？；\\s]|$))`,'u').test(unquoted);
 const explicitlyTo=directAddress||publicAction;
 const ownOtherSecret=own&&secret.test(t)&&(Boolean(esc&&new RegExp(`${esc}(?:对此)?(?:毫不知情|完全不知情|并不知道|不知道的是|一无所知)|(?:瞒着|背着|避开)${esc}`).test(t))||cast.some(a=>a.id!==actor.id&&a.name&&new RegExp(`${a.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[^，,。！？；\\n]{0,6}(?:心底|心想|内心|暗自|悄悄藏|背着|瞒着|私下|私信|偷偷|没说出口|心里)`).test(t)));
 if(!grant&&(offstage||privateParagraph||ownOtherSecret||!own&&group&&(!publicScene&&(!explicitlyTo||state.world?.groupVisibilityMode==='manual'))))continue;
 if(!grant&&!own&&!group&&!m.is_user)continue;
 out.push({...p,visibility:grant?'manually_shared':own?'own_source':publicScene?'confirmed_public_scene':directAddress?'addressed':publicAction?'public_action':'available',id:node+'@'+p.rawStart,node,speakerId:speaker,speaker:m.name||'',speakerRole:m.is_user?'user':'assistant',swipe:m.swipe_id??0,
 sourceKind:/[“「『"]/.test(t)?'dialogue':m.is_user?'spoken_claim':secret.test(t)?'subjective':'narration',hints:contextHints,knownBy:[actor.id]});
 }return out;
}
export function knownMessages({chat=[],path=[],cast=[],actorId,state={},group=false,excluded=new Set(),start=0,storyBefore=true}){const a=cast.find(x=>x.id===actorId);if(!a)return [];const out=[];let story=storyBefore;
 for(let i=start;i<chat.length;i++){const row=path[i+1],m=chat[i];if(m.is_user)story=!ooc(m.mes);if(!row||!story||excluded.has(row.hash))continue;
 const attended=group&&(state.presence||[]).some(z=>z.anchor===path[z.from+1]?.hash&&z.from<=i&&i<=z.to&&z.actors.includes(actorId)&&z.actors.includes(m.is_user?USER:messageActor(m,cast)));
 for(const s of permittedParts(m,a,cast,state,row.hash,group,attended))out.push({...s,index:i,at:m.send_date||null});}return out;}
export function verifyQuote(span,source,chat,path){
 if(!source||typeof span?.quote!=='string'||span.quote.trim().length<2||span.quote.length>400||!Number.isInteger(span.offset)||span.offset<0||!source.text.startsWith(span.quote,span.offset))throw Error('引文或字符位置不对应原文。');
 const row=chat[source.index],r=path[source.index+1];const start=source.rawStart+span.offset;
 if(!row||r?.hash!==source.node||source.swipe!==(row.swipe_id??0)||String(row.mes).slice(start,start+span.quote.length)!==span.quote)throw Error('引文来自未选中的版本或已被修改。');
 return {node:r.hash,index:source.index,key:source.id,sourceId:source.id,speakerId:source.speakerId,speakerRole:source.speakerRole,sourceKind:source.sourceKind,swipe:source.swipe,quote:span.quote,start:source.start+span.offset,end:source.start+span.offset+span.quote.length,rawStart:start,rawEnd:start+span.quote.length};
}
export async function diskChat(c,signal,fetcher=globalThis.fetch){
 if(!chatOwner(c)||!c.getRequestHeaders)throw Error('宿主未提供可核实的存档入口。');const group=c.groupId!=null&&c.groupId!=='',name=c.chatId||c.getCurrentChatId(),card=c.characters?.[c.characterId];
 const res=await fetcher(group?'/api/chats/group/get':'/api/chats/get',{method:'POST',headers:c.getRequestHeaders(),credentials:'same-origin',cache:'no-store',body:JSON.stringify(group?{id:name}:{ch_name:card.name,file_name:name,avatar_url:card.avatar}),signal});
 if(!res.ok)throw Error('酒馆存档读取失败。');if(Number(res.headers?.get?.('content-length'))>64000000)throw Error('存档过大，已跳过本次核对。');const data=await res.json();if(!Array.isArray(data))throw Error('存档尚未就绪。');
 const header=data[0]&&typeof data[0].mes!=='string'?data[0]:null;if(c.chatMetadata?.integrity&&header?.chat_metadata?.integrity!==c.chatMetadata.integrity)throw Error('酒馆文件身份不一致。');
 return header?data.slice(1):data;
}
export const sameRows=(a,b,n=a.length)=>a.length>=n&&b.length>=n&&Array.from({length:n},(_,i)=>fingerprintMessage(a[i])===fingerprintMessage(b[i])).every(Boolean);
