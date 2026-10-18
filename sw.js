'use strict';
const VERSION='family-cinema-shell-v5';
const FILES=['./','index.html','style.css','app.js','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png'];
const URLS=FILES.map(p=>new URL(p,self.registration.scope).href);
self.addEventListener('install',event=>event.waitUntil((async()=>{const c=await caches.open(VERSION);await c.addAll(URLS.map(u=>new Request(u,{cache:'reload'})));await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{await self.clients.claim();for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:'SHELL_UPDATED',version:VERSION});})()));
self.addEventListener('message',event=>{if(event.data?.type==='CHECK_SHELL')event.waitUntil((async()=>{const c=await caches.open(VERSION);const checks=await Promise.all(URLS.map(u=>c.match(u)));event.ports[0]?.postMessage({ready:checks.every(Boolean),version:VERSION,mediaRange:true});})());});
function readMedia(key){return new Promise((resolve,reject)=>{
 const r=indexedDB.open('family-cinema-local-v1',1);
 r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('media'))db.createObjectStore('media');if(!db.objectStoreNames.contains('settings'))db.createObjectStore('settings');};
 r.onerror=()=>reject(r.error);
 r.onsuccess=()=>{const db=r.result;const tx=db.transaction('media','readonly');const q=tx.objectStore('media').get(key);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=tx.onabort=()=>db.close();};
});}
async function mediaResponse(request,key){
 try{
  const stored=await readMedia(key);
  const blob=stored instanceof ArrayBuffer?new Blob([stored],{type:'video/mp4'}):stored;
  if(!(blob instanceof Blob)||blob.size===0)return new Response('Local video is missing',{status:404});
  const total=blob.size,headers={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'no-store','Content-Length':String(total)};
  if(request.method==='HEAD')return new Response(null,{status:200,headers});
  const range=request.headers.get('Range');
  if(!range)return new Response(blob,{status:200,headers});
  const m=/^bytes=(\d*)-(\d*)$/.exec(range);
  const invalid=()=>new Response(null,{status:416,headers:{'Content-Range':`bytes */${total}`,'Accept-Ranges':'bytes'}});
  if(!m||(!m[1]&&!m[2]))return invalid();
  let start,end;
  if(!m[1]){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return invalid();start=Math.max(0,total-suffix);end=total-1;}
  else{start=Number(m[1]);end=m[2]?Number(m[2]):total-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=total||end<start)return invalid();end=Math.min(end,total-1);}
  headers['Content-Length']=String(end-start+1);headers['Content-Range']=`bytes ${start}-${end}/${total}`;
  // Materialize only this requested range, avoiding a file-backed Blob URL in the media process.
  return new Response(await blob.slice(start,end+1).arrayBuffer(),{status:206,headers});
 }catch{return new Response('Local video could not be read',{status:500});}
}
self.addEventListener('fetch',event=>{
 if(!['GET','HEAD'].includes(event.request.method))return;
 const u=new URL(event.request.url);if(u.origin!==self.location.origin)return;
 const scope=self.registration.scope,mediaBase=new URL('local-media/',scope).pathname;
 if(u.pathname.startsWith(mediaBase)){
  const m=/^([a-f0-9]{64})\.mp4$/.exec(u.pathname.slice(mediaBase.length));
  event.respondWith(m?mediaResponse(event.request,m[1]):Promise.resolve(new Response('Not found',{status:404})));return;
 }
 if(event.request.method!=='GET')return;
 if(event.request.mode==='navigate' && u.href.startsWith(scope)){
  event.respondWith((async()=>{const c=await caches.open(VERSION);return await c.match(new URL('./',scope).href)||await fetch(event.request);})());return;
 }
 if(URLS.includes(u.href))event.respondWith((async()=>{const c=await caches.open(VERSION);return await c.match(event.request)||await fetch(event.request);})());
});
