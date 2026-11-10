import {_electron as electron} from '@playwright/test';
import {encode} from 'next-auth/jwt';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {config} from 'dotenv';
config({path:'.env',quiet:true});
const db=postgres(process.env.POSTGRES_URL!,{max:1});
const rows=await db`select id,email from "User" where email=${'robotbird@qq.com'}`;
assert.equal(rows.length,1);const user=rows[0];await db.end();
const token=await encode({salt:'authjs.session-token',secret:process.env.AUTH_SECRET!,token:{id:user.id,sub:user.id,type:'regular',email:user.email}});
const desktop=path.resolve('../piwork-desktop/apps/desktop');const profile=await mkdtemp(path.join(os.tmpdir(),'piwork-live-sync-'));const base=process.env.PIWORK_SYNC_TEST_URL??'http://localhost:3000';let app:any;let chatId:string|undefined;
async function poll<T>(fn:()=>Promise<T>,ok:(x:T)=>boolean,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(ok(value))return value;await new Promise(r=>setTimeout(r,250))}throw new Error('Timed out')}
try{
 await writeFile(path.join(profile,'account-server.json'),JSON.stringify({baseUrl:base}),{mode:0o600});
 app=await electron.launch({executablePath:path.join(desktop,'node_modules/.bin/electron'),args:[desktop,`--user-data-dir=${profile}`],env:{...process.env,VITE_DEV_SERVER_URL:'',PIWORK_DESKTOP_SYNC_EXPERIMENTAL:'1'}});
 await app.evaluate(async({session}:any,data:any)=>{await session.fromPartition('persist:piwork-account').cookies.set({url:data.base,name:'authjs.session-token',value:data.token,httpOnly:true,sameSite:'lax'})},{base,token});
 const page=await app.firstWindow();const account=await page.evaluate(()=>window.desktop.accountStatus());assert.equal(account.user?.email,user.email);assert.ok(account.models.length);
 const status=await app.evaluate(async({session}:any,url:string)=>{const response=await session.fromPartition('persist:piwork-account').fetch(url,{headers:{'x-piwork-desktop':'1'}});return {status:response.status,body:await response.text()}},base+'/api/desktop/sync/status');assert.equal(status.status,200,JSON.stringify(status));
 await page.evaluate(()=>window.desktop.setPreferences({appearance:'light',language:'en',syncEnabled:true}));
 await poll(()=>page.evaluate(()=>window.desktop.syncStatus()),s=>s.state==='ready');
 const local=await page.evaluate(async(model:string)=>{const result=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Desktop inference timeout')),90000);const off=window.desktop.onChat((event:any)=>{if(['completed','failed','aborted'].includes(event.type)){clearTimeout(timer);off();resolve(event)}})});const id=await window.desktop.sendChat('测试同步，请仅回复 OK。',null,null,null,null,{source:'account',id:model});return {id,event:await result}},account.models[0].id);
 chatId=local.id;assert.equal(local.event.type,'completed');assert.ok(local.event.text);
 const fetchJson=async(url:string,init:any={})=>app.evaluate(async({session}:any,data:any)=>{const r=await session.fromPartition('persist:piwork-account').fetch(data.url,data.init);return {status:r.status,body:await r.text()}},{url,init});
 const syncUrl=`${base}/api/desktop/sync/${chatId}`;
 await poll(async()=>{await page.evaluate(()=>window.desktop.syncNow());const r=await fetchJson(syncUrl,{headers:{'x-piwork-desktop':'1'}});return r.status===200?JSON.parse(r.body):null},v=>v?.messages?.length>=2&&!v.activeBy);
 const webMessage={id:randomUUID(),role:'user',parts:[{type:'text',text:'请仅回复 YES。'}]};
 const web=await fetchJson(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:chatId,message:webMessage,selectedChatModel:account.models[0].id,selectedVisibilityType:'private'})});assert.equal(web.status,200,web.body.slice(0,300));
 await poll(async()=>{const r=await fetchJson(syncUrl,{headers:{'x-piwork-desktop':'1'}});return JSON.parse(r.body)},v=>!v.activeBy&&v.messages?.some((m:any)=>m.id===webMessage.id)&&v.messages.length>=4,90000);
 await poll(async()=>{await page.evaluate(()=>window.desktop.syncNow());return page.evaluate(id=>window.desktop.openChat(id).catch(()=>null),chatId!)},v=>!!v?.messages.some((m:any)=>m.text==='请仅回复 YES。'),30000);
 console.log('Live Web and desktop: account, local run, text upload, Web continuation and return to Pi session passed');
}finally{
 if(app&&chatId){try{const result=await app.evaluate(async({session}:any,url:string)=>{const response=await session.fromPartition('persist:piwork-account').fetch(url,{method:'DELETE'});return response.status},`${base}/api/chat?id=${chatId}`);if(result!==200)console.error(`Test conversation cleanup returned ${result}`)}catch{console.error('Test conversation cleanup failed')}}
 if(app)await app.close().catch(()=>{});await rm(profile,{recursive:true,force:true});
}
