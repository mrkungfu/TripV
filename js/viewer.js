"use strict";
/* ============================================================
   Trip visualizer — viewer
   Renders whatever trip config is loaded (saved trip, dropped
   file, or the bundled demo). All trip-specific data lives in
   the config; nothing about a particular trip is hardcoded here.
   ============================================================ */

/* ---------- state ---------- */
let M=null;                                   // current derived model (buildModel)
let now=0, playing=false, speed=1, raf=null, last=0;
const view={k:1,x:0,y:0}, base={x:0,y:0,w:1,h:1};
let follow=false, fitSet=null, mapNeedsFit=false;
let currentView='map';
let filter='all', query='', CARDS=[], lastActive=-2, userScrolled=false, programScroll=false, scrollTimer=null;
let jOrder='lon', jGeom=null;
let fullPath={}, doneEls={}, nodeEls={}, nodeLbl={}, nodeSub={}, SUB=[];

const mapSvg=$('#mapSvg'), mapRoot=$('#mapRoot'), jSvg=$('#journeySvg'), scrub=$('#scrub'), tip=$('#tip');
let drag=null, didPan=false, U=1;

/* ============================================================
   1.  Static map furniture (ocean, graticule, land, puck)
   ============================================================ */
(function drawStatic(){
  let g='';
  for(let lon=-180;lon<=180;lon+=15){ const a=proj(lon,84),b=proj(lon,-84); g+='<path class="grat" d="M'+a[0]+' '+a[1]+'L'+b[0]+' '+b[1]+'"/>'; }
  for(let lat=-75;lat<=75;lat+=15){ const a=proj(-180,lat),b=proj(180,lat); g+='<path class="grat" d="M'+a[0]+' '+a[1]+'L'+b[0]+' '+b[1]+'"/>'; }
  $('#gGrat').innerHTML=g;
  $('#gLand').innerHTML=WORLD_LAND.split('|').map(d=>'<path class="land" d="'+d+'"/>').join('');
  $('#gTraveler').innerHTML=
    '<g class="traveler" id="puck" transform="translate(0,0)">'+
     '<circle class="halo" r="30" fill="url(#halo)"/>'+
     '<circle class="puck" r="7.5"/>'+
     '<path id="puckIcon" d="" fill="#0b1120" transform="translate(-6,-6) scale(0.5)"/>'+
    '</g>';
})();

/* leg polylines in projected space, split cleanly at the antimeridian so
   Pacific crossings do not smear a line across the whole map */
function legPathD(l, upto){
  const N=Math.max(2, Math.min(96, Math.round(l.km/60)+8));
  const end = upto===undefined?1:upto;
  let d='', pen=false, prev=null;
  for(let i=0;i<=N;i++){
    const f=i/N*end;
    const p=gcPoint(l.A,l.B,f);
    if(prev && Math.abs(p.lon-prev.lon)>180){
      const edge = prev.lon>0 ? 180 : -180;
      const lonB = p.lon + (prev.lon>0?360:-360);
      const t=(edge-prev.lon)/((lonB-prev.lon)||1e-9);
      const latX=prev.lat+(p.lat-prev.lat)*t;
      const q1=proj(edge,latX), q2=proj(-edge,latX);
      d+='L'+q1[0].toFixed(1)+' '+q1[1].toFixed(1)+'M'+q2[0].toFixed(1)+' '+q2[1].toFixed(1);
    }
    const q=proj(p.lon,p.lat);
    d+=(pen?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1);
    pen=true; prev=p;
  }
  return d;
}

/* ============================================================
   2.  Per-trip map layers
   ============================================================ */
function buildMapLayers(){
  fullPath={}; M.LEGS.forEach(l=>fullPath[l.id]=legPathD(l));

  $('#gRoutesBase').innerHTML=M.LEGS.map(l=>
    '<path class="route base'+(l.mode==='gap'?' gap':'')+'" data-leg="'+esc(l.id)+'" d="'+fullPath[l.id]+'"/>').join('');
  $('#gRoutesDone').innerHTML=M.LEGS.map(l=>
    '<path class="route done'+(l.mode==='gap'?' gap':'')+'" id="done-'+esc(l.id)+'" stroke="'+MODE_COLOR[l.mode]+'" d=""/>').join('');
  $('#gRoutesHit').innerHTML=M.LEGS.map(l=>
    '<path class="route" data-leg="'+esc(l.id)+'" stroke="transparent" stroke-width="12" style="cursor:pointer" d="'+fullPath[l.id]+'"/>').join('');
  doneEls={}; M.LEGS.forEach(l=>doneEls[l.id]=$('#done-'+l.id));

  /* nodes — geometry is written in CSS pixels and re-scaled in applyView() */
  $('#gNodes').innerHTML=M.placeKeys.map(k=>{
    const P=M.PLACES[k];
    const [x,y]=proj(P.lon,P.lat);
    const n=M.NIGHTS[k]||0, r=3.4+Math.sqrt(n)*1.9;
    const L=P.lbl;
    return '<g class="node" id="node-'+esc(k)+'" data-place="'+esc(k)+'" transform="translate('+x+','+y+')">'+
      '<circle class="ring" r="'+(r+4).toFixed(1)+'" stroke="'+P.c+'"/>'+
      '<circle class="core" r="'+r.toFixed(1)+'" fill="'+P.c+'"/>'+
      '<circle class="hit" r="'+Math.max(12,r+7).toFixed(1)+'"/>'+
      '<text class="lb" x="'+L[0]+'" y="'+L[1]+'" text-anchor="'+L[2]+'">'+esc(P.n)+'</text>'+
      (n>=1?'<text class="sm" x="'+L[0]+'" y="'+(L[1]+(L[1]<0?-11:11))+'" text-anchor="'+L[2]+'">'+
        Math.round(n)+' night'+(Math.round(n)>1?'s':'')+'</text>':'')+
    '</g>';
  }).join('');
  nodeEls={}; nodeLbl={}; nodeSub={};
  M.placeKeys.forEach(k=>{
    nodeEls[k]=$('#node-'+k);
    nodeLbl[k]=$('.lb',nodeEls[k]);
    nodeSub[k]=$('.sm',nodeEls[k]);
  });

  /* fine-grained points (lodging, meeting points) — appear when you zoom in */
  SUB=[];
  M.STAYS.forEach(s=>SUB.push({lat:s.lat,lon:s.lon,c:MODE_COLOR.stay,n:s.name,s:s.addr||'',t:'stay',ref:s}));
  M.EVENTS.filter(e=>e.lat!=null&&e.lon!=null).forEach(e=>SUB.push({lat:+e.lat,lon:+e.lon,c:MODE_COLOR.activity,n:e.title,s:e.addr||'',t:'event',ref:e}));
  $('#gSub').innerHTML=SUB.map((p,i)=>{
    const [x,y]=proj(p.lon,p.lat);
    return '<g class="subpt" id="sub-'+i+'" data-sub="'+i+'" transform="translate('+x+','+y+')" opacity="0">'+
      '<circle r="3" fill="'+p.c+'"/><circle r="9" fill="transparent"/>'+
      '<text x="6" y="3.5">'+esc(String(p.n).slice(0,38))+'</text></g>';
  }).join('');

  /* legend from the modes this trip actually uses */
  const modes=[...new Set(M.LEGS.map(l=>l.mode))];
  $('#mapLegend').innerHTML=modes.map(m=>
    '<span><i style="border-color:'+MODE_COLOR[m]+(m==='gap'?';border-top-style:dashed':'')+'"></i>'+MODE_LABEL[m]+'</span>').join('')+
    '<span><i class="dot" style="background:#fff"></i>Marker size = nights in town</span>';
}

