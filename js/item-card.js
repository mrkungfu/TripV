"use strict";
/* ============================================================
   Trip visualizer — item detail card
   Clicking an itinerary item (or its route / pin) opens a card laid
   out for that kind of item: tap-to-copy fields, a directions / call
   action bottom-left, and an in-place editor bottom-right that saves
   back to the trip library (and can delete the item). The same sheet hosts
   the form for adding a new item. Relies on viewer.js globals (M, curCfg,
   curName, now, loadTrip, populateTripSel, setNowForItem, focusItem) at call time.
   ============================================================ */

let cardItem=null, cardEditing=false, cardReturnFocus=null, toastTimer=null, cardTimer=null, cardDrag=null, cardDragTimer=null;
const sheet=$('#sheet'), sheetCard=$('#sheetCard'), sheetBack=sheet.querySelector('.sheet-back');

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
  map:'M9 3 3 5.5v15L9 18l6 3 6-2.5v-15L15 6 9 3zM9 3v15M15 6v15',
  trash:'M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4h6v3'
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
function cardIsOpen(){ return !!(cardItem||cardNew); }

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
function cardView(it){
  const kind=itemKind(it);
  return kind==='leg'?legCard(it):kind==='stay'?stayCard(it):eventCard(it);
}
function renderCard(){
  const it=cardItem, v=cardView(it);
  scheduleCardTick();
  let actions='';
  if(v.dest) actions+='<a class="sc-btn primary" href="'+esc(mapsUrl(v.dest))+'" target="_blank" rel="noopener" title="Directions to '+esc(v.destLbl)+'">'+ico(LINE_ICON.nav)+'Directions</a>';
  if(v.phone) actions+='<a class="sc-btn'+(v.dest?' icon':' primary')+'" href="'+esc(telHref(v.phone))+'" title="Call '+esc(v.phone)+'" aria-label="Call">'+ico(LINE_ICON.phone)+(v.dest?'':'Call')+'</a>';
  sheetCard.innerHTML=cardHead(it,v)+
    '<div class="sc-body">'+v.body+'</div>'+
    '<footer class="sc-foot">'+actions+'<span class="sp"></span>'+
      '<button type="button" class="sc-btn" data-edit>'+ico(LINE_ICON.edit)+'Edit</button></footer>';
}
/* while the open item is under way, refresh its status and progress track on each minute
   boundary; patched in place so scroll position, focus and an open editor survive */
function refreshCardLive(){
  if(!cardItem) return;
  const v=cardView(cardItem), tmp=document.createElement('div');
  tmp.innerHTML=cardHead(cardItem,v)+v.body;
  [['.sc-head .status','.status'],['.sc-body .ep-mid','.ep-mid']].forEach(([sel,src])=>{
    const cur=sheetCard.querySelector(sel), nxt=tmp.querySelector(src);
    if(cur && nxt) cur.replaceWith(nxt);
  });
}
function scheduleCardTick(){
  clearTimeout(cardTimer); cardTimer=null;
  const r=cardItem && cardItem.ref, n=Date.now();
  if(!r || !(r.t1>r.t0) || n<r.t0 || n>=r.t1) return;
  cardTimer=setTimeout(()=>{ refreshCardLive(); scheduleCardTick(); }, MIN-n%MIN+50);
}
function styleCard(it){
  sheetCard.style.setProperty('--c',it.color);
  sheetCard.style.setProperty('--c2',it.color+'2e');
}

