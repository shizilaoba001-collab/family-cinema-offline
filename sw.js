'use strict';
const VERSION='family-cinema-shell-v1';
const FILES=['./','index.html','style.css','app.js','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png'];
const URLS=FILES.map(p=>new URL(p,self.registration.scope).href);
self.addEventListener('install',event=>event.waitUntil((async()=>{const c=await caches.open(VERSION);await c.addAll(URLS);await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{if(event.data?.type==='CHECK_SHELL')event.waitUntil((async()=>{const c=await caches.open(VERSION);const checks=await Promise.all(URLS.map(u=>c.match(u)));event.ports[0]?.postMessage({ready:checks.every(Boolean),version:VERSION});})());});
self.addEventListener('fetch',event=>{
 if(event.request.method!=='GET')return;
 const u=new URL(event.request.url);if(u.origin!==self.location.origin)return;
 const scope=self.registration.scope;
 if(event.request.mode==='navigate' && u.href.startsWith(scope)){
  event.respondWith((async()=>{const c=await caches.open(VERSION);return await c.match(new URL('./',scope).href)||await fetch(event.request);})());return;
 }
 if(URLS.includes(u.href))event.respondWith((async()=>{const c=await caches.open(VERSION);return await c.match(event.request)||await fetch(event.request);})());
});