/* ---------- viewport ---------- */
function fitTo(pad){
  const el=mapSvg.getBoundingClientRect();
  if(el.width<40||el.height<40){ mapNeedsFit=true; return; }
  const keys=(fitSet&&fitSet.length)?fitSet:M.placeKeys;
  const pts=keys.map(k=>proj(M.PLACES[k].lon,M.PLACES[k].lat));
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
  const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys);
  const px=Math.max(20,(x1-x0)*(pad||.12)), py=Math.max(20,(y1-y0)*(pad||.12))+14;
  base.x=x0-px; base.y=y0-py; base.w=(x1-x0)+px*2; base.h=(y1-y0)+py*2;
  const ar=el.width/Math.max(1,el.height), bar=base.w/base.h;
  if(ar>bar){ const w=base.h*ar; base.x-=(w-base.w)/2; base.w=w; }
  else { const h=base.w/ar; base.y-=(h-base.h)/2; base.h=h; }
  mapSvg.setAttribute('viewBox', base.x+' '+base.y+' '+base.w+' '+base.h);
  mapNeedsFit=false;
}
/* one viewBox unit is this many CSS pixels wide — markers are drawn in pixel
   units and scaled by it so they stay the same size at every zoom level */
function unitsPerPx(){
  const r=mapSvg.getBoundingClientRect();
  return base.w/Math.max(1,r.width);
}
function applyView(){
  if(!M) return;
  U=unitsPerPx();
  mapRoot.setAttribute('transform','translate('+view.x+','+view.y+') scale('+view.k+')');
  const ppu = view.k/U;
  const tier = ppu>=2 ? 4 : ppu>=.85 ? 3 : ppu>=.3 ? 2 : 1;
  const showNights = ppu>=1.15;
  M.placeKeys.forEach(k=>{
    const P=M.PLACES[k];
    const [x,y]=proj(P.lon,P.lat);
    nodeEls[k].setAttribute('transform','translate('+(x*view.k+view.x).toFixed(2)+','+(y*view.k+view.y).toFixed(2)+') scale('+U.toFixed(4)+')');
    nodeLbl[k].style.display=(P.lbl[3]<=tier)?'':'none';
    if(nodeSub[k]) nodeSub[k].style.display=showNights?'':'none';
  });
  const showSub=ppu>=14, subNames=ppu>=70;
  SUB.forEach((p,i)=>{
    const el=$('#sub-'+i); const [x,y]=proj(p.lon,p.lat);
    el.setAttribute('transform','translate('+(x*view.k+view.x).toFixed(2)+','+(y*view.k+view.y).toFixed(2)+') scale('+U.toFixed(4)+')');
    el.setAttribute('opacity', showSub?1:0);
    el.style.pointerEvents=showSub?'auto':'none';
    el.querySelector('text').style.display=subNames?'':'none';
  });
  placePuck();
  $('#mapHint').textContent = view.k>1.05
    ? ('zoom ×'+view.k.toFixed(1)+(subNames?' · lodging & meeting points':showSub?' · street level':''))
    : 'drag to pan · scroll to zoom';
}
function zoomAt(cx,cy,factor){
  const pt=svgPoint(cx,cy);
  const k2=clamp(view.k*factor,1,2600);
  const f=k2/view.k;
  view.x=pt.x-(pt.x-view.x)*f;
  view.y=pt.y-(pt.y-view.y)*f;
  view.k=k2;
  applyView();
}
function svgPoint(cx,cy){
  const r=mapSvg.getBoundingClientRect();
  return { x: base.x + (cx-r.left)/r.width*base.w, y: base.y + (cy-r.top)/r.height*base.h };
}
function syncFollowBtn(){ $('#zFollow').classList.toggle('on',follow); }
function stopFollow(){ if(follow){ follow=false; syncFollowBtn(); } }
function centerOnTraveler(){
  const L=M.locationAt(now);
  const [x,y]=proj(L.lon,L.lat);
  const cx=base.x+base.w/2, cy=base.y+base.h/2;
  view.x=cx-x*view.k; view.y=cy-y*view.k;
  applyView();
}
function placePuck(){
  if(!M) return;
  const L=M.locationAt(now);
  const [x,y]=proj(L.lon,L.lat);
  $('#puck').setAttribute('transform','translate('+(x*view.k+view.x).toFixed(2)+','+(y*view.k+view.y).toFixed(2)+') scale('+U.toFixed(4)+')');
  const mode=L.moving?L.leg.mode:'bed';
  $('#puckIcon').setAttribute('d', mode==='bed'?ICON.bed:modeIcon(mode));
}
function updateRoutes(ts){
  M.LEGS.forEach(l=>{
    const el=doneEls[l.id];
    if(ts<=l.t0){ el.setAttribute('d',''); }
    else if(ts>=l.t1){ el.setAttribute('d', fullPath[l.id]); }
    else { el.setAttribute('d', legPathD(l,(ts-l.t0)/(l.t1-l.t0))); }
  });
  M.placeKeys.forEach(k=>{
    const visited=M.LEGS.some(l=>(l.from===k&&ts>=l.t0)||(l.to===k&&ts>=l.t1));
    nodeEls[k].classList.toggle('dim',!visited);
  });
}