function openCard(id){
  const it=M.ITEMS.find(x=>x.id===id); if(!it) return;
  const wasOpen=cardIsOpen();
  cardItem=it; cardEditing=false; cardNew=null;
  sheetCard.classList.remove('editing');
  clearTimeout(cardDragTimer); sheetCard.style.transform='';
  styleCard(it);
  renderCard();
  if(typeof hideTip==='function') hideTip();
  sheet.classList.add('on'); sheet.setAttribute('aria-hidden','false');
  document.body.classList.add('sheet-open');
  if(!wasOpen){ cardReturnFocus=document.activeElement; }
  sheetCard.focus({preventScroll:true});
}
function closeCard(){
  if(!cardIsOpen()) return;
  clearTimeout(cardTimer); cardTimer=null;
  cardItem=null; cardEditing=false; cardNew=null;
  sheetCard.classList.remove('editing');
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
    '<footer class="sc-foot"><button type="button" class="sc-btn" data-cancel>Cancel</button>'+
      '<button type="button" class="sc-btn danger" data-delete title="Delete this item">'+ico(LINE_ICON.trash)+'Delete</button><span class="sp"></span>'+
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

  const name=persistTrip(cfg,'edit',captureAndRerender);
  if(!name) return;
  const id=it.id;
  loadTrip(cfg,{keep:true});
  sheetCard.classList.remove('editing');
  openCard(id);
  toast('Saved to “'+name+'”');
}
/* entries are only flagged, never spliced out, so srcIndex/ids stay put and undo can clear the flag */
function deleteItem(){
  const it=cardItem, kind=itemKind(it);
  const label=kind==='stay'? it.ref.name : it.ref.title;
  const what=kind==='stay'? 'the stay "'+label+'" (check-in and check-out)' : '"'+label+'"';
  if(!confirm('Delete '+what+' from this trip?')) return;
  const cfg=JSON.parse(JSON.stringify(curCfg));
  const raw=rawEntry(cfg,it);
  raw.deleted=true;
  raw.deletedAt=new Date().toISOString();
  try{ buildModel(cfg); }
  catch(e){ captureAndRerender('Can’t delete this item: '+e.message); return; }

  const name=persistTrip(cfg,'deletion',captureAndRerender);
  if(!name) return;
  sheetCard.classList.remove('editing');
  loadTrip(cfg,{keep:true});
  toast('Deleted “'+label+'”');
}
/* save cfg to the library under the current trip's name (asking for one if it isn't saved yet);
   returns the name, or null if the user backed out */
function persistTrip(cfg,what,onErr){
  let name=curName;
  if(!TripStore.get(name)){
    const suggested=(cfg.title||'My trip')+(curName==='__demo'?' (my copy)':'');
    const ans=prompt('This trip is not saved in this browser yet, so your '+what+' will be saved as a new trip. Name it:', suggested);
    if(ans==null) return null;
    name=ans.trim();
    if(!name){ onErr('Give the trip a name to save your '+what+'.'); return null; }
    if(TripStore.get(name) && !confirm('Replace the saved trip "'+name+'" with this one?')) return null;
  }
  TripStore.save(name,cfg);
  TripStore.setActive(name);
  curName=name;
  populateTripSel(name);
  return name;
}
/* re-render the form with an error while keeping what the user typed */
function captureAndRerender(err){
  const typed={};
  $$('#scForm [data-f]').forEach(inp=>typed[inp.dataset.f]=inp.value);
  renderEditor(err);
  $$('#scForm [data-f]').forEach(inp=>{ if(typed[inp.dataset.f]!=null) inp.value=typed[inp.dataset.f]; });
}

/* ---------- adding ----------
   The form works on generic keys (title, place, from/to, start/end…) that saveNew maps onto
   the schema. Times are wall-clock values in the zone of the chosen place (from/to for travel),
   so changing the place keeps the typed time and re-labels its zone. */
const NEW_KINDS=[['activity','Activity',ICON.star],['stay','Stay',ICON.bed],['travel','Travel',ICON.flight],['note','Note',ICON.note]];
const NEW_FIELDS={
  activity:[['title','Name','wide'],['place','Place','place'],['start','Starts','dt'],['end','Ends','dt'],
            ['addr','Address','wide'],['conf','Confirmation #'],['phone','Phone'],['det','Notes','area']],
  stay:[['title','Name','wide'],['place','Place','place'],['start','Check-in','dt'],['end','Check-out','dt'],
        ['addr','Address','wide'],['conf','Confirmation #'],['phone','Phone'],['det','Notes','area']],
  travel:[['mode','Mode','mode'],['title','Title'],['from','From','place'],['to','To','place'],['start','Departs','dt'],['end','Arrives','dt'],
          ['op','Operator / flight no.'],['conf','Confirmation / PNR'],['det','Notes','area']],
  note:[['title','Name','wide'],['place','Place','place'],['start','When','dt'],['det','Notes','area']]
};
const NEW_REQUIRED={activity:['title','start'], stay:['title','start','end'], travel:['start','end'], note:['title','start']};
let cardNew=null;

