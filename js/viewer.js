"use strict";
/* ============================================================
   Trip visualizer — viewer
   Renders whatever trip config is loaded (saved trip, dropped
   file, or the bundled demo). All trip-specific data lives in
   the config; nothing about a particular trip is hardcoded here.
   ============================================================ */

/* ---------- state ---------- */
let M=null;                                   // current derived model (buildModel)
let curCfg=null, curName='__demo';            // raw config behind M, and its library name (or __demo / __dropped)
let now=0, playing=false, speed=1, raf=null, last=0;
const view={k:1,x:0,y:0}, base={x:0,y:0,w:1,h:1};
let follow=false, fitSet=null, mapNeedsFit=false;
let currentView='map', mapZoom='fit', liveNow=false, calModePref=null;
let filter='all', query='', CARDS=[], lastActive=-2, userScrolled=false, programScroll=false, scrollTimer=null, scrollRaf=null;
let jOrder='seq', jGeom=null;
const UI_PREFS_KEY='tripviz.ui';
const narrow=matchMedia('(max-width:940px)');
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
function readUiPrefs(){
  try{
    const p=JSON.parse(localStorage.getItem(UI_PREFS_KEY)||'{}');
    if(['map','journey','calendar','chapters','list'].includes(p.view)) currentView=p.view;
    if(p.mapZoom==='fit'||p.mapZoom==='focus'||p.mapZoom==='follow') mapZoom=p.mapZoom;
    if(p.calMode==='month'||p.calMode==='week') calModePref=p.calMode;
  }catch(e){}
}
function saveUiPrefs(){
  try{ localStorage.setItem(UI_PREFS_KEY, JSON.stringify({view:currentView, mapZoom:mapZoom, calMode:calModePref})); }catch(e){}
}
function syncZoomBtns(){
  $('#zFit').classList.toggle('on', !follow && mapZoom==='fit');
  $('#zFocus').classList.toggle('on', !follow && mapZoom==='focus');
  $('#zFollow').classList.toggle('on', follow);
}
function syncFollowBtn(){ syncZoomBtns(); }
function stopFollow(){ if(follow){ follow=false; syncZoomBtns(); } }
function setMapZoom(mode){
  mapZoom=mode;
  if(mode==='follow'){
    follow=true;
    if(view.k<3.5) view.k=3.5;
    centerOnTraveler();
  } else {
    follow=false;
    fitSet = mode==='focus' ? M.focusKeys : null;
    view.k=1; view.x=0; view.y=0;
    fitTo(); applyView();
  }
  syncZoomBtns();
  saveUiPrefs();
}
function applySavedMapZoom(){
  follow=false;
  view.k=1; view.x=0; view.y=0;
  if(mapZoom==='focus') fitSet=M.focusKeys;
  else fitSet=null;
  fitTo();
  if(mapZoom==='follow'){
    follow=true;
    if(view.k<3.5) view.k=3.5;
    centerOnTraveler();
  }
  syncZoomBtns();
  applyView();
}
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
  setTripDays();
  const first=new Date(tripIdx0*DAY), lastD=new Date(tripIdx1*DAY);
  const months=[];
  let y=first.getUTCFullYear(), mo=first.getUTCMonth();
  while(y<lastD.getUTCFullYear() || (y===lastD.getUTCFullYear()&&mo<=lastD.getUTCMonth())){
    months.push([y,mo]);
    mo++; if(mo>11){ mo=0; y++; }
  }
  buildDayFlags();
  let html='';
  months.forEach(([yy,mm])=>{
    const firstDow=new Date(Date.UTC(yy,mm,1)).getUTCDay();
    const nDays=new Date(Date.UTC(yy,mm+1,0)).getUTCDate();
    let cells='';
    for(let i=0;i<firstDow;i++) cells+='<div></div>';
    for(let dnum=1;dnum<=nDays;dnum++){
      const dayStart=Date.UTC(yy,mm,dnum,0,0)-calShift, idx=cellIdx(dayStart);
      const sample=dayStart+12*HOUR;
      const inTrip=idx>=tripIdx0 && idx<=tripIdx1;
      if(!inTrip){ cells+='<div class="day"><span class="num">'+dnum+'</span></div>'; continue; }
      const evs=M.ITEMS.filter(it=>itemIdx(it)===idx&&it.cls!=='gap');
      const gapDay=!evs.length;
      const isToday=idx===todayIdx();
      const dots=evs.slice(0,5).map(()=>'<i></i>').join('');
      cells+='<div class="day in'+(isToday?' today':'')+(gapDay?' open':'')+'" data-t="'+sample+'" data-d0="'+dayStart+'">'+
        flagIcons(dayStart)+
        '<span class="num">'+dnum+'</span><span class="band" style="background:'+dayBand(dayStart)+'"><span class="evd">'+dots+'</span></span></div>';
    }
    html+='<div class="month"><h3>'+MON_FULL[mm]+' '+yy+'</h3>'+
      '<div class="dow">'+['S','M','T','W','T','F','S'].map(d=>'<span>'+d+'</span>').join('')+'</div>'+
      '<div class="days">'+cells+'</div></div>';
  });
  $('#calGrid').innerHTML=html;
  const flagged=Object.values(DAY_FLAGS);
  $('#calLegend').innerHTML=M.placeKeys.map(k=>
    '<span><i style="background:'+M.PLACES[k].c+'"></i>'+esc(M.PLACES[k].n)+'</span>').join('')+
    '<span><i style="background:#4b5876"></i>faded number = nothing booked</span>'+
    (flagged.some(f=>f.moves.length)?'<span>'+flagSvg('move')+'no transport booked</span>':'')+
    (flagged.some(f=>f.stay)?'<span>'+flagSvg('stay')+'no bed booked that night</span>':'');
  calCurDay=null;
  if(wkDay!=null) wkDay=clamp(wkDay,tripFirstDay(),tripLastDay());
  updateCalendar(now);
  if(calMode==='week') renderWeek();
  syncCalPast();
}
/* while the trip is under way, days that are already over fade back */
function syncCalPast(){
  const wall=Date.now(), active=wall>=M.T0&&wall<=M.T1;
  $$('#calGrid .day.in, #wkDays .wk-day.in').forEach(d=>d.classList.toggle('past',active && daysAhead(cellIdx(+d.dataset.d0))<0));
}
/* fromUser: remember the choice, so the next visit (and the next trip) opens the same sub-view */
function setCalMode(mode,noRender,fromUser){
  calMode=mode;
  $('#view-calendar').classList.toggle('week',mode==='week');
  hideTip();
  if(fromUser){ calModePref=mode; saveUiPrefs(); }
  if(noRender) return;
  if(mode==='week') renderWeek();
  else scrollToCurMonth();
}
/* bring the month holding the playhead's day into view, unless it's already fully visible */
function scrollToCurMonth(){
  if(currentView!=='calendar' || calMode!=='month' || !calCurDay) return;
  const wrap=$('#calWrap'), m=calCurDay.closest('.month');
  const wr=wrap.getBoundingClientRect(), mr=m.getBoundingClientRect();
  if(mr.top>=wr.top && mr.bottom<=wr.bottom) return;
  wrap.scrollTop+=mr.top-wr.top-12;
}
function scrollToCurChapter(){
  const c=calCurChap!=null && calCurChap>=0 ? $$('#chapters .chapter')[calCurChap] : null;
  if(currentView!=='chapters' || !c) return;
  const wrap=$('#chapWrap'), wr=wrap.getBoundingClientRect(), cr=c.getBoundingClientRect();
  if(cr.top>=wr.top && cr.bottom<=wr.bottom) return;
  wrap.scrollTop+=cr.top-wr.top-Math.max(12,(wr.height-cr.height)/2);
}