/* ============================================================
   3.  Journey (space–time) chart
   ============================================================ */
function placeOrder(){
  if(jOrder==='lon') return M.placeKeys.slice().sort((a,b)=>M.PLACES[a].lon-M.PLACES[b].lon);
  const seen=[]; M.LEGS.forEach(l=>{ if(!seen.includes(l.from)) seen.push(l.from); if(!seen.includes(l.to)) seen.push(l.to); });
  M.placeKeys.forEach(k=>{ if(!seen.includes(k)) seen.push(k); });
  return seen;
}
function drawJourney(){
  const box=jSvg.getBoundingClientRect();
  const W=Math.max(560,box.width), H=Math.max(360,box.height);
  const m={l:132,r:22,t:94,b:46};
  const order=placeOrder();
  const iw=W-m.l-m.r, ih=H-m.t-m.b;
  const rowH=ih/Math.max(1,order.length-1);
  const X=t=>m.l+(t-M.T0)/M.TRIP_MS*iw;
  const Y=k=>m.t+order.indexOf(k)*rowH;
  jGeom={X,Y,W,H,m,iw};
  const calShift=M.calOff*MIN;

  let s='';
  // month + week grid, derived from the trip window (was hardcoded to Jul–Oct 2026)
  const start=new Date(M.T0+calShift);
  let d=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),1));
  while(d.getTime()-calShift<M.T1+DAY){
    const t=d.getTime()-calShift;
    if(t>=M.T0-DAY && t<=M.T1){
      const isMonth=d.getUTCDate()===1, isWeek=d.getUTCDay()===1;
      if(isMonth||isWeek){
        s+='<path class="j-grid'+(isMonth?' strong':'')+'" d="M'+X(t).toFixed(1)+' '+m.t+'V'+(H-m.b)+'"/>';
      }
      if(isMonth) s+='<text class="j-lbl month" x="'+(X(t)+7).toFixed(1)+'" y="'+(m.t-32)+'">'+MON[d.getUTCMonth()].toUpperCase()+'</text>';
      if(isWeek&&!isMonth) s+='<text class="j-lbl" x="'+(X(t)).toFixed(1)+'" y="'+(m.t-12)+'" text-anchor="middle">'+d.getUTCDate()+'</text>';
      if(isMonth) s+='<text class="j-lbl" x="'+(X(t)).toFixed(1)+'" y="'+(m.t-12)+'" text-anchor="middle">1</text>';
    }
    d=new Date(d.getTime()+DAY);
  }
  // rows
  order.forEach(k=>{
    const y=Y(k), P=M.PLACES[k];
    s+='<path class="j-grid" d="M'+m.l+' '+y.toFixed(1)+'H'+(W-m.r)+'" opacity=".55"/>';
    s+='<text class="j-place" x="'+(m.l-10)+'" y="'+(y+3.5).toFixed(1)+'" text-anchor="end">'+esc(P.n)+
       ' <tspan class="cc">'+esc(P.cc)+'</tspan></text>';
    s+='<circle cx="'+(m.l-4)+'" cy="'+y.toFixed(1)+'" r="2.6" fill="'+P.c+'"/>';
  });
  // lodging bands
  M.STAYS.forEach(st=>{
    const y=Y(st.place);
    s+='<path class="j-lodge" stroke="'+MODE_COLOR.stay+'" data-stay="'+esc(st.id)+'" d="M'+X(st.t0).toFixed(1)+' '+y.toFixed(1)+'H'+Math.max(X(st.t1),X(st.t0)+1.5).toFixed(1)+'"/>';
  });
  // stays + moves
  M.SEGS.forEach(sg=>{
    if(sg.type==='stay'){
      const y=Y(sg.place);
      s+='<path class="j-stay" stroke="'+M.PLACES[sg.place].c+'" d="M'+X(sg.t0).toFixed(1)+' '+y.toFixed(1)+'H'+Math.max(X(sg.t1),X(sg.t0)+1).toFixed(1)+'"/>';
    } else {
      const l=sg.leg, y0=Y(l.from), y1=Y(l.to);
      const x0=X(l.t0), x1=Math.max(X(l.t1),X(l.t0)+1.2);
      s+='<path class="j-move'+(l.mode==='gap'?' gap':'')+'" stroke="'+MODE_COLOR[l.mode]+'" data-leg="'+esc(l.id)+'" d="M'+x0.toFixed(1)+' '+y0.toFixed(1)+'L'+x1.toFixed(1)+' '+y1.toFixed(1)+'"/>';
      s+='<path class="j-hit" data-leg="'+esc(l.id)+'" d="M'+x0.toFixed(1)+' '+(y0-6).toFixed(1)+'L'+x1.toFixed(1)+' '+(y1-6).toFixed(1)+'L'+x1.toFixed(1)+' '+(y1+6).toFixed(1)+'L'+x0.toFixed(1)+' '+(y0+6).toFixed(1)+'Z"/>';
    }
  });
  // events
  M.EVENTS.filter(e=>e.kind==='activity').forEach(e=>{
    const y=Y(e.place)-8.5, x=X(e.t0);
    s+='<circle class="j-ev" data-ev="'+esc(e.id)+'" cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="3" fill="'+MODE_COLOR.activity+'" stroke="#0b1120" stroke-width="1"/>';
  });
  // playhead
  s+='<rect class="j-headfill" id="jFill" x="'+m.l+'" y="'+m.t+'" width="0" height="'+ih+'"/>';
  s+='<path class="j-head" id="jHead" d="M'+m.l+' '+(m.t-6)+'V'+(H-m.b)+'"/>';
  s+='<circle id="jDot" cx="'+m.l+'" cy="'+m.t+'" r="4" fill="#fff"/>';

  jSvg.setAttribute('viewBox','0 0 '+W+' '+H);
  jSvg.innerHTML=s;
  updateJourney(now);
}
function updateJourney(ts){
  if(!jGeom||!$('#jHead')) return;
  const x=jGeom.X(clamp(ts,M.T0,M.T1));
  $('#jHead').setAttribute('d','M'+x.toFixed(1)+' '+(jGeom.m.t-6)+'V'+(jGeom.H-jGeom.m.b));
  $('#jFill').setAttribute('width',Math.max(0,x-jGeom.m.l).toFixed(1));
  const L=M.locationAt(ts);
  const dot=$('#jDot');
  if(L.moving){
    const l=L.leg, y0=jGeom.Y(l.from), y1=jGeom.Y(l.to);
    dot.setAttribute('cy',lerp(y0,y1,L.f).toFixed(1));
  } else dot.setAttribute('cy',jGeom.Y(L.place).toFixed(1));
  dot.setAttribute('cx',x.toFixed(1));
}