function newColor(v){ return v.kind==='travel'? MODE_COLOR[v.mode]||MODE_COLOR.gap : MODE_COLOR[v.kind]; }
function newZone(v,f){
  const P=M.PLACES[v.kind==='travel'? (f==='end'?v.to:v.from) : v.place];
  return P? P.off : 0;
}
function nextHour(ts,off){ return Math.ceil((ts+off*MIN)/HOUR)*HOUR-off*MIN; }
/* suggested times around the playhead for each kind */
function newTimes(v){
  const so=newZone(v,'start'), eo=newZone(v,'end');
  if(v.kind==='stay'){
    const t=Math.floor((now+so*MIN)/DAY)*DAY-so*MIN+15*HOUR;
    return {start:localInput(t,so), end:localInput(t+20*HOUR,eo)};
  }
  const t=nextHour(now,so);
  return {start:localInput(t,so), end:v.kind==='travel'? localInput(t+2*HOUR,eo) : ''};
}
function freshId(cfg,prefix){
  const used=new Set();
  [['legs','L'],['stays','S'],['events','E']].forEach(([c,p])=>
    (Array.isArray(cfg[c])?cfg[c]:[]).forEach((x,i)=>used.add(String(x&&x.id||p+(i+1)))));
  let n=1;
  while(used.has(prefix+n)) n++;
  return prefix+n;
}

