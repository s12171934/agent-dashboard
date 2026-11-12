// Browser/native interop only. All page views, decisions and UI state are implemented in Rust.
const transport = () => window.adashTransport;
export async function apiCall(name, args) {
  const method = transport()?.[name];
  if (typeof method !== 'function') throw new Error(`서버 연결 기능을 불러오지 못했습니다 (${name})`);
  const result = await method(...args);
  return result === undefined ? null : result;
}
export function storageGet(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
export function storageSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
export function go(hash) { location.hash = hash; }
export function timestamp(s) { if (!s) return ''; const d = new Date(s); return Number.isNaN(+d) ? s : new Intl.DateTimeFormat('ko-KR', {dateStyle:'short', timeStyle:'medium'}).format(d); }
export function connect(callback) {
  let alive = true;
  const tick = kind => { if (alive) callback(kind); };
  transport().events({ version: () => tick('state'), change: () => tick('state'), projects: () => tick('projects') });
  const hash = () => tick('route'), visible = () => { if (!document.hidden) tick('resume'); };
  addEventListener('hashchange', hash); document.addEventListener('visibilitychange', visible);
  const motion=setInterval(()=>{if(!document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches)tick('motion');},100);
  const timer = setInterval(() => { if (!document.hidden) tick('state'); }, 15000);
  return () => { alive=false; clearInterval(timer); clearInterval(motion); removeEventListener('hashchange', hash); document.removeEventListener('visibilitychange', visible); };
}
export function nativeResume(callback) {
  const previous = window.adashNative;
  window.adashNative = { ...previous, resume() { transport().resume(); callback('resume'); } };
  return () => { window.adashNative = previous; };
}
export function localFrame(url) { try { const u = new URL(url); const p=window.adashVscodePort; return p && ['127.0.0.1','localhost'].includes(u.hostname) && +u.port===+p ? location.origin+u.pathname+u.search+u.hash : url; } catch { return url; } }
export function videoBridge(video) {
  const post = window.webkit?.messageHandlers?.adash;
  const old = window.adashPip;
  window.adashPip = (what,t,playing) => { if(what==='start')video.pause(); else {if(Number.isFinite(t))video.currentTime=t;if(playing)video.play().catch(()=>{});} };
  let sent=0;
  const tell=()=>{sent=Date.now();const r=video.getBoundingClientRect();post?.postMessage({pip:{src:video.isConnected?video.currentSrc:'',t:video.currentTime,playing:video.isConnected&&!video.paused&&!video.ended,rate:video.playbackRate,rect:[r.x,r.y,r.width,r.height]}});};
  const time=()=>{if(Date.now()-sent>1000)tell();};
  const resize=new ResizeObserver(tell);resize.observe(video);
  const events=['loadedmetadata','play','pause','seeked','ratechange','ended'];events.forEach(ev=>video.addEventListener(ev,tell));video.addEventListener('timeupdate',time);
  return()=>{resize.disconnect();events.forEach(ev=>video.removeEventListener(ev,tell));video.removeEventListener('timeupdate',time);post?.postMessage({pip:{src:'',t:0,playing:false,rate:1,rect:[0,0,0,0]}});window.adashPip=old;};
}
export async function readFile(input) {
  const file=input.files?.[0];if(!file)return null;if(file.size>10*1024*1024)throw new Error('이미지는 10MB까지 올릴 수 있습니다');
  const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
  return {name:file.name,data:String(data).split(',')[1],mime:file.type};
}
export async function loadRoster(){
  const base=await fetch(new URL('chars/catalog.json',document.baseURI)).then(r=>r.json());
  try { const r=await fetch(new URL('chars/chars.json',document.baseURI),{cache:'no-cache'});if(r.ok){const roster=await r.json();for(const [who,c]of Object.entries(roster.chars||{}))if(/^[a-zA-Z0-9_-]+$/.test(who))base.chars[who]={...c,remote:true};for(const [who,c]of Object.entries(roster.meta||{}))if(base.chars[who])Object.assign(base.chars[who],c);for(const who of roster.hidden||[])delete base.chars[who];} }catch{}
  return base;
}
export function icons(){return (window.APP_ICONS||[]).map(x=>({...x,src:window.appIconSrc(x.id)}));}
export function setIcon(id){window.setAppIcon?.(id);}
export function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

export function scrollId(id){requestAnimationFrame(()=>document.getElementById(id)?.scrollIntoView({block:'start'}));}

export function observeVisible(element,callback){const observer=new IntersectionObserver(entries=>callback(entries[0]?.isIntersecting||false));observer.observe(element);return()=>observer.disconnect();}
