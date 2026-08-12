"use strict";
/* ============================================================
   Trip editor — edit/validate trip configs, manage the trip
   library, and import drafts from pasted itinerary text.
   ============================================================ */

const cfgText=$('#cfgText'), out=$('#out'), nameInp=$('#tripName'), savedSel=$('#savedSel'), statusEl=$('#status');

const NEW_TEMPLATE={
  title:"My new trip",
  places:{
    hom:{n:"Home",r:"",cc:"USA",lat:40.7128,lon:-74.006,off:-240},
    dst:{n:"Destination",r:"",cc:"Somewhere",lat:48.8566,lon:2.3522,off:120}
  },
  legs:[
    {mode:"flight",from:"hom",to:"dst",dep:"2026-06-01T18:00:00-04:00",arr:"2026-06-02T08:00:00+02:00",op:"XX 123"},
    {mode:"flight",from:"dst",to:"hom",dep:"2026-06-08T10:00:00+02:00",arr:"2026-06-08T13:00:00-04:00",op:"XX 124"}
  ],
  stays:[
    {place:"dst",name:"Hotel Example","in":"2026-06-02T15:00:00+02:00",out:"2026-06-08T08:00:00+02:00"}
  ],
  events:[
    {kind:"activity",place:"dst",title:"Walking tour",start:"2026-06-03T10:00:00+02:00",end:"2026-06-03T12:00:00+02:00"}
  ]
};

/* ---------- output panel ---------- */
function esc2(s){ return esc(s); }
function showMessages(blocks){
  out.innerHTML=blocks.map(b=>{
    if(b.h) return '<h3>'+esc2(b.h)+'</h3>';
    if(b.stats) return '<div class="quickstats">'+b.stats.map(s=>'<span><b>'+esc2(String(s[0]))+'</b> '+esc2(s[1])+'</span>').join('')+'</div>';
    return '<div class="msg '+b.cls+'">'+b.html+'</div>';
  }).join('');
}
function flashStatus(msg){
  statusEl.textContent=msg; statusEl.classList.add('flash');
  setTimeout(()=>{ statusEl.classList.remove('flash'); },1500);
}

/* ---------- validate ---------- */
function runValidation(showOk){
  let raw;
  try{ raw=parseTripConfigText(cfgText.value); }
  catch(err){
    showMessages([{h:'Parse error'},{cls:'err',html:esc2(err.message)}]);
    return null;
  }
  const {errors,warnings,model}=validateTrip(raw);
  const blocks=[];
  if(errors.length){
    blocks.push({h:'Errors — fix these before saving'});
    errors.forEach(e=>blocks.push({cls:'err',html:esc2(e)}));
  }
  if(model){
    const km=model.LEGS.reduce((s,l)=>s+l.km,0);
    blocks.push({h:'Trip at a glance'});
    blocks.push({stats:[
      [model.title,''],
      [model.TOTAL_DAYS,'days'],
      [model.placeKeys.length,'places'],
      [model.LEGS.length,'legs'],
      [model.STAYS.length,'stays'],
      [model.EVENTS.length,'events'],
      [Math.round(km).toLocaleString(),'km'],
      [fmt(model.T0,model.originOff,'d')+' → '+fmt(model.T1,model.originOff,'d'),'']
    ]});
  }
  if(warnings.length){
    blocks.push({h:'Warnings — worth a look'});
    warnings.forEach(w=>blocks.push({cls:'warn',html:esc2(w)}));
  }
  if(!errors.length&&showOk){
    blocks.unshift({cls:'ok',html:'Config is valid'+(warnings.length?' (with '+warnings.length+' warning'+(warnings.length>1?'s':'')+').':'.')});
  }
  showMessages(blocks);
  return errors.length? null : raw;
}

/* ---------- library ---------- */
function refreshSaved(selected){
  const names=TripStore.names();
  savedSel.innerHTML='<option value="">— saved trips —</option>'+
    names.map(n=>'<option value="'+esc2(n)+'">'+esc2(n)+'</option>').join('');
  savedSel.value=selected||'';
  if(savedSel.selectedIndex<0) savedSel.value='';
}
function setEditorConfig(cfg,name){
  cfgText.value=JSON.stringify(cfg,null,2);
  if(name!=null) nameInp.value=name;
}
function saveCurrent(){
  const raw=runValidation(true);
  if(!raw){ flashStatus('Not saved — fix the errors first.'); return null; }
  const name=nameInp.value.trim();
  if(!name){
    showMessages([{cls:'err',html:'Give the trip a name (top right) before saving.'}]);
    nameInp.focus();
    return null;
  }
  TripStore.save(name,raw);
  TripStore.setActive(name);
  refreshSaved(name);
  flashStatus('Saved "'+name+'" · it is now the active trip in the viewer.');
  return name;
}