function openNewItem(name){
  if(!M || !curCfg) return;
  const wasOpen=cardIsOpen();
  const here=M.locationAt(now).place;
  const next=M.LEGS.find(l=>l.t0>=now && l.to!==here);
  const other=M.placeKeys.find(k=>k!==here)||here;
  const v={kind:'activity', mode:'flight', title:name||'', place:here, from:here, to:next?next.to:other};
  Object.assign(v,newTimes(v));
  cardNew={vals:v, auto:newTimes(v)};
  cardItem=null; cardEditing=false;
  clearTimeout(cardTimer); cardTimer=null;
  renderNewForm();
  if(typeof hideTip==='function') hideTip();
  sheet.classList.add('on'); sheet.setAttribute('aria-hidden','false');
  document.body.classList.add('sheet-open');
  if(!wasOpen) cardReturnFocus=document.activeElement;
}
function captureNew(){
  $$('#scForm [data-f]').forEach(inp=>{ cardNew.vals[inp.dataset.f]=inp.value; });
}
function renderNewForm(err,focusField){
  const v=cardNew.vals, kind=v.kind, req=NEW_REQUIRED[kind], color=newColor(v);
  const kindDef=NEW_KINDS.find(k=>k[0]===kind);
  sheetCard.style.setProperty('--c',color);
  sheetCard.style.setProperty('--c2',color+'2e');
  const placeOpts=sel=>M.placeKeys.map(k=>{
    const P=M.PLACES[k];
    return '<option value="'+esc(k)+'"'+(k===sel?' selected':'')+'>'+esc(P.n+(P.r?', '+P.r:''))+'</option>';
  }).join('');
  const fields=NEW_FIELDS[kind].map(([f,label,type])=>{
    const val=v[f]||'', need=req.includes(f);
    let input;
    if(type==='dt'){
      input='<div class="dtwrap"><input type="datetime-local" data-f="'+f+'" value="'+esc(val)+'"'+(need?' required':'')+'>'+
        '<span class="tz">'+tzLabel(newZone(v,f))+'</span></div>';
    } else if(type==='place'){
      input='<select data-f="'+f+'">'+placeOpts(val)+'</select>';
    } else if(type==='mode'){
      input='<select data-f="mode">'+LEG_MODES.map(m=>'<option value="'+m+'"'+(m===val?' selected':'')+'>'+esc(MODE_LABEL[m])+'</option>').join('')+'</select>';
    } else if(type==='area'){
      input='<textarea data-f="'+f+'" rows="4">'+esc(val)+'</textarea>';
    } else {
      const ph=kind==='travel'&&f==='title'? 'From → To' : '';
      input='<input type="text" data-f="'+f+'" value="'+esc(val)+'"'+(ph?' placeholder="'+esc(ph)+'"':'')+(f==='phone'?' inputmode="tel"':'')+(need?' required':'')+'>';
    }
    return '<label class="fld'+(type==='area'||type==='wide'?' full':'')+'"><span>'+esc(label)+'</span>'+input+'</label>';
  }).join('');
  sheetCard.innerHTML=
    '<header class="sc-head"><div class="grab"></div>'+
      '<div class="kick"><span class="badge">'+solid(kindDef[2])+'New '+esc(kindDef[1].toLowerCase())+'</span>'+
        '<span class="daylbl">'+esc(M.title)+'</span>'+
        '<button type="button" class="x" data-close title="Close (Esc)" aria-label="Close">'+ico(LINE_ICON.close)+'</button></div>'+
      '<h2 id="scTitle">Add to the itinerary</h2>'+
    '</header>'+
    '<div class="sc-body"><form class="sc-form" id="scForm" novalidate>'+
      '<div class="sc-kinds" role="group" aria-label="Kind of item">'+NEW_KINDS.map(([k,l,ic])=>
        '<button type="button" data-kind="'+k+'"'+(k===kind?' class="on" aria-pressed="true"':' aria-pressed="false"')+'>'+solid(ic)+esc(l)+'</button>').join('')+'</div>'+
      (err?'<div class="sc-err">'+esc(err)+'</div>':'')+fields+
      '<p class="sc-formnote">New places, pins and other details are added in the <a href="editor.html">full trip editor</a>.</p>'+
    '</form></div>'+
    '<footer class="sc-foot"><button type="button" class="sc-btn" data-cancel>Cancel</button><span class="sp"></span>'+
      '<button type="button" class="sc-btn primary" data-save>'+ico(LINE_ICON.check)+'Add</button></footer>';
  sheetCard.classList.add('editing');
  const e=$('#scForm .sc-err');
  if(e){ e.scrollIntoView({block:'nearest'}); sheetCard.focus({preventScroll:true}); return; }
  const target=$('#scForm [data-f="'+(focusField||'title')+'"]')||$('#scForm [data-f]');
  if(target){
    target.focus();
    if(!focusField && target.setSelectionRange) target.setSelectionRange(target.value.length,target.value.length);
  }
}
function setNewKind(kind){
  captureNew();
  const v=cardNew.vals, a=cardNew.auto;
  const untouched=v.start===a.start && v.end===a.end;
  v.kind=kind;
  cardNew.auto=newTimes(v);
  if(untouched) Object.assign(v,cardNew.auto);
  renderNewForm(null,null);
  const b=$('.sc-kinds [data-kind="'+kind+'"]'); if(b) b.focus();
}
function saveNew(){
  captureNew();
  const v=cardNew.vals, kind=v.kind, t=s=>String(s||'').trim();
  const missing=NEW_REQUIRED[kind].find(f=>!t(v[f]));
  if(missing){
    const label=NEW_FIELDS[kind].find(x=>x[0]===missing)[1];
    renderNewForm(missing==='title'? 'Give the item a name.' : label+' needs a date and time.');
    return;
  }
  const cfg=JSON.parse(JSON.stringify(curCfg));
  const iso=f=>t(v[f])+':00'+offIso(newZone(v,f));
  let coll, prefix, entry;
  if(kind==='travel'){
    coll='legs'; prefix='L';
    entry={mode:v.mode, from:v.from, to:v.to, dep:iso('start'), arr:iso('end'), title:t(v.title), op:t(v.op)};
  } else if(kind==='stay'){
    coll='stays'; prefix='S';
    entry={place:v.place, name:t(v.title), addr:t(v.addr), phone:t(v.phone), in:iso('start'), out:iso('end')};
  } else {
    coll='events'; prefix='E';
    entry={kind, place:v.place, title:t(v.title), start:iso('start'), end:t(v.end)? iso('end') : '', addr:t(v.addr), phone:t(v.phone)};
  }
  Object.assign(entry,{conf:t(v.conf), det:t(v.det)});
  Object.keys(entry).forEach(k=>{ if(entry[k]==null||entry[k]==='') delete entry[k]; });
  entry=Object.assign({id:freshId(cfg,prefix)},entry);
  if(!Array.isArray(cfg[coll])) cfg[coll]=[];
  cfg[coll].push(entry);
  try{ buildModel(cfg); }catch(e){ renderNewForm(e.message); return; }

  const name=persistTrip(cfg,'new item',msg=>renderNewForm(msg));
  if(!name) return;
  loadTrip(cfg,{keep:true});
  const q=$('#q');
  if(q.value){ q.value=''; q.dispatchEvent(new Event('input')); }
  const id=entry.id+(kind==='stay'?'i':''), it=M.ITEMS.find(x=>x.id===id);
  if(it){ setNowForItem(id,it.t0); focusItem(id); }
  toast('Added to “'+name+'”');
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
  const k=e.target.closest('[data-kind]');
  if(k && cardNew){ setNewKind(k.dataset.kind); return; }
  if(e.target.closest('[data-cancel]')){ if(cardNew) closeCard(); else cancelEdit(); return; }
  if(e.target.closest('[data-save]')){ if(cardNew) saveNew(); else saveEdit(); return; }
  if(e.target.closest('[data-delete]') && !cardNew){ deleteItem(); return; }
});
sheet.addEventListener('change',e=>{
  const f=cardNew && e.target.dataset.f;
  if(f==='mode'||f==='place'||f==='from'||f==='to'){ captureNew(); renderNewForm(null,f); }
});
sheet.addEventListener('submit',e=>{ e.preventDefault(); if(cardNew) saveNew(); else saveEdit(); });

