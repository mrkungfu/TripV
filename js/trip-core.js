"use strict";
/* ============================================================
   Trip visualizer — shared core
   Helpers, config schema (normalization + validation), derived
   model building, localStorage trip library, and a best-effort
   plain-text itinerary importer.

   Everything is plain browser JS with no dependencies; this file
   is shared by index.html (viewer) and editor.html (editor).
   ============================================================ */

/* ---------- tiny DOM + time helpers ---------- */
const MIN=60000, HOUR=3600000, DAY=86400000;
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const T=iso=>Date.parse(iso);
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MON_FULL=['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const lerp=(a,b,t)=>a+(b-a)*t;

/** format an instant in a fixed UTC offset (minutes) */
function fmt(ts, off, what){
  const d=new Date(ts+off*MIN);
  const H=d.getUTCHours(), M=d.getUTCMinutes();
  const h12=(H%12)||12, ap=H<12?'am':'pm';
  const time=h12+':'+String(M).padStart(2,'0')+ap;
  const date=DOW[d.getUTCDay()]+', '+MON[d.getUTCMonth()]+' '+d.getUTCDate();
  const dateLong=DOW[d.getUTCDay()]+', '+d.getUTCDate()+' '+MON[d.getUTCMonth()]+' '+d.getUTCFullYear();
  const key=d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
  return what==='t'?time:what==='d'?date:what==='D'?dateLong:what==='k'?key:date+' '+time;
}
function tzLabel(off){
  if(off===0) return 'UTC';
  const s=off<0?'−':'+', a=Math.abs(off);
  return 'UTC'+s+(a/60|0? Math.floor(a/60):'0')+(a%60?':'+String(a%60).padStart(2,'0'):'');
}
function dur(ms){
  const m=Math.round(ms/MIN), h=Math.floor(m/60), d=Math.floor(h/24);
  if(m<60) return m+' min';
  if(h<36) return h+' h'+(m%60?' '+(m%60)+' m':'');
  return d+(d===1?' day':' days')+(h%24?' '+(h%24)+' h':'');
}
function nights(a,b){ return Math.max(1,Math.round((b-a)/DAY)); }
function haversine(a,b){
  const R=6371, p=Math.PI/180;
  const dLa=(b.lat-a.lat)*p, dLo=(b.lon-a.lon)*p;
  const s=Math.sin(dLa/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
/** great-circle interpolation */
function gcPoint(a,b,f){
  const p=Math.PI/180, r=180/Math.PI;
  const la1=a.lat*p, lo1=a.lon*p, la2=b.lat*p, lo2=b.lon*p;
  const d=2*Math.asin(Math.sqrt(Math.sin((la2-la1)/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin((lo2-lo1)/2)**2));
  if(d<1e-9) return {lat:a.lat,lon:a.lon};
  const A=Math.sin((1-f)*d)/Math.sin(d), B=Math.sin(f*d)/Math.sin(d);
  const x=A*Math.cos(la1)*Math.cos(lo1)+B*Math.cos(la2)*Math.cos(lo2);
  const y=A*Math.cos(la1)*Math.sin(lo1)+B*Math.cos(la2)*Math.sin(lo2);
  const z=A*Math.sin(la1)+B*Math.sin(la2);
  return {lat:Math.atan2(z,Math.hypot(x,y))*r, lon:Math.atan2(y,x)*r};
}
/* Web-Mercator into the same 4000-wide space the coastline data uses */
const MW=4000;
function proj(lon,lat){
  lat=clamp(lat,-84,84);
  const s=Math.sin(lat*Math.PI/180);
  return [ (lon+180)/360*MW, (0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*MW ];
}
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ---------- modes, colors, icons ---------- */
const MODE_COLOR={
  flight:'#f7b955', bus:'#3ecf8e', car:'#5aa9ff', train:'#2dd4bf', ferry:'#818cf8',
  gap:'#7a89ab', stay:'#a78bfa', activity:'#fb7185', note:'#7dd3fc'
};
const MODE_LABEL={flight:'Flight', bus:'Coach / bus', car:'Car / transfer', train:'Train', ferry:'Ferry / boat', gap:'Unbooked gap'};
const LEG_MODES=['flight','bus','car','train','ferry','gap'];
const ICON={
  flight:'M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z',
  bus:'M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4S4 2.5 4 6v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12v5z',
  car:'M18.92 6.01A1.5 1.5 0 0 0 17.5 5h-11a1.5 1.5 0 0 0-1.42 1.01L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8l-2.08-5.99zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11H5z',
  train:'M12 2c-4 0-8 .5-8 4v9.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h2.23l2-2H14l2 2h2.27v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-3.58-4-8-4zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm3.5-6H6V6h5v5zm5.5 6c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6h-5V6h5v5z',
  ferry:'M3.95 19H4c1.6 0 3.02-.88 4-2 .98 1.12 2.4 2 4 2s3.02-.88 4-2c.98 1.12 2.4 2 4 2h.05l1.89-6.68c.08-.26.06-.54-.06-.78s-.34-.42-.6-.5L20 10.62V6c0-1.1-.9-2-2-2h-3V1H9v3H6c-1.1 0-2 .9-2 2v4.62l-1.29.42c-.26.08-.48.26-.6.5s-.15.52-.06.78L3.95 19zM6 6h12v3.97L12 8 6 9.97V6z',
  bed:'M7 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9a4 4 0 0 0-4-4z',
  out:'M5 5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7v-2H5V5zm11.5 2.5-1.4 1.4L17.2 11H9v2h8.2l-2.1 2.1 1.4 1.4L21 12l-4.5-4.5z',
  star:'M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01z',
  note:'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zM7 8v2h10V8H7zm0 4v2h10v-2H7zm0 4v2h7v-2H7z',
  gap:'M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'
};
function modeIcon(m){ return ICON[m]||ICON.gap; }
const GROUND_MODES=new Set(['bus','car','train','ferry']);

/* auto-assigned place colors, cycled when a place has no explicit `c` */
const PLACE_PALETTE=['#fb923c','#60a5fa','#34d399','#f472b6','#c084fc','#fcd34d','#2dd4bf','#f87171',
  '#a3e635','#93c5fd','#fca5a5','#67e8f9','#d8b4fe','#86efac','#f0abfc','#fbbf24','#38bdf8','#fda4af'];

/* ============================================================
   Config schema → derived model
   ============================================================
   Config shape (see README.md / the editor's Schema tab):
   {
     title: "…",
     places: { key: {n, r, cc, lat, lon, off, c?, lbl?} },
     legs:   [ {id?, mode, from, to, dep, arr, title?, op?, warn?, det?} ],
     stays:  [ {id?, place, name, addr?, lat?, lon?, in, out, det?} ],
     events: [ {id?, kind?, place, title, start, end?, lat?, lon?, addr?, det?, warn?, off?} ],
     focus:  [placeKeys]?          // what the FOCUS map button fits
     calendarOffset: minutes?      // which clock defines "a day" in the calendar
   }
*/
function buildModel(raw){
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('The config must be a single object.');
  const cfg=JSON.parse(JSON.stringify(raw));
  const PLACES=cfg.places||{};
  const placeKeys=Object.keys(PLACES);
  if(!placeKeys.length) throw new Error('The config needs at least one entry in "places".');

  placeKeys.forEach((k,i)=>{
    const P=PLACES[k];
    if(!P || typeof P!=='object') throw new Error('Place "'+k+'" must be an object.');
    P.key=k;
    P.lat=+P.lat; P.lon=+P.lon; P.off=(P.off==null?0:+P.off);
    if(!isFinite(P.lat)||!isFinite(P.lon)) throw new Error('Place "'+k+'" needs numeric lat/lon.');
    if(Math.abs(P.lat)>90||Math.abs(P.lon)>180) throw new Error('Place "'+k+'": lat must be −90…90 and lon −180…180.');
    if(!isFinite(P.off)) throw new Error('Place "'+k+'": "off" (UTC offset in minutes) must be a number.');
    if(!P.n) P.n=k;
    if(P.r==null) P.r='';
    if(P.cc==null) P.cc='';
    if(!P.c) P.c=PLACE_PALETTE[i%PLACE_PALETTE.length];
  });

  const LEGS=(Array.isArray(cfg.legs)?cfg.legs:[]).map(l=>Object.assign({},l));
  if(!LEGS.length) throw new Error('The config needs at least one entry in "legs".');
  LEGS.forEach((l,i)=>{
    if(!l.id) l.id='L'+(i+1);
    if(!l.mode) l.mode='flight';
    if(!LEG_MODES.includes(l.mode)) throw new Error('Leg '+l.id+': mode "'+l.mode+'" is not one of '+LEG_MODES.join(', ')+'.');
    if(!PLACES[l.from]) throw new Error('Leg '+l.id+': "from" refers to unknown place "'+l.from+'".');
    if(!PLACES[l.to])   throw new Error('Leg '+l.id+': "to" refers to unknown place "'+l.to+'".');
    l.t0=T(l.dep); l.t1=T(l.arr);
    if(!isFinite(l.t0)) throw new Error('Leg '+l.id+': "dep" is not a parseable date ("'+l.dep+'"). Use ISO 8601 with a UTC offset, e.g. 2026-07-29T11:30:00-07:00.');
    if(!isFinite(l.t1)) throw new Error('Leg '+l.id+': "arr" is not a parseable date ("'+l.arr+'").');
    if(l.t1<l.t0) throw new Error('Leg '+l.id+' arrives before it departs.');
    l.A=PLACES[l.from]; l.B=PLACES[l.to];
    l.km=haversine(l.A,l.B); l.kind='leg';
    if(!l.title) l.title=l.A.n+' → '+l.B.n;
  });
  LEGS.sort((a,b)=>a.t0-b.t0);

  const STAYS=(Array.isArray(cfg.stays)?cfg.stays:[]).map(s=>Object.assign({},s));
  STAYS.forEach((s,i)=>{
    if(!s.id) s.id='S'+(i+1);
    if(!PLACES[s.place]) throw new Error('Stay '+s.id+' ("'+(s.name||'?')+'"): unknown place "'+s.place+'".');
    s.P=PLACES[s.place];
    s.t0=T(s.in); s.t1=T(s.out);
    if(!isFinite(s.t0)) throw new Error('Stay '+s.id+': "in" is not a parseable date ("'+s.in+'").');
    if(!isFinite(s.t1)) throw new Error('Stay '+s.id+': "out" is not a parseable date ("'+s.out+'").');
    if(s.t1<=s.t0) throw new Error('Stay '+s.id+' checks out before (or when) it checks in.');
    if(!s.name) s.name='Stay in '+s.P.n;
    if(s.lat==null) s.lat=s.P.lat; else s.lat=+s.lat;
    if(s.lon==null) s.lon=s.P.lon; else s.lon=+s.lon;
  });
  STAYS.sort((a,b)=>a.t0-b.t0);

  const EVENTS=(Array.isArray(cfg.events)?cfg.events:[]).map(e=>Object.assign({},e));
  EVENTS.forEach((e,i)=>{
    if(!e.id) e.id='E'+(i+1);
    if(!e.kind) e.kind='activity';
    if(!['activity','note','gapnote'].includes(e.kind)) throw new Error('Event '+e.id+': kind "'+e.kind+'" must be activity, note or gapnote.');
    if(!PLACES[e.place]) throw new Error('Event '+e.id+' ("'+(e.title||'?')+'"): unknown place "'+e.place+'".');
    e.P=PLACES[e.place];
    e.t0=T(e.start);
    if(!isFinite(e.t0)) throw new Error('Event '+e.id+': "start" is not a parseable date ("'+e.start+'").');
    e.t1=e.end?T(e.end):e.t0;
    if(!isFinite(e.t1)) throw new Error('Event '+e.id+': "end" is not a parseable date ("'+e.end+'").');
    if(e.t1<e.t0) throw new Error('Event '+e.id+' ends before it starts.');
    if(!e.title) e.title='Event in '+e.P.n;
  });
  EVENTS.sort((a,b)=>a.t0-b.t0);

  /* trip window: earliest note/leg/stay to the latest of them */
  const T0=Math.min(LEGS[0].t0, ...EVENTS.map(e=>e.t0), ...STAYS.map(s=>s.t0));
  const T1=Math.max(LEGS[LEGS.length-1].t1, ...EVENTS.map(e=>e.t1), ...STAYS.map(s=>s.t1));
  const TRIP_MS=Math.max(1,T1-T0);

  const originKey=LEGS[0].from;
  const originOff=PLACES[originKey].off;
  // local midnight of the departure day, in the origin's clock — day numbering anchors here
  const DAY1=Math.floor((LEGS[0].t0+originOff*MIN)/DAY)*DAY-originOff*MIN;
  const dayNo=t=>Math.max(1,Math.floor((t-DAY1)/DAY)+1);
  const TOTAL_DAYS=dayNo(T1);

  /* segments: alternating MOVE (a leg) and STAY (between legs) */
  const SEGS=[];
  LEGS.forEach((l,i)=>{
    SEGS.push({type:'move', t0:l.t0, t1:l.t1, leg:l});
    const nx=LEGS[i+1];
    if(nx && nx.t0>l.t1) SEGS.push({type:'stay', t0:l.t1, t1:nx.t0, place:l.to});
  });

  /* nights per town (marker size + label priority) */
  const NIGHTS={};
  SEGS.filter(s=>s.type==='stay').forEach(s=>{ NIGHTS[s.place]=(NIGHTS[s.place]||0)+(s.t1-s.t0)/DAY; });

  /* which clock defines a "day" for the calendar: default = the offset where
     the most time is spent (the old page hardcoded UTC+2 here) */
  let calOff=originOff;
  if(cfg.calendarOffset!=null && isFinite(+cfg.calendarOffset)){ calOff=+cfg.calendarOffset; }
  else {
    const w={}; let best=-1;
    SEGS.filter(s=>s.type==='stay').forEach(s=>{ const o=PLACES[s.place].off; w[o]=(w[o]||0)+(s.t1-s.t0); });
    Object.entries(w).forEach(([o,ms])=>{ if(ms>best){ best=ms; calOff=+o; } });
  }

  /* label placement: explicit `lbl` wins, otherwise nudge up and reveal
     big stops first ([dx, dy, anchor, zoom-tier]) */
  placeKeys.forEach(k=>{
    const P=PLACES[k];
    let l=P.lbl;
    if(Array.isArray(l)&&l.length){
      l=[ +l[0]||0, l[1]!=null? +l[1] : -11, l[2]||'middle', l[3]!=null? +l[3] : 1 ];
    } else {
      const n=NIGHTS[k]||0;
      const tier = (k===originKey||n>=6)?1 : n>=2?2 : 3;
      l=[0,-11,'middle',tier];
    }
    P.lbl=l;
  });

  /* what the FOCUS button fits: config override, else everything outside the
     origin's country (i.e. "the destination region") */
  let focusKeys=Array.isArray(cfg.focus)? cfg.focus.filter(k=>PLACES[k]) : [];
  if(!focusKeys.length) focusKeys=placeKeys.filter(k=>PLACES[k].cc!==PLACES[originKey].cc);
  if(!focusKeys.length) focusKeys=placeKeys.slice();

  function locationAt(ts){
    ts=clamp(ts,T0,T1);
    if(ts<SEGS[0].t0){ const P=LEGS[0].A; return {lat:P.lat, lon:P.lon, place:LEGS[0].from, P, moving:false}; }
    for(const s of SEGS){
      if(ts>=s.t0 && ts<=s.t1){
        if(s.type==='stay'){
          const P=PLACES[s.place];
          return {lat:P.lat, lon:P.lon, place:s.place, P, moving:false, seg:s};
        }
        const f=(ts-s.t0)/Math.max(1,(s.t1-s.t0));
        const p=gcPoint(s.leg.A, s.leg.B, f);
        return {lat:p.lat, lon:p.lon, place:(f<.5?s.leg.from:s.leg.to), P:(f<.5?s.leg.A:s.leg.B),
                moving:true, f, seg:s, leg:s.leg};
      }
    }
    const P=PLACES[LEGS[LEGS.length-1].to];
    return {lat:P.lat, lon:P.lon, place:LEGS[LEGS.length-1].to, P, moving:false};
  }

  /* flattened itinerary list */
  const ITEMS=[];
  LEGS.forEach(l=>{
    const off=l.A.off;
    ITEMS.push({
      id:l.id, t0:l.t0, t1:l.t1, off, cls:(l.mode==='gap'?'gap':l.mode==='flight'?'flight':'ground'),
      color:MODE_COLOR[l.mode], icon:modeIcon(l.mode), title:l.title, place:l.from, place2:l.to,
      sub:l.op||'', warn:l.warn, det:l.det,
      tags:[ l.mode==='gap' ? dur(l.t1-l.t0)+' unplanned' : dur(l.t1-l.t0),
             Math.round(l.km).toLocaleString()+' km',
             l.B.off!==l.A.off ? ('clocks '+(l.B.off>l.A.off?'+':'−')+Math.abs(l.B.off-l.A.off)/60+' h') : null,
             'arrive '+fmt(l.t1,l.B.off,'t')+' '+(l.B.off!==l.A.off?tzLabel(l.B.off):'') ].filter(Boolean),
      ref:l
    });
  });
  STAYS.forEach(s=>{
    const off=s.P.off, nn=nights(s.t0,s.t1);
    ITEMS.push({id:s.id+'i', t0:s.t0, t1:s.t0, off, cls:'stay', color:MODE_COLOR.stay, icon:ICON.bed,
      title:'Check in · '+s.name, place:s.place, sub:s.addr||'', det:s.det,
      tags:[nn+' night'+(nn>1?'s':''), 'out '+fmt(s.t1,off,'d')+' '+fmt(s.t1,off,'t')], ref:s});
    ITEMS.push({id:s.id+'o', t0:s.t1, t1:s.t1, off, cls:'stay', color:MODE_COLOR.stay, icon:ICON.out,
      title:'Check out · '+s.name, place:s.place, sub:s.addr||'', tags:[nn+' night'+(nn>1?'s':'')+' done'], ref:s});
  });
  EVENTS.forEach(e=>{
    const off=(e.off!=null?+e.off:e.P.off), isNote=e.kind==='note', isGap=e.kind==='gapnote';
    ITEMS.push({id:e.id, t0:e.t0, t1:e.t1, off,
      cls:isGap?'gap':'activity',
      color:isGap?MODE_COLOR.gap:isNote?MODE_COLOR.note:MODE_COLOR.activity,
      icon:isGap?ICON.gap:isNote?ICON.note:ICON.star,
      title:e.title, place:e.place, sub:e.addr||'', det:e.det, warn:e.warn,
      tags:[ e.end?('until '+fmt(e.t1,off,'t')):null, e.end?dur(e.t1-e.t0):null ].filter(Boolean),
      ref:e});
  });
  ITEMS.sort((a,b)=>a.t0-b.t0 || (a.cls==='stay'?1:0)-(b.cls==='stay'?1:0));

  return {
    config:cfg,
    title:cfg.title||'Untitled trip',
    PLACES, placeKeys, LEGS, STAYS, EVENTS, SEGS, ITEMS, NIGHTS,
    T0, T1, TRIP_MS, DAY1, TOTAL_DAYS, dayNo, locationAt,
    originKey, originOff, calOff, focusKeys
  };
}

/* structural validation: fatal problems become errors, oddities become warnings */
function validateTrip(raw){
  const errors=[], warnings=[];
  let model=null;
  try{ model=buildModel(raw); }
  catch(err){ errors.push(err.message); return {errors, warnings, model:null}; }

  const L=model.LEGS;
  for(let i=1;i<L.length;i++){
    if(L[i].from!==L[i-1].to)
      warnings.push('Leg '+L[i].id+' ("'+L[i].title+'") starts in "'+L[i].from+'" but the previous leg ended in "'+L[i-1].to+'" — the traveller will teleport. Add a connecting leg (mode "gap" works for unbooked stretches).');
    if(L[i].t0<L[i-1].t1)
      warnings.push('Leg '+L[i].id+' departs before leg '+L[i-1].id+' has arrived (overlapping legs).');
  }
  model.STAYS.forEach(s=>{
    const loc=model.locationAt((s.t0+s.t1)/2);
    if(!loc.moving && loc.place!==s.place)
      warnings.push('Stay "'+s.name+'" is tagged to "'+s.place+'" but mid-stay the legs place you in "'+loc.place+'". Check the dates or the place key.');
  });
  model.EVENTS.forEach(e=>{
    if(e.kind!=='activity') return;
    const loc=model.locationAt(e.t0);
    if(!loc.moving && loc.place!==e.place)
      warnings.push('Event "'+e.title+'" is tagged to "'+e.place+'" but at its start time the itinerary has you in "'+loc.place+'".');
  });
  const used=new Set();
  model.LEGS.forEach(l=>{ used.add(l.from); used.add(l.to); });
  model.STAYS.forEach(s=>used.add(s.place));
  model.EVENTS.forEach(e=>used.add(e.place));
  model.placeKeys.forEach(k=>{
    if(!used.has(k)) warnings.push('Place "'+k+'" is defined but never used by a leg, stay or event.');
    const off=model.PLACES[k].off;
    if(Math.abs(off)>840) warnings.push('Place "'+k+'" has a suspicious UTC offset of '+off+' minutes (should usually be between −720 and +840).');
    if(Math.abs(off)>0 && Math.abs(off)<=14 && off===Math.round(off))
      warnings.push('Place "'+k+'": off is '+off+' — offsets are in MINUTES (e.g. 120 for UTC+2), did you mean '+(off*60)+'?');
  });
  return {errors, warnings, model};
}

/* accept strict JSON first, then a relaxed JS object literal (handy when
   pasting data straight out of an old <script> block) */
function parseTripConfigText(text){
  const t=String(text||'').trim();
  if(!t) throw new Error('Nothing to parse — the input is empty.');
  try{ return JSON.parse(t); }
  catch(jsonErr){
    try{ return (new Function('"use strict";return ('+t+');'))(); }
    catch(jsErr){ throw new Error('Could not parse as JSON ('+jsonErr.message+') nor as a JS object literal ('+jsErr.message+').'); }
  }
}

/* ============================================================
   Trip library (localStorage)
   ============================================================ */
const TripStore={
  KEY:'tripviz.trips', ACTIVE:'tripviz.active',
  _all(){ try{ return JSON.parse(localStorage.getItem(this.KEY))||{}; }catch(e){ return {}; } },
  names(){ return Object.keys(this._all()).sort((a,b)=>a.localeCompare(b)); },
  get(name){ return this._all()[name]||null; },
  save(name,cfg){ const a=this._all(); a[name]=cfg; localStorage.setItem(this.KEY,JSON.stringify(a)); },
  remove(name){
    const a=this._all(); delete a[name]; localStorage.setItem(this.KEY,JSON.stringify(a));
    if(this.active()===name) localStorage.removeItem(this.ACTIVE);
  },
  active(){ return localStorage.getItem(this.ACTIVE)||''; },
  setActive(name){ if(name) localStorage.setItem(this.ACTIVE,name); else localStorage.removeItem(this.ACTIVE); }
};

/* ============================================================
   Best-effort plain-text itinerary importer (TripIt-style)
   ============================================================
   Feeds on the plain text you get from TripIt's print / plain-text
   itinerary view (or forwarded confirmation summaries). It extracts:
     - flights     time line + "PHX → DTW" + "DL 1070 (Delta Air Lines)"
                   + "Arrive Detroit (DTW)" blocks, incl. gates/layovers
     - ground legs "FlixBus - A → B" (or "X Driver To Y") titles with
                   Depart/Arrive lines → bus / car / train / ferry
     - lodging     "Check In <name>" / "Check Out <name>" pairs, with
                   addresses and note lines (PIN codes etc.) kept as det
     - activities  a time line followed by a plain title, an optional
                   address line, "Until 9:00 PM GMT+2", and note lines
   Timezone labels after times ("MST", "GMT+2") are honoured; forwarded
   confirmation emails pasted inside the itinerary are skipped.
   Coordinates come from the AIRPORTS and CITIES tables below — nothing
   is geocoded. Unknown spots get lat/lon 0,0 plus a report entry.
   Anything the importer assumes (years, placeholder arrival times) is
   reported, not silently guessed.
*/
const AIRPORTS={
  ATL:{n:'Atlanta',lat:33.6407,lon:-84.4277,off:-240,cc:'USA'}, BOS:{n:'Boston',lat:42.3656,lon:-71.0096,off:-240,cc:'USA'},
  DEN:{n:'Denver',lat:39.8561,lon:-104.6737,off:-360,cc:'USA'}, DFW:{n:'Dallas',lat:32.8998,lon:-97.0403,off:-300,cc:'USA'},
  DTW:{n:'Detroit',lat:42.2124,lon:-83.3534,off:-240,cc:'USA'}, EWR:{n:'Newark',lat:40.6895,lon:-74.1745,off:-240,cc:'USA'},
  IAD:{n:'Washington',lat:38.9531,lon:-77.4565,off:-240,cc:'USA'}, JFK:{n:'New York',lat:40.6413,lon:-73.7781,off:-240,cc:'USA'},
  LAX:{n:'Los Angeles',lat:33.9416,lon:-118.4085,off:-420,cc:'USA'}, MIA:{n:'Miami',lat:25.7959,lon:-80.2870,off:-240,cc:'USA'},
  ORD:{n:'Chicago',lat:41.9742,lon:-87.9073,off:-300,cc:'USA'}, PHX:{n:'Phoenix',lat:33.4342,lon:-112.0116,off:-420,cc:'USA'},
  SEA:{n:'Seattle',lat:47.4502,lon:-122.3088,off:-420,cc:'USA'}, SFO:{n:'San Francisco',lat:37.6213,lon:-122.3790,off:-420,cc:'USA'},
  YVR:{n:'Vancouver',lat:49.1967,lon:-123.1815,off:-420,cc:'Canada'}, YYZ:{n:'Toronto',lat:43.6777,lon:-79.6248,off:-240,cc:'Canada'},
  MEX:{n:'Mexico City',lat:19.4361,lon:-99.0719,off:-360,cc:'Mexico'}, GRU:{n:'São Paulo',lat:-23.4356,lon:-46.4731,off:-180,cc:'Brazil'},
  EZE:{n:'Buenos Aires',lat:-34.8222,lon:-58.5358,off:-180,cc:'Argentina'},
  LHR:{n:'London',lat:51.4700,lon:-0.4543,off:60,cc:'UK'}, LGW:{n:'London Gatwick',lat:51.1537,lon:-0.1821,off:60,cc:'UK'},
  STN:{n:'London Stansted',lat:51.8860,lon:0.2389,off:60,cc:'UK'}, MAN:{n:'Manchester',lat:53.3650,lon:-2.2724,off:60,cc:'UK'},
  DUB:{n:'Dublin',lat:53.4264,lon:-6.2499,off:60,cc:'Ireland'}, CDG:{n:'Paris',lat:49.0097,lon:2.5479,off:120,cc:'France'},
  AMS:{n:'Amsterdam',lat:52.3105,lon:4.7683,off:120,cc:'Netherlands'}, BRU:{n:'Brussels',lat:50.9010,lon:4.4844,off:120,cc:'Belgium'},
  FRA:{n:'Frankfurt',lat:50.0379,lon:8.5622,off:120,cc:'Germany'}, MUC:{n:'Munich',lat:48.3538,lon:11.7861,off:120,cc:'Germany'},
  BER:{n:'Berlin',lat:52.3667,lon:13.5033,off:120,cc:'Germany'}, ZRH:{n:'Zürich',lat:47.4582,lon:8.5555,off:120,cc:'Switzerland'},
  GVA:{n:'Geneva',lat:46.2381,lon:6.1090,off:120,cc:'Switzerland'}, VIE:{n:'Vienna',lat:48.1103,lon:16.5697,off:120,cc:'Austria'},
  PRG:{n:'Prague',lat:50.1008,lon:14.2632,off:120,cc:'Czechia'}, BUD:{n:'Budapest',lat:47.4298,lon:19.2611,off:120,cc:'Hungary'},
  WAW:{n:'Warsaw',lat:52.1672,lon:20.9679,off:120,cc:'Poland'}, CPH:{n:'Copenhagen',lat:55.6180,lon:12.6508,off:120,cc:'Denmark'},
  ARN:{n:'Stockholm',lat:59.6498,lon:17.9238,off:120,cc:'Sweden'}, OSL:{n:'Oslo',lat:60.1976,lon:11.1004,off:120,cc:'Norway'},
  HEL:{n:'Helsinki',lat:60.3183,lon:24.9497,off:180,cc:'Finland'}, MAD:{n:'Madrid',lat:40.4983,lon:-3.5676,off:120,cc:'Spain'},
  BCN:{n:'Barcelona',lat:41.2971,lon:2.0785,off:120,cc:'Spain'}, LIS:{n:'Lisbon',lat:38.7742,lon:-9.1342,off:60,cc:'Portugal'},
  FCO:{n:'Rome',lat:41.8003,lon:12.2389,off:120,cc:'Italy'}, CIA:{n:'Rome Ciampino',lat:41.7994,lon:12.5949,off:120,cc:'Italy'},
  MXP:{n:'Milan',lat:45.6306,lon:8.7281,off:120,cc:'Italy'}, ATH:{n:'Athens',lat:37.9364,lon:23.9445,off:180,cc:'Greece'},
  IST:{n:'Istanbul',lat:41.2753,lon:28.7519,off:180,cc:'Türkiye'}, SAW:{n:'Istanbul Sabiha',lat:40.8986,lon:29.3092,off:180,cc:'Türkiye'},
  TIA:{n:'Tirana',lat:41.4147,lon:19.7206,off:120,cc:'Albania'}, KUT:{n:'Kutaisi',lat:42.1770,lon:42.4826,off:240,cc:'Georgia'},
  TBS:{n:'Tbilisi',lat:41.6692,lon:44.9547,off:240,cc:'Georgia'}, EVN:{n:'Yerevan',lat:40.1473,lon:44.3959,off:240,cc:'Armenia'},
  DXB:{n:'Dubai',lat:25.2532,lon:55.3657,off:240,cc:'UAE'}, DOH:{n:'Doha',lat:25.2731,lon:51.6081,off:180,cc:'Qatar'},
  DEL:{n:'Delhi',lat:28.5562,lon:77.1000,off:330,cc:'India'}, BOM:{n:'Mumbai',lat:19.0896,lon:72.8656,off:330,cc:'India'},
  BKK:{n:'Bangkok',lat:13.6900,lon:100.7501,off:420,cc:'Thailand'}, SIN:{n:'Singapore',lat:1.3644,lon:103.9915,off:480,cc:'Singapore'},
  HKG:{n:'Hong Kong',lat:22.3080,lon:113.9185,off:480,cc:'Hong Kong'}, PVG:{n:'Shanghai',lat:31.1443,lon:121.8083,off:480,cc:'China'},
  PEK:{n:'Beijing',lat:40.0799,lon:116.6031,off:480,cc:'China'}, ICN:{n:'Seoul',lat:37.4602,lon:126.4407,off:540,cc:'South Korea'},
  NRT:{n:'Tokyo Narita',lat:35.7720,lon:140.3929,off:540,cc:'Japan'}, HND:{n:'Tokyo',lat:35.5494,lon:139.7798,off:540,cc:'Japan'},
  KIX:{n:'Osaka',lat:34.4347,lon:135.2441,off:540,cc:'Japan'}, FUK:{n:'Fukuoka',lat:33.5859,lon:130.4510,off:540,cc:'Japan'},
  SYD:{n:'Sydney',lat:-33.9399,lon:151.1753,off:600,cc:'Australia'}, MEL:{n:'Melbourne',lat:-37.6690,lon:144.8410,off:600,cc:'Australia'},
  AKL:{n:'Auckland',lat:-37.0082,lon:174.7850,off:720,cc:'New Zealand'}
};

/* City coordinates for ground transport, lodging and activities. The
   importer scans station names / street addresses for these names
   (accent-insensitive, whole words, longest match wins). `off` is the
   typical summer UTC offset in minutes, matching the AIRPORTS table. */
const CITIES={
  Frankfurt:{lat:50.1109,lon:8.6821,off:120,cc:'Germany'},
  Munich:{lat:48.1351,lon:11.5820,off:120,cc:'Germany',aka:['München','Muenchen']},
  Berlin:{lat:52.5200,lon:13.4050,off:120,cc:'Germany'},
  Heidelberg:{lat:49.3988,lon:8.6724,off:120,cc:'Germany'},
  Cologne:{lat:50.9375,lon:6.9603,off:120,cc:'Germany',aka:['Köln','Koeln']},
  Hamburg:{lat:53.5511,lon:9.9937,off:120,cc:'Germany'},
  Vienna:{lat:48.2082,lon:16.3738,off:120,cc:'Austria',aka:['Wien']},
  Salzburg:{lat:47.8095,lon:13.0550,off:120,cc:'Austria'},
  Linz:{lat:48.3069,lon:14.2858,off:120,cc:'Austria'},
  Innsbruck:{lat:47.2692,lon:11.4041,off:120,cc:'Austria'},
  Budapest:{lat:47.4979,lon:19.0402,off:120,cc:'Hungary'},
  Prague:{lat:50.0755,lon:14.4378,off:120,cc:'Czechia',aka:['Praha']},
  Bratislava:{lat:48.1486,lon:17.1077,off:120,cc:'Slovakia'},
  Krakow:{lat:50.0647,lon:19.9450,off:120,cc:'Poland',aka:['Kraków']},
  Warsaw:{lat:52.2297,lon:21.0122,off:120,cc:'Poland',aka:['Warszawa']},
  Rome:{lat:41.9028,lon:12.4964,off:120,cc:'Italy',aka:['Roma']},
  Florence:{lat:43.7696,lon:11.2558,off:120,cc:'Italy',aka:['Firenze']},
  Venice:{lat:45.4408,lon:12.3155,off:120,cc:'Italy',aka:['Venezia']},
  Milan:{lat:45.4642,lon:9.1900,off:120,cc:'Italy',aka:['Milano']},
  Naples:{lat:40.8518,lon:14.2681,off:120,cc:'Italy',aka:['Napoli']},
  Paris:{lat:48.8566,lon:2.3522,off:120,cc:'France'},
  Nice:{lat:43.7102,lon:7.2620,off:120,cc:'France'},
  Madrid:{lat:40.4168,lon:-3.7038,off:120,cc:'Spain'},
  Barcelona:{lat:41.3874,lon:2.1686,off:120,cc:'Spain'},
  Seville:{lat:37.3891,lon:-5.9845,off:120,cc:'Spain',aka:['Sevilla']},
  Lisbon:{lat:38.7223,lon:-9.1393,off:60,cc:'Portugal',aka:['Lisboa']},
  Porto:{lat:41.1579,lon:-8.6291,off:60,cc:'Portugal'},
  London:{lat:51.5074,lon:-0.1278,off:60,cc:'UK'},
  Oxford:{lat:51.7520,lon:-1.2577,off:60,cc:'UK'},
  Bristol:{lat:51.4545,lon:-2.5879,off:60,cc:'UK'},
  Edinburgh:{lat:55.9533,lon:-3.1883,off:60,cc:'UK'},
  Dublin:{lat:53.3498,lon:-6.2603,off:60,cc:'Ireland'},
  Amsterdam:{lat:52.3676,lon:4.9041,off:120,cc:'Netherlands'},
  Brussels:{lat:50.8503,lon:4.3517,off:120,cc:'Belgium'},
  Bruges:{lat:51.2093,lon:3.2247,off:120,cc:'Belgium',aka:['Brugge']},
  Zurich:{lat:47.3769,lon:8.5417,off:120,cc:'Switzerland',aka:['Zürich']},
  Geneva:{lat:46.2044,lon:6.1432,off:120,cc:'Switzerland',aka:['Genève']},
  Copenhagen:{lat:55.6761,lon:12.5683,off:120,cc:'Denmark',aka:['København']},
  Stockholm:{lat:59.3293,lon:18.0686,off:120,cc:'Sweden'},
  Oslo:{lat:59.9139,lon:10.7522,off:120,cc:'Norway'},
  Helsinki:{lat:60.1699,lon:24.9384,off:180,cc:'Finland'},
  Athens:{lat:37.9838,lon:23.7275,off:180,cc:'Greece'},
  Istanbul:{lat:41.0082,lon:28.9784,off:180,cc:'Türkiye'},
  Zagreb:{lat:45.8150,lon:15.9819,off:120,cc:'Croatia'},
  Split:{lat:43.5081,lon:16.4402,off:120,cc:'Croatia'},
  Dubrovnik:{lat:42.6507,lon:18.0944,off:120,cc:'Croatia'},
  Ljubljana:{lat:46.0569,lon:14.5058,off:120,cc:'Slovenia'},
  Tbilisi:{lat:41.7151,lon:44.8271,off:240,cc:'Georgia',aka:["T'bilisi",'Tiflis']},
  Kutaisi:{lat:42.2679,lon:42.6946,off:240,cc:'Georgia'},
  Mestia:{lat:43.0453,lon:42.7278,off:240,cc:'Georgia'},
  Batumi:{lat:41.6168,lon:41.6367,off:240,cc:'Georgia'},
  Yerevan:{lat:40.1792,lon:44.4991,off:240,cc:'Armenia'},
  'New York':{lat:40.7128,lon:-74.0060,off:-240,cc:'USA',aka:['NYC']},
  Phoenix:{lat:33.4484,lon:-112.0740,off:-420,cc:'USA'}
};

/* UTC offsets (minutes) for the timezone labels TripIt prints after
   times, e.g. "10:52 AM MST" or "9:43 AM GMT+2". DST variants are
   distinct labels, so no timezone database is needed. */
const TZ_ABBR={
  UT:0, UTC:0, GMT:0, WET:0, Z:0,
  WEST:60, BST:60, CET:60,
  CEST:120, EET:120, SAST:120,
  EEST:180, MSK:180, TRT:180,
  GST:240, PKT:300, IST:330, ICT:420, WIB:420, HKT:480, SGT:480,
  JST:540, KST:540, ACST:570, AEST:600, AEDT:660, NZST:720, NZDT:780,
  EST:-300, EDT:-240, CST:-360, CDT:-300, MST:-420, MDT:-360,
  PST:-480, PDT:-420, AKST:-540, AKDT:-480, HST:-600,
  AST:-240, ADT:-180, NST:-210, NDT:-150
};

function parseItineraryText(text){
  const report=[], places={};
  const legsRaw=[], staysRaw=[], eventsRaw=[];
  const lines=String(text||'').split(/\r?\n/).map(s=>s.replace(/\u00a0/g,' ').trim());
  const MONTHS={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const MONTH_RE='jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const nowYear=new Date().getFullYear();
  const DET_MAX=12;
  const unknownTz=new Set(), unknownPlaces=new Set();
  let skippedFwd=0, assumedYear=0;

  /* ---------- dates ---------- */
  function findDate(s){
    let m=s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if(m) return {y:+m[1], mo:+m[2]-1, d:+m[3]};
    m=s.match(new RegExp('\\b('+MONTH_RE+')[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?','i'));
    if(m) return {y:m[3]?+m[3]:null, mo:MONTHS[m[1].slice(0,3).toLowerCase()], d:+m[2]};
    m=s.match(new RegExp('\\b(\\d{1,2})\\s+('+MONTH_RE+')[a-z]*\\.?(?:\\s+(\\d{4}))?','i'));
    if(m) return {y:m[3]?+m[3]:null, mo:MONTHS[m[2].slice(0,3).toLowerCase()], d:+m[1]};
    return null;
  }
  /* a line that is ONLY a date — TripIt's "Wed, Jul 29" day headers,
     or standalone "Jul 29, 2026" / "2026-07-29" lines */
  const BARE_DATE_RE=new RegExp(
    '^(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?,?\\s+)?'+
    '(?:(?:'+MONTH_RE+')[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}\\s+(?:'+MONTH_RE+')[a-z]*\\.?|\\d{4}-\\d{2}-\\d{2})'+
    '(?:,?\\s*\\d{4})?$','i');
  let lastYmd=null;
  function withYear(dt){ // TripIt day headers carry no year — infer it, assuming chronological order
    if(dt.y==null){
      let y=lastYmd? lastYmd.y : nowYear;
      if(!lastYmd) assumedYear=y;
      else if(Date.UTC(y,dt.mo,dt.d)<Date.UTC(lastYmd.y,lastYmd.mo,lastYmd.d)-2*DAY) y++;
      dt.y=y;
    }
    lastYmd=dt;
    return dt;
  }
  function inlineDate(dd){ // a date found inside a depart/arrive/check line
    if(!dd) return null;
    if(dd.y==null) dd.y=curDate? curDate.y : (lastYmd? lastYmd.y : nowYear);
    return dd;
  }

  /* ---------- times & timezones ---------- */
  const TIME_SRC='(\\d{1,2}):(\\d{2})\\s*(am|pm)?(?:\\s*(?:(?:GMT|UTC)\\s*([+-]\\d{1,2})(?::?(\\d{2}))?|([A-Za-z]{2,5})\\b))?';
  const TIMELINE_RE=new RegExp('^'+TIME_SRC+'$','i');
  const UNTIL_RE=new RegExp('^until\\s+'+TIME_SRC+'\\s*$','i');
  const TIME_ANY_RE=new RegExp('\\b'+TIME_SRC,'i');
  function timeFrom(m){
    let h=+m[1]; const min=+m[2];
    if(h>23||min>59) return null;
    const ap=m[3]&&m[3].toLowerCase();
    if(ap==='pm'&&h<12)h+=12;
    if(ap==='am'&&h===12)h=0;
    let off=null, tzWord=null;
    if(m[4]!=null){
      const sign=m[4].charAt(0)==='-'?-1:1;
      off=(+m[4])*60+sign*(+(m[5]||0));
    } else if(m[6]){
      tzWord=m[6];
      if(tzWord===tzWord.toUpperCase() && TZ_ABBR[tzWord]!=null) off=TZ_ABBR[tzWord];
    }
    return {h,min,off,tzWord};
  }
  function cleanTime(m){ // for anchored time lines: a lowercase trailing word means it wasn't a time line
    const t=timeFrom(m);
    if(!t) return null;
    if(t.tzWord && t.off==null){
      if(t.tzWord!==t.tzWord.toUpperCase()) return null;
      unknownTz.add(t.tzWord);
    }
    return t;
  }
  function findTimeAny(s){ const m=s.match(TIME_ANY_RE); return m? timeFrom(m):null; }

  /* ---------- ISO helpers ---------- */
  function isoLocal(dt,tm){
    const p=n=>String(n).padStart(2,'0');
    return dt.y+'-'+p(dt.mo+1)+'-'+p(dt.d)+'T'+p(tm?tm.h:12)+':'+p(tm?tm.min:0)+':00';
  }
  function offStr(off){
    const s=off<0?'-':'+', a=Math.abs(off);
    return s+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0');
  }
  function isoFromTs(ts,off){
    const d=new Date(ts+off*MIN), p=n=>String(n).padStart(2,'0');
    return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+
      'T'+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':00'+offStr(off);
  }

  /* ---------- places ---------- */
  function normPlaceName(s){
    return String(s==null?'':s).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[\u2019'`]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  }
  function findCityIn(text){ // scan an address / station name for a known city (longest match wins)
    if(!text) return null;
    const hay=' '+normPlaceName(text)+' ';
    let best=null, bestLen=0;
    Object.keys(CITIES).forEach(name=>{
      const info=CITIES[name];
      [name].concat(info.aka||[]).forEach(alias=>{
        const n=normPlaceName(alias);
        if(n.length<=bestLen) return;
        let i=hay.indexOf(n);
        while(i>=0){
          if(!/[a-z0-9]/.test(hay.charAt(i-1)) && !/[a-z0-9]/.test(hay.charAt(i+n.length))){
            best={name,info}; bestLen=n.length; break;
          }
          i=hay.indexOf(n,i+1);
        }
      });
    });
    return best;
  }
  function findPlaceByName(name){ // reuse an existing place: exact name first, containment second
    const nn=normPlaceName(name);
    if(!nn) return null;
    const keys=Object.keys(places);
    for(let i=0;i<keys.length;i++) if(normPlaceName(places[keys[i]].n)===nn) return keys[i];
    for(let i=0;i<keys.length;i++){
      const pn=normPlaceName(places[keys[i]].n);
      if(pn.length>3&&nn.length>3&&(pn.indexOf(nn)>=0||nn.indexOf(pn)>=0)) return keys[i];
    }
    return null;
  }
  function slugKey(name){
    const base=normPlaceName(name).replace(/[^a-z0-9]+/g,'').slice(0,12)||'place';
    let k=base, i=2;
    while(places[k]) k=base+(i++);
    return k;
  }
  function ensureAirport(code,obsOff){
    const ap=AIRPORTS[code.toUpperCase()];
    if(ap){
      const hit=findPlaceByName(ap.n);
      if(hit) return hit;
      const key=code.toLowerCase();
      if(!places[key]) places[key]={n:ap.n, r:'', cc:ap.cc, lat:ap.lat, lon:ap.lon, off:(obsOff!=null?obsOff:ap.off)};
      return key;
    }
    const key=code.toLowerCase();
    if(!places[key]){
      places[key]={n:code+' (TODO: name)', r:'', cc:'TODO', lat:0, lon:0, off:(obsOff!=null?obsOff:0)};
      unknownPlaces.add(code);
    }
    return key;
  }
  function ensureCity(hit,obsOff){
    const found=findPlaceByName(hit.name);
    if(found) return found;
    const key=slugKey(hit.name);
    places[key]={n:hit.name, r:'', cc:hit.info.cc, lat:hit.info.lat, lon:hit.info.lon,
                 off:(obsOff!=null?obsOff:hit.info.off)};
    return key;
  }
  function ensureStub(name,obsOff){
    const clean=String(name).replace(/\s+/g,' ').trim().slice(0,40);
    const found=findPlaceByName(clean);
    if(found) return found;
    const key=slugKey(clean);
    places[key]={n:clean, r:'', cc:'TODO', lat:0, lon:0, off:(obsOff!=null?obsOff:0)};
    unknownPlaces.add(clean);
    return key;
  }
  function resolvePlace(cands,obsOff,fallbackKey){
    for(let i=0;i<cands.length;i++){
      const hit=findCityIn(cands[i]);
      if(hit) return ensureCity(hit,obsOff);
    }
    if(fallbackKey) return fallbackKey;
    for(let i=0;i<cands.length;i++)
      if(cands[i]&&cands[i].trim()) return ensureStub(cands[i],obsOff);
    return null;
  }
  function offOf(key){ return places[key]? places[key].off : 0; }

  /* ---------- parser state ---------- */
  let curDate=null;      // date of the current "Wed, Jul 29" block
  let pendingTime=null;  // {d,t,off} — a standalone time line waiting for its item
  let trans=null;        // flight or ground leg being assembled
  let act=null;          // activity being assembled
  let detTarget=null;    // finished/ongoing item that stray note lines annotate
  let curKey=null;       // where the traveller is after the last completed leg
  let lastName='';       // legacy format: bare line remembered as a lodging name
  let skipFwd=false;     // inside a forwarded confirmation email
  const openStays={};    // normalized lodging name -> queue of stays awaiting check-out

  function pushDet(o,s){
    if(!o||!o.det) return;
    s=String(s).replace(/\[\[TripItALT:[^\]]*\]\]/g,'').trim();
    if(!s||/^courtesy of tripit/i.test(s)) return;
    if(o.addr===s) return;
    if(o.det.length>DET_MAX) return;
    if(o.det.length===DET_MAX){ o.det.push('… (more lines trimmed)'); return; }
    if(o.det.indexOf(s)<0) o.det.push(s);
  }
  function isAddressy(s){
    return s.length<120 && /\d/.test(s) && /,/.test(s) &&
      !/^(pin|code|order|seat|until|gate|terminal)\b/i.test(s);
  }
  function splitTitle(title){ // "GoTrip - Mestia → Kutaisi" / "Saba Driver To Mestia" endpoints
    let m=title.match(/^(.*?)(?:→|->)(.*)$/);
    if(m) return [m[1],m[2]];
    m=title.match(/^(.*\S)\s+to\s+(\S.*)$/i);
    if(m) return [m[1],m[2]];
    return [null,null];
  }
  function groundMode(s){
    if(/flix|\bbus\b|coach|autobus/i.test(s)) return 'bus';
    if(/ferry|\bboat\b|cruise/i.test(s)) return 'ferry';
    if(/train|railjet|\brail\b|bahn|\bzug\b|eurostar|amtrak/i.test(s)) return 'train';
    return 'car';
  }

  function pushLeg(t){
    if(!t) return;
    const label=t.title||t.op||'transport';
    if(!t.depD){ report.push('Dropped "'+label+'" — no departure date in scope.'); return; }
    let fk,tk;
    if(t.isFlight){
      if(!t.fromCode||!t.toCode){ report.push('Dropped incomplete flight "'+label+'" — missing the '+(!t.fromCode?'origin':'destination')+' airport code.'); return; }
      fk=ensureAirport(t.fromCode,t.depOff);
      tk=ensureAirport(t.toCode,t.arrOff);
    } else {
      fk=resolvePlace([t.fromAddr,t.fromTitle],t.depOff,curKey);
      tk=resolvePlace([t.toAddr,t.toTitle],(t.arrOff!=null?t.arrOff:t.depOff),null)||fk;
      if(!fk){ report.push('Dropped "'+label+'" — could not tell where it starts or ends.'); return; }
    }
    const depOff=(t.depOff!=null?t.depOff:offOf(fk));
    const arrOff=(t.arrOff!=null?t.arrOff:offOf(tk));
    const depIso=isoLocal(t.depD,t.depT)+offStr(depOff);
    const depTs=Date.parse(depIso);
    const title=t.title||((t.fromCode||places[fk].n)+' → '+(t.toCode||places[tk].n));
    /* TripIt prints "12:00 AM" when a ground arrival time is unknown */
    const placeholder=!t.isFlight&&t.arrT&&t.arrT.h===0&&t.arrT.min===0;
    let arrTs, note=null;
    if(!t.arrT||placeholder){
      arrTs=depTs+2*HOUR;
      note=placeholder?'the arrival time looked like a TripIt placeholder (12:00 AM) — assumed a 2 h ride'
                      :'no arrival time found — assumed 2 h';
    } else {
      arrTs=Date.parse(isoLocal(t.arrD||t.depD,t.arrT)+offStr(arrOff));
      if(arrTs<depTs){ // clock wrapped past midnight with no new day header — assume overnight
        arrTs+=DAY; note='arrival assumed to be the next day (overnight)';
        if(arrTs<depTs){ arrTs=depTs+2*HOUR; note='arrival was before departure — assumed a 2 h leg'; }
      }
    }
    if(note) report.push('"'+title+'": '+note+' — fix "arr" in the draft.');
    const rec={mode:t.mode, from:fk, to:tk, dep:depIso, arr:isoFromTs(arrTs,arrOff),
               title:title, op:t.op||'', det:t.det||[]};
    legsRaw.push(rec);
    curKey=tk;
    detTarget=rec;
  }
  function flushTrans(){ const t=trans; trans=null; if(t) pushLeg(t); }
  function flushAct(){
    const a=act; act=null;
    if(!a) return;
    if(!a.d){ report.push('Skipped "'+a.title+'" — no date in scope.'); return; }
    eventsRaw.push(a);
  }

  function restIsJustDate(rest,dd){ // legacy "Check-in: Jul 30, 2026 3:00pm" vs "Check In <name>"
    if(!dd) return false;
    const stripped=rest
      .replace(new RegExp('\\b('+MONTH_RE+')[a-z]*\\.?','gi'),'')
      .replace(/\b(am|pm|at|noon|midnight)\b/gi,'')
      .replace(/[\d:,.\-\/\s]+/g,'');
    return stripped.length<=2;
  }
  function handleCheckIn(rest){
    flushAct(); flushTrans();
    rest=rest.trim();
    const dd=findDate(rest);
    let st;
    if(restIsJustDate(rest,dd)){
      const t2=findTimeAny(rest);
      st={name:lastName||'TODO: lodging name', inD:inlineDate(dd),
          inT:t2?{h:t2.h,min:t2.min}:{h:15,min:0}, inOff:t2?t2.off:null,
          det:[], addr:null, expectAddr:false, placeHint:curKey};
    } else {
      st={name:rest||lastName||'TODO: lodging name',
          inD:(pendingTime?pendingTime.d:curDate),
          inT:pendingTime?pendingTime.t:{h:15,min:0},
          inOff:pendingTime?pendingTime.off:null,
          det:[], addr:null, expectAddr:true, placeHint:curKey};
    }
    if(!st.inD){ report.push('Skipped a check-in ("'+st.name+'") — no date in scope.'); return; }
    const k=normPlaceName(st.name);
    if(!openStays[k]) openStays[k]=[];
    openStays[k].push(st);
    staysRaw.push(st);
    pendingTime=null; detTarget=st;
  }
  function handleCheckOut(rest){
    flushAct(); flushTrans();
    rest=rest.trim();
    const dd=findDate(rest);
    let name=rest, outD, outT, outOff;
    if(restIsJustDate(rest,dd)){
      const t2=findTimeAny(rest);
      name=''; outD=inlineDate(dd);
      outT=t2?{h:t2.h,min:t2.min}:{h:11,min:0}; outOff=t2?t2.off:null;
    } else {
      outD=(pendingTime?pendingTime.d:curDate);
      outT=pendingTime?pendingTime.t:{h:11,min:0};
      outOff=pendingTime?pendingTime.off:null;
    }
    let st=null;
    const k=normPlaceName(name);
    if(name&&openStays[k]&&openStays[k].length) st=openStays[k].shift();
    if(!st){
      const openKeys=Object.keys(openStays).filter(kk=>openStays[kk].length);
      if(!name&&openKeys.length){ // legacy: unnamed check-out closes the oldest open stay
        let bk=openKeys[0];
        openKeys.forEach(kk=>{
          const a=openStays[kk][0], b=openStays[bk][0];
          if(Date.UTC(a.inD.y,a.inD.mo,a.inD.d)<Date.UTC(b.inD.y,b.inD.mo,b.inD.d)) bk=kk;
        });
        st=openStays[bk].shift();
      } else if(openKeys.length===1&&openStays[openKeys[0]].length===1){
        st=openStays[openKeys[0]].shift(); // only one candidate — a near-miss name
      }
    }
    if(!st){
      st={name:name||'TODO: lodging name', inD:null, inT:null, inOff:null,
          det:[], addr:null, expectAddr:true, placeHint:curKey};
      staysRaw.push(st);
      report.push('Check-out of "'+st.name+'" had no matching check-in — assumed a 1-night stay.');
    }
    if(outD){ st.outD=outD; st.outT=outT; st.outOff=outOff; }
    pendingTime=null; detTarget=st;
  }

  /* ---------- the line scanner ---------- */
  lines.forEach(line=>{
    if(!line){
      if(act) act.expectAddr=false;
      if(detTarget&&detTarget.expectAddr) detTarget.expectAddr=false;
      return;
    }
    // forwarded confirmation emails pasted into the itinerary: skip until the next day header
    if(/^-{3,}\s*forwarded message/i.test(line)){ skipFwd=true; skippedFwd++; return; }
    if(skipFwd&&!BARE_DATE_RE.test(line)) return;

    // day headers: "Wed, Jul 29" (TripIt) or "Jul 29, 2026" (legacy)
    if(BARE_DATE_RE.test(line)){
      const dd=findDate(line);
      if(dd){ skipFwd=false; curDate=withYear(dd); pendingTime=null; flushAct(); detTarget=null; return; }
    }
    if(skipFwd) return;

    // standalone time line — starts (or completes) a timed item
    let m=line.match(TIMELINE_RE);
    if(m){
      const t=cleanTime(m);
      if(t){ flushAct(); pendingTime={d:curDate, t:{h:t.h,min:t.min}, off:t.off}; return; }
    }

    // "Until 9:00 PM GMT+2" — the end time of the open activity
    m=line.match(UNTIL_RE);
    if(m){
      const t=cleanTime(m);
      if(t&&act){ act.endD=curDate; act.endT={h:t.h,min:t.min}; act.endOff=t.off; }
      else if(t&&detTarget) pushDet(detTarget,line);
      return;
    }

    // lodging
    m=line.match(/^check[\s-]?in\b:?\s*(.*)$/i);
    if(m){ handleCheckIn(m[1]); return; }
    m=line.match(/^check[\s-]?out\b:?\s*(.*)$/i);
    if(m){ handleCheckOut(m[1]); return; }

    // flight routes: "PHX → DTW" / "PHX to DTW"
    m=line.match(/^([A-Z]{3})\s*(?:→|->|—|–|-|to)\s*([A-Z]{3})$/);
    if(m&&m[1]!==m[2]){
      flushAct();
      if(trans&&trans.isFlight&&!trans.fromCode){
        trans.fromCode=m[1]; trans.toCode=m[2];
        if(!trans.title) trans.title=m[1]+' → '+m[2];
      } else {
        flushTrans();
        trans={isFlight:true, mode:'flight', fromCode:m[1], toCode:m[2], title:m[1]+' → '+m[2], det:[],
               depD:(pendingTime?pendingTime.d:curDate),
               depT:pendingTime?pendingTime.t:null, depOff:pendingTime?pendingTime.off:null};
      }
      pendingTime=null; detTarget=trans; return;
    }

    // ground transport titles: "FlixBus - Frankfurt Airport (P36, Terminal 1) → M"
    m=line.match(/^(?:(.+?)\s+[-–—]\s+)?(.+?)\s*(?:→|->)\s*(.+)$/);
    if(m){
      flushAct(); flushTrans();
      const op=(m[1]||'').trim();
      trans={isFlight:false, mode:groundMode(line), op:op, title:line.slice(0,90),
             fromTitle:m[2].trim(), toTitle:m[3].trim(), det:[],
             depD:(pendingTime?pendingTime.d:curDate),
             depT:pendingTime?pendingTime.t:null, depOff:pendingTime?pendingTime.off:null};
      pendingTime=null; detTarget=trans; return;
    }

    // "Depart <station> <address>" (TripIt) / "Departs: Jul 29, 2026 11:30am" (legacy)
    m=line.match(/^departs?\b:?\s*(.*)$/i);
    if(m){
      const rest=m[1].trim();
      if(!trans&&act){ // "Saba Driver To Mestia" + Depart/Arrive lines → it was a transfer, not an activity
        const parts=splitTitle(act.title);
        trans={isFlight:false, mode:groundMode(act.title), op:'', title:act.title, det:act.det,
               fromTitle:parts[0]||'', toTitle:parts[1]||'',
               depD:act.d, depT:act.t, depOff:act.off};
        act=null;
      }
      if(!trans) trans={isFlight:false, mode:'car', op:'', title:'Transfer', det:[],
                        depD:null, depT:null, depOff:null};
      const dd=inlineDate(findDate(rest));
      if(dd) trans.depD=dd;
      const t2=rest?findTimeAny(rest):null;
      if(t2&&(!trans.depT||dd)){ trans.depT={h:t2.h,min:t2.min}; if(t2.off!=null)trans.depOff=t2.off; }
      if(!trans.depD) trans.depD=(pendingTime?pendingTime.d:curDate);
      if(!trans.depT&&pendingTime){ trans.depT=pendingTime.t; trans.depOff=pendingTime.off; }
      const code=rest.match(/\(([A-Z]{3})\)/)||rest.match(/^([A-Z]{3})$/);
      if(code&&trans.isFlight&&!trans.fromCode) trans.fromCode=code[1];
      if(rest&&!dd&&!trans.isFlight&&!trans.fromAddr) trans.fromAddr=rest;
      pendingTime=null; detTarget=trans; return;
    }

    // "Arrive Detroit (DTW)" / "Arrive <station> <address>" / legacy "Arrives: …"
    m=line.match(/^arrives?\b:?\s*(.*)$/i);
    if(m){
      if(!trans){ if(detTarget)pushDet(detTarget,line); return; }
      const rest=m[1].trim();
      if(pendingTime){ trans.arrD=pendingTime.d; trans.arrT=pendingTime.t; trans.arrOff=pendingTime.off; pendingTime=null; }
      const dd=inlineDate(findDate(rest));
      if(dd) trans.arrD=dd;
      const t2=rest?findTimeAny(rest):null;
      if(t2&&(!trans.arrT||dd)){ trans.arrT={h:t2.h,min:t2.min}; if(t2.off!=null)trans.arrOff=t2.off; }
      if(!trans.arrD) trans.arrD=curDate;
      const code=rest.match(/\(([A-Z]{3})\)/);
      if(trans.isFlight){ if(code&&!trans.toCode) trans.toCode=code[1]; }
      else if(rest&&!dd&&!trans.toAddr) trans.toAddr=rest;
      flushTrans(); return;
    }

    // flight-number lines: "DL 1070 (Delta Air Lines), Terminal 3, Gate F9"
    m=line.match(/^([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s?(\d{1,4})\s*\(([^)]+)\)\s*,?\s*(.*)$/);
    if(m){
      flushAct();
      if(!trans||!trans.isFlight){
        flushTrans();
        trans={isFlight:true, mode:'flight', det:[], title:'',
               depD:(pendingTime?pendingTime.d:curDate),
               depT:pendingTime?pendingTime.t:null, depOff:pendingTime?pendingTime.off:null};
        pendingTime=null;
      }
      if(!trans.op) trans.op=m[1]+' '+m[2]+' ('+m[3]+')';
      if(m[4]) pushDet(trans,m[4]);
      detTarget=trans; return;
    }
    // legacy flight-number lines: "Delta Air Lines DL 1070"
    m=line.match(/\b([A-Z]{2})\s?(\d{2,4})\b/);
    if(m&&/air|airline|airways|flight|wizz|ryanair|delta|lufthansa|united|klm|easyjet|turkish|condor|jetblue|ana|jal|emirates|qatar|pegasus/i.test(line)){
      flushAct();
      if(!trans||!trans.isFlight){
        flushTrans();
        trans={isFlight:true, mode:'flight', det:[], title:'',
               depD:(pendingTime?pendingTime.d:curDate),
               depT:pendingTime?pendingTime.t:null, depOff:pendingTime?pendingTime.off:null};
        pendingTime=null;
      }
      if(!trans.op) trans.op=line.length<60?line:m[1]+' '+m[2];
      detTarget=trans; return;
    }

    // a timed plain line becomes an activity
    if(pendingTime){
      if(trans) flushTrans(); // a stale transport still open here never got its Arrive line
      act={title:line.slice(0,90), d:pendingTime.d, t:pendingTime.t, off:pendingTime.off,
           det:[], addr:null, endD:null, endT:null, endOff:null, expectAddr:true, placeHint:curKey};
      pendingTime=null; detTarget=act;
      if(line.length>2&&line.length<70) lastName=line;
      return;
    }

    // otherwise the line annotates whatever came last (addresses, gates, PIN codes, seat notes…)
    if(detTarget){
      if(detTarget.expectAddr&&!detTarget.addr&&isAddressy(line)){ detTarget.addr=line; detTarget.expectAddr=false; }
      else { if(detTarget.expectAddr)detTarget.expectAddr=false; pushDet(detTarget,line); }
    }
    if(line.length>2&&line.length<70)
      lastName=line.replace(/^(hotel|lodging|stay)[:\s]+/i,'').trim()||lastName;
  });
  flushAct();
  flushTrans();

  /* ---------- assemble the draft config ---------- */
  legsRaw.sort((a,b)=>Date.parse(a.dep)-Date.parse(b.dep));
  const legs=legsRaw.map(r=>{
    const o={mode:r.mode, from:r.from, to:r.to, dep:r.dep, arr:r.arr, title:r.title};
    if(r.op) o.op=r.op;
    if(r.det.length) o.det=r.det.join('\n');
    return o;
  });

  const stays=[];
  staysRaw.forEach(st=>{
    const hit=findCityIn(st.addr||'');
    let pk=hit? ensureCity(hit,(st.inOff!=null?st.inOff:st.outOff)) : (st.placeHint||null);
    if(!pk&&legsRaw.length) pk=legsRaw[0].from;
    if(!pk){ report.push('Skipped stay "'+st.name+'" — no place to attach it to.'); return; }
    const inOff=(st.inOff!=null?st.inOff:offOf(pk)), outOff=(st.outOff!=null?st.outOff:offOf(pk));
    let inIso=st.inD? isoLocal(st.inD,st.inT)+offStr(inOff) : null;
    let outIso=st.outD? isoLocal(st.outD,st.outT)+offStr(outOff) : null;
    if(!inIso&&!outIso){ report.push('Skipped stay "'+st.name+'" — no usable dates.'); return; }
    if(!inIso) inIso=isoFromTs(Date.parse(outIso)-DAY,outOff);
    if(!outIso){ outIso=isoFromTs(Date.parse(inIso)+DAY,inOff); report.push('Stay "'+st.name+'" never checks out in the text — assumed 1 night.'); }
    if(Date.parse(outIso)<=Date.parse(inIso)){ outIso=isoFromTs(Date.parse(inIso)+DAY,inOff); report.push('Stay "'+st.name+'": check-out was not after check-in — assumed 1 night.'); }
    const o={place:pk, name:st.name, "in":inIso, out:outIso};
    if(st.addr) o.addr=st.addr;
    if(st.det.length) o.det=st.det.join('\n');
    stays.push(o);
  });
  stays.sort((a,b)=>Date.parse(a.in)-Date.parse(b.in));

  const events=[];
  eventsRaw.forEach(a=>{
    const hit=findCityIn(a.addr||'');
    let pk=hit? ensureCity(hit,a.off) : (a.placeHint||null);
    if(!pk&&legsRaw.length) pk=legsRaw[0].from;
    if(!pk){ report.push('Skipped activity "'+a.title+'" — no place to attach it to.'); return; }
    const off=(a.off!=null?a.off:offOf(pk));
    const o={kind:'activity', place:pk, title:a.title, start:isoLocal(a.d,a.t)+offStr(off)};
    if(a.endT){
      const eoff=(a.endOff!=null?a.endOff:off);
      const ets=Date.parse(isoLocal(a.endD||a.d,a.endT)+offStr(eoff));
      if(ets>=Date.parse(o.start)) o.end=isoFromTs(ets,eoff);
    }
    if(a.addr) o.addr=a.addr;
    if(a.off!=null&&places[pk]&&a.off!==places[pk].off) o.off=a.off;
    if(a.det.length) o.det=a.det.join('\n');
    events.push(o);
  });
  events.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));

  /* ---------- import report ---------- */
  const nF=legs.filter(l=>l.mode==='flight').length, nG=legs.length-nF;
  if(!legs.length&&!stays.length&&!events.length){
    report.unshift('Nothing recognisable found. The importer reads TripIt-style plain text: day headers ("Wed, Jul 29"), time lines ("10:52 AM MST"), routes ("PHX → DTW", "FlixBus - A → B" with Depart/Arrive lines), "Check In <name>" / "Check Out <name>", and timed activity titles. The old "PHX to DTW / Departs: Jul 29, 2026 11:30am / Check-in: …" style works too. You can also build the config by hand — see the Schema tab.');
  } else {
    report.unshift('Parsed '+nF+' flight'+(nF===1?'':'s')+', '+nG+' ground leg'+(nG===1?'':'s')+', '+
      stays.length+' stay'+(stays.length===1?'':'s')+' and '+events.length+' activit'+(events.length===1?'y':'ies')+
      '. This is a DRAFT: verify every time, offset and place, then add "gap" legs for any unbooked stretches the validator flags.');
    if(nG) report.push('Map note: every leg is drawn as a straight (great-circle) line between its two places\' coordinates — buses and cars are not routed along roads. Ground endpoints were matched to city coordinates by scanning the station/stop text for known city names; nudge any place\'s lat/lon to taste.');
  }
  if(assumedYear) report.push('The itinerary text has no year on its dates — assumed '+assumedYear+' (edit the draft if that is wrong).');
  if(skippedFwd) report.push('Skipped '+skippedFwd+' forwarded confirmation email'+(skippedFwd===1?'':'s')+' embedded in the text (only the itinerary lines around them were read).');
  if(unknownTz.size) report.push('Unknown timezone label'+(unknownTz.size===1?'':'s')+': '+[...unknownTz].join(', ')+' — those times fell back to the place\'s UTC offset; double-check them.');
  if(unknownPlaces.size) report.push('No coordinates known for: '+[...unknownPlaces].join(' · ')+'. Added with lat/lon 0,0 — fill them in or the map will draw them off the coast of West Africa.');

  const cfg={ title:'Imported trip (rename me)', places, legs, stays, events };
  return {config:cfg, report};
}
