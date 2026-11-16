import {EventEmitter} from 'node:events';import {Database} from '../src/storage.js';import {Controller} from '../src/controller.js';import {IDBFactory} from './shims/indexeddb.js';import {KEY} from '../src/util.js';import {userEdit} from '../src/model.js';
export const A={name:'沈青',avatar:'qing.png',description:'在配音室工作，性格克制。绝不擅动原稿。'},B={name:'余宁',avatar:'ning.png'};
export const U=(mes,date)=>({name:'许禾',is_user:true,mes,...date&&{send_date:date}}),R=(mes,a=A,swipe=0)=>({name:a.name,original_avatar:a.avatar,mes,swipe_id:swipe});
const en=['GENERATION_STARTED','GENERATION_STOPPED','GENERATION_ENDED','MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED','CHAT_CHANGED','MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','MESSAGE_SENT','APP_READY'];
export async function fixture({chat=[U('准备工作了吗？')],group=false,settings={},factory=new IDBFactory(),ctx={},db,delays=[0],recovery}={}){
 const prompts=[],c={characters:[A,B].map(x=>({...x})),characterId:0,groups:[{id:'g',members:[A.avatar,B.avatar]}],groupId:group?'g':null,chatId:'world-A',chatMetadata:{integrity:'sA'},extensionSettings:{},chat:structuredClone(chat),name1:'许禾',getChatCompletionModel:()=> 'gemini-4-carbon',eventSource:new EventEmitter(),eventTypes:Object.fromEntries(en.map(e=>[e,e])),saveSettingsDebounced(){},saveMetadataDebounced(){},getTokenCountAsync:async s=>Math.ceil(new TextEncoder().encode(s).length/2),setExtensionPrompt:(...p)=>prompts.push(p),...ctx};
 let saved=structuredClone(c.chat);const ctl=new Controller(()=>c,{db:db||new Database('fixture',factory),readSaved:async()=>structuredClone(saved),delays,recovery});ctl.bind();ctl.changeSettings({expressive:false,...settings});await ctl.sync({recovery:true});return {ctl,c,prompts,factory,save:()=>saved=structuredClone(c.chat),disk:rows=>saved=structuredClone(rows),
 event:(k,...a)=>c.eventSource.emit(k,...a),raw:()=>saved};
}
export async function turn(f,text,{type='normal',who=A,swipe=0,user='',save=true,stop=false,tool=false}={}){
 const {c,ctl,event}=f;if(user)c.chat.push(U(user));c.characterId=c.characters.findIndex(v=>v.avatar===who.avatar);event('GENERATION_STARTED',type,{},false);
 if(type==='regenerate'&&!c.chat.at(-1)?.is_user)c.chat.pop();await ctl.intercept(c.chat,10000,()=>{throw Error('must not abort host');},type);
 const m=R(text,who,swipe);if(tool)m.extra={tool_invocations:[{}]};if(['continue','swipe'].includes(type))c.chat[c.chat.length-1]=m;else c.chat.push(m);
 if(stop)event('GENERATION_STOPPED');if(save)f.save();event('GENERATION_ENDED');event('MESSAGE_RECEIVED',c.chat.length-1,type==='continue'?'append':type);event('CHARACTER_MESSAGE_RENDERED',c.chat.length-1,type==='continue'?'append':type);await ctl.idle();return m;
}
export const add=(f,id,desc,opt={})=>f.ctl.mutate(s=>userEdit(s,{id,description:desc,layer:'acquired',...opt},A.avatar),'玩家编辑');
export const mood=(f,n)=>add(f,'mood','被夸以后心情轻快，不一定表现。',{layer:'immediate',duration:{mode:'turns',remaining:n}});
export const get=(f,id)=>f.ctl.timeline.node.state.influences.find(x=>x.id===id);
