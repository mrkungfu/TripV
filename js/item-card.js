"use strict";
/* ============================================================
   Trip visualizer — item detail card
   Clicking an itinerary item (or its route / pin) opens a card laid
   out for that kind of item: tap-to-copy fields, a directions / call
   action bottom-left, and an in-place editor bottom-right that saves
   back to the trip library. Relies on viewer.js globals (M, curCfg,
   curName, loadTrip, populateTripSel) at call time.
   ============================================================ */

let cardItem=null, cardEditing=false, cardReturnFocus=null, toastTimer=null;
const sheet=$('#sheet'), sheetCard=$('#sheetCard');

const LINE_ICON={
  pin:'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  phone:'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  ticket:'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7zM14 5v2M14 11v2M14 17v2',
  hash:'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  seat:'M7 4v9a2 2 0 0 0 2 2h7M7 13h8a2 2 0 0 1 2 2v5M9 15v5',
  copy:'M9 9h11v11H9zM5 15H4V4h11v1',
  check:'M5 12.5l4.5 4.5L19 7',
  nav:'M3 11l18-8-8 18-2-8-8-2z',
  edit:'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
  close:'M6 6l12 12M18 6 6 18',
  warn:'M12 3 2 20h20L12 3zM12 10v4M12 17.5v.01',
  map:'M9 3 3 5.5v15L9 18l6 3 6-2.5v-15L15 6 9 3zM9 3v15M15 6v15'
};
const ico=(d,cls)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'+
  (cls?' class="'+cls+'"':'')+'><path d="'+d+'"/></svg>';
const solid=(d,fill)=>'<svg viewBox="0 0 24 24" fill="'+(fill||'currentColor')+'"><path d="'+d+'"/></svg>';

const COLL={leg:'legs', stay:'stays', event:'events'};

function itemKind(it){
  if(it.ref.kind==='leg') return 'leg';
  if(it.cls==='stay') return 'stay';
  return 'event';
}
function cardIsOpen(){ return !!cardItem; }

