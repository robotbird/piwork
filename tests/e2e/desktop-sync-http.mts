import assert from 'node:assert/strict';import postgres from 'postgres';import {encode} from 'next-auth/jwt';
const db=postgres(process.env.POSTGRES_URL!,{max:1});const secret=process.env.AUTH_SECRET!;const base=process.env.DESKTOP_SYNC_TEST_URL??'http://127.0.0.1:43877';const user=crypto.randomUUID(),other=crypto.randomUUID(),chat=crypto.randomUUID();
async function cookie(id:string){return `authjs.session-token=${await encode({salt:'authjs.session-token',secret,token:{id,sub:id,type:'regular',email:`${id}@test.local`}})}`}
const ownerCookie=await cookie(user),otherCookie=await cookie(other);const endpoint=`${base}/api/desktop/sync/${chat}`;const first={id:crypto.randomUUID(),role:'user',text:'原始输入'},answer={id:crypto.randomUUID(),role:'assistant',text:'答复'};const payload={title:'同步测试',expected:[],messages:[first,answer]};
const send=(cookieValue:string,body:unknown)=>fetch(endpoint,{method:'POST',headers:{cookie:cookieValue,'x-piwork-desktop':'1','content-type':'application/json'},body:JSON.stringify(body)});
try{
 await db`insert into "User" (id,email) values (${user},${`${user}@test.local`}),(${other},${`${other}@test.local`})`;
 await db`insert into "Member" ("userId") values (${user}),(${other})`;
 assert.equal((await fetch(endpoint)).status,401);assert.equal((await send(ownerCookie,{...payload,projectPath:'/secret'})).status,400);
 let result=await send(ownerCookie,payload);assert.equal(result.status,200);assert.deepEqual((await result.json()).ids,[first.id,answer.id]);assert.equal((await send(ownerCookie,payload)).status,200);
 assert.equal((await send(otherCookie,payload)).status,403);assert.equal((await fetch(endpoint,{headers:{cookie:otherCookie,'x-piwork-desktop':'1'}})).status,404);
 await db`update "Member" set status='disabled' where "userId"=${user}`;assert.equal((await send(ownerCookie,payload)).status,401);await db`update "Member" set status='enabled' where "userId"=${user}`;
 assert.equal((await send(ownerCookie,{...payload,messages:[first,{...answer,text:'改写'}]})).status,409);
 const leaseRequest=(data:unknown)=>fetch(`${endpoint}/lease`,{method:'POST',headers:{cookie:ownerCookie,'x-piwork-desktop':'1','content-type':'application/json'},body:JSON.stringify(data)});
 const acquired=await leaseRequest({action:'acquire',expected:[first,answer]});assert.equal(acquired.status,200);const {token}=await acquired.json();
 const webMessage={id:crypto.randomUUID(),role:'user',parts:[{type:'text',text:'longstream'}]};
 const webSend=()=>fetch(`${base}/api/chat`,{method:'POST',headers:{cookie:ownerCookie,'content-type':'application/json'},body:JSON.stringify({id:chat,message:webMessage,selectedChatModel:'deepseek/deepseek-flash',selectedVisibilityType:'private'})});
 assert.equal((await webSend()).status,409);
 assert.equal((await leaseRequest({action:'release',token})).status,200);
 const web=await webSend();assert.equal(web.status,200);assert.equal((await leaseRequest({action:'acquire',expected:[first,answer]})).status,409);
 await web.text();let history;for(let i=0;i<100;i++){history=await (await fetch(endpoint,{headers:{cookie:ownerCookie,'x-piwork-desktop':'1'}})).json();if(!history.activeBy)break;await new Promise(resolve=>setTimeout(resolve,100))}assert.equal(history.activeBy,null);assert.ok(history.messages.some((item:{id:string})=>item.id===webMessage.id));
 const invalidFileMessage={id:crypto.randomUUID(),role:'user',parts:[{type:'file',url:`/api/files/${crypto.randomUUID()}`,filename:'missing.png',mediaType:'image/png'}]};
 const bad=await fetch(`${base}/api/chat`,{method:'POST',headers:{cookie:ownerCookie,'content-type':'application/json'},body:JSON.stringify({id:chat,message:invalidFileMessage,selectedChatModel:'deepseek/deepseek-flash',selectedVisibilityType:'private'})});assert.equal(bad.status,403);
 const afterBad=await (await fetch(endpoint,{headers:{cookie:ownerCookie,'x-piwork-desktop':'1'}})).json();assert.equal(afterBad.activeBy,null);


 await db`update "Message_v2" set parts=${db.json([{type:'text',text:'答复'},{type:'tool-secret',input:{path:'/private/file'},output:'secret output'},{type:'file',url:'/private/file'}])} where id=${answer.id}`;
 const returned=await (await fetch(endpoint,{headers:{cookie:ownerCookie,'x-piwork-desktop':'1'}})).json();assert.deepEqual(returned.messages.slice(0,2),[first,answer]);assert.doesNotMatch(JSON.stringify(returned),/private|secret output/);
 console.log('Desktop sync HTTP: authentication, private ownership, text-only schema, retries and conflicts passed');
}finally{await db`delete from "Message_v2" where "chatId"=${chat}`;await db`delete from "Chat" where id=${chat}`;await db`delete from "User" where id in (${user},${other})`;await db.end()}