/* booking holes per calendar day: moves between towns with nothing booked (an unbooked "gap" leg, or a leg
   that starts somewhere other than where the last one ended), and nights with no bed booked */
let DAY_FLAGS={};
const FLAG_ICON={
  move:'M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z',
  stay:ICON.bed
};
function buildDayFlags(){
  DAY_FLAGS={};
  const at=d0=>DAY_FLAGS[d0]||(DAY_FLAGS[d0]={stay:null,moves:[]});
  M.LEGS.forEach((l,i)=>{
    const p=M.LEGS[i-1];
    const d0=dayOfIdx(dateIdx(l.t0,l.A.off));
    if(p && p.to!==l.from) at(d0).moves.push({from:p.to,to:l.from});
    if(l.mode==='gap') at(d0).moves.push({from:l.from,to:l.to,id:l.id});
  });
  for(let d0=tripFirstDay();d0<=tripLastDay();d0+=DAY){
    const s=nightGap(d0);
    if(s) at(d0).stay=s;
  }
}
/* the night after day d0, checked at 2am local time: a hole when you're settled away from home for more than a
   quick connection (or out on an unbooked stretch) and no stay covers it — night trains and red-eyes don't count */
function nightGap(d0){
  const off=M.locationAt(clamp(d0+20*HOUR,M.T0,M.T1)).P.off;
  const tn=Math.floor((d0+12*HOUR+off*MIN)/DAY)*DAY+DAY+2*HOUR-off*MIN;
  if(tn<=M.T0 || tn>=M.T1) return null;
  const L=M.locationAt(tn);
  if(!L.seg) return null;
  if(L.moving? L.leg.mode!=='gap' : (L.place===M.originKey || L.seg.t1-L.seg.t0<6*HOUR)) return null;
  if(M.STAYS.some(s=>tn>=s.t0 && tn<s.t1)) return null;
  return L.moving? {from:L.leg.from,to:L.leg.to} : {place:L.place};
}
function flagSvg(k){ return '<svg class="flag-ic '+k+'" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="'+FLAG_ICON[k]+'"/></svg>'; }
function flagTexts(d0){
  const f=DAY_FLAGS[d0], out=[];
  if(!f) return out;
  const n=k=>esc(M.PLACES[k].n);
  f.moves.forEach(m=>out.push({k:'move', txt:'No transport booked · '+n(m.from)+' → '+n(m.to)}));
  if(f.stay) out.push({k:'stay', txt:'No bed booked tonight · '+(f.stay.place? n(f.stay.place) : 'between '+n(f.stay.from)+' and '+n(f.stay.to))});
  return out;
}
/* corner markers on a day square: transport top-left (it happens during the day), the missing bed top-right (that night) */
function flagIcons(d0){
  const f=DAY_FLAGS[d0];
  if(!f) return '';
  const t=flagTexts(d0).map(x=>x.txt).join('\n');
  return '<span class="flags" title="'+t+'">'+(f.moves.length?flagSvg('move'):'<i></i>')+(f.stay?flagSvg('stay'):'')+'</span>';
}

/* the town(s) of one calendar day, left → right through the day, as hard
   colour stops so travel days split sharply at roughly the hour you move */
function dayBand(dayStart){
  const N=48, runs=[];
  for(let i=0;i<N;i++){
    const L=M.locationAt(clamp(dayStart+(i+.5)*DAY/N,M.T0,M.T1));
    const k=L.moving?(L.f<.5?L.leg.from:L.leg.to):L.place;
    const r=runs[runs.length-1];
    if(r&&r.k===k) r.n++; else runs.push({k,n:1});
  }
  // drop sub-hour slivers (layovers, quick connections) into their neighbours
  const kept=[];
  runs.forEach((r,i)=>{
    const prev=kept[kept.length-1];
    if(r.n<2 && runs.length>1){ if(prev) prev.n+=r.n; else runs[i+1].n+=r.n; return; }
    if(prev&&prev.k===r.k) prev.n+=r.n; else kept.push(r);
  });
  if(kept.length===1) return M.PLACES[kept[0].k].c;
  let acc=0;
  return 'linear-gradient(90deg,'+kept.map(r=>{
    const a=acc/N*100; acc+=r.n;
    return M.PLACES[r.k].c+' '+a.toFixed(2)+'% '+(acc/N*100).toFixed(2)+'%';
  }).join(',')+')';
}

/* follow the playhead: highlight its day, and move the week view along with it */
let calCurDay=null, calCurChap=null, calLiveChap=null, chapStarts=[];
function updateCalendar(ts){
  const days=$$('#calGrid .day.in'), idx=localIdx(ts);
  const day=days.find(d=>cellIdx(+d.dataset.d0)===idx)||null;
  if(day!==calCurDay){
    if(calCurDay) calCurDay.classList.remove('cur');
    if(day) day.classList.add('cur');
    calCurDay=day;
    days.forEach(d=>d.classList.toggle('before',cellIdx(+d.dataset.d0)<idx));
  }
  const pd=dayOfIdx(idx);
  if(pd!==wkPlayDay){ wkPlayDay=pd; if(!wkHold) setWeekDay(pd); }
  else syncWeekActive();
}