/* ============================================================
   4.  Calendar (months derived from the trip window)
   ============================================================ */
function buildCalendar(){
  const calShift=M.calOff*MIN;
  const first=new Date(M.T0+calShift), lastD=new Date(M.T1+calShift);
  const months=[];
  let y=first.getUTCFullYear(), mo=first.getUTCMonth();
  while(y<lastD.getUTCFullYear() || (y===lastD.getUTCFullYear()&&mo<=lastD.getUTCMonth())){
    months.push([y,mo]);
    mo++; if(mo>11){ mo=0; y++; }
  }
  let html='';
  months.forEach(([yy,mm])=>{
    const firstDow=new Date(Date.UTC(yy,mm,1)).getUTCDay();
    const nDays=new Date(Date.UTC(yy,mm+1,0)).getUTCDate();
    let cells='';
    for(let i=0;i<firstDow;i++) cells+='<div></div>';
    for(let dnum=1;dnum<=nDays;dnum++){
      const dayStart=Date.UTC(yy,mm,dnum,0,0)-calShift, dayEnd=dayStart+DAY;
      const sample=dayStart+12*HOUR;
      const inTrip=dayEnd>M.T0 && dayStart<M.T1;
      if(!inTrip){ cells+='<div class="day"><span class="num">'+dnum+'</span></div>'; continue; }
      const L=M.locationAt(clamp(sample,M.T0,M.T1));
      let bg;
      if(L.moving){
        const a=M.PLACES[L.leg.from].c, b=M.PLACES[L.leg.to].c;
        bg='linear-gradient(120deg,'+a+' 0 42%,'+b+' 58% 100%)';
      } else bg=L.P.c;
      const evs=M.ITEMS.filter(it=>it.t0>=dayStart&&it.t0<dayEnd&&it.cls!=='gap');
      const gapDay=!evs.length;
      const isToday=Date.now()>=dayStart&&Date.now()<dayEnd;
      const dots=evs.slice(0,5).map(()=>'<i></i>').join('');
      cells+='<div class="day in'+(isToday?' today':'')+'" data-t="'+sample+'" style="background:'+bg+
        (gapDay?';opacity:.42':'')+'"><span class="num">'+dnum+'</span><span class="evd">'+dots+'</span></div>';
    }
    html+='<div class="month"><h3>'+MON_FULL[mm]+' '+yy+'</h3>'+
      '<div class="dow">'+['S','M','T','W','T','F','S'].map(d=>'<span>'+d+'</span>').join('')+'</div>'+
      '<div class="days">'+cells+'</div></div>';
  });
  $('#calGrid').innerHTML=html;
  $('#calLegend').innerHTML=M.placeKeys.map(k=>
    '<span><i style="background:'+M.PLACES[k].c+'"></i>'+esc(M.PLACES[k].n)+'</span>').join('')+
    '<span><i style="background:#4b5876"></i>faded = nothing booked</span>';
  buildChapters();
}

/* every stretch spent in one town, in order — including the places only touched in transit */
function buildChapters(){
  const chs=[];
  M.LEGS.forEach((l,i)=>{
    const stay=M.SEGS.find(s=>s.type==='stay'&&s.t0===l.t1);
    const last=i===M.LEGS.length-1;
    const s=stay||{t0:l.t1, t1:l.t1, place:l.to};
    const P=M.PLACES[s.place];
    const hrs=(s.t1-s.t0)/HOUR, nts=hrs/24;
    const beds=M.STAYS.filter(h=>h.place===s.place&&h.t0<Math.max(s.t1,s.t0+1)&&h.t1>s.t0);
    const names=[...new Set(beds.map(b=>b.name.replace(/ \(.*\)$/,'')))];
    const booked=M.ITEMS.filter(it=>it.t0>=s.t0&&it.t0<=s.t1&&it.cls==='activity').length;
    let big,unit;
    if(last){ big='end'; unit='of the road'; }
    else if(nts>=1){ big=String(Math.round(nts)); unit=Math.round(nts)===1?'night':'nights'; }
    else if(hrs>=1){ big=String(Math.round(hrs)); unit=Math.round(hrs)===1?'hour':'hours'; }
    else if(hrs>0){ big=String(Math.round(hrs*60)); unit='minutes'; }
    else { big='—'; unit='transit only'; }
    chs.push({s,P,hrs,names,booked,last,big,unit});
  });
  $('#chapters').innerHTML=chs.map(c=>
    '<div class="chapter" data-t="'+(c.s.t0+(c.hrs>1?HOUR:0))+'">'+
      '<div class="bar" style="background:'+c.P.c+'"></div>'+
      '<b>'+esc(c.P.n)+'</b>'+
      '<div class="cw">'+fmt(c.s.t0,c.P.off,'d')+(c.hrs>=20?' → '+fmt(c.s.t1,c.P.off,'d'):'')+'</div>'+
      '<div class="cn"><span class="cbig">'+c.big+'<span>'+c.unit+'</span></span></div>'+
      '<div class="cn">'+
        (c.names.length?esc(c.names.join(' · '))
         : c.last?'<span style="color:var(--txt-faint)">home</span>'
         : c.hrs<6?'<span style="color:var(--gap)">passing through</span>'
         : '<span style="color:var(--gap)">no bed booked</span>')+
        '<br>'+(c.booked?c.booked+' thing'+(c.booked>1?'s':'')+' booked':'nothing scheduled')+'</div>'+
    '</div>').join('');
}

