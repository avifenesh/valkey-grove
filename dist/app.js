import { hashSlot, ownerOf } from './slots.js';

const $ = id => document.getElementById(id);
const palette = ['#d4eaa2','#80d0b8','#8dbbc9','#bda9d8','#dfa894','#e1cc91'];
const lightPalette = ['#67833a','#308573','#4d8497','#8a72a6','#b3745f','#a4904f'];
const fmt = number => number.toLocaleString('en-US');
const canvas = $('grove'), ctx = canvas.getContext('2d');
const layer = document.createElement('canvas'), ink = layer.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let data = null, selected = -1, focus = null, paths = [], dots = [], geometry = [], branchGroups = [];
let width = 0, height = 0, dpr = 1, zoom = 1, pan = {x:0,y:0}, spread = Math.PI/6, depth = 9;
let motion = !reducedMotion, dark = true, dirty = true, live = true, loading = false, time = 0, lastFrame = 0, toastTimer;
let drag = null, moved = false, generation = 0;
try { dark = localStorage.getItem('grove-theme') !== 'light'; } catch {}
function setTheme() { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('theme').setAttribute('aria-label',`Switch to ${dark?'light':'dark'} theme`); dirty=true; }
setTheme();
$('motion').setAttribute('aria-pressed',String(motion));
function color(i) { return (dark?palette:lightPalette)[i%palette.length]; }
function toast(message) { $('toast').textContent=message; $('toast').classList.add('visible'); clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3500); }
function el(tag, text, className) {const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function viewScale() {return Math.min((width-62)/800,(height-144)/780)*zoom;}
function point(x,y) {const scale=viewScale();return {x:width*.5+(x+pan.x)*scale,y:(height-120)*.48+35+(y+pan.y)*scale};}
function curveControl(a,b,node,level) {
 const bend=Math.sin(node*1.7+level*.9)*.14;
 return {x:(a.x+b.x)/2-(b.y-a.y)*bend,y:(a.y+b.y)/2+(b.x-a.x)*bend};
}
function curvePoint(a,b,c,t) {const u=1-t;return {x:u*u*a.x+2*u*t*c.x+t*t*b.x,y:u*u*a.y+2*u*t*c.y+t*t*b.y};}
function strokeBranch(context,a,b,node,level) {
 const control=curveControl(a,b,node,level),p=point(a.x,a.y),q=point(b.x,b.y),c=point(control.x,control.y);
 context.moveTo(p.x,p.y);context.quadraticCurveTo(c.x,c.y,q.x,q.y);
}
function keyLabel(key) {return key.encoding==='base64'?`[binary] ${key.name}`:key.name;}
function branchFor(nodeIndex, fraction) {
 const angle=(nodeIndex/(data.nodes.length))*Math.PI*2-Math.PI/2;
 let x=Math.cos(angle)*26,y=Math.sin(angle)*26,a=angle,len=108;
 const line=[{x:0,y:0},{x,y}];
 for(let level=0;level<=depth;level++) {
  x+=Math.cos(a)*len;y+=Math.sin(a)*len;line.push({x,y});
  const side=fraction>=.5?1:-1;fraction=(fraction*2)%1;a+=side*spread;len*=.71;
 }
 return line;
}
function fractionFor(slot,node) {
 const total=node.slots.reduce((n,[a,b])=>n+b-a+1,0);let offset=0;
 for(const [a,b] of node.slots){if(slot>=a&&slot<=b)return (offset+slot-a+.5)/total;offset+=b-a+1;}
 return slot/16384;
}
function rebuild() {
 if(!data)return;
 paths=[];geometry=[];branchGroups=data.nodes.map(()=>Array.from({length:depth+2},()=>[]));
 function addBranch(branch){geometry.push(branch);branchGroups[branch.node][branch.level+1].push(branch);}
 data.nodes.forEach((node,i)=>{
  const angle=i/data.nodes.length*Math.PI*2-Math.PI/2;
  const start={x:Math.cos(angle)*26,y:Math.sin(angle)*26};
  addBranch({a:{x:0,y:0},b:start,level:-1,node:i});
  function grow(x,y,a,len,level) {
   const nx=x+Math.cos(a)*len,ny=y+Math.sin(a)*len;
   addBranch({a:{x,y},b:{x:nx,y:ny},level,node:i});
   if(level<depth){grow(nx,ny,a-spread,len*.71,level+1);grow(nx,ny,a+spread,len*.71,level+1);}
  }
  grow(start.x,start.y,angle,108,0);
  for(let j=0;j<12;j++)paths.push({node:i,line:branchFor(i,(j+.5)/12),offset:j/12});
 });
 dots=data.keys.map(key=>{
  const slot=key.slot??hashSlot(key.name),node=data.nodes[key.node];
  const line=branchFor(key.node,fractionFor(slot,node));const end=line.at(-1);
  // A stable name-derived offset separates keys in the same hash slot.
  let h=2166136261;for(const ch of key.name){h=Math.imul(h^ch.codePointAt(0),16777619)>>>0;}
  const a=(h%6283)/1000,r=Math.sqrt((h>>>8)%1000)/31.6*5.2;
  return {x:end.x+Math.cos(a)*r,y:end.y+Math.sin(a)*r,node:key.node,slot,name:keyLabel(key),key};
 });
 dirty=true;
}
function renderBase() {
 ink.setTransform(dpr,0,0,dpr,0,0);ink.clearRect(0,0,width,height);
 if(!data)return;
 const scale=viewScale(),center=point(0,0);
 // A broad, cached wash gives each real primary its own atmosphere.
 data.nodes.forEach((node,i)=>{
  if(selected!==-1&&selected!==i)return;
  const angle=i/data.nodes.length*Math.PI*2-Math.PI/2;
  const p=point(Math.cos(angle)*220,Math.sin(angle)*220),r=220*scale;
  const wash=ink.createRadialGradient(p.x,p.y,0,p.x,p.y,r);
  wash.addColorStop(0,color(i)+(dark?'10':'0c'));wash.addColorStop(1,color(i)+'00');
  ink.fillStyle=wash;ink.fillRect(p.x-r,p.y-r,r*2,r*2);
 });
 for(let i=0;i<170;i++){const x=((i*7919)%997)/997*width,y=((i*3571)%991)/991*height;ink.fillStyle=dark?'#d9e9c31a':'#45603b14';ink.beginPath();ink.arc(x,y,i%11===0?1:.45,0,Math.PI*2);ink.fill();}
 for(const r of [92,220,388]){ink.beginPath();ink.arc(center.x,center.y,r*scale,0,Math.PI*2);ink.strokeStyle=dark?'#c4dfae0c':'#42652a12';ink.lineWidth=.55;ink.setLineDash(r===388?[]:[1,7]);ink.stroke();}ink.setLineDash([]);
 // Group by node and depth so glow is a handful of strokes, not thousands of filters.
 for(let node=0;node<data.nodes.length;node++){
  const faded=selected!==-1&&selected!==node;
  for(let level=-1;level<=depth;level++){
   ink.beginPath();for(const branch of branchGroups[node][level+1])strokeBranch(ink,branch.a,branch.b,node,level);
   ink.globalAlpha=faded?.045:Math.max(.25,.67-level*.037);ink.strokeStyle=color(node);ink.lineWidth=Math.max(.42,(1.65-level*.14)*scale);
   ink.shadowBlur=dark&&!faded&&level<4?4:0;ink.shadowColor=color(node);ink.stroke();
  }
 }
 ink.shadowBlur=0;ink.globalAlpha=1;
 for(const dot of dots){const p=point(dot.x,dot.y);ink.globalAlpha=selected!==-1&&selected!==dot.node?.065:(dark?.85:.8);ink.fillStyle=color(dot.node);ink.beginPath();ink.arc(p.x,p.y,Math.max(.62,.94*scale),0,Math.PI*2);ink.fill();}
 ink.globalAlpha=1;
 data.nodes.forEach((node,i)=>{
  const a=i/data.nodes.length*Math.PI*2-Math.PI/2,p=point(Math.cos(a)*398,Math.sin(a)*398);
  ink.globalAlpha=selected!==-1&&selected!==i?.16:1;
  ink.fillStyle=dark?'#132219e8':'#e9eee3ed';ink.beginPath();ink.roundRect(p.x-31,p.y-11,62,23,11);ink.fill();
  ink.strokeStyle=dark?color(i)+'38':color(i)+'35';ink.lineWidth=.6;ink.stroke();
  ink.font='8px "DM Sans", sans-serif';ink.textAlign='center';ink.fillStyle=color(i);ink.fillText(`NODE ${String(i+1).padStart(2,'0')}`,p.x,p.y+3);
 });
 ink.globalAlpha=1;
 const halo=ink.createRadialGradient(center.x,center.y,0,center.x,center.y,46*scale);halo.addColorStop(0,dark?'#d4ecac30':'#54753e22');halo.addColorStop(1,'#00000000');ink.fillStyle=halo;ink.fillRect(center.x-46*scale,center.y-46*scale,92*scale,92*scale);
 ink.beginPath();ink.arc(center.x,center.y,11*scale,0,Math.PI*2);ink.strokeStyle=dark?'#d4ecac70':'#49662d70';ink.lineWidth=.6;ink.stroke();
 ink.beginPath();ink.arc(center.x,center.y,4*scale,0,Math.PI*2);ink.fillStyle=dark?'#e1f2bf':'#49662d';ink.fill();
 if(focus){
  const line=branchFor(focus.node,fractionFor(focus.slot,data.nodes[focus.node]));ink.strokeStyle=dark?'#f1f8e3':'#233820';ink.lineWidth=1.6;ink.shadowBlur=10;ink.shadowColor=color(focus.node);ink.beginPath();
  for(let i=0;i<line.length-1;i++)strokeBranch(ink,line[i],line[i+1],focus.node,i-1);
  ink.stroke();ink.shadowBlur=0;const p=point(line.at(-1).x,line.at(-1).y);ink.beginPath();ink.arc(p.x,p.y,7,0,Math.PI*2);ink.stroke();
 }
 ink.globalAlpha=1;
}
function frame(now) {
 requestAnimationFrame(frame);
 if(document.hidden||(!motion&&!dirty))return;
 if(now-lastFrame<32&&!dirty)return;
 const elapsed=lastFrame?Math.min(now-lastFrame,100):0;lastFrame=now;if(motion)time+=elapsed;
 if(dirty){renderBase();dirty=false;}
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.drawImage(layer,0,0,width,height);
 if(!motion||!data)return;
 for(const path of paths){if(selected!==-1&&selected!==path.node)continue;const t=((time/8500+path.offset)%1)*(path.line.length-1),i=Math.floor(t),f=t-i;const a=path.line[i],b=path.line[i+1];if(!b)continue;const q=curvePoint(a,b,curveControl(a,b,path.node,i-1),f),p=point(q.x,q.y);ctx.globalAlpha=Math.sin((t/(path.line.length-1))*Math.PI)*.9;ctx.fillStyle=color(path.node);ctx.shadowColor=color(path.node);ctx.shadowBlur=7;ctx.beginPath();ctx.arc(p.x,p.y,1.5,0,Math.PI*2);ctx.fill();}ctx.shadowBlur=0;ctx.globalAlpha=1;
}
new ResizeObserver(()=>{const rect=canvas.getBoundingClientRect();width=rect.width;height=rect.height;dpr=Math.min(devicePixelRatio||1,2);canvas.width=layer.width=Math.round(width*dpr);canvas.height=layer.height=Math.round(height*dpr);dirty=true;}).observe(canvas);
requestAnimationFrame(frame);

function validateSnapshot(s) {
 if(!s||!Array.isArray(s.nodes)||!s.nodes.length||s.nodes.length>16384||!Array.isArray(s.keys))throw Error('This is not a Grove snapshot.');
 // A 20-million-segment budget keeps imported snapshots within the same canvas workload as the local sample.
 if(s.nodes.length*2**(depth+1)+s.keys.length>20000000)throw Error('This snapshot is too large to render at this depth.');
 for(const node of s.nodes)if(typeof node.id!=='string'||typeof node.address!=='string'||!Number.isSafeInteger(node.keys)||node.keys<0||!Array.isArray(node.slots)||!node.slots.length||node.slots.some(r=>!Array.isArray(r)||r.length!==2||!r.every(Number.isInteger)||r[0]<0||r[1]>16383||r[0]>r[1]))throw Error('Snapshot node data is invalid.');
 for(const key of s.keys)if(typeof key.name!=='string'||!Number.isInteger(key.node)||key.node<0||key.node>=s.nodes.length||(key.slot!==undefined&&(!Number.isInteger(key.slot)||key.slot<0||key.slot>16383))||(key.encoding!==undefined&&(key.encoding!=='base64'||key.slot===undefined)))throw Error('Snapshot key data is invalid.');
 if(!s.capturedAt||!Number.isFinite(Date.parse(s.capturedAt)))throw Error('Snapshot timestamp is invalid.');
 return s;
}
function updateData(s) {
 const selectedID=data?.nodes[selected]?.id, previousFocus=focus;
 data=validateSnapshot(s);selected=selectedID?data.nodes.findIndex(n=>n.id===selectedID):-1;focus=null;
 $('empty-state').hidden=true;
 $('total-keys').textContent=fmt(data.nodes.reduce((n,node)=>n+node.keys,0));
 const slots=new Set();for(const node of data.nodes)for(const[a,b]of node.slots)for(let j=a;j<=b;j++)slots.add(j);
 $('total-slots').textContent=fmt(slots.size);$('node-count').textContent=String(data.nodes.length).padStart(2,'0');
 $('cluster-description').textContent=`${data.nodes.length} primaries · ${data.nodes.reduce((n,node)=>n+(node.replicas||0),0)} replicas`;
 const largestNode=data.nodes.reduce((max,node)=>Math.max(max,node.keys),1);
 $('nodes').replaceChildren(...data.nodes.map((node,i)=>{const button=el('button',undefined,`node${selected===i?' selected':''}`);button.dataset.node=i;button.setAttribute('aria-pressed',String(selected===i));button.setAttribute('aria-label',`Node ${i+1}, ${fmt(node.keys)} keys${node.error?', unavailable':''}`);const dot=el('span',undefined,'dot');dot.style.color=palette[i%palette.length];dot.style.background='currentColor';const range=el('span',node.slots.map(([a,b])=>`${fmt(a)}–${fmt(b)}`).join(', '),'node-range');const share=el('span',undefined,'node-share'),bar=el('span');bar.style.width=`${node.keys/largestNode*100}%`;bar.style.color=palette[i%palette.length];share.append(bar);button.append(dot,el('span',`Node ${String(i+1).padStart(2,'0')}`,'node-name'),el('span',node.error?'offline':fmt(node.keys),'node-count'),range,share);button.addEventListener('click',()=>selectNode(i));return button;}));
 $('sample-count').textContent=`${fmt(data.keys.length)} keys drawn · ${fmt(slots.size)} slots mapped`;
 const stamp=new Date(data.capturedAt).toLocaleTimeString('en-GB',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 $('last-updated').textContent=`${live?'UPDATED':'SNAPSHOT'} ${stamp} JERUSALEM`;
 $('connection').replaceChildren(el('i'),document.createTextNode(live?(data.complete?'Live cluster':'Partial connection'):'Saved snapshot'));$('connection').classList.toggle('error',live&&!data.complete);
 rebuild();if(previousFocus){const key=previousFocus.key?data.keys.find(k=>k.name===previousFocus.key.name&&k.encoding===previousFocus.key.encoding):null;if(previousFocus.key?.encoding==='base64'&&!key){$('inspector').hidden=true;}else{locate(previousFocus.name,false,key);}}
}
async function refresh(manual=false) {
 if(loading)return;if(!live){if(manual)toast('Viewing a snapshot. Run Grove locally for live data.');return;}
 loading=true;const started=generation;$('refresh').disabled=true;
 try{const response=await fetch('/api/snapshot',{signal:AbortSignal.timeout(18000)});const type=response.headers.get('content-type')||'';if(!type.includes('application/json'))throw Error('Open the local app for a live connection.');const s=await response.json();if(started!==generation||!live)return;if(!response.ok)throw Error(s.error||'Cannot read the cluster.');updateData(s);if(manual)toast('The grove is up to date.');}
 catch(error){if(started!==generation||!live)return;$('connection').replaceChildren(el('i'),document.createTextNode(data?'Connection lost':'Not connected'));$('connection').classList.add('error');if(!data){$('empty-state').hidden=false;$('connection-error').textContent=error.message;$('cluster-description').textContent='No cluster connected';}else{$('last-updated').textContent='CONNECTION LOST · SHOWING LAST CAPTURE';}if(manual)toast(error.message);}
 finally{loading=false;$('refresh').disabled=false;}
}
function selectNode(i) {selected=selected===i?-1:i;focus=null;dirty=true;document.querySelectorAll('.node').forEach((e,j)=>{e.classList.toggle('selected',j===selected);e.setAttribute('aria-pressed',String(j===selected))});$('view-label').textContent=selected===-1?'FRACTAL CANOPY':`NODE ${String(i+1).padStart(2,'0')} · ISOLATED`;if(selected<0){$('inspector').hidden=true;return;}const node=data.nodes[i];$('inspector-label').textContent='PRIMARY NODE';$('inspector-name').textContent=`Node ${String(i+1).padStart(2,'0')}`;$('inspector-info').replaceChildren(el('p',node.address),el('p',`${fmt(node.keys)} keys · ${node.replicas||0} replicas`),el('p',`Slots ${node.slots.map(r=>r.join('–')).join(', ')}`),el('span',node.id,'node-id'));if(node.error)$('inspector-info').append(el('p',node.error,'error-text'));$('inspector').hidden=false;}
function locate(name,notify=true,exactKey=null) {
 if(!data){if(notify)toast('Connect a cluster or open a snapshot first.');return;}if(!name.length)return;
 const key=exactKey??data.keys.find(k=>!k.encoding&&k.name===name),slot=key?.slot??hashSlot(name),owner=ownerOf(slot,data.nodes),node=key?.node??owner;
 if(node<0){if(notify)toast(`Slot ${slot} has no assigned node.`);return;}
 selected=node;focus={name,slot,node,key};dirty=true;document.querySelectorAll('.node').forEach((e,j)=>{e.classList.toggle('selected',j===node);e.setAttribute('aria-pressed',String(j===node))});$('view-label').textContent=`SLOT ${fmt(slot)} · KEY PATH`;
 $('inspector-label').textContent=key?'KEY FOUND IN SCAN':'CALCULATED KEY LOCATION';$('inspector-name').textContent=name;$('inspector-info').replaceChildren(el('p',`Slot ${fmt(slot)} → Node ${String(node+1).padStart(2,'0')}`),el('p',data.nodes[node].address),el('p',key?'Observed in the captured key sample.':'Not in the sample. This shows where the key would belong.'));
 if(key&&owner!==node)$('inspector-info').append(el('p','Observed node differs from slot owner; the key may be moving.'));
 $('inspector').hidden=false;
}
$('search-form').addEventListener('submit',e=>{e.preventDefault();locate($('key-search').value)});
$('show-all').onclick=()=>{selected=-1;focus=null;$('inspector').hidden=true;$('view-label').textContent='FRACTAL CANOPY';document.querySelectorAll('.node').forEach(e=>{e.classList.remove('selected');e.setAttribute('aria-pressed','false')});dirty=true;};
$('close-inspector').onclick=()=>$('show-all').click();
$('spread').oninput=e=>{spread=Number(e.target.value)*Math.PI/180;$('spread-value').textContent=`${e.target.value}°`;rebuild()};
$('depth').oninput=e=>{depth=Number(e.target.value);$('depth-value').textContent=e.target.value;rebuild()};
$('motion').onclick=()=>{motion=!motion;$('motion').setAttribute('aria-pressed',String(motion));dirty=true};
$('theme').onclick=()=>{dark=!dark;setTheme();try{localStorage.setItem('grove-theme',dark?'dark':'light')}catch{}};
function setZoom(value){zoom=Math.max(.4,Math.min(3.5,value));$('zoom-label').textContent=`${Math.round(zoom*100)}%`;dirty=true;}
$('zoom-in').onclick=()=>setZoom(zoom*1.2);$('zoom-out').onclick=()=>setZoom(zoom/1.2);$('reset-view').onclick=()=>{pan={x:0,y:0};setZoom(1)};
canvas.addEventListener('wheel',e=>{e.preventDefault();setZoom(zoom*Math.exp(-e.deltaY*.001))},{passive:false});
canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};moved=false;canvas.setPointerCapture(e.pointerId)});
canvas.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;const scale=viewScale();if(Math.hypot(dx,dy)>4)moved=true;pan={x:drag.px+dx/scale,y:drag.py+dy/scale};dirty=true});
canvas.addEventListener('pointerup',e=>{if(!moved&&data){const rect=canvas.getBoundingClientRect();let closest=null,best=14;for(const dot of dots){if(selected!==-1&&dot.node!==selected)continue;const p=point(dot.x,dot.y);const distance=Math.hypot(p.x-(e.clientX-rect.left),p.y-(e.clientY-rect.top));if(distance<best){best=distance;closest=dot}}if(closest){$('key-search').value=closest.name;locate(closest.name,true,closest.key)}}drag=null;});
canvas.addEventListener('pointercancel',()=>{drag=null});
function download(blob,name){const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export').onclick=()=>{if(!data){toast('Connect a cluster or open a snapshot first.');return;}const art=document.createElement('canvas');art.width=canvas.width;art.height=canvas.height;const c=art.getContext('2d');c.fillStyle=dark?'#101c17':'#e9eee3';c.fillRect(0,0,art.width,art.height);c.drawImage(canvas,0,0);c.fillStyle=dark?'#d4ecac':'#49662d';c.font=`${24*dpr}px Georgia`;c.fillText('valkey grove',30*dpr,40*dpr);c.font=`${10*dpr}px sans-serif`;c.fillText(`${fmt(data.keys.length)} keys · ${data.nodes.length} nodes · ${new Date(data.capturedAt).toLocaleDateString()}`,30*dpr,60*dpr);art.toBlob(blob=>{if(blob)download(blob,'valkey-grove.png')},'image/png');};
$('snapshot').onclick=()=>{if(!data){toast('There is no cluster data to export yet.');return;}download(new Blob([JSON.stringify({...data,source:'snapshot'},null,2)],{type:'application/json'}),'valkey-grove-snapshot.json');toast('Snapshot saved. It contains key names and node addresses.');};
$('import').onclick=$('import-empty').onclick=()=>$('snapshot-file').click();
$('snapshot-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const s=validateSnapshot(JSON.parse(await file.text()));generation++;live=false;updateData(s);toast('Snapshot opened locally in your browser.')}catch(error){toast(error.message)}finally{e.target.value=''}};
$('refresh').onclick=()=>refresh(true);
$('about').onclick=()=>$('about-dialog').showModal();$('close-about').onclick=()=>$('about-dialog').close();$('about-dialog').addEventListener('click',e=>{if(e.target===$('about-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close()}});
async function start() {
 if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)){refresh();return;}
 live=false;
 try{const response=await fetch('example.json');if(!response.ok)throw Error('Open a snapshot to explore this grove.');updateData(await response.json());$('cluster-description').textContent=`${data.nodes.length} primaries · captured local cluster`;}
 catch(error){$('connection').replaceChildren(el('i'),document.createTextNode('Snapshot viewer'));$('empty-state').hidden=false;$('connection-error').textContent=error.message;}
}
start();setInterval(()=>{if(!document.hidden&&live)refresh()},8000);