/* ---------- stepping between items ----------
   Follows the itinerary list as currently filtered; an item opened from the map that the
   filter hides still gets its neighbours from the full list. */
function cardNeighbor(dir){
  if(!cardItem) return null;
  let seq=M.ITEMS.filter(it=>passes(it));
  if(!seq.includes(cardItem)) seq=M.ITEMS;
  return seq[seq.indexOf(cardItem)+dir]||null;
}
function stepCard(dir){
  const it=cardNeighbor(dir);
  if(!it) return false;
  setNowForItem(it.id,it.t0);
  focusItem(it.id);
  return true;
}
/* slide the open card out towards the swipe, swap in the neighbour, and slide that in from the far side */
function slideCard(dir){
  if(!cardNeighbor(dir)){ sheetCard.style.transform=''; sheetCard.style.opacity=''; return; }
  const w=sheetCard.offsetWidth;
  cardSliding=true;
  sheetCard.style.transform='translateX('+(-dir*w)+'px)';
  sheetCard.style.opacity='0';
  clearTimeout(cardDragTimer);
  cardDragTimer=setTimeout(()=>{
    cardSliding=false;
    if(!cardItem || !stepCard(dir)){ sheetCard.style.transform=''; sheetCard.style.opacity=''; return; }
    sheet.classList.add('dragging');
    sheetCard.style.transform='translateX('+(dir*w*.35)+'px)';
    sheetCard.style.opacity='0';
    void sheetCard.offsetWidth;
    sheet.classList.remove('dragging');
    sheetCard.style.transform=''; sheetCard.style.opacity='';
  },170);
}

/* touch, on a card being viewed (not edited or created): drag the header down to dismiss,
   or swipe anywhere on the card sideways to step to the previous / next item */
