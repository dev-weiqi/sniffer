// Run after npm run test:server and npm --prefix server/ui run build.
// Pass --preview to serve in-memory examples on port 5200 (or SNIFFER_PREVIEW_PORT).
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from '../server/daemon/node_modules/playwright-core/index.mjs';
import {WebSocketServer} from '../server/daemon/node_modules/ws/wrapper.mjs';
import {serveStatic} from '../server/daemon/build/test/static.js';
const preview=process.argv.includes('--preview');
const device={deviceId:'body-test',deviceName:'Body mock preview iPhone',platform:'ios',appId:'body.test',sdkVersion:'dev',connected:true,capabilities:['http','http-query-mocks','http-body-mocks','socketio','ktor-ws','socket-payload-mocks']};
const body={session_id:'69afe89417d1f6d5d539704d',limit:20};
const response={items:[{id:'message-1',text:'Hello'}],next_cursor:null};
let mocks={http:preview?[{id:'http-preview',name:'Messages · first page',enabled:true,method:'POST',urlPattern:'/messages',queryParams:{locale:'zh-TW'},bodyMatch:JSON.stringify(body),status:200,headers:{'content-type':'application/json'},body:JSON.stringify(response),delayMs:0,delayOnly:false}]:[],socket:[
 {id:'socket-preview',name:'Items · page 1',enabled:true,transport:'socketio',event:'items',payloadMatch:'{"page":1}',ackPayload:'[{"items":[{"id":1}],"page":1}]',delayMs:0},
 {id:'socket-fallback',name:'Items · fallback',enabled:true,transport:'socketio',event:'items',ackPayload:'[{"items":[]}]',delayMs:0},
]};
if(preview){
 mocks.http.push(...['GET','DELETE',null].map((method,i)=>({id:`preview-method-${i}`,enabled:true,method,urlPattern:i===0?'/profile':i===1?'/messages/1':'/health',status:200,headers:{},body:'{}',delayMs:0,delayOnly:false})));
 mocks.socket.push({id:'preview-ws',enabled:true,transport:'ktor-ws',event:'ping',ackPayload:'pong',delayMs:0});
}
let breakpoints=[];
const entries=[
 {deviceId:device.deviceId,message:{type:'http-request',id:'post-1',method:'POST',url:'https://preview.example/messages?locale=zh-TW',headers:{'content-type':'application/json'},body:JSON.stringify(body),bodySize:55,bodyTruncated:false,library:'urlsession',timestamp:Date.now()}},
 {deviceId:device.deviceId,message:{type:'http-response',id:'post-1',status:200,headers:{'content-type':'application/json'},body:JSON.stringify(response),bodySize:60,bodyTruncated:false,durationMs:12,mocked:false,timestamp:Date.now()+12}},
];
entries.push(
 {deviceId:device.deviceId,message:{type:'http-request',id:'plain-get',method:'GET',url:'https://preview.example/profile',headers:{},body:null,bodySize:0,bodyTruncated:false,library:'urlsession',timestamp:Date.now()}},
 {deviceId:device.deviceId,message:{type:'http-request',id:'invalid-body',method:'POST',url:'https://preview.example/form?page=1',headers:{},body:'page=1',bodySize:6,bodyTruncated:false,library:'urlsession',timestamp:Date.now()}},
 {deviceId:device.deviceId,message:{type:'socket-event',id:'ack-1',connectionId:'conn-1',transport:'socketio',direction:'out',event:'items',payload:'[{"page":1,"limit":20},{"ignore":true}]',mocked:false,timestamp:Date.now()}},
 {deviceId:device.deviceId,message:{type:'socket-ack',id:'ack-1',payload:'[{"items":[{"id":1}]}]',mocked:false,timestamp:Date.now()+1}},
 {deviceId:device.deviceId,message:{type:'socket-event',id:'ack-empty',connectionId:'conn-1',transport:'socketio',direction:'out',event:'ping',payload:'[]',mocked:false,timestamp:Date.now()+2}},
);
const wss=new WebSocketServer({noServer:true});
const server=createServer(async(req,res)=>{
 if(req.url==='/api/mocks'&&req.method==='PUT'){
  let text='';for await(const chunk of req)text+=chunk;
  const saved=JSON.parse(text);mocks={http:saved.http,socket:saved.socket};
  for(const ws of wss.clients)ws.send(JSON.stringify({type:'mocks-changed',deviceId:device.deviceId,mocks}));
  res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;
 }
 if(req.url==='/api/breakpoints'&&req.method==='PUT'){
  let text='';for await(const chunk of req)text+=chunk;
  breakpoints=JSON.parse(text).rules;
  for(const ws of wss.clients)ws.send(JSON.stringify({type:'breakpoints-changed',deviceId:device.deviceId,rules:breakpoints}));
  res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;
 }
 await serveStatic(res,new URL(req.url,'http://localhost').pathname,{uiDist:fileURLToPath(new URL('../server/ui/dist',import.meta.url))});
});
server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws)));
wss.on('connection',ws=>ws.send(JSON.stringify({type:'init',devices:[device],entries,mocksByDevice:{[device.deviceId]:mocks},breakpointsByDevice:{[device.deviceId]:breakpoints},pausedHits:[]})));
await new Promise(resolve=>server.listen(preview?Number(process.env.SNIFFER_PREVIEW_PORT??5200):0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
if(preview){console.log(`HTTP body mock preview: ${url} (in-memory sample data)`)}else{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];
 try{
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('sniffer-device','body-test'));
  await page.goto(url);
  await page.locator('tbody tr').filter({hasText:'/messages'}).click();
  await page.getByRole('button',{name:'Mock this request',exact:true}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),false,'Path only starts collapsed');
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  assert.equal(mocks.http[0].queryParams,undefined,'primary action excludes query');
  assert.equal(mocks.http[0].bodyMatch,undefined,'primary action excludes body');
  await page.getByTitle('Delete rule',{exact:true}).click();
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  await page.getByTitle('Close',{exact:true}).click();
  for(const choice of ['With query','With body']){
   await page.getByRole('button',{name:'Choose conditions for mock this request',exact:true}).click();
   await page.getByRole('menuitem',{name:choice,exact:false}).filter({hasText:choice==='With query'?'Include captured query':'Include captured JSON'}).click();
   assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),true,'explicit conditions open automatically');
   assert.equal(await page.getByRole('tab',{name:choice==='With query'?/Query parameters/:/Body conditions/}).getAttribute('aria-selected'),'true');
   await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
   assert.equal(!!mocks.http[0].queryParams,choice==='With query');
   assert.equal(!!mocks.http[0].bodyMatch,choice==='With body');
   await page.getByTitle('Delete rule',{exact:true}).click();
   await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
   await page.getByTitle('Close',{exact:true}).click();
  }
  await page.getByRole('button',{name:'Choose conditions for mock this request',exact:true}).click();
  await page.getByRole('menuitem',{name:/With query \+ body/}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),true,'query and body open automatically');
  assert.equal(await page.getByRole('tab',{name:/Body conditions/}).getAttribute('aria-selected'),'true','body takes priority');
  await page.locator('.rule-conditions summary').click();
  assert.equal(await page.locator('.rule-tabs').getByRole('textbox',{name:'Delay ms',exact:true}).isVisible(),true,'HTTP delay stays in the response toolbar');
  const modalBox=await page.getByRole('dialog').boundingBox();
  assert.ok(modalBox.width>=1280&&modalBox.height>=840,'mock panel uses larger defaults');
  const assertDisabledConditions=async()=>{
   const enabled=page.locator('.mock-rule-editor .toggle input');
   await enabled.uncheck();
   assert.equal(await page.locator('.rule-conditions > summary').evaluate(el=>getComputedStyle(el).opacity),'0.45','disabled condition summary dims like other fields');
   assert.equal(await page.locator('.rule-conditions > summary .hint').evaluate(el=>getComputedStyle(el).opacity),'1','summary hint does not receive opacity twice');
   await page.locator('.rule-conditions summary').click();
   assert.equal(await page.locator('.condition-panel .condition-heading').evaluate(el=>getComputedStyle(el).opacity),'0.45','expanded condition heading also dims');
   assert.equal(await enabled.evaluate(el=>getComputedStyle(el).opacity),'1','enable toggle remains fully visible');
   await page.locator('.rule-conditions summary').click();
   await enabled.check();
   assert.equal(await page.locator('.rule-conditions > summary').evaluate(el=>getComputedStyle(el).opacity),'1','enabled summary restores full opacity');
  };
  await assertDisabledConditions();
  await page.screenshot({path:'/tmp/sniffer-progressive-http.png',fullPage:true});
  await page.locator('.rule-conditions summary').focus();
  await page.keyboard.press('Enter');
  const condition=page.getByRole('textbox',{name:'Body conditions',exact:true});
  await condition.waitFor();
  assert.deepEqual(JSON.parse(await condition.inputValue()),body);
  assert.equal(await page.getByRole('tab',{name:/Body conditions/}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:/Body conditions/}).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByLabel('parameter name 1').inputValue(),'locale');
  assert.equal(await page.getByLabel('parameter value 1').inputValue(),'zh-TW');
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:/HTTP Mocks/}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),true,'HTTP conditions reopen expanded');
  assert.equal(await page.getByRole('tab',{name:/Query parameters/}).getAttribute('aria-selected'),'true','HTTP condition tab survives reopening');
  await page.reload();
  await page.getByRole('button',{name:/HTTP Mocks/}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),true,'HTTP expansion survives reload');
  assert.equal(await page.getByRole('tab',{name:/Query parameters/}).getAttribute('aria-selected'),'true','HTTP condition tab survives reload');
  const queryHeight=(await page.getByRole('tabpanel',{name:'Query parameters'}).boundingBox()).height;
  const queryPadding=await page.getByRole('tabpanel',{name:'Query parameters'}).evaluate(el=>getComputedStyle(el).padding);
  await page.getByRole('tab',{name:/Body conditions/}).click();
  const bodyHeight=(await page.getByRole('tabpanel',{name:'Body conditions'}).boundingBox()).height;
  assert.ok(Math.abs(queryHeight-bodyHeight)<2,'query and body panels have matching default height');
  assert.equal(await page.getByRole('tabpanel',{name:'Body conditions'}).evaluate(el=>getComputedStyle(el).padding),queryPadding,'query and body panels have matching padding');
  await condition.fill('{"limit":20}');
  await page.getByRole('tabpanel',{name:'Body conditions',exact:true}).getByRole('button',{name:'Pretty JSON',exact:true}).click();
  assert.equal(await condition.inputValue(),JSON.stringify({limit:20},null,2));
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  assert.equal(mocks.http.length,1);
  assert.deepEqual(JSON.parse(mocks.http[0].bodyMatch),{limit:20});
  assert.deepEqual(mocks.http[0].queryParams,{locale:'zh-TW'});
  assert.deepEqual(JSON.parse(mocks.http[0].body),response);
  await condition.fill('{');
  await page.getByRole('alert').filter({hasText:'Enter a JSON object'}).waitFor();
  await page.getByRole('tab',{name:/Query parameters/}).click();
  assert.equal(await page.getByRole('alert').count(),1,'body error remains visible on query tab');
  await page.getByRole('tab',{name:/Body conditions/}).click();
  await condition.fill('{"limit":20}');
  await page.getByRole('tabpanel',{name:'Body conditions',exact:true}).getByRole('button',{name:'Pretty JSON',exact:true}).click();
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  await page.screenshot({path:'/tmp/sniffer-http-body-tabs.png',fullPage:true});
  await page.locator('.rule-conditions summary').click();
  const httpDelay=page.getByRole('textbox',{name:'Delay ms',exact:true});
  await httpDelay.fill('125');
  await httpDelay.press('Tab');
  await page.getByRole('checkbox',{name:'Delay only',exact:true}).check();
  assert.equal(await page.getByRole('textbox',{name:'Response body',exact:true}).count(),0);
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  assert.equal(mocks.http[0].delayOnly,true);
  assert.equal(mocks.http[0].delayMs,125);
  await page.getByRole('checkbox',{name:'Delay only',exact:true}).uncheck();
  await page.getByRole('textbox',{name:'Response body',exact:true}).waitFor();
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:/HTTP Mocks/}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),false,'HTTP conditions remember being collapsed');
  await page.locator('.rule-conditions summary').click();
  assert.equal(await page.getByRole('tab',{name:/Body conditions/}).getAttribute('aria-selected'),'true','Body tab selection is remembered while collapsed');
  await page.locator('.rule-conditions summary').click();
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:/^Export \(\d+\)$/}).click();
  const download=await downloadPromise;
  const exported=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.deepEqual(JSON.parse(exported.http[0].bodyMatch),{limit:20});
  await page.locator('input[type=file]').setInputFiles({name:'body-mocks.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(exported))});
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  assert.equal(mocks.http.length,2);
  assert.deepEqual(mocks.http.map(r=>JSON.parse(r.bodyMatch)),[{limit:20},{limit:20}]);
  device.capabilities=['http','http-query-mocks'];
  await page.reload();
  await page.getByRole('button',{name:/HTTP Mocks/}).click();
  await page.getByText('Update the device SDK to use body conditions.',{exact:false}).waitFor();
  await page.getByTitle('Close',{exact:true}).click();
  await page.locator('nav.tabs').getByRole('button',{name:/^Socket,/}).click();
  await page.getByRole('button',{name:/Socket Mocks/}).click();
  assert.equal(await page.locator('.rule-conditions').getAttribute('open'),null,'socket conditions start collapsed');
  assert.equal(await page.locator('.rule-tabs').getByRole('textbox',{name:'Delay ms',exact:true}).isVisible(),true,'Socket delay stays in the response toolbar');
  await assertDisabledConditions();
  await page.screenshot({path:'/tmp/sniffer-progressive-socket.png',fullPage:true});
  await page.locator('.rule-conditions summary').click();
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:/Socket Mocks/}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),true,'Socket conditions reopen expanded');
  await page.locator('.mocks-list-row').filter({hasText:'Items · fallback'}).first().click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),false,'another rule retains its own collapsed default');
  await page.locator('.mocks-list-row').filter({hasText:'Items · page 1'}).first().click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),true,'switching rules restores the saved expansion');
  const payload=page.getByRole('textbox',{name:'Payload conditions',exact:true});
  await payload.fill('{"page":2}');
  await page.locator('.rule-conditions').getByRole('button',{name:'Pretty JSON',exact:true}).click();
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  assert.deepEqual(JSON.parse(mocks.socket[0].payloadMatch),{page:2});
  await payload.fill('{');
  await page.locator('.rule-conditions summary').click();
  await page.getByRole('alert').filter({hasText:'Enter a JSON object'}).waitFor();
  await page.locator('.rule-conditions summary').click();
  await payload.fill('{"page":2}');
  await page.locator('.rule-conditions summary').click();
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:/Socket Mocks/}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),false,'Socket conditions remember being collapsed');
  const delay=page.getByRole('textbox',{name:'Delay ms',exact:true});
  await delay.fill('250');
  await delay.press('Tab');
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  assert.equal(mocks.socket[0].delayMs,250);
  assert.equal(await delay.inputValue(),'250');
  for(const mode of ['sio-event','ws','sio-ack']){
   await page.locator('.rule-row select').selectOption(mode);
   await page.getByRole('textbox',{name:'Response body',exact:true}).waitFor();
   if(mode==='sio-event')await page.getByRole('textbox',{name:'Event',exact:true}).fill('items:result');
  }
  const reply=page.getByRole('textbox',{name:'Response body',exact:true});
  await reply.fill('[]');
  await reply.press('End');
  await page.locator('.rule-placeholders summary').click();
  await page.getByRole('button',{name:'${randomId}',exact:true}).click();
  assert.equal(await reply.inputValue(),'[]${randomId}');
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  assert.equal(mocks.socket[0].ackPayload,'[]${randomId}');
  await page.getByRole('button',{name:/Server push events/}).click();
  await page.getByText('No push events yet',{exact:false}).waitFor();
  await page.setViewportSize({width:1100,height:740});
  const compactModal=await page.getByRole('dialog').boundingBox();
  assert.ok(compactModal.x>=0&&compactModal.y>=0&&compactModal.x+compactModal.width<=1100&&compactModal.y+compactModal.height<=740,'modal fits smaller desktop windows');
  await page.getByTitle('Close',{exact:true}).click();
  await page.locator('tbody tr').filter({hasText:'items'}).first().click();
  await page.getByRole('button',{name:'Mock this ack',exact:true}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),false,'ack primary action is event only');
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  assert.equal(mocks.socket[0].payloadMatch,undefined);
  assert.deepEqual(JSON.parse(mocks.socket[0].ackPayload),[{items:[{id:1}]}]);
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:'Choose conditions for mock this ack',exact:true}).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox',{name:'Payload conditions',exact:true}).waitFor();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),true,'ack payload opens automatically');
  assert.deepEqual(JSON.parse(await page.getByRole('textbox',{name:'Payload conditions',exact:true}).inputValue()),{page:1,limit:20});
  assert.deepEqual(JSON.parse(await page.getByRole('textbox',{name:'Response body',exact:true}).inputValue()),[{items:[{id:1}]}]);
  await page.waitForResponse(r=>r.url().endsWith('/api/mocks')&&r.status()===200);
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:/Socket Mocks/}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),true,'prefill expansion persists after reopening');
  await page.locator('.rule-conditions summary').click();
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:/Socket Mocks/}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),false,'manual collapse overrides automatic prefill');
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:'Mock this ack',exact:true}).click();
  assert.equal(await page.locator('.rule-conditions').evaluate(el=>el.open),false,'menu selection never changes the primary action');
  await page.getByTitle('Close',{exact:true}).click();
  await page.locator('tbody tr').filter({hasText:'ping'}).first().click();
  await page.getByRole('button',{name:'Choose conditions for mock this ack',exact:true}).click();
  assert.equal(await page.getByRole('menuitem',{name:/With payload/}).isDisabled(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(),0);
  assert.equal(await page.getByRole('button',{name:'Choose conditions for mock this ack',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.locator('nav.tabs').getByRole('button',{name:/^API,/}).click();
  await page.locator('tbody tr').filter({hasText:'/messages'}).click();
  await page.getByRole('button',{name:'Choose conditions for mock this request',exact:true}).click();
  const menuBox=await page.getByRole('menu',{name:'Mock conditions'}).boundingBox();
  assert.ok(menuBox.x>=0&&menuBox.x+menuBox.width<=1100,'split menu fits the viewport');
  await page.screenshot({path:'/tmp/sniffer-split-actions.png',fullPage:true});
  await page.keyboard.press('Escape');
  const armed=page.waitForResponse(r=>r.url().endsWith('/api/breakpoints')&&r.status()===200);
  await page.getByRole('button',{name:'Break on path',exact:true}).click();await armed;
  assert.equal(breakpoints[0].method,'POST');assert.equal(breakpoints[0].urlPattern,'/messages');
  assert.equal(breakpoints[0].queryParams,undefined);assert.equal(breakpoints[0].bodyMatch,undefined);
  for(const path of ['/profile','/form']){
   await page.locator('tbody tr').filter({hasText:path}).click();
   await page.getByRole('button',{name:'Choose conditions for mock this request',exact:true}).click();
   assert.equal(await page.getByRole('menuitem',{name:/With body/}).isDisabled(),true);
   assert.equal(await page.getByRole('menuitem',{name:/With query \+ body/}).isDisabled(),true);
   assert.equal(await page.getByRole('menuitem',{name:/^With query(?! \+)/}).isDisabled(),path==='/profile');
   await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: HTTP/Socket progressive sections, persisted expansion and tabs, matching panel geometry, split action defaults, selected prefill, keyboard controls, breakpoint scope, autosave, hidden errors, timing, reply modes, placeholders, export/import and old SDK notice.');
 }catch(error){
  await page.screenshot({path:'/tmp/sniffer-http-body-failure.png',fullPage:true});
  console.error(errors,await page.locator('body').innerText());
  throw error;
 }finally{
  await browser.close();for(const ws of wss.clients)ws.terminate();wss.close();server.close();
 }
}
