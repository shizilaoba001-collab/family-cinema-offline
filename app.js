'use strict';
const APP_VERSION='3';
const $=s=>document.querySelector(s), player=$('#player');
let db, catalog=null, currentChild='', selected=null, objectURL=null, selectionVersion=0, shellReady=false, busy=false, mediaRangeReady=false, playbackTimer=null, playbackRoute='range', compatibleTicket=0;
const en=player.addTextTrack('subtitles','English','en'),zh=player.addTextTrack('subtitles','中文','zh');en.mode=zh.mode='disabled';
const setStatus=(text,bad=false)=>{$('#status').textContent=text;$('#status').className='status '+(bad?'notice':'');};
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('family-cinema-local-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('media');r.result.createObjectStore('settings');};r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('请关闭其他小影院页面后重试。'));});}
function get(store,key){return new Promise((resolve,reject)=>{const r=db.transaction(store,'readonly').objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function put(store,key,value){return new Promise((resolve,reject)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value,key);t.oncomplete=()=>resolve();t.onabort=t.onerror=()=>reject(t.error||new Error('本机保存失败'));});}
async function checkShell(){
 if(!window.isSecureContext || !('serviceWorker' in navigator))throw new Error('这个地址无法安装离线版。请使用家长提供的HTTPS安装地址；局域网HTTP或文件预览不能完成安装。');
 const registration=await navigator.serviceWorker.register('sw.js',{scope:'./',updateViaCache:'none'});registration.update().catch(()=>{});const reg=await navigator.serviceWorker.ready;
 if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('离线页面还未接管，请重新打开一次。')),12000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(t);resolve();},{once:true});});
 return new Promise((resolve,reject)=>{const channel=new MessageChannel();const t=setTimeout(()=>reject(new Error('离线页面检查超时，请联网重试。')),12000);channel.port1.onmessage=e=>{clearTimeout(t);mediaRangeReady=e.data.mediaRange===true;resolve(e.data.ready===true);};(navigator.serviceWorker.controller||reg.active).postMessage({type:'CHECK_SHELL'},[channel.port2]);});
}
function standalone(){return navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;}
async function checkLibrary(c){if(!c?.videos?.length)return false;for(const v of c.videos){const b=await get('media',v.sha256);if(!(b instanceof Blob)||b.size!==v.bytes)return false;}return true;}
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
  if(!(saved instanceof Blob)||saved.size!==v.bytes)throw new Error('本机视频不完整。请在家长设置重新选择原ZIP恢复，不用重新下载。');
  const bytes=await saved.arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
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
  if(!mediaRangeReady)await checkShell();
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
$('#import').onclick=()=>{if(!busy)$('#file').click();};
$('#file').onchange=async()=>{
 const file=$('#file').files?.[0];if(!file||busy)return;
 if(!window.isSecureContext){setStatus('请从HTTPS安装入口打开，不要在文件预览或旧局域网地址导入。',true);return;}
 busy=true;$('#import').disabled=true;$('#closeSetup').hidden=true;$('#progress').hidden=false;$('#progress').value=0;
 let persistent=false;try{if(navigator.storage?.persist)persistent=await navigator.storage.persist();}catch{}
 try{
  shellReady=await checkShell();if(!shellReady)throw new Error('离线页面没有保存完整，请联网重试。');
  setStatus('正在读取视频包……');const entries=await zipEntries(file);const meta=entries.get('catalog.json');if(!meta||meta.length>16*1024*1024)throw new Error('视频包缺少有效目录。');const next=JSON.parse(await(await entryBlob(file,meta,'application/json')).text());validateCatalog(next,entries);
  const estimate=await navigator.storage?.estimate?.();let needed=0;for(const v of next.videos){const old=await get('media',v.sha256);if(!(old instanceof Blob)||old.size!==v.bytes)needed+=v.bytes;}
  if(estimate?.quota && estimate?.usage && estimate.quota-estimate.usage<needed+10*1024*1024)throw new Error('iPad可用网页存储不足，请清理空间后再导入。');
  for(let i=0;i<next.videos.length;i++){
   const v=next.videos[i];setStatus(`正在保存 ${i+1}/${next.videos.length}：${v.title}\n请保持小影院在前台，暂时不要锁屏。`);let blob=await get('media',v.sha256);
   if(!(blob instanceof Blob)||blob.size!==v.bytes||await sha256(blob)!==v.sha256){blob=await entryBlob(file,entries.get(v.archivePath),'video/mp4');if(await sha256(blob)!==v.sha256)throw new Error(`“${v.title}”不完整，请重新传入视频包。`);blob=new Blob([await blob.arrayBuffer()],{type:'video/mp4'});await put('media',v.sha256,blob);const saved=await get('media',v.sha256);if(!(saved instanceof Blob)||saved.size!==v.bytes||await sha256(saved)!==v.sha256)throw new Error('写入后的完整性检查未通过，请重新选择原视频包。');}
   $('#progress').value=Math.round((i+1)/next.videos.length*100);
  }
  if(!await checkLibrary(next))throw new Error('视频未全部保存完成。');await put('settings','catalog',next);catalog=next;await showLibrary();
  const installHint=standalone()?'现在可以开启飞行模式，关闭再打开本App试播；成功后Mac即可关机。':'请先添加到主屏幕，再从“小影院”图标打开。若主屏幕App显示未导入，请在那里再导入同一个包。';
  setStatus(`离线准备完成：${catalog.videos.length}/${catalog.videos.length}条视频已保存在本机。\n${installHint}`);$('#offlineStatus').textContent=' · 离线准备完成';await put('settings','storagePersistence',persistent);$('#closeSetup').hidden=false;
 }catch(e){setStatus(e.name==='QuotaExceededError'?'iPad存储空间不足，已保存部分可以保留；清理空间后重新选择同一个包继续。':`未完成：${e.message}\n已保存的视频可复用，重新选择同一个视频包即可继续。`,true);}
 finally{busy=false;$('#import').disabled=false;$('#file').value='';}
};
(async()=>{
 try{db=await openDB();const stored=await get('settings','catalog');if(await checkLibrary(stored)){catalog=stored;await showLibrary();$('#setup').hidden=true;}else setStatus('请从主屏幕打开后，导入家长准备的视频包。');}
 catch(e){setStatus('无法打开本机存储：'+e.message,true);$('#import').disabled=true;}
 try{shellReady=await checkShell();if(!shellReady)throw new Error('离线页面不完整');if(!catalog)setStatus('离线页面已就绪。请先添加到主屏幕，再从图标打开并导入视频包。');}
 catch(e){setStatus(e.message,true);if(catalog){$('#setup').hidden=false;$('#closeSetup').hidden=false;}}
 readiness();
})();
navigator.serviceWorker?.addEventListener('controllerchange',()=>{if(!busy && player.paused)location.reload();});