/* ---------- wire up ---------- */
$('#tabs').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  $$('#tabs button').forEach(x=>x.classList.toggle('on',x===b));
  $$('.pane').forEach(x=>x.classList.toggle('on',x.id==='pane-'+b.dataset.pane));
});

savedSel.addEventListener('change',()=>{
  const n=savedSel.value; if(!n) return;
  const cfg=TripStore.get(n);
  if(!cfg){ refreshSaved(); return; }
  setEditorConfig(cfg,n);
  runValidation(true);
  flashStatus('Loaded "'+n+'".');
});
$('#btnNew').onclick=()=>{
  setEditorConfig(NEW_TEMPLATE,'');
  savedSel.value='';
  showMessages([{cls:'info',html:'A minimal skeleton to build on — see the <b>Schema help</b> tab for every field.'}]);
};
$('#btnDemo').onclick=()=>{
  setEditorConfig(DEMO_TRIP,'');
  savedSel.value='';
  runValidation(true);
  flashStatus('Demo loaded — save it under a new name to make it yours.');
};
$('#btnDelete').onclick=()=>{
  const n=savedSel.value;
  if(!n){ flashStatus('Select a saved trip to delete.'); return; }
  if(!confirm('Delete saved trip "'+n+'" from this browser? This cannot be undone.')) return;
  TripStore.remove(n);
  refreshSaved();
  flashStatus('Deleted "'+n+'".');
};
$('#btnValidate').onclick=()=>runValidation(true);
$('#btnFormat').onclick=()=>{
  try{
    const raw=parseTripConfigText(cfgText.value);
    cfgText.value=JSON.stringify(raw,null,2);
    flashStatus('Formatted.');
  }catch(err){
    showMessages([{h:'Parse error'},{cls:'err',html:esc2(err.message)}]);
  }
};
$('#btnSave').onclick=()=>saveCurrent();
$('#btnSaveView').onclick=()=>{ if(saveCurrent()) location.href='index.html'; };

$('#btnImport').onclick=()=>$('#fileInp').click();
$('#fileInp').addEventListener('change',e=>{
  const f=e.target.files&&e.target.files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=()=>{
    cfgText.value=String(rd.result);
    nameInp.value=nameInp.value||f.name.replace(/\.(trip\.)?json$|\.txt$/i,'');
    runValidation(true);
  };
  rd.readAsText(f);
  e.target.value='';
});
$('#btnExport').onclick=()=>{
  let raw;
  try{ raw=parseTripConfigText(cfgText.value); }
  catch(err){ showMessages([{h:'Parse error'},{cls:'err',html:esc2(err.message)}]); return; }
  const name=(nameInp.value.trim()||raw.title||'trip').replace(/[^\w.-]+/g,'-').toLowerCase();
  const blob=new Blob([JSON.stringify(raw,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name+'.trip.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  flashStatus('Downloaded '+name+'.trip.json');
};

$('#btnConvert').onclick=()=>{
  const text=$('#pasteText').value;
  if(!text.trim()){ flashStatus('Paste some itinerary text first.'); return; }
  const {config,report}=parseItineraryText(text);
  setEditorConfig(config,nameInp.value);
  // jump to the JSON tab so the draft is front and centre
  $$('#tabs button').forEach(x=>x.classList.toggle('on',x.dataset.pane==='json'));
  $$('.pane').forEach(x=>x.classList.toggle('on',x.id==='pane-json'));
  const blocks=[{h:'Import report'}];
  report.forEach((r,i)=>blocks.push({cls:i===0?'info':'warn',html:esc2(r)}));
  const v=validateTrip(config);
  if(v.errors.length){ blocks.push({h:'Draft has errors'}); v.errors.forEach(e=>blocks.push({cls:'err',html:esc2(e)})); }
  if(v.warnings.length){ blocks.push({h:'Draft warnings'}); v.warnings.forEach(w=>blocks.push({cls:'warn',html:esc2(w)})); }
  showMessages(blocks);
};

/* keep Tab usable inside the textareas */
[cfgText,$('#pasteText')].forEach(ta=>{
  ta.addEventListener('keydown',e=>{
    if(e.key==='Tab'){
      e.preventDefault();
      const s=ta.selectionStart, epos=ta.selectionEnd;
      ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(epos);
      ta.selectionStart=ta.selectionEnd=s+2;
    }
  });
});

/* ---------- boot ---------- */
(function boot(){
  const active=TripStore.active();
  refreshSaved(active);
  if(active && TripStore.get(active)){
    setEditorConfig(TripStore.get(active),active);
    runValidation(false);
  } else {
    setEditorConfig(DEMO_TRIP,'');
    showMessages([{cls:'info',html:'This is the bundled demo trip. Edit it (or hit <b>New</b> / paste your own), give it a name, and <b>Save &amp; view</b>. Trips never leave this browser unless you export them.'}]);
  }
})();