/* ---------- small helpers ---------- */
function offIso(off){
  const s=off<0?'-':'+', a=Math.abs(off);
  return s+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0');
}
/* UTC offset written in an ISO string, else the fallback (minutes) */
function isoOffset(iso,fallback){
  const m=String(iso||'').match(/(Z|([+-])(\d{2}):?(\d{2}))\s*$/i);
  if(!m) return fallback;
  if(/z/i.test(m[1])) return 0;
  return (m[2]==='-'?-1:1)*((+m[3])*60+(+m[4]));
}
function localInput(ts,off){ return new Date(ts+off*MIN).toISOString().slice(0,16); }
function dayShift(t0,off0,t1,off1){
  return Math.round((Date.parse(fmt(t1,off1,'k'))-Date.parse(fmt(t0,off0,'k')))/DAY);
}
function mapsUrl(dest){ return 'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(dest); }
function telHref(phone){ return 'tel:'+String(phone).replace(/[^\d+]/g,''); }
function flightCodes(l){
  const m=l.mode==='flight' && String(l.title||'').match(/^\s*([A-Z]{3})\s*(?:→|->|–|—|-|to)\s*([A-Z]{3})\b/);
  return m? [m[1],m[2]] : null;
}
/* structured fields win; otherwise fish a booking code / phone number out of the notes */
function fromNotes(det){
  const out={};
  if(!det) return out;
  const c=String(det).match(CONF_ANY_RE);
  if(c && looksLikeCode(c[1])) out.conf=c[1];
  const p=String(det).match(PHONE_ANY_RE);
  if(p) out.phone=(p[1]||p[2]).trim();
  return out;
}
function relStatus(t0,t1,w){
  const n=Date.now();
  if(n<t0) return {cls:'soon', txt:w[0]+' in '+dur(t0-n)};
  if(t1>t0 && n<=t1) return {cls:'live', txt:w[1]+' · '+dur(t1-n)+' '+w[2]};
  return {cls:'past', txt:w[3]+' '+dur(n-Math.max(t0,t1))+' ago'};
}

/* ---------- building blocks ---------- */
function copyRow(label,value,icon,opts){
  opts=opts||{};
  return '<button type="button" class="cp'+(opts.big?' big':'')+'" data-copy="'+esc(value)+'" data-label="'+esc(label)+'" title="Copy '+esc(label.toLowerCase())+'">'+
    '<span class="ic">'+ico(icon)+'</span>'+
    '<span class="tx"><span class="lb">'+esc(label)+(opts.note?' <em>'+esc(opts.note)+'</em>':'')+'</span>'+
      '<span class="v'+(opts.mono?' mono':'')+'">'+esc(value)+'</span></span>'+
    '<span class="hint">'+ico(LINE_ICON.copy)+'<span>Copy</span></span>'+
  '</button>';
}
function tiles(list){
  list=list.filter(Boolean);
  return list.length? '<div class="sc-tiles">'+list.map(t=>'<div class="tile"><span>'+esc(t[0])+'</span><b>'+esc(t[1])+'</b></div>').join('')+'</div>' : '';
}
function contactRows(src,det,skipAddr){
  const n=fromNotes(det);
  let h='';
  const conf=src.conf||n.conf, phone=src.phone||n.phone;
  if(conf) h+=copyRow('Confirmation',conf,LINE_ICON.ticket,{mono:true,big:true,note:src.conf?'':'from notes'});
  if(!skipAddr && src.addr) h+=copyRow('Address',src.addr,LINE_ICON.pin);
  if(phone) h+=copyRow('Phone',phone,LINE_ICON.phone,{note:src.phone?'':'from notes'});
  return {html:h, phone};
}
/* middle divider: dotted before, progress bar while under way, solid with a filled end dot once done */
function midTrack(t0,t1,icon,color,opts){
  opts=opts||{};
  const p=clamp((Date.now()-t0)/Math.max(1,t1-t0),0,1);
  const state=p<=0?'pre':p>=1?'done':'live';
  return '<div class="ep-mid"><div class="track '+state+(opts.gap?' gap':'')+'"><i style="width:'+(p*100).toFixed(1)+'%"></i>'+
      '<span class="plane'+(opts.fly?' fly':'')+'" style="left:'+(state==='live'?(p*100).toFixed(1):50)+'%">'+solid(icon,color)+'</span></div>'+
    '<span class="du">'+esc(opts.label)+'</span>'+
    (opts.km?'<span class="km">'+Math.round(opts.km).toLocaleString()+' km</span>':'')+
  '</div>';
}
function warnBlock(w){ return w? '<div class="sc-warn">'+ico(LINE_ICON.warn)+'<div>'+esc(w)+'</div></div>' : ''; }
function notesBlock(d){ return d? '<section class="sc-notes"><h4>Notes</h4><p>'+esc(d)+'</p></section>' : ''; }

/* ---------- per-kind layouts ---------- */
function legCard(it){
  const l=it.ref, A=l.A, B=l.B, codes=flightCodes(l), gap=l.mode==='gap';
  const shift=dayShift(l.t0,A.off,l.t1,B.off);
  const ep=(P,code,t,off,side,extra)=>
    '<div class="ep '+side+'">'+
      '<div class="code'+(code?'':' long')+'">'+esc(code||P.n)+'</div>'+
      '<div class="nm">'+esc(code? P.n : (P.r||P.cc||''))+'</div>'+
      '<div class="tm">'+fmt(t,off,'t')+(extra||'')+'</div>'+
      '<div class="dt">'+fmt(t,off,'d')+' · '+tzLabel(off)+'</div>'+
    '</div>';
  const route='<div class="route-blk">'+
    ep(A,codes&&codes[0],l.t0,A.off,'from')+
    midTrack(l.t0,l.t1,it.icon,it.color,{gap, fly:l.mode==='flight', label:dur(l.t1-l.t0), km:l.km>=0.5?l.km:0})+
    ep(B,codes&&codes[1],l.t1,B.off,'to',shift?'<sup>'+(shift>0?'+':'−')+Math.abs(shift)+'</sup>':'')+
  '</div>';
  const tz=B.off-A.off;
  const body=route+warnBlock(l.warn)+
    tiles([
      tz?['Time change',(tz>0?'+':'−')+Math.abs(tz)/60+' h']:null
    ]);
  let rows='';
  const n2=fromNotes(l.det), conf=l.conf||n2.conf, phone=l.phone||n2.phone;
  if(conf) rows+=copyRow('Confirmation / PNR',conf,LINE_ICON.ticket,{mono:true,big:true,note:l.conf?'':'from notes'});
  if(l.op && !gap) rows+=copyRow(l.mode==='flight'?'Flight':'Operator',l.op,l.mode==='flight'?LINE_ICON.hash:LINE_ICON.ticket);
  if(l.seat) rows+=copyRow('Seat',l.seat,LINE_ICON.seat);
  if(l.depAddr) rows+=copyRow('Departs from',l.depAddr,LINE_ICON.pin);
  if(l.arrAddr) rows+=copyRow('Arrives at',l.arrAddr,LINE_ICON.pin);
  if(phone) rows+=copyRow('Phone',phone,LINE_ICON.phone,{note:l.phone?'':'from notes'});

  let dest=null, destLbl='';
  if(l.depAddr){ dest=l.depAddr; destLbl=l.depAddr; }
  else if(codes){ dest=codes[0]+' airport'; destLbl=codes[0]+' airport'; }
  else if(!gap){ dest=A.lat+','+A.lon; destLbl=A.n; }
  return {
    kicker:MODE_LABEL[l.mode]||'Trip leg',
    title: codes? A.n+' to '+B.n : l.title,
    sub: l.op||(!codes&&l.title!==A.n+' → '+B.n? A.n+' → '+B.n : ''),
    status: relStatus(l.t0,l.t1, gap?['Starts','Underway','left','Ended']:['Departs','En route','to go','Arrived']),
    body: body+(rows?'<div class="sc-rows">'+rows+'</div>':'')+notesBlock(l.det),
    dest, destLbl, phone
  };
}

function stayCard(it){
  const s=it.ref, P=s.P, nn=nights(s.t0,s.t1), isOut=/o$/.test(it.id);
  const col=(lbl,t,side)=>
    '<div class="ep '+side+'"><div class="lbl">'+lbl+'</div>'+
      '<div class="tm big">'+fmt(t,P.off,'t')+'</div>'+
      '<div class="dt">'+fmt(t,P.off,'d')+' · '+tzLabel(P.off)+'</div></div>';
  const blk='<div class="route-blk stay">'+
    col('Check-in',s.t0,'from'+(isOut?'':' hl'))+
    midTrack(s.t0,s.t1,ICON.bed,it.color,{label:nn+' night'+(nn>1?'s':'')})+
    col('Check-out',s.t1,'to'+(isOut?' hl':''))+
  '</div>';
  const c=contactRows(s,s.det);
  let dest=null, destLbl='';
  if(s.pin){ dest=s.lat+','+s.lon; destLbl=s.name; }
  else if(s.addr){ dest=s.name+', '+s.addr; destLbl=s.addr; }
  return {
    kicker:'Stay · '+(isOut?'check-out':'check-in'),
    title:s.name,
    sub:P.n+(P.r?', '+P.r:''),
    status:relStatus(s.t0,s.t1,['Check-in','Checked in','left','Checked out']),
    body:blk+warnBlock(s.warn)+(c.html?'<div class="sc-rows">'+c.html+'</div>':'')+notesBlock(s.det),
    dest, destLbl, phone:c.phone
  };
}

function eventCard(it){
  const e=it.ref, off=it.off, hasEnd=!!e.end;
  const kicker=e.kind==='note'?'Note':e.kind==='gapnote'?'Open time':'Activity';
  let blk;
  if(hasEnd){
    const shift=dayShift(e.t0,off,e.t1,off);
    blk='<div class="route-blk event">'+
      '<div class="ep from"><div class="lbl">Starts</div><div class="tm big">'+fmt(e.t0,off,'t')+'</div><div class="dt">'+fmt(e.t0,off,'d')+' · '+tzLabel(off)+'</div></div>'+
      midTrack(e.t0,e.t1,it.icon,it.color,{label:dur(e.t1-e.t0)})+
      '<div class="ep to"><div class="lbl">Ends</div><div class="tm big">'+fmt(e.t1,off,'t')+(shift?'<sup>+'+shift+'</sup>':'')+'</div><div class="dt">'+fmt(e.t1,off,'d')+'</div></div>'+
    '</div>';
  } else {
    blk='<div class="when-blk"><span class="ic">'+solid(it.icon,it.color)+'</span><div><div class="tm big">'+fmt(e.t0,off,'t')+'</div>'+
      '<div class="dt">'+fmt(e.t0,off,'D')+' · '+tzLabel(off)+'</div></div></div>';
  }
  const c=contactRows(e,e.det);
  const hasPin=e.lat!=null&&e.lon!=null;
  let dest=null, destLbl='';
  if(hasPin){ dest=(+e.lat)+','+(+e.lon); destLbl=e.addr||e.title; }
  else if(e.addr){ dest=e.addr+', '+e.P.n; destLbl=e.addr; }
  return {
    kicker, title:e.title,
    sub:e.P.n+(e.P.r?', '+e.P.r:''),
    status: hasEnd? relStatus(e.t0,e.t1,['Starts','Happening now','left','Ended']) : relStatus(e.t0,e.t0,['Due','','','Was due']),
    body:blk+warnBlock(e.warn)+(c.html?'<div class="sc-rows">'+c.html+'</div>':'')+notesBlock(e.det),
    dest, destLbl, phone:c.phone
  };
}

/* ---------- render ---------- */
function cardHead(it,v){
  return '<header class="sc-head">'+
    '<div class="grab"></div>'+
    '<div class="kick"><span class="badge">'+solid(it.icon)+esc(v.kicker)+'</span>'+
      '<span class="daylbl">Day '+M.dayNo(it.t0)+' · '+fmt(it.t0,it.off,'d')+'</span>'+
      '<button type="button" class="x" data-close title="Close (Esc)" aria-label="Close">'+ico(LINE_ICON.close)+'</button></div>'+
    '<h2 id="scTitle">'+esc(v.title)+'</h2>'+
    (v.sub?'<div class="sub">'+esc(v.sub)+'</div>':'')+
    (v.status&&v.status.txt?'<div class="status '+v.status.cls+'"><i></i>'+esc(v.status.txt)+'</div>':'')+
  '</header>';
}
function renderCard(){
  const it=cardItem, kind=itemKind(it);
  const v=kind==='leg'?legCard(it):kind==='stay'?stayCard(it):eventCard(it);
  let actions='';
  if(v.dest) actions+='<a class="sc-btn primary" href="'+esc(mapsUrl(v.dest))+'" target="_blank" rel="noopener" title="Directions to '+esc(v.destLbl)+'">'+ico(LINE_ICON.nav)+'Directions</a>';
  if(v.phone) actions+='<a class="sc-btn'+(v.dest?' icon':' primary')+'" href="'+esc(telHref(v.phone))+'" title="Call '+esc(v.phone)+'" aria-label="Call">'+ico(LINE_ICON.phone)+(v.dest?'':'Call')+'</a>';
  sheetCard.innerHTML=cardHead(it,v)+
    '<div class="sc-body">'+v.body+'</div>'+
    '<footer class="sc-foot">'+actions+'<span class="sp"></span>'+
      '<button type="button" class="sc-btn" data-edit>'+ico(LINE_ICON.edit)+'Edit</button></footer>';
}
function styleCard(it){
  sheetCard.style.setProperty('--c',it.color);
  sheetCard.style.setProperty('--c2',it.color+'2e');
}

function openCard(id){
  const it=M.ITEMS.find(x=>x.id===id); if(!it) return;
  const wasOpen=!!cardItem;
  cardItem=it; cardEditing=false;
  sheetCard.classList.remove('editing');
  styleCard(it);
  renderCard();
  if(typeof hideTip==='function') hideTip();
  sheet.classList.add('on'); sheet.setAttribute('aria-hidden','false');
  document.body.classList.add('sheet-open');
  if(!wasOpen){ cardReturnFocus=document.activeElement; }
  sheetCard.focus({preventScroll:true});
}
function closeCard(){
  if(!cardItem) return;
  cardItem=null; cardEditing=false;
  sheet.classList.remove('on'); sheet.setAttribute('aria-hidden','true');
  document.body.classList.remove('sheet-open');
  if(cardReturnFocus && document.contains(cardReturnFocus)) cardReturnFocus.focus({preventScroll:true});
  cardReturnFocus=null;
}

/* ---------- editing ---------- */
const EDIT_FIELDS={
  leg:[['title','Title'],['op','Operator / flight no.'],['conf','Confirmation / PNR'],['seat','Seat'],
       ['dep','Departs','dt'],['arr','Arrives','dt'],['depAddr','Departure address','wide'],['arrAddr','Arrival address','wide'],
       ['phone','Phone'],['warn','Heads-up','area'],['det','Notes','area']],
  stay:[['name','Name','wide'],['addr','Address','wide'],['phone','Phone'],['conf','Confirmation #'],
        ['in','Check-in','dt'],['out','Check-out','dt'],['warn','Heads-up','area'],['det','Notes','area']],
  event:[['title','Title','wide'],['addr','Address','wide'],['phone','Phone'],['conf','Confirmation #'],
         ['start','Starts','dt'],['end','Ends','dt'],['warn','Heads-up','area'],['det','Notes','area']]
};
const REQUIRED_TIMES=new Set(['dep','arr','in','out','start']);

function rawEntry(cfg,it){
  const arr=cfg&&cfg[COLL[itemKind(it)]];
  return arr? arr[it.ref.srcIndex] : null;
}
function timeFieldOff(it,f,raw){
  const r=it.ref;
  const fallback= f==='arr'? r.B.off : f==='dep'? r.A.off : (r.off!=null? +r.off : r.P.off);
  return isoOffset(raw[f], fallback);
}
function renderEditor(err){
  const it=cardItem, kind=itemKind(it), raw=rawEntry(curCfg,it)||{};
  const fields=EDIT_FIELDS[kind].map(([f,label,type])=>{
    let input;
    if(type==='dt'){
      const off=timeFieldOff(it,f,raw);
      const ts=raw[f]? Date.parse(raw[f]) : NaN;
      const val=isFinite(ts)? localInput(ts,off) : '';
      input='<div class="dtwrap"><input type="datetime-local" data-f="'+f+'" data-off="'+off+'" data-orig="'+val+'" value="'+val+'"'+
        (REQUIRED_TIMES.has(f)?' required':'')+'><span class="tz">'+tzLabel(off)+'</span></div>';
    } else if(type==='area'){
      input='<textarea data-f="'+f+'" rows="'+(f==='det'?5:2)+'">'+esc(raw[f]||'')+'</textarea>';
    } else {
      input='<input type="text" data-f="'+f+'" value="'+esc(raw[f]||'')+'"'+(f==='phone'?' inputmode="tel"':'')+'>';
    }
    return '<label class="fld'+(type==='area'||type==='wide'?' full':'')+'"><span>'+esc(label)+'</span>'+input+'</label>';
  }).join('');
  const head=sheetCard.querySelector('.sc-head');
  sheetCard.innerHTML=(head?head.outerHTML:'')+
    '<div class="sc-body"><form class="sc-form" id="scForm" novalidate>'+
      (err?'<div class="sc-err">'+esc(err)+'</div>':'')+fields+
      '<p class="sc-formnote">Places, mode and ordering are edited in the <a href="editor.html">full trip editor</a>.</p>'+
    '</form></div>'+
    '<footer class="sc-foot"><button type="button" class="sc-btn" data-cancel>Cancel</button><span class="sp"></span>'+
      '<button type="button" class="sc-btn primary" data-save>'+ico(LINE_ICON.check)+'Save</button></footer>';
  sheetCard.classList.add('editing');
  const first=$('#scForm [data-f]'); if(first && !err) first.focus();
  const e=$('#scForm .sc-err'); if(e) e.scrollIntoView({block:'nearest'});
}
function startEdit(){
  if(!curCfg || !rawEntry(curCfg,cardItem)){ toast('This item cannot be edited here — use the full editor.'); return; }
  cardEditing=true;
  renderEditor();
}
function cancelEdit(){
  cardEditing=false;
  sheetCard.classList.remove('editing');
  renderCard();
  sheetCard.focus({preventScroll:true});
}
function saveEdit(){
  const it=cardItem;
  const cfg=JSON.parse(JSON.stringify(curCfg));
  const raw=rawEntry(cfg,it);
  let err=null;
  $$('#scForm [data-f]').forEach(inp=>{
    const f=inp.dataset.f, v=inp.value.trim();
    if(inp.type==='datetime-local'){
      if(!v){ if(REQUIRED_TIMES.has(f)) err=err||(inp.closest('.fld').querySelector('span').textContent+' needs a date and time.'); else delete raw[f]; return; }
      if(v!==inp.dataset.orig) raw[f]=v+':00'+offIso(+inp.dataset.off);
    } else if(v) raw[f]=v;
    else delete raw[f];
  });
  if(!err){ try{ buildModel(cfg); }catch(e){ err=e.message; } }
  if(err){ captureAndRerender(err); return; }

  let name=curName;
  if(!TripStore.get(name)){
    const suggested=(cfg.title||'My trip')+(curName==='__demo'?' (my copy)':'');
    const ans=prompt('This trip is not saved in this browser yet, so your edit will be saved as a new trip. Name it:', suggested);
    if(ans==null) return;
    name=ans.trim();
    if(!name){ captureAndRerender('Give the trip a name to save your edit.'); return; }
    if(TripStore.get(name) && !confirm('Replace the saved trip "'+name+'" with this one?')) return;
  }
  TripStore.save(name,cfg);
  TripStore.setActive(name);
  curName=name;
  populateTripSel(name);
  const id=it.id;
  loadTrip(cfg,{keep:true});
  sheetCard.classList.remove('editing');
  openCard(id);
  toast('Saved to “'+name+'”');
}
/* re-render the form with an error while keeping what the user typed */
function captureAndRerender(err){
  const typed={};
  $$('#scForm [data-f]').forEach(inp=>typed[inp.dataset.f]=inp.value);
  renderEditor(err);
  $$('#scForm [data-f]').forEach(inp=>{ if(typed[inp.dataset.f]!=null) inp.value=typed[inp.dataset.f]; });
}

/* ---------- copy + toast ---------- */
function toast(msg){
  const t=$('#toast');
  t.textContent=msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('on'),1600);
}
function fallbackCopy(txt){
  const ta=document.createElement('textarea');
  ta.value=txt; ta.setAttribute('readonly','');
  ta.style.cssText='position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok=false; try{ ok=document.execCommand('copy'); }catch(e){}
  ta.remove();
  return ok;
}
function copyText(txt,label,btn){
  const done=()=>{
    toast(label+' copied');
    if(btn){ btn.classList.add('done'); setTimeout(()=>btn.classList.remove('done'),1400); }
  };
  const fail=()=>{ if(fallbackCopy(txt)) done(); else toast('Could not copy — select the text instead'); };
  if(navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done,fail);
  else fail();
}