/* ============================================================
   5.  Itinerary list
   ============================================================ */
function passes(it){
  if(filter==='warn' && !it.warn) return false;
  if(filter!=='all' && filter!=='warn' && it.cls!==filter) return false;
  if(query){
    const hay=(it.title+' '+it.sub+' '+(it.det||'')+' '+M.PLACES[it.place].n).toLowerCase();
    if(!hay.includes(query)) return false;
  }
  return true;
}
function renderList(){
  const listEl=$('#list');
  let html='', lastKey='', n=0;
  M.ITEMS.forEach(it=>{
    if(!passes(it)) return;
    n++;
    const key=fmt(it.t0,it.off,'k');
    if(key!==lastKey){
      lastKey=key;
      html+='<div class="daygroup"><b>'+fmt(it.t0,it.off,'d')+'</b>'+esc(M.PLACES[it.place].n)+
            '<span class="dnum">day '+M.dayNo(it.t0)+'</span></div>';
    }
    html+='<div class="card" data-id="'+esc(it.id)+'" data-t="'+it.t0+'">'+
      '<div class="rail" style="background:'+it.color+'"></div>'+
      '<div class="when"><b>'+fmt(it.t0,it.off,'t')+'</b><span>'+tzLabel(it.off)+'</span></div>'+
      '<div class="body">'+
        '<div class="ttl"><svg viewBox="0 0 24 24" fill="'+it.color+'"><path d="'+it.icon+'"/></svg><span>'+esc(it.title)+'</span></div>'+
        (it.sub?'<div class="sub">'+esc(it.sub)+'</div>':'')+
        '<div class="meta">'+it.tags.map(t=>'<span class="tag">'+esc(t)+'</span>').join('')+
          (it.warn?'<span class="tag warn">⚠ heads-up</span>':'')+'</div>'+
        ((it.det||it.warn)?'<div class="det">'+(it.warn?'<b style="color:var(--warn)">'+esc(it.warn)+'</b>'+(it.det?'\n\n':''):'')+esc(it.det||'')+'</div>':'')+
        ((it.det||it.warn)?'<div class="more">details ▾</div>':'')+
      '</div></div>';
  });
  listEl.innerHTML = n? html : '<div class="emptylist">Nothing matches that.</div>';
  CARDS=$$('#list .card').map(el=>({el, t:+el.dataset.t}));
  lastActive=-2;
  syncList(now,true);
}
function syncList(ts,force){
  let idx=-1;
  for(let i=0;i<CARDS.length;i++){ if(CARDS[i].t<=ts+1) idx=i; else break; }
  if(idx===lastActive && !force) return;
  if(lastActive>=0 && CARDS[lastActive]) CARDS[lastActive].el.classList.remove('is-active');
  lastActive=idx;
  const active=idx>=0?CARDS[idx].el:null;
  if(!active) return;
  active.classList.add('is-active');
  if(force||!userScrolled){
    programScroll=true;
    const l=$('#list'), r=active.getBoundingClientRect(), lr=l.getBoundingClientRect();
    if(r.top<lr.top+40 || r.bottom>lr.bottom-20) l.scrollTop += (r.top-lr.top) - lr.height*0.38;
    setTimeout(()=>programScroll=false,300);
  }
}
function focusItem(id){
  const c=$('#list .card[data-id="'+CSS.escape(id)+'"]'); if(!c) return;
  userScrolled=false; c.classList.add('open');
  const l=$('#list'), r=c.getBoundingClientRect(), lr=l.getBoundingClientRect();
  l.scrollTop += (r.top-lr.top) - lr.height*0.32;
}

/* ============================================================
   6.  Time controls
   ============================================================ */
function setNow(ts,fromScrub){
  now=clamp(ts,M.T0,M.T1);
  if(!fromScrub) scrub.value=Math.round((now-M.T0)/M.TRIP_MS*10000);
  render();
}
function render(){
  updateRoutes(now);
  placePuck();
  updateJourney(now);
  syncList(now);
  const L=M.locationAt(now);
  const off=L.moving? (L.f<.5?L.leg.A.off:L.leg.B.off) : L.P.off;
  $('#roTime').textContent=fmt(now,off,'t')+'  '+tzLabel(off);
  $('#roDate').textContent=fmt(now,off,'D')+'  ·  day '+M.dayNo(now)+' of '+M.TOTAL_DAYS;
  const ic=$('#roIcon');
  if(L.moving){
    const l=L.leg;
    ic.style.background=MODE_COLOR[l.mode]+'22';
    ic.innerHTML='<svg viewBox="0 0 24 24" fill="'+MODE_COLOR[l.mode]+'"><path d="'+modeIcon(l.mode)+'"/></svg>';
    $('#roPlace').textContent=l.A.n+' → '+l.B.n;
    $('#roStatus').textContent=(l.mode==='gap'?'unbooked stretch · ':'')+Math.round(L.f*100)+'% of the way · '+
      dur(l.t1-now)+' to go';
  } else {
    ic.style.background=L.P.c+'22';
    ic.innerHTML='<svg viewBox="0 0 24 24" fill="'+L.P.c+'"><path d="'+ICON.bed+'"/></svg>';
    const st=M.STAYS.find(s=>now>=s.t0&&now<=s.t1&&s.place===L.place);
    $('#roPlace').textContent=L.P.n;
    $('#roStatus').textContent= st? st.name : (L.seg? 'in town · '+dur(L.seg.t1-now)+' until the next move' : L.P.r||'');
  }
  const pct=((now-M.T0)/M.TRIP_MS*100).toFixed(2);
  scrub.style.setProperty('--track','linear-gradient(90deg,#f7b955 0%,#fb7185 '+pct+'%,#1c2743 '+pct+'%)');
  if(follow) centerOnTraveler();
}
function togglePlay(){
  playing=!playing;
  $('#playIcon').innerHTML= playing?'<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>':'<path d="M8 5v14l11-7z"/>';
  if(playing){ if(now>=M.T1-1000) now=M.T0; last=performance.now(); raf=requestAnimationFrame(tick); }
  else cancelAnimationFrame(raf);
}
function stopPlay(){ if(playing) togglePlay(); }
function tick(t){
  const dt=Math.min(120,t-last); last=t;
  // 1× ≈ 2.2 days of trip per second, but travel legs slow right down so you can see them
  const L=M.locationAt(now);
  const rate=(L.moving? 0.16 : 2.2)*speed*DAY/1000;
  setNow(now+dt*rate);
  if(now>=M.T1){ togglePlay(); return; }
  raf=requestAnimationFrame(tick);
}
function flash(el,msg){
  const old=el.textContent; el.textContent=msg;
  setTimeout(()=>el.textContent=old,1400);
}
/* scrubber tick marks — month boundaries derived from the trip window */
function buildScrubMarks(){
  const calShift=M.calOff*MIN;
  let html='';
  const start=new Date(M.T0+calShift);
  let d=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),1));
  for(let guard=0; guard<40; guard++){
    const t=d.getTime()-calShift;
    if(t>M.T1) break;
    if(t>M.T0) html+='<div class="mk" style="left:'+((t-M.T0)/M.TRIP_MS*100).toFixed(2)+'%">'+MON[d.getUTCMonth()].toUpperCase()+'</div>';
    d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));
  }
  const t=Date.now();
  if(t>M.T0&&t<M.T1) html+='<div class="mk today" title="today" style="left:'+((t-M.T0)/M.TRIP_MS*100).toFixed(2)+'%"></div>';
  $('#trackmarks').innerHTML=html;
}

