const CACHE='suspension-lab-1.2.0';
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const response=await fetch('/asset-manifest.json',{cache:'no-store'});if(!response.ok)throw new Error('Asset manifest unavailable');
 const assets=await response.json();const cache=await caches.open(CACHE);await cache.addAll(['/', '/manifest.webmanifest','/app-icon.svg','/app-icon-192.png','/app-icon-512.png','/THREE-LICENSE.txt',...assets]);await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('suspension-lab-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
 if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).then(async response=>{if(response.ok)(await caches.open(CACHE)).put('/',response.clone());return response;}).catch(()=>caches.match('/')));return;}
 event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(async response=>{if(response.ok&&url.pathname.startsWith('/assets/'))(await caches.open(CACHE)).put(event.request,response.clone());return response;})));
});