/* ---------- wiring ---------- */
sheet.addEventListener('click',e=>{
  if(e.target.closest('[data-close]')){ closeCard(); return; }
  const cp=e.target.closest('[data-copy]');
  if(cp){ copyText(cp.dataset.copy, cp.dataset.label, cp); return; }
  if(e.target.closest('[data-edit]')){ startEdit(); return; }
  if(e.target.closest('[data-cancel]')){ cancelEdit(); return; }
  if(e.target.closest('[data-save]')){ saveEdit(); return; }
});
sheet.addEventListener('submit',e=>{ e.preventDefault(); saveEdit(); });
addEventListener('keydown',e=>{
  if(!cardItem) return;
  if(e.key==='Escape'){ e.preventDefault(); if(cardEditing) cancelEdit(); else closeCard(); }
  else if(cardEditing && e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); saveEdit(); }
  else if(e.key==='Tab'){
    const f=$$('a[href],button,input,textarea,select',sheetCard).filter(x=>!x.disabled && x.offsetParent!==null);
    if(!f.length) return;
    const a=f[0], z=f[f.length-1];
    if(e.shiftKey && (document.activeElement===a || document.activeElement===sheetCard)){ e.preventDefault(); z.focus(); }
    else if(!e.shiftKey && document.activeElement===z){ e.preventDefault(); a.focus(); }
  }
});