/* ============================================================
   7.  Header (title + stats)
   ============================================================ */
function buildHeader(){
  const km=M.LEGS.reduce((s,l)=>s+l.km,0);
  const countries=new Set(M.placeKeys.map(k=>M.PLACES[k].cc||'?')).size;
  const flights=M.LEGS.filter(l=>l.mode==='flight').length;
  const ground=M.LEGS.filter(l=>GROUND_MODES.has(l.mode)).length;
  const gaps=M.LEGS.filter(l=>l.mode==='gap').length;
  const acts=M.EVENTS.filter(e=>e.kind==='activity').length;
  const rows=[
    [M.TOTAL_DAYS,'days'],[countries,'countries'],[M.placeKeys.length,'places'],
    [(km>=1500? Math.round(km/1000)+'k' : Math.round(km)),'km'],[flights,'flights'],[ground,'ground'],
    [M.STAYS.length,'stays'],[acts,'booked'],[gaps,'gaps']
  ];
  $('#stats').innerHTML=rows.map(r=>'<div class="stat"><b>'+r[0]+'</b><span>'+r[1]+'</span></div>').join('');
  $('#brandTitle').textContent=M.title;
  $('#brandSub').textContent=fmt(M.T0,M.originOff,'D')+'  →  '+fmt(M.T1,M.originOff,'D')+'  ·  '+M.TOTAL_DAYS+' days';
  document.title=M.title+' · Trip visualizer';
}

/* ============================================================
   8.  Tooltip
   ============================================================ */
function showTip(e,html){
  tip.innerHTML=html; tip.style.opacity=1;
  const pad=14, w=tip.offsetWidth, h=tip.offsetHeight;
  let x=e.clientX+pad, y=e.clientY+pad;
  if(x+w>innerWidth-8) x=e.clientX-w-pad;
  if(y+h>innerHeight-8) y=e.clientY-h-pad;
  tip.style.left=x+'px'; tip.style.top=y+'px';
}
function hideTip(){ tip.style.opacity=0; }

/* ============================================================
   9.  Trip loading + library
   ============================================================ */
function loadTrip(cfg){
  M=buildModel(cfg);           // throws on a broken config — callers catch
  stopPlay();
  now=M.T0;
  follow=false; syncFollowBtn();
  fitSet=null; view.k=1; view.x=0; view.y=0;
  query=''; $('#q').value='';
  filter='all'; $$('#filters button').forEach(b=>b.classList.toggle('on',b.dataset.f==='all'));

  buildHeader();
  buildMapLayers();
  fitTo(); applyView();
  buildCalendar();
  buildScrubMarks();
  renderList();
  jGeom=null;
  if(currentView==='journey') drawJourney();
  setNow(M.T0);
}
function populateTripSel(value){
  const sel=$('#tripSel');
  sel.innerHTML='<option value="__demo">Demo trip</option>'+
    TripStore.names().map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('');
  sel.value=value||'__demo';
  if(sel.selectedIndex<0) sel.value='__demo';
}
function loadByName(name){
  if(name==='__demo'){ TripStore.setActive(''); loadTrip(DEMO_TRIP); return; }
  const cfg=TripStore.get(name);
  try{
    if(!cfg) throw new Error('Trip "'+name+'" was not found in this browser.');
    loadTrip(cfg);
    TripStore.setActive(name);
  }catch(err){
    alert('Could not load "'+name+'": '+err.message+'\n\nFalling back to the demo trip. Open the editor to fix it.');
    populateTripSel('__demo');
    loadTrip(DEMO_TRIP);
    TripStore.setActive('');
  }
}

/* ============================================================
   10.  Event wiring (bound once — layers are rebuilt per trip,
        so all handlers use delegation on stable containers)
   ============================================================ */