/* ---------- week view: the selected day's week up top, that day's items below ---------- */
let calMode='month', wkDay=null, wkPlayDay=null, wkShownDay=null, wkActiveId=null, wkHold=false, wkSliding=false, wkSwiped=false;
function tripFirstDay(){ return dayOfIdx(tripIdx0); }
function tripLastDay(){ return dayOfIdx(tripIdx1); }
function weekStartOf(d){ return d-new Date(d+M.calOff*MIN).getUTCDay()*DAY; }
function setWeekDay(d){
  d=clamp(d,tripFirstDay(),tripLastDay());
  if(d===wkDay) return;
  wkDay=d;
  if(calMode==='week') renderWeek();
}
function hasWeek(dir){
  const ws=weekStartOf(wkDay);
  return dir<0 ? ws>tripFirstDay() : ws+7*DAY<=tripLastDay();
}
function renderWeek(){
  if(wkDay==null) wkDay=clamp(localDay(now),tripFirstDay(),tripLastDay());
  const calShift=M.calOff*MIN, ws=weekStartOf(wkDay), sel=new Date(wkDay+calShift);
  $('#wkMonth').textContent=MON_FULL[sel.getUTCMonth()];
  $('#wkPrev').disabled=!hasWeek(-1);
  $('#wkNext').disabled=!hasWeek(1);
  let cells='';
  for(let i=0;i<7;i++){
    const d0=ws+i*DAY, n=new Date(d0+calShift).getUTCDate(), idx=cellIdx(d0);
    const inTrip=idx>=tripIdx0 && idx<=tripIdx1;
    if(!inTrip){ cells+='<div class="wk-day"><span class="num">'+n+'</span></div>'; continue; }
    const evs=M.ITEMS.filter(it=>itemIdx(it)===idx&&it.cls!=='gap');
    const isToday=idx===todayIdx();
    cells+='<button type="button" class="wk-day in'+(d0===wkDay?' sel':'')+(isToday?' today':'')+(evs.length?'':' open')+'" data-d0="'+d0+'"'+
      ' aria-label="'+fmt(d0+12*HOUR,M.calOff,'D')+flagTexts(d0).map(x=>'. '+x.txt).join('')+'"'+(d0===wkDay?' aria-current="date"':'')+'>'+
      flagIcons(d0)+
      '<span class="num">'+n+'</span>'+
      '<span class="band" style="background:'+dayBand(d0)+'"></span>'+
      '<span class="evd">'+evs.slice(0,5).map(()=>'<i></i>').join('')+'</span></button>';
  }
  $('#wkDays').innerHTML=cells;

  const L=M.locationAt(clamp(wkDay+12*HOUR,M.T0,M.T1));
  const where=L.moving? M.PLACES[L.leg.from].n+' → '+M.PLACES[L.leg.to].n : L.P.n;
  const wkIdx=cellIdx(wkDay), n=daysAhead(wkIdx);
  $('#wkTitle').className='wk-title '+(n<0?'past':n===0?'today':'future');
  $('#wkTitle').innerHTML='<b>'+fmt(wkDay+12*HOUR,M.calOff,'d')+'</b><span class="wk-where">'+esc(where)+'</span>'+
    '<span class="dnum">'+(n===0?'Today · ':'')+dayLabel(wkIdx)+'</span>';
  const items=M.ITEMS.filter(it=>itemIdx(it)===wkIdx);
  const flags=flagTexts(wkDay);
  $('#wkList').innerHTML=(flags.length?'<div class="wk-flags'+(n<0?' past':'')+'">'+flags.map(f=>'<div class="wk-flag">'+flagSvg(f.k)+'<span>'+f.txt+'</span></div>').join('')+'</div>':'')+
    (items.length? items.map(it=>cardHTML(it,wkIdx)).join('') : '<div class="emptylist">Nothing booked this day.</div>');
  if(wkDay!==wkShownDay){ $('#wkList').scrollTop=0; wkShownDay=wkDay; }
  wkActiveId=null;
  syncListStatus();
  syncWeekActive();
}
/* the week view highlights the same item as the itinerary list */
function syncWeekActive(){
  if(calMode!=='week') return;
  const c=lastActive>=0?CARDS[lastActive]:null, id=c?c.id:null;
  if(id===wkActiveId) return;
  wkActiveId=id;
  $$('#wkList .card').forEach(el=>el.classList.toggle('is-active',el.dataset.id===id));
}
/* pick a day: it becomes the selected day and the whole page moves to it */
function selectCalDay(d0){
  d0=clamp(d0,tripFirstDay(),tripLastDay());
  if(cellIdx(d0)===todayIdx()) jumpToNow();
  else setNow(clamp(localNoon(cellIdx(d0)),M.T0,M.T1));
  setWeekDay(d0);
}
/* the same weekday in the previous / next week, clamped to the trip */
function stepWeek(dir){
  if(!hasWeek(dir)) return false;
  selectCalDay(wkDay+dir*7*DAY);
  return true;
}
function hasDay(dir){ return dir<0 ? wkDay>tripFirstDay() : wkDay<tripLastDay(); }
/* slide el out towards the swipe, step(), and slide the new content in from the far side */
function slideAcross(el,dir,can,step){
  if(!can){ el.style.transform=''; el.style.opacity=''; return; }
  const w=el.offsetWidth;
  wkSliding=true;
  el.classList.remove('dragging');
  el.style.transform='translateX('+(-dir*w*.6)+'px)';
  el.style.opacity='0';
  setTimeout(()=>{
    wkSliding=false;
    step();
    el.classList.add('dragging');
    el.style.transform='translateX('+(dir*w*.35)+'px)';
    el.style.opacity='0';
    void el.offsetWidth;
    el.classList.remove('dragging');
    el.style.transform=''; el.style.opacity='';
  },160);
}
function slideWeek(dir){ slideAcross($('#wkDays'),dir,hasWeek(dir),()=>stepWeek(dir)); }
function slideDay(dir){ slideAcross($('#wkList'),dir,hasDay(dir),()=>selectCalDay(wkDay+dir*DAY)); }
/* drag el sideways inside area; past a distance or a flick, slide(dir) moves on (dir 1 = next).
   Vertical drags are left to the browser, so a list inside can still scroll. */
