// Run after npm run test:server and npm --prefix server/ui run build.
// Pass --preview to serve the same in-memory example on port 5200.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from '../server/daemon/node_modules/playwright-core/index.mjs';
import {WebSocketServer} from '../server/daemon/node_modules/ws/wrapper.mjs';
import {serveStatic} from '../server/daemon/build/test/static.js';
const preview=process.argv.includes('--preview');
const device={deviceId:'body-test',deviceName:'Body mock preview iPhone',platform:'ios',appId:'body.test',sdkVersion:'dev',connected:true,capabilities:['http','http-query-mocks','http-body-mocks']};
const body={session_id:'69afe89417d1f6d5d539704d',limit:20};
const response={items:[{id:'message-1',text:'Hello'}],next_cursor:null};
let mocks={http:[],socket:[]};
const entries=[
 {deviceId:device.deviceId,message:{type:'http-request',id:'post-1',method:'POST',url:'https://preview.example/messages?locale=zh-TW',headers:{'content-type':'application/json'},body:JSON.stringify(body),bodySize:55,bodyTruncated:false,library:'urlsession',timestamp:Date.now()}},
 {deviceId:device.deviceId,message:{type:'http-response',id:'post-1',status:200,headers:{'content-type':'application/json'},body:JSON.stringify(response),bodySize:60,bodyTruncated:false,durationMs:12,mocked:false,timestamp:Date.now()+12}},
];
const wss=new WebSocketServer({noServer:true});
const server=createServer(async(req,res)=>{
 if(req.url==='/api/mocks'&&req.method==='PUT'){
  let text='';for await(const chunk of req)text+=chunk;
  const saved=JSON.parse(text);mocks={http:saved.http,socket:saved.socket};
  for(const ws of wss.clients)ws.send(JSON.stringify({type:'mocks-changed',deviceId:device.deviceId,mocks}));
  res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;
 }
 await serveStatic(res,new URL(req.url,'http://localhost').pathname,{uiDist:fileURLToPath(new URL('../server/ui/dist',import.meta.url))});
});
server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws)));
wss.on('connection',ws=>ws.send(JSON.stringify({type:'init',devices:[device],entries,mocksByDevice:{[device.deviceId]:mocks},breakpointsByDevice:{},pausedHits:[]})));
await new Promise(resolve=>server.listen(preview?5200:0,'127.0.0.1',resolve));
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
  const condition=page.getByRole('textbox',{name:'Body conditions',exact:true});
  await condition.waitFor();
  assert.deepEqual(JSON.parse(await condition.inputValue()),body);
  assert.equal(await page.getByRole('tab',{name:/Body conditions/}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:/Body conditions/}).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByLabel('parameter name 1').inputValue(),'locale');
  assert.equal(await page.getByLabel('parameter value 1').inputValue(),'zh-TW');
  await page.getByRole('tab',{name:/Body conditions/}).click();
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
  assert.deepEqual(errors,[]);
  console.log('PASS: request prefill, condition tabs, autosave, validation, formatting, export/import and old SDK notice.');
 }catch(error){
  await page.screenshot({path:'/tmp/sniffer-http-body-failure.png',fullPage:true});
  console.error(errors,await page.locator('body').innerText());
  throw error;
 }finally{
  await browser.close();for(const ws of wss.clients)ws.terminate();wss.close();server.close();
 }
}
