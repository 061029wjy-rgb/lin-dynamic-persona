// Standalone option for Tauri: behind an operator-controlled HTTPS reverse proxy.
import http from 'node:http';import {createHash,timingSafeEqual} from 'node:crypto';import {config,buildService,failure} from './index.js';
const serve=buildService(),hash=x=>createHash('sha256').update(x).digest(),port=Number(process.env.LDP_PORT||8733);
http.createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');try{const cfg=await config(),origin=req.headers.origin;
 if(req.url!=='/analyze'||!origin||!(cfg.origins||[]).includes(origin)){res.writeHead(403);res.end();return;}res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
 if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','POST');res.writeHead(204);res.end();return;}
 if(req.method!=='POST'){res.writeHead(405);res.end();return;}const val=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||'')?.[1];let account;
 if(val&&val.length<=400)for(const [who,env]of Object.entries(cfg.clients||{})){const secret=/^LDP_[A-Z0-9_]+$/.test(env)?process.env[env]:'';if(secret&&secret.length>=24&&timingSafeEqual(hash(secret),hash(val)))account=who;}if(!account){res.writeHead(401);res.end();return;}
 let n=0,parts=[];for await(const c of req){n+=c.length;if(n>230000){res.writeHead(413);res.end();return;}parts.push(c);}
 const ctrl=new AbortController();res.on('close',()=>{if(!res.writableEnded)ctrl.abort();});let packet;try{packet=JSON.parse(Buffer.concat(parts));}catch{res.writeHead(400);res.end();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await serve(account,packet,ctrl.signal)));}catch(e){if(!res.destroyed)res.end(JSON.stringify(failure(e)));}}).listen(port,'127.0.0.1');
