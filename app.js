'use strict';
const APP_VERSION='4';
const $=s=>document.querySelector(s), player=$('#player');
let db, catalog=null, currentChild='', selected=null, objectURL=null, selectionVersion=0, shellReady=false, busy=false, mediaRangeReady=false, playbackTimer=null, playbackRoute='range', compatibleTicket=0;
const en=player.addTextTrack('subtitles','English','en'),zh=player.addTextTrack('subtitles','中文','zh');en.mode=zh.mode='disabled';
const setStatus=(text,bad=false)=>{$('#status').textContent=text;$('#status').className='status '+(bad?'notice':'');};
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('family-cinema-local-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('media');r.result.createObjectStore('settings');};r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('请关闭其他小影院页面后重试。'));});}
function withTimeout(promise,ms,message){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(message)),ms);Promise.resolve(promise).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});}
function get(store,key){return new Promise((resolve,reject)=>{
 const tx=db.transaction(store,'readonly'),r=tx.objectStore(store).get(key);
 const timer=setTimeout(()=>{try{tx.abort();}catch{}reject(new Error('本机读取超时。请关闭小影院后重开，再选择原视频包恢复。'));},15000);
 r.onsuccess=()=>{clearTimeout(timer);resolve(r.result);};r.onerror=()=>{clearTimeout(timer);reject(r.error);};tx.onabort=()=>{clearTimeout(timer);reject(tx.error||new Error('本机读取中断'));};
});}
function put(store,key,value){return new Promise((resolve,reject)=>{
 const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);
 const timer=setTimeout(()=>{try{tx.abort();}catch{}reject(new Error('本机保存超时。请关闭其他小影院窗口后再试，原视频包不用重新下载。'));},20000);
 tx.oncomplete=()=>{clearTimeout(timer);resolve();};tx.onabort=tx.onerror=()=>{clearTimeout(timer);reject(tx.error||new Error('本机保存失败'));};
});}
function mediaSize(value){return value instanceof Blob?value.size:value instanceof ArrayBuffer?value.byteLength:-1;}
async function mediaBytes(value){
 if(value instanceof ArrayBuffer)return value;
 if(value instanceof Blob)return withTimeout(value.arrayBuffer(),20000,'旧视频数据读取超时。请在家长设置重新选择原ZIP恢复。');
 throw new Error('本机视频记录缺失，请重新选择原ZIP恢复。');
}
async function digestBytes(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');}
// Repair never reads an existing media record before replacement. Verify the ZIP bytes first,
// then store a structured-cloned ArrayBuffer, not a file-backed Blob reference.
async function saveVerifiedVideo(file,entries,v,onStage){
 onStage('读取');const part=await withTimeout(entryBlob(file,entries.get(v.archivePath),'video/mp4'),20000,'视频包读取超时，请在“文件”中确认ZIP已下载到这台iPad。');
 const bytes=await withTimeout(part.arrayBuffer(),30000,'读取视频超时，请确认原ZIP已下载到这台iPad，再重新选择。');
 if(bytes.byteLength!==v.bytes||await digestBytes(bytes)!==v.sha256)throw new Error('原ZIP内的视频校验未通过，请确认选择的是完整原包。');
 onStage('保存');await put('media',v.sha256,bytes);
 onStage('检查');const saved=await get('media',v.sha256);
 if(!(saved instanceof ArrayBuffer)||saved.byteLength!==v.bytes||await digestBytes(saved)!==v.sha256)throw new Error('本机保存检查未通过，请保留此提示，暂时不要反复导入。');
}
async function checkShell(){
 if(!window.isSecureContext || !('serviceWorker' in navigator))throw new Error('这个地址无法安装离线版。请使用家长提供的HTTPS安装地址；局域网HTTP或文件预览不能完成安装。');
 const registration=await navigator.serviceWorker.register('sw.js',{scope:'./',updateViaCache:'none'});registration.update().catch(()=>{});const reg=await navigator.serviceWorker.ready;
 if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('离线页面还未接管，请重新打开一次。')),12000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(t);resolve();},{once:true});});
 return new Promise((resolve,reject)=>{const channel=new MessageChannel();const t=setTimeout(()=>reject(new Error('离线页面检查超时，请联网重试。')),12000);channel.port1.onmessage=e=>{clearTimeout(t);mediaRangeReady=e.data.mediaRange===true;resolve(e.data.ready===true);};(navigator.serviceWorker.controller||reg.active).postMessage({type:'CHECK_SHELL'},[channel.port2]);});
}
function standalone(){return navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;}
async function checkLibrary(c){if(!c?.videos?.length)return false;for(const v of c.videos){const b=await get('media',v.sha256);if(mediaSize(b)!==v.bytes)return false;}return true;}
function readiness(){const n=catalog?.videos?.length||0;$('#badge').textContent=n?`${n} 条本地视频 · 不自动连播`:'首次使用，请导入视频包';$('#offlineStatus').textContent=n?(shellReady?' · 离线页面已就绪':' · 离线页面待检查'):'';}
function applyCaptions(){const val=$('#captions').value;en.mode=val==='en'?'showing':'disabled';zh.mode=val==='zh'?'showing':'disabled';}
$('#captions').onchange=applyCaptions;
function renderTabs(){const t=$('#tabs');t.replaceChildren();for(const child of [...new Set(catalog.videos.map(v=>v.child))]){const b=document.createElement('button');b.textContent=child+' · '+(catalog.groups?.[child]||'视频');b.className=child===currentChild?'active':'';b.setAttribute('aria-pressed',String(child===currentChild));b.onclick=()=>{currentChild=child;renderTabs();selectVideo(catalog.videos.find(v=>v.child===child),false);};t.append(b);}}
function renderCards(){const cards=$('#cards');cards.replaceChildren();for(const v of catalog.videos.filter(v=>v.child===currentChild)){const b=document.createElement('button');b.className='card'+(selected?.key===v.key?' selected':'');const thumb=document.createElement('div');thumb.className='thumb';const im=document.createElement('img');im.alt='';im.src=v.posterData;const dur=document.createElement('span');dur.className='duration';dur.textContent=v.time;thumb.append(im,dur);const text=document.createElement('div');text.className='text';for(const [tag,cls,value]of[['div','type',v.performer],['h3','',v.title],['p','',v.focus]]){const x=document.createElement(tag);x.className=cls;x.textContent=value;text.append(x);}b.append(thumb,text);b.onclick=()=>selectVideo(v,true);cards.append(b);}}
function startPlayback(){
 clearTimeout(playbackTimer);$('#playerError').textContent='';
 // Called synchronously from a tap when the selected source is already prepared.
 const attempt=player.play();
 playbackTimer=setTimeout(()=>{if(player.currentTime===0 && player.readyState<3)$('#playerError').textContent='视频读取较慢。请点“重新加载本片”；若仍失败，把下方错误信息告诉家长。';},15000);
 if(attempt)attempt.catch(e=>{clearTimeout(playbackTimer);$('#playerError').textContent=e.name==='NotAllowedError'?'视频已准备好，请再点一次播放。':`无法播放（${e.name}）。请点“重新加载本片”。`;});
}
async function prepareCompatiblePlayback(v,ticket=selectionVersion,playNow=false){
 if(compatibleTicket===ticket)return;
 compatibleTicket=ticket;playbackRoute='checking';clearTimeout(playbackTimer);
 player.pause();player.removeAttribute('src');player.load();
 $('#playerError').textContent='正在检查完整视频并准备兼容播放，请稍等……';
 try{
  const saved=await get('media',v.sha256);
  if(mediaSize(saved)!==v.bytes)throw new Error('本机视频不完整。请在家长设置重新选择原ZIP恢复，不用重新下载。');
  const bytes=await mediaBytes(saved);
  const hash=await digestBytes(bytes);
  if(ticket!==selectionVersion)return;
  if(bytes.byteLength!==v.bytes||hash!==v.sha256)throw new Error('本机视频完整性检查未通过。请在家长设置重新选择原ZIP，程序会替换损坏的本机副本；不用重新下载。');
  if(objectURL)URL.revokeObjectURL(objectURL);
  objectURL=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
  playbackRoute='memory';player.src=objectURL;player.load();
  $('#playerError').textContent='视频完整，兼容模式已准备好。请点“播放”。';
  if(playNow)startPlayback();
 }catch(e){if(ticket===selectionVersion){playbackRoute='failed';$('#playerError').textContent=e.message;}}
}
async function selectVideo(v,playNow=false){
 if(selected?.key===v.key && player.getAttribute('src') && playNow){startPlayback();return;}
 const ticket=++selectionVersion;compatibleTicket=0;playbackRoute='range';clearTimeout(playbackTimer);selected=v;player.pause();player.removeAttribute('src');player.load();if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
 $('#cinema').hidden=false;player.poster=v.posterData;$('#title').textContent=v.title;$('#performer').textContent=v.performer+' · '+v.time;$('#focus').textContent=v.focus;$('#note').textContent=v.note;$('#playerError').textContent='';
 for(const [lang,track]of[['en',en],['zh',zh]]){track.mode='hidden';if(track.cues)Array.from(track.cues).forEach(c=>track.removeCue(c));for(const c of v.tracks?.[lang]||[])track.addCue(new VTTCue(c.s,c.e,c.t));track.mode='disabled';}
 $('#captions').hidden=!Object.keys(v.tracks||{}).length;applyCaptions();renderCards();
 try{
  if(!mediaRangeReady)await withTimeout(checkShell(),15000,'播放组件检查超时，请点“兼容播放”直接读取本机视频。');
  if(ticket!==selectionVersion)return;
  if(!mediaRangeReady)throw new Error('播放组件正在更新。请联网关闭小影院，再重新打开；不用删除或重新导入视频。');
  // The service worker reads the existing IndexedDB video and serves Safari byte ranges.
  player.src=new URL(`local-media/${v.sha256}.mp4`,document.baseURI).href;player.load();
  if(playNow)startPlayback();
 }catch(e){if(ticket===selectionVersion)$('#playerError').textContent=e.message;}
}
$('#playVideo').onclick=()=>{if(player.getAttribute('src'))startPlayback();else if(selected && playbackRoute!=='checking'){$('#playerError').textContent='请点“重新加载本片”或“兼容播放”。';}};
$('#compatibleVideo').onclick=()=>{if(selected){if(playbackRoute==='memory'){startPlayback();}else prepareCompatiblePlayback(selected,selectionVersion,true);}};
$('#retryVideo').onclick=()=>{if(selected){const v=selected;selected=null;selectVideo(v,true);}};
player.addEventListener('playing',()=>{clearTimeout(playbackTimer);$('#playerError').textContent='';});
player.addEventListener('error',async()=>{
 if(!player.getAttribute('src')||playbackRoute==='checking')return;
 clearTimeout(playbackTimer);const ticket=selectionVersion,code=player.error?.code||0;
 if(playbackRoute==='range' && selected){await prepareCompatiblePlayback(selected,ticket,false);return;}
 $('#playerError').textContent=`视频完整性已通过，但兼容播放仍失败（错误 ${code}）。请把此提示告诉家长。`;
});
async function showLibrary(){currentChild=catalog.videos[0].child;renderTabs();await selectVideo(catalog.videos[0]);readiness();$('#closeSetup').hidden=false;}
$('#manage').onclick=()=>{$('#setup').hidden=false;$('#setup').scrollIntoView({behavior:'smooth'});};$('#closeSetup').onclick=()=>{$('#setup').hidden=true;};
// Read only the ZIP directory and one stored entry at a time; avoid loading the whole 300 MB archive into memory.
async function zipEntries(file){
 if(file.size<22)throw new Error('视频包不完整。');const start=Math.max(0,file.size-65557);const tail=new DataView(await file.slice(start).arrayBuffer());let e=-1;
 for(let i=tail.byteLength-22;i>=0;i--)if(tail.getUint32(i,true)===0x06054b50 && i+22+tail.getUint16(i+20,true)===tail.byteLength){e=i;break;}
 if(e<0)throw new Error('未识别到完整ZIP，请选择专用离线视频包。');
 if(tail.getUint16(e+4,true)||tail.getUint16(e+6,true))throw new Error('不支持分卷包。');
 const count=tail.getUint16(e+10,true),size=tail.getUint32(e+12,true),offset=tail.getUint32(e+16,true);
 if(count>1000||size>8*1024*1024||offset+size>file.size)throw new Error('视频包目录异常。');
 const bytes=await file.slice(offset,offset+size).arrayBuffer();const d=new DataView(bytes);const dec=new TextDecoder('utf-8',{fatal:true});const map=new Map();let p=0;
 for(let i=0;i<count;i++){
  if(p+46>d.byteLength||d.getUint32(p,true)!==0x02014b50)throw new Error('视频包目录损坏。');const flags=d.getUint16(p+8,true),method=d.getUint16(p+10,true),packed=d.getUint32(p+20,true),length=d.getUint32(p+24,true),n=d.getUint16(p+28,true),extra=d.getUint16(p+30,true),comment=d.getUint16(p+32,true),local=d.getUint32(p+42,true);
  if(p+46+n+extra+comment>d.byteLength)throw new Error('视频包目录不完整。');const name=dec.decode(new Uint8Array(bytes,p+46,n));
  if(name.startsWith('/')||name.split('/').includes('..')||map.has(name)||(flags&1)||method!==0||packed!==length)throw new Error('请使用本次提供的专用离线视频包，不要重新压缩或加密。');
  map.set(name,{name,length,local});p+=46+n+extra+comment;
 }
 return map;
}
async function entryBlob(file,entry,type='application/octet-stream'){
 if(!entry)throw new Error('视频包缺少必需文件。');const a=entry.local;if(a+30>file.size)throw new Error('视频包损坏。');const h=new DataView(await file.slice(a,a+30).arrayBuffer());if(h.getUint32(0,true)!==0x04034b50)throw new Error('视频包头损坏。');const s=a+30+h.getUint16(26,true)+h.getUint16(28,true);if(s+entry.length>file.size)throw new Error('视频未下载完整。');return file.slice(s,s+entry.length,type);
}
async function sha256(blob){const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return Array.from(new Uint8Array(bytes)).map(v=>v.toString(16).padStart(2,'0')).join('');}
function validateCatalog(c,entries){
 if(c?.format!=='family-cinema-pack-v1'||!Array.isArray(c.videos)||!c.videos.length||c.videos.length>100)throw new Error('不是本次小影院视频包。');const ids=new Set();
 for(const v of c.videos){if(typeof v.key!=='string'||ids.has(v.key)||!/^media\/[a-zA-Z0-9_-]+\.mp4$/.test(v.archivePath)||! /^[a-f0-9]{64}$/.test(v.sha256)||!Number.isSafeInteger(v.bytes)||v.bytes<=0||v.bytes>512*1024*1024||entries.get(v.archivePath)?.length!==v.bytes)throw new Error('视频包清单与文件不一致。');ids.add(v.key);for(const k of ['child','title','performer','focus','note','time'])if(typeof v[k]!=='string'||v[k].length>3000)throw new Error('视频说明异常。');if(!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v.posterData)||v.posterData.length>2e6)throw new Error('封面数据异常。');for(const cs of Object.values(v.tracks||{})){if(!Array.isArray(cs)||cs.length>10000)throw new Error('字幕异常。');for(const q of cs)if(!Number.isFinite(q.s)||!Number.isFinite(q.e)||q.s<0||q.e<=q.s||typeof q.t!=='string'||q.t.length>5000)throw new Error('字幕时间异常。');}}
}
$('#import').onclick=()=>{
 if(busy)return;
 $('#file').value='';setStatus('请选择原来的ZIP视频包。选好后这里会立即显示读取进度。');$('#file').click();
};
$('#file').oncancel=()=>{if(!busy)setStatus('尚未选择视频包。点上方按钮，选择原来的ZIP即可。');};
$('#file').onchange=async()=>{
 const file=$('#file').files?.[0];if(!file||busy)return;
 $('#file').value='';
 if(!window.isSecureContext){setStatus('请从HTTPS安装入口打开，不要在文件预览或旧局域网地址导入。',true);return;}
 busy=true;$('#import').disabled=true;$('#closeSetup').hidden=true;$('#progress').hidden=false;$('#progress').value=0;
 $('#setup').hidden=false;$('#setup').scrollIntoView({behavior:'smooth'});
 ++selectionVersion;compatibleTicket=0;clearTimeout(playbackTimer);playbackRoute='importing';player.pause();player.removeAttribute('src');player.load();
 if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
 let stage='读取视频包目录';
 setStatus(`已选中视频包（${Math.round(file.size/1024/1024)} MB），正在读取目录……`);
 try{
  if(!db)db=await withTimeout(openDB(),15000,'无法打开本机存储，请关闭其他小影院窗口后重试。');
  const entries=await withTimeout(zipEntries(file),20000,'读取ZIP目录超时，请先在“文件”中确认ZIP已完整下载到这台iPad。');
  const meta=entries.get('catalog.json');if(!meta||meta.length>16*1024*1024)throw new Error('视频包缺少有效目录，请选择原来的专用ZIP。');
  const next=JSON.parse(await withTimeout((async()=> (await entryBlob(file,meta,'application/json')).text())(),15000,'视频目录读取超时。'));
  validateCatalog(next,entries);
  for(let i=0;i<next.videos.length;i++){
   const v=next.videos[i];await saveVerifiedVideo(file,entries,v,action=>{stage=`${action} ${i+1}/${next.videos.length}：${v.title}`;setStatus(`正在${stage}\n请保持小影院在前台，不要锁屏。`);});
   $('#progress').value=Math.round((i+1)/next.videos.length*100);
  }
  stage='保存选片目录';await put('settings','catalog',next);catalog=next;
  // Permission/persistence requests must never delay file selection or repair.
  try{navigator.storage?.persist?.().catch(()=>{});}catch{}
  stage='检查离线页面';setStatus('视频已完整保存，正在检查离线页面……');
  let shellNote='';try{shellReady=await withTimeout(checkShell(),15000,'离线页面检查超时');}catch(e){shellReady=false;shellNote=e.message;}
  await showLibrary();
  setStatus(shellReady?`离线准备完成：${catalog.videos.length}/${catalog.videos.length}条视频已重新保存并通过完整检查。点“收起设置，开始选片”试播。`:`${catalog.videos.length}条视频已完整保存。离线页面尚未确认：${shellNote}。请联网关闭后重新打开，不用再次导入。`,!shellReady);
  $('#offlineStatus').textContent=shellReady?' · 离线准备完成':' · 视频已保存';$('#closeSetup').hidden=false;
 }catch(e){setStatus(`停在：${stage}\n${e.name==='QuotaExceededError'?'iPad网页存储空间不足，请释放空间后再恢复。':e.message}\n原ZIP和已保存视频保留。`,true);if(catalog)$('#closeSetup').hidden=false;}
 finally{busy=false;$('#import').disabled=false;}
};
(async()=>{
 try{db=await openDB();const stored=await get('settings','catalog');if(await checkLibrary(stored)){catalog=stored;await showLibrary();$('#setup').hidden=true;}else setStatus('请从主屏幕打开后，导入家长准备的视频包。');}
 catch(e){setStatus('无法打开本机存储：'+e.message,true);$('#import').disabled=true;}
 try{shellReady=await checkShell();if(!shellReady)throw new Error('离线页面不完整');if(!catalog)setStatus('离线页面已就绪。请先添加到主屏幕，再从图标打开并导入视频包。');}
 catch(e){setStatus(e.message,true);if(catalog){$('#setup').hidden=false;$('#closeSetup').hidden=false;}}
 readiness();
})();
navigator.serviceWorker?.addEventListener('controllerchange',()=>{if(!busy && player.paused)location.reload();});
