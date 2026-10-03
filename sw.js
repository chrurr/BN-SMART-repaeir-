const CACHE="bn-smart-shell-v24";
const SHELL=["/","/index.html","/track.html","/share.html","/logo.png","/manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{
  const req=event.request;
  if(req.method!=="GET" || new URL(req.url).origin!==self.location.origin) return;
  if(req.url.includes("/api/")) return;
  event.respondWith((async()=>{
    try{
      const fresh=await fetch(req,{cache:"no-store"});
      const copy=fresh.clone();
      if(fresh.ok) caches.open(CACHE).then(c=>c.put(req,copy));
      return fresh;
    }catch(e){
      return (await caches.match(req)) || (req.mode==="navigate" ? caches.match("/index.html") : Response.error());
    }
  })());
});