function bindSwipe(area,el,has,slide,touchOnly){
  let d=null;
  area.addEventListener('pointerdown',e=>{
    if(e.button || wkSliding || (touchOnly && e.pointerType==='mouse')) return;
    d={id:e.pointerId, x:e.clientX, y:e.clientY, d:0, v:0, last:0, lastT:e.timeStamp, axis:false};
  });
  area.addEventListener('pointermove',e=>{
    if(!d || e.pointerId!==d.id) return;
    const dx=e.clientX-d.x, ax=Math.abs(dx), ay=Math.abs(e.clientY-d.y);
    if(!d.axis){
      if(ax>10 && ax>ay*1.2){ d.axis=true; d.prev=has(-1); d.next=has(1); el.classList.add('dragging'); area.setPointerCapture(e.pointerId); }
      else { if(ay>10) d=null; return; }
    }
    const dt=e.timeStamp-d.lastT;
    if(dt>0) d.v=(dx-d.last)/dt;
    d.last=dx; d.lastT=e.timeStamp; d.d=dx;
    const open=dx<0? d.next : d.prev;
    el.style.transform='translateX('+(open? dx : dx*.25)+'px)';
    if(open) el.style.opacity=String(1-Math.min(.6,ax/el.offsetWidth));
  });
  const end=e=>{
    if(!d || e.pointerId!==d.id) return;
    const s=d; d=null;
    if(!s.axis) return;
    el.classList.remove('dragging');
    wkSwiped=true; setTimeout(()=>{ wkSwiped=false; },0);
    const dir=s.d<0? 1 : -1;
    const go=e.type==='pointerup' && (dir>0? s.next : s.prev) &&
      (Math.abs(s.d)>Math.min(80,el.offsetWidth*.2) || (Math.abs(s.v)>.35 && Math.abs(s.d)>24 && Math.sign(s.v)===-dir));
    if(go) slide(dir);
    else { el.style.transform=''; el.style.opacity=''; }
  };
  area.addEventListener('pointerup',end);
  area.addEventListener('pointercancel',end);
}

