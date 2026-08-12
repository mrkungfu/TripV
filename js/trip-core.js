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
   Feeds on the plain text you get from "print itinerary" / forwarded
   confirmation summaries. It looks for flights (airline + number,
   AAA → BBB airport pairs, depart/arrive lines) and lodging
   (check-in / check-out lines) and produces a DRAFT config for the
   editor. Anything it cannot read is reported, not guessed.
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

function parseItineraryText(text){
  const report=[], places={}, legs=[], stays=[];
  const lines=String(text||'').split(/\r?\n/).map(s=>s.trim());
  const MONTHS={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const nowYear=new Date().getFullYear();

  function findDate(s){
    let m=s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if(m) return {y:+m[1], mo:+m[2]-1, d:+m[3]};
    m=s.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
    if(m) return {y:m[3]?+m[3]:nowYear, mo:MONTHS[m[1].slice(0,3).toLowerCase()], d:+m[2]};
    m=s.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+(\d{4}))?/i);
    if(m) return {y:m[3]?+m[3]:nowYear, mo:MONTHS[m[2].slice(0,3).toLowerCase()], d:+m[1]};
    return null;
  }
  function findTime(s){
    const m=s.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
    if(!m) return null;
    let h=+m[1]; const min=+m[2];
    if(m[3]){ const ap=m[3].toLowerCase(); if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; }
    return {h,min};
  }
  function isoLocal(dt,tm){
    const p=n=>String(n).padStart(2,'0');
    return dt.y+'-'+p(dt.mo+1)+'-'+p(dt.d)+'T'+p(tm?tm.h:12)+':'+p(tm?tm.min:0)+':00';
  }
  function offStr(off){
    const s=off<0?'-':'+', a=Math.abs(off);
    return s+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0');
  }
  function ensurePlace(code){
    const key=code.toLowerCase();
    if(places[key]) return key;
    const ap=AIRPORTS[code];
    if(ap){ places[key]={n:ap.n, r:'', cc:ap.cc, lat:ap.lat, lon:ap.lon, off:ap.off}; }
    else {
      places[key]={n:code+' (TODO: name)', r:'', cc:'TODO', lat:0, lon:0, off:0};
      report.push('Unknown airport/place code "'+code+'" — fill in its lat/lon/off by hand.');
    }
    return key;
  }

  let curDate=null, pending=null, pendingStay=null, lastName='';
  const flightNoRe=/\b([A-Z]{2})\s?(\d{2,4})\b/;
  const routeRe=/\b([A-Z]{3})\b\s*(?:to|→|—|–|-|>)\s*\b([A-Z]{3})\b/;
  const airlineWordRe=/air|airline|airways|flight|wizz|ryanair|delta|lufthansa|united|klm|easyjet|turkish|condor|jetblue|ana|jal|emirates|qatar/i;

  lines.forEach(line=>{
    if(!line) return;
    const d=findDate(line);
    if(d && !/check.?in|check.?out|depart|arriv/i.test(line)) curDate=d;

    // lodging
    if(/check.?in/i.test(line)){
      const dd=findDate(line)||curDate;
      if(dd){
        pendingStay={ name:(lastName&&!/check.?in/i.test(lastName)?lastName:'TODO: lodging name'),
                      inD:dd, inT:findTime(line)||{h:15,min:0} };
      }
      return;
    }
    if(/check.?out/i.test(line) && pendingStay){
      const dd=findDate(line)||curDate;
      if(dd){
        pendingStay.outD=dd; pendingStay.outT=findTime(line)||{h:11,min:0};
        stays.push(pendingStay); pendingStay=null;
      }
      return;
    }

    // flights
    const route=line.match(routeRe);
    const fno=line.match(flightNoRe);
    if(route && route[1]!==route[2]){
      if(!pending) pending={};
      pending.from=route[1]; pending.to=route[2];
    }
    if(fno && (airlineWordRe.test(line)||route)){
      if(!pending) pending={};
      if(!pending.op) pending.op=fno[1]+' '+fno[2];
    }
    if(/depart/i.test(line)){
      if(!pending) pending={};
      pending.depD=findDate(line)||curDate; pending.depT=findTime(line);
      const ap=line.match(/\(([A-Z]{3})\)/)||line.match(/\b([A-Z]{3})\b\s*$/);
      if(ap && !pending.from) pending.from=ap[1];
    }
    if(/arriv/i.test(line) && pending){
      pending.arrD=findDate(line)||pending.depD||curDate; pending.arrT=findTime(line);
      const ap=line.match(/\(([A-Z]{3})\)/)||line.match(/\b([A-Z]{3})\b\s*$/);
      if(ap && !pending.to) pending.to=ap[1];
      if(pending.from&&pending.to&&pending.depD){
        const fk=ensurePlace(pending.from), tk=ensurePlace(pending.to);
        legs.push({ mode:'flight', from:fk, to:tk,
          dep:isoLocal(pending.depD,pending.depT)+offStr(places[fk].off),
          arr:isoLocal(pending.arrD,pending.arrT)+offStr(places[tk].off),
          title:pending.from+' → '+pending.to, op:pending.op||'' });
        pending=null;
      }
    }
    if(!/check.?in|check.?out|depart|arriv/i.test(line) && !routeRe.test(line) && line.length>2 && line.length<70)
      lastName=line.replace(/^(hotel|lodging|stay)[:\s]+/i,'').trim()||lastName;
  });

  // attach stays to the place the flights last landed in before check-in
  legs.sort((a,b)=>T(a.dep)-T(b.dep));
  const stayObjs=stays.map(st=>{
    const inTs=Date.UTC(st.inD.y,st.inD.mo,st.inD.d,st.inT.h,st.inT.min);
    let place=legs.length?legs[0].from:Object.keys(places)[0];
    legs.forEach(l=>{ const dd=findDate(l.dep); if(dd&&Date.UTC(dd.y,dd.mo,dd.d)<=inTs) place=l.to; });
    if(!place){ place=ensurePlace('XXX'); }
    const off=places[place]?places[place].off:0;
    return { place, name:st.name,
      "in":isoLocal(st.inD,st.inT)+offStr(off),
      out:isoLocal(st.outD,st.outT)+offStr(off),
      det:'Imported from pasted text — check the details.' };
  });

  if(!legs.length && !stayObjs.length)
    report.unshift('Nothing recognisable found. The importer looks for lines like "PHX to DTW", "Delta Air Lines DL 1070", "Departs: Jul 29, 2026 11:30am", "Check-in: Jul 30, 2026". You can also build the config by hand — see the Schema tab.');
  else
    report.unshift('Parsed '+legs.length+' flight'+(legs.length===1?'':'s')+' and '+stayObjs.length+' stay'+(stayObjs.length===1?'':'s')+'. This is a DRAFT: verify every time and timezone offset, then add ground legs, gaps and activities by hand.');

  const cfg={ title:'Imported trip (rename me)', places, legs, stays:stayObjs, events:[] };
  return {config:cfg, report};
}