function bindUI(){
  /* map pan/zoom */
  mapSvg.addEventListener('wheel',e=>{ e.preventDefault(); stopFollow(); zoomAt(e.clientX,e.clientY, e.deltaY<0?1.18:1/1.18); },{passive:false});
  mapSvg.addEventListener('pointerdown',e=>{
    if(e.button) return;
    drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y,moved:false};
  });
  addEventListener('pointermove',e=>{
    if(!drag) return;
    const r=mapSvg.getBoundingClientRect();
    const sx=base.w/r.width, sy=base.h/r.height;
    view.x=drag.vx+(e.clientX-drag.x)*sx; view.y=drag.vy+(e.clientY-drag.y)*sy;
    if(Math.abs(e.clientX-drag.x)+Math.abs(e.clientY-drag.y)>3){ drag.moved=true; stopFollow(); }
    applyView();
  });
  addEventListener('pointerup',()=>{
    if(drag&&drag.moved){ didPan=true; setTimeout(()=>didPan=false,60); }
    drag=null;
  });
  $('#zIn').onclick=()=>{ const r=mapSvg.getBoundingClientRect(); zoomAt(r.left+r.width/2,r.top+r.height/2,1.6); };
  $('#zOut').onclick=()=>{ const r=mapSvg.getBoundingClientRect(); zoomAt(r.left+r.width/2,r.top+r.height/2,1/1.6); };
  $('#zFit').onclick=()=>{ fitSet=null; view.k=1;view.x=0;view.y=0; stopFollow(); fitTo(); applyView(); };
  $('#zFocus').onclick=()=>{ fitSet=M.focusKeys; view.k=1;view.x=0;view.y=0; stopFollow(); fitTo(); applyView(); };
  $('#zFollow').onclick=()=>{
    follow=!follow; syncFollowBtn();
    if(follow){ if(view.k<3.5) view.k=3.5; centerOnTraveler(); }
  };

  /* map hover + click (delegated) */
  $('#gNodes').addEventListener('pointerover',e=>{
    const g=e.target.closest('.node'); if(!g) return;
    const k=g.dataset.place, P=M.PLACES[k];
    const n=Math.round(M.NIGHTS[k]||0);
    const visits=M.SEGS.filter(s=>s.type==='stay'&&s.place===k);
    const st=M.STAYS.filter(s=>s.place===k).map(s=>'· '+esc(s.name)).join('<br>');
    showTip(e, '<b>'+esc(P.n)+'</b><span class="m">'+esc(P.r)+(P.r?' · ':'')+tzLabel(P.off)+'</span>'+
      '<div style="margin-top:5px">'+(n?n+' night'+(n>1?'s':''):'transit only')+
      (visits.length>1?' over '+visits.length+' visits':'')+'</div>'+(st?'<div class="m" style="margin-top:4px">'+st+'</div>':''));
  });
  $('#gNodes').addEventListener('pointerout',hideTip);
  $('#gNodes').addEventListener('click',e=>{
    const g=e.target.closest('.node'); if(!g||didPan) return;
    const k=g.dataset.place;
    const seg=M.SEGS.find(s=>s.type==='stay'&&s.place===k&&s.t1>now) || M.SEGS.find(s=>s.type==='stay'&&s.place===k);
    if(seg) setNow(seg.t0+Math.min(6*HOUR,(seg.t1-seg.t0)/2));
  });
  $('#gRoutesHit').addEventListener('pointerover',e=>{
    const p=e.target.closest('[data-leg]'); if(!p) return;
    const l=M.LEGS.find(l=>l.id===p.dataset.leg); if(!l) return;
    showTip(e,'<b>'+esc(l.title)+'</b><span class="m">'+esc(l.op||'')+'</span>'+
     '<div style="margin-top:5px">'+fmt(l.t0,l.A.off,'d')+' '+fmt(l.t0,l.A.off,'t')+' → '+fmt(l.t1,l.B.off,'t')+' '+tzLabel(l.B.off)+'</div>'+
     '<div class="m">'+Math.round(l.km).toLocaleString()+' km · '+dur(l.t1-l.t0)+'</div>');
  });
  $('#gRoutesHit').addEventListener('pointerout',hideTip);
  $('#gRoutesHit').addEventListener('click',e=>{
    const p=e.target.closest('[data-leg]'); if(!p||didPan) return;
    const l=M.LEGS.find(l=>l.id===p.dataset.leg); if(!l) return;
    setNow(l.t0+(l.t1-l.t0)*0.4); focusItem(l.id);
  });
  $('#gSub').addEventListener('pointerover',e=>{
    const g=e.target.closest('[data-sub]'); if(!g) return;
    const p=SUB[+g.dataset.sub];
    showTip(e,'<b>'+esc(p.n)+'</b><span class="m">'+esc(p.s)+'</span>');
  });
  $('#gSub').addEventListener('pointerout',hideTip);
  $('#gSub').addEventListener('click',e=>{
    const g=e.target.closest('[data-sub]'); if(!g||didPan) return;
    const p=SUB[+g.dataset.sub]; setNow(p.ref.t0); focusItem(p.ref.id+(p.t==='stay'?'i':''));
  });

  /* journey chart */
  jSvg.addEventListener('pointermove',e=>{
    const el=e.target.closest('[data-leg],[data-stay],[data-ev]');
    if(!el){ hideTip(); return; }
    if(el.dataset.leg){
      const l=M.LEGS.find(l=>l.id===el.dataset.leg); if(!l) return;
      showTip(e,'<b>'+esc(l.title)+'</b><span class="m">'+esc(l.op||'')+'</span><div style="margin-top:4px">'+
        fmt(l.t0,l.A.off,'d')+' '+fmt(l.t0,l.A.off,'t')+' → '+fmt(l.t1,l.B.off,'t')+'</div><div class="m">'+
        Math.round(l.km).toLocaleString()+' km · '+dur(l.t1-l.t0)+'</div>');
    } else if(el.dataset.stay){
      const st=M.STAYS.find(s=>s.id===el.dataset.stay); if(!st) return;
      showTip(e,'<b>'+esc(st.name)+'</b><span class="m">'+esc(st.addr||'')+'</span><div style="margin-top:4px">'+
        fmt(st.t0,st.P.off,'d')+' → '+fmt(st.t1,st.P.off,'d')+' · '+nights(st.t0,st.t1)+' night'+(nights(st.t0,st.t1)>1?'s':'')+'</div>');
    } else {
      const ev=M.EVENTS.find(x=>x.id===el.dataset.ev); if(!ev) return;
      showTip(e,'<b>'+esc(ev.title)+'</b><span class="m">'+fmt(ev.t0,ev.P.off,'d')+' '+fmt(ev.t0,ev.P.off,'t')+
        (ev.end?' – '+fmt(ev.t1,ev.P.off,'t'):'')+'</span>');
    }
  });
  jSvg.addEventListener('pointerleave',hideTip);
  jSvg.addEventListener('click',e=>{
    const el=e.target.closest('[data-leg],[data-stay],[data-ev]');
    if(el){
      if(el.dataset.leg){ const l=M.LEGS.find(l=>l.id===el.dataset.leg); if(l){ setNow(l.t0+(l.t1-l.t0)*.4); focusItem(l.id); } return; }
      if(el.dataset.stay){ const s=M.STAYS.find(s=>s.id===el.dataset.stay); if(s){ setNow(s.t0); focusItem(s.id+'i'); } return; }
      const ev=M.EVENTS.find(x=>x.id===el.dataset.ev); if(ev){ setNow(ev.t0); focusItem(ev.id); } return;
    }
    // click anywhere on the plot to scrub
    if(!jGeom) return;
    const r=jSvg.getBoundingClientRect();
    const vx=(e.clientX-r.left)/r.width*jGeom.W;
    if(vx>jGeom.m.l) setNow(M.T0+(vx-jGeom.m.l)/jGeom.iw*M.TRIP_MS);
  });
  $('#jOrder').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    jOrder=b.dataset.order;
    $$('#jOrder button').forEach(x=>x.classList.toggle('on',x===b));
    drawJourney();
  });

  /* calendar + chapters (delegated once — the old page re-bound these on
     every rebuild, stacking duplicate handlers) */
  $('#calGrid').addEventListener('click',e=>{
    const d=e.target.closest('.day.in'); if(!d) return;
    setNow(clamp(+d.dataset.t,M.T0,M.T1));
  });
  $('#calGrid').addEventListener('pointerover',e=>{
    const d=e.target.closest('.day.in'); if(!d) return;
    const t=+d.dataset.t, L=M.locationAt(clamp(t,M.T0,M.T1));
    const dayStart=t-12*HOUR, dayEnd=dayStart+DAY;
    const evs=M.ITEMS.filter(it=>it.t0>=dayStart&&it.t0<dayEnd);
    showTip(e,'<b>'+fmt(t,M.calOff,'D')+'</b><span class="m">'+
      (L.moving?'travelling '+esc(M.PLACES[L.leg.from].n)+' → '+esc(M.PLACES[L.leg.to].n):'in '+esc(L.P.n)+(L.P.r?', '+esc(L.P.r):''))+'</span>'+
      (evs.length?'<div style="margin-top:5px">'+evs.map(it=>'· '+fmt(it.t0,it.off,'t')+' '+esc(it.title)).join('<br>')+'</div>'
                 :'<div class="m" style="margin-top:5px">nothing scheduled</div>'));
  });
  $('#calGrid').addEventListener('pointerout',hideTip);
  $('#chapters').addEventListener('click',e=>{
    const c=e.target.closest('.chapter'); if(!c) return;
    setNow(+c.dataset.t); setView('map');
  });

  /* itinerary list */
  $('#list').addEventListener('click',e=>{
    const c=e.target.closest('.card'); if(!c) return;
    if(e.target.closest('.more')||e.target.closest('.det')){ c.classList.toggle('open'); return; }
    setNow(+c.dataset.t);
    if(view.k>1.05) centerOnTraveler();
    c.classList.toggle('open');
  });
  $('#filters').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    filter=b.dataset.f; $$('#filters button').forEach(x=>x.classList.toggle('on',x===b)); renderList();
  });
  $('#q').addEventListener('input',e=>{ query=e.target.value.trim().toLowerCase(); renderList(); });
  $('#list').addEventListener('scroll',()=>{
    if(programScroll) return;
    userScrolled=true; clearTimeout(scrollTimer);
    scrollTimer=setTimeout(()=>userScrolled=false,4000);
  });

  /* transport */
  scrub.min=0; scrub.max=10000; scrub.step=1;
  scrub.addEventListener('input',()=>{ setNow(M.T0+(+scrub.value/10000)*M.TRIP_MS,true); });
  $('#play').onclick=togglePlay;
  $('#speed').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    speed=+b.dataset.s; $$('#speed button').forEach(x=>x.classList.toggle('on',x===b));
  });
  $('#stepBack').onclick=()=>setNow(now-6*HOUR);
  $('#stepFwd').onclick=()=>setNow(now+6*HOUR);
  $('#toNow').onclick=()=>{
    const t=Date.now();
    setNow(clamp(t,M.T0,M.T1));
    if(t<M.T0||t>M.T1) flash($('#toNow'), t<M.T0?'not yet':'trip over');
  };

  /* tooltip dismiss */
  addEventListener('pointerdown',e=>{ if(!e.target.closest('svg')) hideTip(); });

  /* tabs */
  $('#tabs').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    setView(b.dataset.view);
  });

  /* keyboard */
  addEventListener('keydown',e=>{
    if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
    else if(e.key==='ArrowRight') setNow(now+(e.shiftKey?DAY:6*HOUR));
    else if(e.key==='ArrowLeft') setNow(now-(e.shiftKey?DAY:6*HOUR));
    else if(e.key==='1') setView('map');
    else if(e.key==='2') setView('journey');
    else if(e.key==='3') setView('calendar');
  });

  /* resize */
  let rz=null;
  addEventListener('resize',()=>{
    clearTimeout(rz);
    rz=setTimeout(()=>{
      if(currentView==='map'){ fitTo(); applyView(); }
      else mapNeedsFit=true;
      if(currentView==='journey') drawJourney();
    },120);
  });

  /* trip selector + drag-and-drop loading */
  $('#tripSel').addEventListener('change',e=>loadByName(e.target.value));
  addEventListener('dragover',e=>{ e.preventDefault(); });
  addEventListener('drop',e=>{
    e.preventDefault();
    const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
    if(!f) return;
    const rd=new FileReader();
    rd.onload=()=>{
      try{
        const cfg=parseTripConfigText(rd.result);
        loadTrip(cfg);
        const sel=$('#tripSel');
        let opt=$('#tripSel option[value="__dropped"]');
        if(!opt){ opt=document.createElement('option'); opt.value='__dropped'; sel.appendChild(opt); }
        opt.textContent='(file) '+f.name;
        sel.value='__dropped';
      }catch(err){ alert('Could not load "'+f.name+'": '+err.message); }
    };
    rd.readAsText(f);
  });
}

function setView(v){
  currentView=v;
  $$('#tabs button').forEach(x=>x.classList.toggle('on',x.dataset.view===v));
  $$('.view').forEach(x=>x.classList.toggle('on',x.id==='view-'+v));
  if(v==='journey') drawJourney();
  if(v==='map'&&mapNeedsFit){ fitTo(); applyView(); }
}

/* ============================================================
   11.  Boot
   ============================================================ */
bindUI();
(function boot(){
  const active=TripStore.active();
  if(active && TripStore.get(active)){
    populateTripSel(active);
    loadByName(active);
  } else {
    populateTripSel('__demo');
    loadByName('__demo');
  }
})();