let cardSliding=false, cardSwiped=false;
sheetCard.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse' || cardEditing || cardNew || cardDrag || cardSliding || !cardItem) return;
  cardDrag={id:e.pointerId, x:e.clientX, y:e.clientY, d:0, v:0, last:0, lastT:e.timeStamp, axis:null,
            head:!!e.target.closest('.sc-head')};
});
sheetCard.addEventListener('pointermove',e=>{
  const d=cardDrag;
  if(!d || e.pointerId!==d.id) return;
  const dy=e.clientY-d.y, dx=e.clientX-d.x, ax=Math.abs(dx), ay=Math.abs(dy);
  if(!d.axis){
    if(ax>10 && ax>ay*1.2){
      d.axis='x';
      d.prev=cardNeighbor(-1); d.next=cardNeighbor(1);
    } else if(d.head && dy>8 && dy>ax) d.axis='y';
    else { if(ay>10) cardDrag=null; return; }
    sheet.classList.add('dragging');
    sheetCard.setPointerCapture(e.pointerId);
  }
  const pos=d.axis==='x'? dx : dy;
  const dt=e.timeStamp-d.lastT;
  if(dt>0) d.v=(pos-d.last)/dt;
  d.last=pos; d.lastT=e.timeStamp;
  if(d.axis==='y'){
    d.d=Math.max(0,dy);
    sheetCard.style.transform='translateY('+d.d+'px)';
    sheetBack.style.opacity=String(1-Math.min(1,d.d/sheetCard.offsetHeight));
  } else {
    d.d=dx;
    const open=dx<0? d.next : d.prev;
    const shown=open? dx : dx*.3;
    sheetCard.style.transform='translateX('+shown+'px)';
    if(open) sheetCard.style.opacity=String(1-Math.min(.6,Math.abs(dx)/sheetCard.offsetWidth));
  }
});
function endDrag(e){
  if(!cardDrag || e.pointerId!==cardDrag.id) return;
  const d=cardDrag; cardDrag=null;
  if(!d.axis) return;
  sheet.classList.remove('dragging');
  sheetBack.style.opacity='';
  cardSwiped=true; setTimeout(()=>{ cardSwiped=false; },0);
  const up=e.type==='pointerup';
  if(d.axis==='x'){
    const dir=d.d<0? 1 : -1;
    const go=up && (dir>0? d.next : d.prev) &&
      (Math.abs(d.d)>Math.min(100,sheetCard.offsetWidth*.25) || (Math.abs(d.v)>.4 && Math.abs(d.d)>30 && Math.sign(d.v)===-dir));
    if(go) slideCard(dir);
    else { sheetCard.style.transform=''; sheetCard.style.opacity=''; }
    return;
  }
  const dismiss=up && (d.d>Math.min(140,sheetCard.offsetHeight*.3) || (d.v>.5 && d.d>30));
  if(!dismiss){ sheetCard.style.transform=''; return; }
  sheetCard.style.transform='translateY(100%)';
  closeCard();
  clearTimeout(cardDragTimer);
  cardDragTimer=setTimeout(()=>{ sheetCard.style.transform=''; },260);
}
sheetCard.addEventListener('pointerup',endDrag);
sheetCard.addEventListener('pointercancel',endDrag);
/* a swipe that started on a copy row must not also copy it */
sheetCard.addEventListener('click',e=>{ if(cardSwiped){ e.stopPropagation(); e.preventDefault(); } },true);
addEventListener('keydown',e=>{
  if(!cardIsOpen()) return;
  if(e.key==='Escape'){ e.preventDefault(); if(cardEditing) cancelEdit(); else closeCard(); }
  else if(cardItem && !cardEditing && (e.key==='ArrowLeft'||e.key==='ArrowRight') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey &&
          !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)){
    e.preventDefault();
    if(!cardSliding) slideCard(e.key==='ArrowRight'? 1 : -1);
  }
  else if((cardEditing||cardNew) && e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); if(cardNew) saveNew(); else saveEdit(); }
  else if(e.key==='Tab'){
    const f=$$('a[href],button,input,textarea,select',sheetCard).filter(x=>!x.disabled && x.offsetParent!==null);
    if(!f.length) return;
    const a=f[0], z=f[f.length-1];
    if(e.shiftKey && (document.activeElement===a || document.activeElement===sheetCard)){ e.preventDefault(); z.focus(); }
    else if(!e.shiftKey && document.activeElement===z){ e.preventDefault(); a.focus(); }
  }
});