/* mark chapters as past / current */
function updateChapters(ts){
  const chapAt=t=>{ let k=-1; chapStarts.forEach((s,i)=>{ if(t>=s) k=i; }); return k; };
  const cur=chapAt(ts);
  const wall=Date.now(), live=wall>=M.T0&&wall<=M.T1?chapAt(wall):-1;
  if(cur!==calCurChap||live!==calLiveChap){
    $$('#chapters .chapter').forEach((c,i)=>{
      c.classList.toggle('past',i<cur);
      c.classList.toggle('cur',i===cur);
      c.classList.toggle('live',i===live);
    });
    calCurChap=cur; calLiveChap=live;
  }
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
  chapStarts=chs.map(c=>c.s.t0);
  calCurChap=null; calLiveChap=null;
  $('#chapters').innerHTML=chs.map(c=>
    '<div class="chapter" data-t="'+(c.s.t0+(c.hrs>1?HOUR:0))+'" style="--pc:'+c.P.c+'">'+
      '<div class="bar"></div><span class="nowtag">Now</span>'+
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
function passes(it,f){
  if(f===undefined) f=filter;
  if(f==='warn' && !it.warn) return false;
  if(f!=='all' && f!=='warn' && it.cls!==f) return false;
  if(query){
    const hay=(it.title+' '+it.sub+' '+(it.det||'')+' '+(it.ref.conf||'')+' '+M.PLACES[it.place].n).toLowerCase();
    if(!hay.includes(query)) return false;
  }
  return true;
}
/* one itinerary row — shared by the list and the calendar's week view */
function cardHTML(it,day){
  return '<div class="card" role="button" tabindex="0" data-id="'+esc(it.id)+'" data-t="'+it.t0+'" data-day="'+day+'">'+
    '<div class="rail" style="background:'+it.color+'"></div>'+
    '<div class="when"><b>'+fmt(it.t0,it.off,'t')+'</b><span>'+tzLabel(it.off)+'</span></div>'+
    '<div class="body">'+
      '<div class="ttl"><svg viewBox="0 0 24 24" fill="'+it.color+'"><path d="'+it.icon+'"/></svg><span>'+esc(it.title)+'</span></div>'+
      (it.sub?'<div class="sub">'+esc(it.sub)+'</div>':'')+
      '<div class="meta">'+it.tags.map(t=>'<span class="tag">'+esc(t)+'</span>').join('')+
        (it.warn?'<span class="tag warn">⚠ heads-up</span>':'')+'</div>'+
    '</div>'+
    '<svg class="chk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Completed"><title>Completed</title><path d="M5 12.5l4.5 4.5L19 7"/></svg>'+
    '<svg class="go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>'+
  '</div>';
}
function renderList(){
  const listEl=$('#list');
  let html='', lastDay=null, n=0;
  M.ITEMS.forEach(it=>{
    if(!passes(it)) return;
    n++;
    const day=itemIdx(it);
    if(day!==lastDay){
      lastDay=day;
      html+='<div class="daygroup" data-day="'+day+'"><b>'+fmt(it.t0,it.off,'d')+'</b>'+esc(M.PLACES[it.place].n)+
            '<span class="dnum"></span></div>';
    }
    html+=cardHTML(it,day);
  });
  listEl.innerHTML = n? html : '<div class="emptylist">Nothing matches that.</div>';
  renderFilterCounts();
  CARDS=$$('#list .card').map(el=>{
    const id=el.dataset.id;
    const it=M.ITEMS.find(x=>x.id===id);
    const leg=it&&M.LEGS.includes(it.ref)?it.ref:null;
    return {el, t:+el.dataset.t, t1:it&&it.t1!=null?it.t1:+el.dataset.t, day:+el.dataset.day, id, lead:leg?leadTime(leg):0, moving:!!leg&&leg.mode!=='gap', gap:!!it&&it.cls==='gap'};
  });
  syncListStatus();
  lastActive=-2;
  syncList(now,true);
}
/* past / today / future by the wall clock: earlier days fade out, and today's items tick off once they're over */
function syncListStatus(){
  $$('#list .daygroup').forEach(h=>{
    const day=+h.dataset.day, n=daysAhead(day), d=$('.dnum',h);
    h.className='daygroup '+(n<0?'past':n===0?'today':'future');
    d.textContent=dayLabel(day);
    if(n>0) d.title='in '+n+' day'+(n===1?'':'s'); else d.removeAttribute('title');
  });
  const wall=Date.now();
  CARDS.forEach(c=>{
    const n=daysAhead(c.day);
    c.el.classList.toggle('past',n<0);
    c.el.classList.toggle('done',n===0 && wall>=c.t1);
  });
  $$('#wkList .card').forEach(el=>{
    const it=M.ITEMS.find(x=>x.id===el.dataset.id), n=daysAhead(+el.dataset.day);
    el.classList.toggle('past',n<0);
    el.classList.toggle('done',n===0 && !!it && wall>=(it.t1!=null?it.t1:it.t0));
  });
  syncCalPast();
}
/* bookings per filter within the current search — a stay counts once, not once for check-in and again for check-out */
function renderFilterCounts(){
  $$('#filters button').forEach(b=>{
    const refs=new Set();
    M.ITEMS.forEach(it=>{ if(passes(it,b.dataset.f)) refs.add(it.ref); });
    $('.fc',b).textContent=refs.size;
    b.classList.toggle('none',!refs.size);
  });
}
function listVisible(){ return $('#list').clientHeight>0; }
/* Days are local calendar dates (day counts from dateIdx): an item belongs to the date on its own clock,
   and "today" is the date where the itinerary has you right now. Calendar cells are keyed by d0, the
   midnight of their date on the calendar's clock (calOff). */
function dayOfIdx(i){ return i*DAY-M.calOff*MIN; }
function cellIdx(d0){ return dateIdx(d0,M.calOff); }
function itemIdx(it){ return dateIdx(it.t0,it.off); }
function localIdx(ts){ return dateIdx(ts,M.offAt(ts)); }
function localDay(ts){ return dayOfIdx(localIdx(ts)); }
function todayIdx(){ return localIdx(Date.now()); }
/* noon of local date i where the itinerary has you then */
function localNoon(i){
  let t=i*DAY+12*HOUR-M.calOff*MIN;
  t=i*DAY+12*HOUR-M.offAt(t)*MIN;
  return t;
}
function daysAhead(idx){ return idx-todayIdx(); }
function dayLabel(idx){
  const n=daysAhead(idx);
  const label='Day '+Math.max(1,idx-M.DAY1_IDX+1);
  return n>0 ? label+' ('+n+'d)' : label;
}
let tripIdx0=0, tripIdx1=0;
function setTripDays(){
  const idxs=M.ITEMS.map(itemIdx).concat(localIdx(M.T0),localIdx(M.T1));
  tripIdx0=Math.min(...idxs); tripIdx1=Math.max(...idxs);
}
function lastStartedIndex(ts){
  let idx=-1;
  for(let i=0;i<CARDS.length;i++){ if(CARDS[i].t<=ts+1) idx=i; else break; }
  return idx;
}
/* how long before departure a leg takes the highlight — by then you should be on your way to it */
const MAX_LEAD=3.5*HOUR;
function leadTime(l){
  if(l.mode==='flight') return (l.A.cc && l.A.cc===l.B.cc ? 2.5 : 3.5)*HOUR;
  if(l.mode==='train'||l.mode==='bus'||l.mode==='ferry') return HOUR;
  if(l.mode==='car') return 30*MIN;
  return 0;
}
/* live: the plane / train / bus / … you're on; otherwise a departure inside its lead time, even with
   something else before it (a check-out on the way to the airport); otherwise an activity still under way;
   otherwise the next thing that hasn't started yet */
function nextHighlightIndex(ts){
  let riding=-1, ongoing=-1, next=-1;
  for(let i=0;i<CARDS.length;i++){
    const c=CARDS[i];
    if(c.t<=ts+1){
      if(ts<c.t1){ if(c.moving) riding=i; else if(!c.gap) ongoing=i; }
      continue;
    }
    if(riding>=0) return riding;
    if(next<0) next=i;
    else if(c.t-MAX_LEAD>ts) break;
    if(c.lead && c.t-c.lead<=ts) return i;
  }
  if(riding>=0) return riding;
  if(ongoing>=0) return ongoing;
  return next>=0 ? next : CARDS.length-1;
}
function scrollCardIntoView(el){
  programScroll=true;
  if(scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf=requestAnimationFrame(()=>{
    scrollRaf=null;
    const l=$('#list'), r=el.getBoundingClientRect(), lr=l.getBoundingClientRect();
    l.scrollTop += (r.top-lr.top) - lr.height*0.38;
    setTimeout(()=>programScroll=false,400);
  });
}
function syncList(ts,force){
  const idx=liveNow ? nextHighlightIndex(Date.now()) : lastStartedIndex(ts);
  if(idx===lastActive && !force) return;
  if(lastActive>=0 && CARDS[lastActive]) CARDS[lastActive].el.classList.remove('is-active');
  lastActive=idx;
  const active=idx>=0?CARDS[idx].el:null;
  if(!active) return;
  active.classList.add('is-active');
  if(!listVisible()) return;
  if(force){
    userScrolled=false;
    scrollCardIntoView(active);
  } else if(!userScrolled){
    const r=active.getBoundingClientRect(), lr=$('#list').getBoundingClientRect();
    if(r.top<lr.top+40 || r.bottom>lr.bottom-20) scrollCardIntoView(active);
  }
}
function focusItem(id){
  const c=$('#list .card[data-id="'+CSS.escape(id)+'"]');
  if(c){
    userScrolled=false;
    const l=$('#list'), r=c.getBoundingClientRect(), lr=l.getBoundingClientRect();
    l.scrollTop += (r.top-lr.top) - lr.height*0.32;
  }
  const it=M.ITEMS.find(x=>x.id===id);
  if(it) setWeekDay(dayOfIdx(itemIdx(it)));
  openCard(id);
}

/* ============================================================
   6.  Time controls
   ============================================================ */
function setNow(ts,fromScrub,opts){
  liveNow=!!(opts&&opts.live);
  now=clamp(ts,M.T0,M.T1);
  if(!fromScrub) scrub.value=Math.round((now-M.T0)/M.TRIP_MS*10000);
  render(opts&&opts.force);
}
function jumpToNow(opts){
  const t=Date.now();
  userScrolled=false;
  setNow(clamp(t,M.T0,M.T1), false, {live:true, force:true});
  if(opts&&opts.announce && (t<M.T0||t>M.T1)) flash($('#toNow'), t<M.T0?'not yet':'trip over');
}
/* opening an item that is under way right now keeps "now" live rather than jumping to t */
function setNowForItem(id,t){
  const it=M.ITEMS.find(x=>x.id===id), r=it&&it.ref, n=Date.now();
  if(r && r.t1>r.t0 && n>=r.t0 && n<r.t1) setNow(n,false,{live:true});
  else setNow(t);
}
/* while "now" is live, follow the wall clock — refreshed on each minute boundary */
let liveTimer=null, liveDay=null;
function refreshLive(){
  if(!M || !liveNow || playing) return;
  const day=todayIdx();
  if(day!==liveDay){
    // "today" markers and "(Nd)" labels are baked into the calendar, scrubber and list
    liveDay=day;
    buildCalendar(); buildScrubMarks(); renderList();
  }
  setNow(clamp(Date.now(),M.T0,M.T1), false, {live:true});
}
function scheduleLiveTick(){
  clearTimeout(liveTimer);
  liveTimer=setTimeout(()=>{ refreshLive(); if(M) syncListStatus(); scheduleLiveTick(); }, MIN-Date.now()%MIN+50);
}
function render(listForce){
  updateRoutes(now);
  placePuck();
  updateJourney(now);
  updateCalendar(now);
  updateChapters(now);
  syncList(now,listForce);
  syncWeekActive();
  const L=M.locationAt(now);
  const off=M.offAt(now);
  const wall=Date.now(), isNow=liveNow && wall>=M.T0 && wall<=M.T1;
  $('#roTime').innerHTML=(isNow?'Now · ':'')+fmt(now,off,'t')+'<span class="tz">'+tzLabel(off)+'</span>';
  $('#roDate').textContent=fmt(now,off,'D')+'  ·  day '+M.dayNo(now,off)+' of '+M.TOTAL_DAYS;
  const ic=$('#roIcon');
  let roItem=null, roTitle=null;
  if(L.moving){
    roItem=L.leg.id;
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
    if(st) roItem=st.id+'i';
    else {
      // nothing under way: link the next item later on the same local day instead
      const dayEnd=Math.floor((now+off*MIN)/DAY)*DAY+DAY-off*MIN;
      const next=M.ITEMS.find(x=>x.t0>now && x.t0<dayEnd);
      if(next){ roItem=next.id; roTitle='Next up: '+next.title; }
    }
    $('#roPlace').textContent=L.P.n;
    $('#roStatus').textContent= st? st.name : (L.seg? 'in town · '+dur(L.seg.t1-now)+' until the next move' : L.P.r||'');
  }
  setRoItem(roItem && M.ITEMS.some(x=>x.id===roItem) ? roItem : null, roTitle);
  const pct=((now-M.T0)/M.TRIP_MS*100).toFixed(2);
  scrub.style.setProperty('--track','linear-gradient(90deg,#f7b955 0%,#fb7185 '+pct+'%,#1c2743 '+pct+'%)');
  $('#toNow').classList.toggle('on', liveNow);
  if(follow) centerOnTraveler();
}
function setRoItem(id,title){
  const el=$('#roLoc');
  el.dataset.id=id||'';
  el.classList.toggle('has-item',!!id);
  if(id){
    el.setAttribute('role','button'); el.tabIndex=0;
    el.title=title||'Open details';
  } else {
    el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('title');
  }
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
/* step to the start of the next / previous item in the (filtered) itinerary list;
   stepping back from partway through an item lands on that item's start first */
function stepItem(dir){
  const times=(CARDS.length? CARDS.map(c=>c.t) : M.ITEMS.map(it=>it.t0)).sort((a,b)=>a-b);
  let t=null;
  if(dir>0){ for(const x of times) if(x>now+1){ t=x; break; } }
  else { for(let i=times.length-1;i>=0;i--) if(times[i]<now-1){ t=times[i]; break; } }
  if(t==null) return;
  userScrolled=false;
  setNow(t,false,{force:true});
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
  const rows=[
    [M.TOTAL_DAYS,'days'],[countries,'countries'],[M.placeKeys.length,'places'],
    [(km>=1500? Math.round(km/1000)+'k' : Math.round(km)),'km'],[flights,'flights'],[ground,'ground'],
    [M.STAYS.length,'stays']
  ];
  const stat=r=>'<b>'+r[0]+'</b><span>'+r[1]+'</span>';
  $('#stats').innerHTML=rows.map(r=>r[1]==='days'
    ? '<button type="button" class="stat stat-days" id="statDays" aria-haspopup="dialog" aria-controls="statsPop" aria-expanded="false" title="Trip stats">'+stat(r)+'</button>'
    : '<div class="stat">'+stat(r)+'</div>').join('');
  const places=M.placeKeys.length;
  $('#statsPop').innerHTML='<div class="sp-sum">'+places+' place'+(places===1?'':'s')+' in '+countries+' countr'+(countries===1?'y':'ies')+
    ' · '+rows[3][0]+' km travelled</div><div class="sp-grid">'+rows.map(r=>'<div class="stat">'+stat(r)+'</div>').join('')+'</div>';
  setStatsPop(false);
  $('#tripSel').title=M.title+' — switch between trips saved in this browser';
  $('#brandSub').textContent=fmt(M.T0,M.originOff,'D')+'  →  '+fmt(M.T1,M.originOff,'D');
  document.title=M.title+' · Trip visualizer';
}

// narrow screens only show the days pill in the header; it opens a card with the rest of the stats
function setStatsPop(open){
  open=open&&narrow.matches;
  $('#statsPop').hidden=!open;
  const b=$('#statDays'); if(b) b.setAttribute('aria-expanded',open);
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
/* opts.keep: reloading the same trip after an edit — keep the time, filters and map view */
function loadTrip(cfg,opts){
  const keep=!!(opts&&opts.keep);
  M=buildModel(cfg);           // throws on a broken config — callers catch
  curCfg=cfg;
  closeCard();
  stopPlay();
  if(!keep){
    query=''; $('#q').value=''; setSearchOpen(false);
    filter='all'; $$('#filters button').forEach(b=>b.classList.toggle('on',b.dataset.f==='all'));
  }

  liveDay=todayIdx();
  if(!keep){
    wkDay=null; wkPlayDay=null;
    setCalMode(calModePref||(M.TOTAL_DAYS<=7?'week':'month'),true);
  }
  buildHeader();
  buildMapLayers();
  buildChapters();
  buildCalendar();
  buildScrubMarks();

  if(keep) now=clamp(now,M.T0,M.T1);
  else {
    liveNow=true;
    userScrolled=false;
    now=clamp(Date.now(),M.T0,M.T1);
  }
  scrub.value=Math.round((now-M.T0)/M.TRIP_MS*10000);

  renderList();
  if(keep) applyView(); else applySavedMapZoom();
  jGeom=null;
  setView(currentView, true);
  render(!keep);
  if(!keep){ scrollToCurMonth(); scrollToCurChapter(); }
}
function populateTripSel(value){
  const sel=$('#tripSel');
  sel.innerHTML='<option value="__demo">Demo trip</option>'+
    TripStore.names().map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('');
  sel.value=value||'__demo';
  if(sel.selectedIndex<0) sel.value='__demo';
}
function loadByName(name){
  if(name==='__demo'){ TripStore.setActive(''); loadTrip(DEMO_TRIP); curName='__demo'; return; }
  const cfg=TripStore.get(name);
  try{
    if(!cfg) throw new Error('Trip "'+name+'" was not found in this browser.');
    loadTrip(cfg);
    curName=name;
    TripStore.setActive(name);
  }catch(err){
    alert('Could not load "'+name+'": '+err.message+'\n\nFalling back to the demo trip. Open the editor to fix it.');
    populateTripSel('__demo');
    loadTrip(DEMO_TRIP);
    curName='__demo';
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
  $('#zFit').onclick=()=>setMapZoom('fit');
  $('#zFocus').onclick=()=>setMapZoom('focus');
  $('#zFollow').onclick=()=>{
    if(follow){
      follow=false;
      mapZoom=fitSet?'focus':'fit';
      syncZoomBtns();
      saveUiPrefs();
    } else setMapZoom('follow');
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
    setNowForItem(l.id, l.t0+(l.t1-l.t0)*0.4); focusItem(l.id);
  });
  $('#gSub').addEventListener('pointerover',e=>{
    const g=e.target.closest('[data-sub]'); if(!g) return;
    const p=SUB[+g.dataset.sub];
    showTip(e,'<b>'+esc(p.n)+'</b><span class="m">'+esc(p.s)+'</span>');
  });
  $('#gSub').addEventListener('pointerout',hideTip);
  $('#gSub').addEventListener('click',e=>{
    const g=e.target.closest('[data-sub]'); if(!g||didPan) return;
    const p=SUB[+g.dataset.sub], id=p.ref.id+(p.t==='stay'?'i':'');
    setNowForItem(id, p.ref.t0); focusItem(id);
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
      if(el.dataset.leg){ const l=M.LEGS.find(l=>l.id===el.dataset.leg); if(l){ setNowForItem(l.id, l.t0+(l.t1-l.t0)*.4); focusItem(l.id); } return; }
      if(el.dataset.stay){ const s=M.STAYS.find(s=>s.id===el.dataset.stay); if(s){ setNowForItem(s.id+'i', s.t0); focusItem(s.id+'i'); } return; }
      const ev=M.EVENTS.find(x=>x.id===el.dataset.ev); if(ev){ setNowForItem(ev.id, ev.t0); focusItem(ev.id); } return;
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
    wkDay=null;
    setCalMode('week',true,true);
    selectCalDay(+d.dataset.d0);
  });
  $('#wkBack').addEventListener('click',()=>setCalMode('month',false,true));
  $('#wkPrev').addEventListener('click',()=>{ if(!wkSliding) slideWeek(-1); });
  $('#wkNext').addEventListener('click',()=>{ if(!wkSliding) slideWeek(1); });
  $('#wkDays').addEventListener('click',e=>{
    const d=e.target.closest('.wk-day.in'); if(!d||wkSwiped) return;
    selectCalDay(+d.dataset.d0);
  });
  const openFromWeek=c=>{
    wkHold=true;
    setNowForItem(c.dataset.id, +c.dataset.t);
    wkHold=false;
    focusItem(c.dataset.id);
  };
  $('#wkList').addEventListener('click',e=>{
    const c=e.target.closest('.card'); if(c && !wkSwiped) openFromWeek(c);
  });
  $('#wkList').addEventListener('keydown',e=>{
    const c=e.target.closest('.card');
    if(c && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); openFromWeek(c); }
  });
  $('#wkAdd').addEventListener('click',()=>{ stopPlay(); openNewItem('',cellIdx(wkDay)); });
  /* swipe the week strip sideways for the previous / next week, and the day's items for the previous / next day */
  bindSwipe($('#wkStrip'),$('#wkDays'),hasWeek,slideWeek);
  bindSwipe($('#wkList'),$('#wkList'),hasDay,slideDay,true);
  $('#calGrid').addEventListener('pointerover',e=>{
    const d=e.target.closest('.day.in'); if(!d) return;
    const t=+d.dataset.t, L=M.locationAt(clamp(t,M.T0,M.T1));
    const dayStart=+d.dataset.d0, idx=cellIdx(dayStart);
    const evs=M.ITEMS.filter(it=>itemIdx(it)===idx);
    showTip(e,'<b>'+fmt(t,M.calOff,'D')+'</b><span class="m">'+
      (L.moving?'travelling '+esc(M.PLACES[L.leg.from].n)+' → '+esc(M.PLACES[L.leg.to].n):'in '+esc(L.P.n)+(L.P.r?', '+esc(L.P.r):''))+'</span>'+
      (evs.length?'<div style="margin-top:5px">'+evs.map(it=>'· '+fmt(it.t0,it.off,'t')+' '+esc(it.title)).join('<br>')+'</div>'
                 :'<div class="m" style="margin-top:5px">nothing scheduled</div>')+
      flagTexts(dayStart).map(f=>'<div class="tip-flag">'+flagSvg(f.k)+f.txt+'</div>').join(''));
  });
  $('#calGrid').addEventListener('pointerout',hideTip);
  $('#chapters').addEventListener('click',e=>{
    const c=e.target.closest('.chapter'); if(!c) return;
    if(c.classList.contains('live')) jumpToNow(); else setNow(+c.dataset.t);
  });

  /* itinerary list */
  const openFromList=c=>{
    setNowForItem(c.dataset.id, +c.dataset.t);
    if(view.k>1.05) centerOnTraveler();
    openCard(c.dataset.id);
  };
  $('#list').addEventListener('click',e=>{
    const c=e.target.closest('.card'); if(c) openFromList(c);
  });
  $('#list').addEventListener('keydown',e=>{
    const c=e.target.closest('.card');
    if(c && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); openFromList(c); }
  });
  $('#filters').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    filter=b.dataset.f; $$('#filters button').forEach(x=>x.classList.toggle('on',x===b)); renderList();
  });
  $('#q').addEventListener('input',e=>{ query=e.target.value.trim().toLowerCase(); renderList(); });
  $('#addItem').addEventListener('click',()=>{ stopPlay(); openNewItem($('#q').value.trim()); });
  $('#searchBtn').addEventListener('click',()=>setSearchOpen(!$('.side').classList.contains('searching')));
  $('#q').addEventListener('keydown',e=>{
    if(e.key==='Escape' && $('.side').classList.contains('searching')){ e.preventDefault(); setSearchOpen(false); $('#searchBtn').focus(); }
  });
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
  $('#stepBack').onclick=()=>stepItem(-1);
  $('#stepFwd').onclick=()=>stepItem(1);
  $('#toNow').onclick=()=>jumpToNow({announce:true});
  const roLoc=$('#roLoc');
  roLoc.addEventListener('click',()=>{ if(roLoc.dataset.id) openCard(roLoc.dataset.id); });
  roLoc.addEventListener('keydown',e=>{
    if(roLoc.dataset.id && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); openCard(roLoc.dataset.id); }
  });

  /* tooltip dismiss */
  addEventListener('pointerdown',e=>{ if(!e.target.closest('svg')) hideTip(); });

  /* tabs */
  $('#tabs').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    setView(b.dataset.view);
  });

  /* trip stats card */
  $('#stats').addEventListener('click',e=>{
    if(e.target.closest('#statDays')) setStatsPop($('#statsPop').hidden);
  });
  document.addEventListener('pointerdown',e=>{
    if(!$('#statsPop').hidden && !e.target.closest('#statsPop, #statDays')) setStatsPop(false);
  });
  narrow.addEventListener('change',()=>setStatsPop(false));

  /* keyboard */
  addEventListener('keydown',e=>{
    if(e.key==='Escape' && !$('#statsPop').hidden){ setStatsPop(false); $('#statDays').focus(); return; }
    if(cardIsOpen() || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if(e.target.closest && e.target.closest('#list .card, #wkList .card, #roLoc.has-item') && (e.key==='Enter'||e.code==='Space')) return;
    if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
    else if(e.key==='ArrowRight'){ if(e.shiftKey) setNow(now+DAY); else stepItem(1); }
    else if(e.key==='ArrowLeft'){ if(e.shiftKey) setNow(now-DAY); else stepItem(-1); }
    else if(e.key==='1') setView('map');
    else if(e.key==='2') setView('journey');
    else if(e.key==='3') setView('calendar');
    else if(e.key==='4') setView('chapters');
    else if(e.key==='5' && narrow.matches) setView('list');
  });

  /* resize */
  let rz=null;
  addEventListener('resize',()=>{
    clearTimeout(rz);
    rz=setTimeout(()=>{
      if(currentView==='map'){ fitTo(); if(follow) centerOnTraveler(); else applyView(); }
      else mapNeedsFit=true;
      if(currentView==='journey') drawJourney();
    },120);
  });

  /* the view tabs and time/location readout sit in the header on wide screens, and at the top of the sticky footer on narrow ones */
  const tabs=$('#tabs'), readout=$('.readout');
  const placeControls=()=>{
    if(narrow.matches){ $('.transport').prepend(readout); $('.transport').prepend(tabs); }
    else { $('.topbar').appendChild(tabs); $('.topbar').appendChild(readout); }
    if(!M) return;
    if(narrow.matches && !hasPlayer(currentView)) stopPlay();
    if(currentView==='list' && !narrow.matches) setView('map', true);
    else syncList(now,true);
  };
  narrow.addEventListener('change',placeControls);
  placeControls();

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
        curName='__dropped';
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

/* on narrow screens these views drop the play / step / speed controls and keep just the slider and NOW */
function hasPlayer(v){ return v==='map' || v==='journey'; }
/* the narrow list view's floating search: opening shows the field, closing clears the search */
function setSearchOpen(open){
  const btn=$('#searchBtn'), q=$('#q');
  $('.side').classList.toggle('searching',open);
  btn.setAttribute('aria-expanded',String(open));
  btn.title=open?'Clear and close search':'Search';
  btn.setAttribute('aria-label',btn.title);
  if(open){ q.focus(); return; }
  if(q.value||query){ q.value=''; query=''; if(M) renderList(); }
  if(document.activeElement===q) q.blur();
}
function setView(v, silent){
  // List is narrow-only: wide screens always show the itinerary beside the other views
  if(v==='list' && !narrow.matches){ v='map'; silent=true; }
  currentView=v;
  $$('#tabs button').forEach(x=>x.classList.toggle('on',x.dataset.view===v));
  $$('.view').forEach(x=>x.classList.toggle('on',x.id==='view-'+v));
  const wasList=$('.app').classList.contains('list-view');
  $('.app').classList.toggle('list-view',v==='list');
  $('.app').classList.toggle('no-player',!hasPlayer(v));
  if(narrow.matches && !hasPlayer(v)) stopPlay();
  if(v==='journey') drawJourney();
  if(v==='map'){ if(mapNeedsFit) applySavedMapZoom(); else applyView(); }
  if(v==='calendar') scrollToCurMonth();
  if(v==='chapters') scrollToCurChapter();
  if((v==='list'||wasList) && M) syncList(now,true);
  if(!silent) saveUiPrefs();
}

/* ============================================================
   11.  Boot
   ============================================================ */
bindUI();
(function boot(){
  readUiPrefs();
  const active=TripStore.active();
  if(active && TripStore.get(active)){
    populateTripSel(active);
    loadByName(active);
  } else {
    populateTripSel('__demo');
    loadByName('__demo');
  }
  scheduleLiveTick();
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden) return;
    refreshLive(); if(M) syncListStatus(); scheduleLiveTick();
  });
})();
