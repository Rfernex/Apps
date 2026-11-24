// Literature browser UI shared by Reading Room (any subject, with a saved corpus) and
// Italiano (Italian history). It searches OpenAlex and Open Library, groups and scores
// results, shows abstracts and published reviews or responses, links to legal full
// texts, and sends items to Zotero. Nothing is summarised or generated.
import {openAlexUrls,openLibraryUrl,normalizeOpenAlex,normalizeOpenLibrary,mergeResults,facets,filterRecords,groupByType,findLinks,zoteroItem,pdfAttachment,toRis,toBibtex,toCsv,languageName,fetchOpenPdf,reviewUrls,classifyReviews,suggestionUrls,parseSuggestions,crossrefUrls,normalizeCrossref,enrichUrls,applyEnrichment,rankBestMatch,inFields,poolSuggestions,refineMatch,crossrefReviewUrl,crossrefAsWork,FIELDS,TYPES} from './literature.mjs?v=5';

const ZOTERO='https://api.zotero.org';
const ENGINE_KEY='literature.engine.v1',OA_KEY='openalex.key.v1',ZOTERO_KEY='zotero.key.v1',LIB_KEY='library.template.v1',REVIEWS_KEY='literature.reviews.v2';
const REVIEW_TTL=30*864e5,REVIEW_CACHE=400;
const TYPE_NAME=Object.fromEntries(TYPES);
const STATUSES=[['to-read','To read'],['key','Key source'],['read','Read'],['excluded','Excluded']];
const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const get=(store,k,d)=>{try{return JSON.parse(store.getItem(k)||'null')??d;}catch{return d;}};
const set=(store,k,v)=>{try{v===null?store.removeItem(k):store.setItem(k,JSON.stringify(v));}catch{}};

// One-time move of Italiano's earlier keys to the shared ones, so nothing is pasted twice.
function migrate(){
 try{
  if(!localStorage.getItem(OA_KEY)){const old=localStorage.getItem('italiano.openalex.key.v1')||sessionStorage.getItem('italiano.openalex.session.v1');if(old)localStorage.setItem(OA_KEY,old);}
  const z=get(localStorage,'italiano.zotero.v1',null);
  if(z?.apiKey&&!get(localStorage,ZOTERO_KEY,null)){set(localStorage,ZOTERO_KEY,{apiKey:z.apiKey,userID:z.userID,username:z.username});set(localStorage,'italiano.zotero.collection.v1',{name:z.collectionName,key:z.collectionKey});}
  if(z)localStorage.removeItem('italiano.zotero.v1');
  const lib=localStorage.getItem('italiano.library.template.v1');if(lib&&!localStorage.getItem(LIB_KEY))localStorage.setItem(LIB_KEY,lib);
  ['italiano.openalex.key.v1','italiano.library.template.v1'].forEach(k=>localStorage.removeItem(k));sessionStorage.removeItem('italiano.openalex.session.v1');
 }catch{}
}
const oaKey=()=>{try{return localStorage.getItem(OA_KEY)||'';}catch{return'';}};
// 'crossref' (default): Crossref searches, OpenAlex enriches by DOI. 'openalex': OpenAlex searches.
const engine=()=>{try{return localStorage.getItem(ENGINE_KEY)==='openalex'?'openalex':'crossref';}catch{return'crossref';}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,{signal}={},timeout=25000){
 const controller=new AbortController(),stop=()=>controller.abort(),timer=setTimeout(stop,timeout);signal?.addEventListener('abort',stop,{once:true});
 try{
  // Crossref's refusals can reach the browser as a network error (no CORS headers), so retry once.
  let r=await fetch(url,{signal:controller.signal,credentials:'omit'}).catch(async e=>{if(!url.includes('crossref.org')||signal?.aborted||controller.signal.aborted)throw e;await sleep(1200);return fetch(url,{signal:controller.signal,credentials:'omit'});});
  // Crossref allows about 3 requests a second: wait and retry rather than fail.
  for(let i=0;r.status===429&&url.includes('crossref.org')&&i<3;i++){await sleep(1000*(Number(r.headers.get('Retry-After'))||1+i));r=await fetch(url,{signal:controller.signal,credentials:'omit'});}
  if(r.status===429)throw Error(url.includes('openalex')?'OpenAlex’s daily allowance for anonymous use is spent. Add a free OpenAlex key in settings, or try tomorrow.':'The service is rate-limiting requests; try again in a minute.');
  if(!r.ok)throw Error(`${new URL(url).hostname} answered ${r.status}.`);
  return r.json();
 }catch(e){if(e.name==='AbortError'&&!signal?.aborted)throw Error(`${new URL(url).hostname} did not answer in time.`);if(e instanceof TypeError)throw Error(`${new URL(url).hostname} could not be reached.`);throw e;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
}

/**
 * Mount the browser. Options:
 *  prefix          storage prefix for this app (per-app Zotero collection, last search)
 *  eyebrow,title,intro,placeholder  header copy
 *  presets         suggested searches
 *  fields          default OpenAlex field ids; showFields lets the user change them
 *  language        extra language-restricted search ('it' in Italiano)
 *  collection      default Zotero collection name; tag: Zotero tag / RIS keyword
 *  corpus          {load(), save(data)} to enable saved corpora (Reading Room)
 */
export function mountLiteratureBrowser(element,options={}){
 migrate();
 const o={prefix:'literature',eyebrow:'THE LITERATURE',title:'Find what has been written',intro:'',placeholder:'Search a topic',presets:[],fields:['12','33'],showFields:false,language:'',collection:'Research',tag:'Literature browser',corpus:null,...options};
 const COLLECTION_KEY=`${o.prefix}.zotero.collection.v1`,ADDED_KEY=`${o.prefix}.zotero.added.v1`,LAST_KEY=`${o.prefix}.literature.last.v1`,FIELDS_KEY=`${o.prefix}.literature.fields.v1`,REFINE_KEY=`${o.prefix}.literature.refine.v1`;
 const refineOn=()=>{try{return localStorage.getItem(REFINE_KEY)!=='off';}catch{return true;}};
 const root=element;
 const ui={view:'search',query:'',from:'',to:'',fields:get(localStorage,FIELDS_KEY,o.fields),books:true,records:[],pool:[],total:0,page:1,busy:false,status:'',error:'',
  filters:{type:'all',subfield:'',language:'',openOnly:false,minScore:0,sort:'relevance',withAbstract:false},open:new Set(),reviewsOpen:new Set(),reviewBusy:new Set(),zoteroBusy:new Set(),showSettings:false,
  corpusFilters:{status:'',type:'all',sort:'added'},batch:'',
  // refine: the suggestion panel shown before a search; active: the refinement applied to the results
  refine:null,active:{themes:[],periods:[],related:[]}};
 const last=get(sessionStorage,LAST_KEY,null);
 if(last)Object.assign(ui,{query:last.query,from:last.from,to:last.to,books:last.books!==false,page:last.page,records:last.records||[],pool:last.pool||[],total:last.total||0,active:last.active||ui.active});

 // ---- corpus ----------------------------------------------------------------------
 const corpusData=()=>{const d=o.corpus?.load()||{};d.corpora||=[];if(!d.corpora.length)d.corpora.push({id:crypto.randomUUID(),name:'My corpus',createdAt:Date.now(),items:{}});if(!d.corpora.some(c=>c.id===d.active))d.active=d.corpora[0].id;return d;};
 const activeCorpus=d=>d.corpora.find(c=>c.id===d.active);
 const inCorpus=id=>!!o.corpus&&!!activeCorpus(corpusData()).items[id];
 function saveCorpus(mutate){const d=corpusData();mutate(d,activeCorpus(d));o.corpus.save(d);}
 function toggleCorpus(rec){
  saveCorpus((d,c)=>{if(c.items[rec.id])delete c.items[rec.id];else c.items[rec.id]={record:rec,addedAt:Date.now(),status:'to-read',note:'',query:ui.query};});
  ui.status=inCorpus(rec.id)?`Saved to “${activeCorpus(corpusData()).name}”.`:'Removed from the corpus.';draw();
 }

 // ---- reviews -----------------------------------------------------------------------
 const reviewCache=()=>get(localStorage,REVIEWS_KEY,{});
 function cachedReviews(id){const hit=reviewCache()[id];return hit&&Date.now()-hit.at<REVIEW_TTL?hit.items:null;}
 async function loadReviews(rec,{quiet=false}={}){
  if(cachedReviews(rec.id)||ui.reviewBusy.has(rec.id))return cachedReviews(rec.id);
  ui.reviewBusy.add(rec.id);if(!quiet)draw();
  try{
   const cr=crossrefReviewUrl(rec);
   const pages=await Promise.all([...reviewUrls(rec,{key:oaKey(),useTitleSearch:false}).map(u=>json(u).then(d=>d.results||[]).catch(()=>[])),...(cr?[json(cr).then(d=>(d.message?.items||[]).map(crossrefAsWork))]:[])]);
   const items=classifyReviews(rec,pages.flat()),cache=reviewCache();
   cache[rec.id]={at:Date.now(),items};
   const keys=Object.keys(cache);if(keys.length>REVIEW_CACHE)keys.sort((a,b)=>cache[a].at-cache[b].at).slice(0,keys.length-REVIEW_CACHE).forEach(k=>delete cache[k]);
   set(localStorage,REVIEWS_KEY,cache);
   if(o.corpus&&inCorpus(rec.id))saveCorpus((d,c)=>{c.items[rec.id].reviews=items;});
   return items;
  }catch(e){if(!quiet){ui.error=`Reviews: ${e.message}`;}throw e;}
  finally{ui.reviewBusy.delete(rec.id);if(!quiet)draw();}
 }
 function reviewSummary(items){
  if(!items)return'';if(!items.length)return'<span class="lit-rv-none">No reviews or responses found</span>';
  const n=k=>items.filter(x=>x.kind===k).length,parts=[['Retraction notice','retraction notice'],['Correction','correction'],['Response','response'],['Review','review']].map(([k,l])=>n(k)?`${n(k)} ${l}${n(k)>1?'s':''}`:'').filter(Boolean);
  const critical=items.filter(x=>x.cues.length).length;
  return`<span class="lit-rv-count ${items.some(x=>x.kind!=='Review')?'alert':''}">${parts.join(' · ')}</span>${critical?`<span class="lit-rv-critical" title="Reviews or responses whose title or opening uses critical wording">${critical} with critical wording</span>`:''}`;
 }
 function reviewList(items){
  if(!items?.length)return'<p class="lit-hint">OpenAlex lists no review, comment or correction that names this work. Reviews in journals it does not index will not appear.</p>';
  return`<ul class="lit-rv-list">${items.map(x=>`<li><span class="lit-rv-kind ${x.kind.toLowerCase().replace(/\s+/g,'-')}">${esc(x.kind)}</span> <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><small>${esc([x.authors.join(', '),x.venue,x.year].filter(Boolean).join(' · '))}${x.free?` · <a href="${esc(x.free)}" target="_blank" rel="noopener">free copy ↗</a>`:''}</small>${x.cues.length?`<p class="lit-rv-cues">Critical wording: ${esc(x.cues.join(', '))}</p>`:''}${x.excerpt?`<p class="lit-rv-excerpt">${esc(x.excerpt)}${x.excerpt.length>=700?'…':''}</p>`:''}</li>`).join('')}</ul><p class="lit-hint">Found by matching titles and citations in OpenAlex. “Critical wording” is a keyword hint from the title or opening lines, not a reading of the review.</p>`;
 }

 // ---- Zotero --------------------------------------------------------------------------
 const zcfg=()=>({...get(localStorage,ZOTERO_KEY,{}),collection:get(localStorage,COLLECTION_KEY,{name:o.collection,key:''})});
 const added=()=>get(localStorage,ADDED_KEY,{});
 function zHeaders(cfg,write){const h={'Zotero-API-Key':cfg.apiKey,'Zotero-API-Version':'3'};if(write){h['Content-Type']='application/json';h['Zotero-Write-Token']=crypto.randomUUID().replace(/-/g,'');}return h;}
 async function zFetch(path,cfg,{method='GET',body}={}){
  const r=await fetch(`${ZOTERO}${path}`,{method,headers:zHeaders(cfg,method!=='GET'),body:body&&JSON.stringify(body),credentials:'omit'});
  if(r.status===403)throw Error('Zotero refused: the key needs “Allow library access” and “Allow write access”. Edit it at zotero.org/settings/keys.');
  if(r.status===404)throw Error('Zotero could not find that library. Check the key in settings.');
  if(r.status===429)throw Error(`Zotero asks to slow down${r.headers.get('Retry-After')?`; retry in ${r.headers.get('Retry-After')} s`:''}.`);
  if(!r.ok)throw Error(`Zotero answered ${r.status}: ${(await r.text()).slice(0,160)}`);
  return r.status===204?null:r.json();
 }
 async function ensureCollection(cfg){
  const name=(cfg.collection.name||o.collection).trim(),want=name.toLowerCase();
  for(let start=0;start<1000;start+=100){
   const page=await zFetch(`/users/${cfg.userID}/collections?limit=100&start=${start}`,cfg);
   const hit=page.find(c=>c.data?.name?.trim().toLowerCase()===want);if(hit)return save(hit.key);
   if(page.length<100)break;
  }
  const made=await zFetch(`/users/${cfg.userID}/collections`,cfg,{method:'POST',body:[{name}]});
  const key=made?.successful?.['0']?.key;if(!key)throw Error('Zotero did not create the collection.');return save(key);
  function save(key){set(localStorage,COLLECTION_KEY,{name,key});return key;}
 }
 async function connectZotero(apiKey,collectionName){
  const info=await fetch(`${ZOTERO}/keys/current`,{headers:{'Zotero-API-Key':apiKey,'Zotero-API-Version':'3'},credentials:'omit'});
  if(info.status===403||info.status===404)throw Error('Zotero did not recognise this key.');
  const data=await info.json();
  if(!data.access?.user?.library||!data.access?.user?.write)throw Error('This key cannot write to your library. Create one with library and write access at zotero.org/settings/keys.');
  set(localStorage,ZOTERO_KEY,{apiKey,userID:data.userID,username:data.username});
  set(localStorage,COLLECTION_KEY,{name:collectionName||o.collection,key:''});
  return ensureCollection(zcfg());
 }
 /** Send records to Zotero in batches of 50; open-access PDFs follow as linked attachments. */
 async function sendToZotero(recs){
  let cfg=zcfg();
  if(!cfg.apiKey){ui.showSettings=true;ui.error='Connect Zotero first (settings below): paste an API key with write access.';draw();root.querySelector('#lit-zotero-key')?.focus();return 0;}
  if(!cfg.collection.key){await ensureCollection(cfg);cfg=zcfg();}
  const todo=recs.filter(r=>!added()[r.id]);let sent=0;
  for(let i=0;i<todo.length;i+=50){
   const chunk=todo.slice(i,i+50),items=chunk.map(r=>zoteroItem(r,{collection:cfg.collection.key,tags:[r._query||ui.query],label:o.tag}));
   let res=await zFetch(`/users/${cfg.userID}/items`,cfg,{method:'POST',body:items});
   if(Object.values(res?.failed||{}).some(f=>/collection/i.test(f.message||''))){await ensureCollection({...cfg,collection:{...cfg.collection,key:''}});cfg=zcfg();res=await zFetch(`/users/${cfg.userID}/items`,cfg,{method:'POST',body:chunk.map(r=>zoteroItem(r,{collection:cfg.collection.key,tags:[r._query||ui.query],label:o.tag}))});}
   const map={...added()},attachments=[];
   for(const [idx,ok] of Object.entries(res?.successful||{})){const rec=chunk[Number(idx)];map[rec.id]=ok.key;sent++;const pdf=rec.links.find(l=>l.kind==='pdf');if(pdf)attachments.push(pdfAttachment(pdf.url,ok.key));}
   set(localStorage,ADDED_KEY,map);
   if(attachments.length)await zFetch(`/users/${cfg.userID}/items`,cfg,{method:'POST',body:attachments}).catch(()=>{});
   const failed=Object.values(res?.failed||{});if(failed.length)ui.error=`Zotero rejected ${failed.length} item${failed.length>1?'s':''}: ${failed[0].message}`;
   if(todo.length>50){ui.batch=`Zotero: ${Math.min(i+50,todo.length)} of ${todo.length} sent…`;draw();}
  }
  return sent;
 }
 async function addOne(rec){
  ui.zoteroBusy.add(rec.id);draw();
  try{const n=await sendToZotero([rec]);if(n)ui.status=`Added to Zotero · ${zcfg().collection.name}${rec.links.some(l=>l.kind==='pdf')?' (with a link to the PDF)':''}.`;}
  catch(e){ui.error=e.message;}
  finally{ui.zoteroBusy.delete(rec.id);draw();}
 }
 function download(name,text,type){
  const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([text],{type})),download:name});
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);
 }
 const slug=t=>String(t).slice(0,60).replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'')||'citation';

 // ---- search ---------------------------------------------------------------------------
 let controller=null;
 async function search(page=1){
  if(engine()==='crossref')return searchCrossref(page);
  const q=ui.query.trim();if(q.length<3){ui.error='Enter a topic of at least three characters.';draw();return;}
  controller?.abort();controller=new AbortController();const signal=controller.signal;
  ui.busy=true;ui.error='';ui.status=page>1?'Loading more results…':`Searching OpenAlex${ui.books?' and Open Library':''}…`;if(page===1){ui.records=[];ui.open.clear();ui.reviewsOpen.clear();}draw();
  const a=ui.active,opts={key:oaKey(),from:ui.from,to:ui.to,fields:ui.fields,language:o.language,page,topics:a.themes.map(x=>x.id),keywords:[a.periods.map(x=>x.id),a.related.map(x=>x.id)]};
  const jobs=openAlexUrls(q,opts).map(u=>json(u,{signal}).then(d=>(d.results||[]).map(normalizeOpenAlex)));
  if(ui.books&&page===1)jobs.push(json(openLibraryUrl([q,...a.periods.map(x=>x.name),...a.related.map(x=>x.name)].join(' '),opts),{signal}).then(d=>(d.docs||[]).map(normalizeOpenLibrary)));
  const settled=await Promise.allSettled(jobs);
  if(signal.aborted)return;
  const lists=settled.filter(s=>s.status==='fulfilled').map(s=>s.value),failures=settled.filter(s=>s.status==='rejected').map(s=>s.reason?.message);
  ui.records=mergeResults(ui.records,...lists);ui.page=page;ui.busy=false;ui.status='';
  ui.error=!lists.length?(failures[0]||'The search failed.'):failures.length?`Some sources failed: ${[...new Set(failures)].join(' ')}`:'';
  set(sessionStorage,LAST_KEY,{query:q,from:ui.from,to:ui.to,books:ui.books,page,records:ui.records,active:ui.active});
  draw();
 }

 // Crossref search: free text search, then one cheap OpenAlex request per 50 DOIs.
 async function searchCrossref(page=1,{thenRefine=false}={}){
  const q=ui.query.trim();if(q.length<3){ui.error='Enter a topic of at least three characters.';draw();return;}
  controller?.abort();controller=new AbortController();const signal=controller.signal;
  ui.busy=true;ui.error='';ui.status=page>1?'Loading more results…':`Searching Crossref${ui.books?' and Open Library':''}…`;if(page===1){ui.pool=[];ui.records=[];ui.open.clear();ui.reviewsOpen.clear();if(!thenRefine)ui.active={themes:[],periods:[],related:[]};}draw();
  const opts={from:ui.from,to:ui.to,page},failures=[],lists=[];
  const books=ui.books&&page===1?json(openLibraryUrl(q,opts),{signal}).then(d=>(d.docs||[]).map(normalizeOpenLibrary)).catch(e=>{failures.push(e.message);return[];}):Promise.resolve([]);
  for(const [n,u] of crossrefUrls(q,opts).entries()){
   if(n)await sleep(350); // stay under Crossref's 3 requests a second
   try{const d=await json(u,{signal});if(page===1&&!lists.length)ui.total=d.message?.['total-results']||0;lists.push((d.message?.items||[]).map(normalizeCrossref));}
   catch(e){if(signal.aborted)return;failures.push(e.message);}
  }
  lists.push(await books);
  if(signal.aborted)return;
  let pool=mergeResults(ui.pool,...lists);
  ui.status='Adding citation percentiles, subjects and free full texts from OpenAlex…';draw();
  let enriched=true;
  const enrich=await Promise.allSettled(enrichUrls(pool,{key:oaKey()}).map(u=>json(u,{signal}).then(d=>d.results||[])));
  if(signal.aborted)return;
  const works=enrich.filter(x=>x.status==='fulfilled').flatMap(x=>x.value);
  if(enrich.some(x=>x.status==='rejected'))enriched=false;
  pool=rankBestMatch(applyEnrichment(pool,works),q);
  ui.pool=pool;ui.records=pool;ui.page=page;ui.busy=false;ui.status='';
  ui.error=!pool.length&&failures.length?failures[0]:failures.length?`Some sources failed: ${[...new Set(failures)].join(' ')}`:'';
  if(!enriched)ui.status='Results come from Crossref. OpenAlex details (citation percentiles, subjects, free full texts) are missing because its daily allowance is spent; add a free OpenAlex key in settings for more.';
  set(sessionStorage,LAST_KEY,{query:q,from:ui.from,to:ui.to,books:ui.books,page,pool:ui.pool,records:ui.pool,total:ui.total,active:ui.active});
  if(thenRefine)openPoolRefine();else draw();
 }
 // With Crossref the suggestions come from the fetched results, so refining is instant.
 function openPoolRefine(){
  const base=ui.pool.filter(r=>inFields(r,ui.fields));
  ui.refine={query:ui.query.trim(),loading:false,data:{...poolSuggestions(ui.query.trim(),base,ui.total),fromPool:true},sel:new Set()};
  draw();root.querySelector('.lit-refine')?.scrollIntoView({block:'nearest',behavior:'smooth'});
 }
 /** What is shown: Crossref results filtered locally by field and refinement; OpenAlex results as fetched. */
 const visible=()=>engine()==='crossref'?ui.pool.filter(r=>inFields(r,ui.fields)&&refineMatch(r,ui.active)):ui.records;

 // ---- refining before a search ----------------------------------------------------------
 function startRefineForced(){if(engine()==='crossref'&&ui.pool.length)return openPoolRefine();const off=!refineOn();if(off)try{localStorage.setItem(REFINE_KEY,'on');}catch{}startRefine().finally(()=>{if(off)try{localStorage.setItem(REFINE_KEY,'off');}catch{}});}
 async function startRefine(){
  const q=ui.query.trim();if(q.length<3){ui.error='Enter a topic of at least three characters.';draw();return;}
  if(!refineOn()){ui.active={themes:[],periods:[],related:[]};return search(1);}
  if(engine()==='crossref'){ui.active={themes:[],periods:[],related:[]};return searchCrossref(1,{thenRefine:true});}
  ui.refine={query:q,loading:true,data:null,sel:new Set()};ui.error='';ui.status='';draw();
  root.querySelector('.lit-refine')?.scrollIntoView({block:'nearest',behavior:'smooth'});
  try{
   const [t,k]=await Promise.all(suggestionUrls(q,{key:oaKey(),from:ui.from,to:ui.to,fields:ui.fields}).map(u=>json(u)));
   if(ui.refine?.query!==q)return;
   ui.refine.data=parseSuggestions(q,t.group_by||[],k.group_by||[],t.meta?.count||0);
  }catch(e){if(ui.refine?.query!==q)return;ui.refine.error=e.message;}
  if(ui.refine)ui.refine.loading=false;draw();
 }
 function runRefine(useSelection){
  const r=ui.refine,pick=(list,group)=>(list||[]).filter(x=>r.sel.has(`${group}:${x.id}`)).map(({id,name})=>({id,name}));
  ui.active=useSelection&&r?.data?{themes:pick(r.data.themes,'t'),periods:pick(r.data.periods,'p'),related:pick(r.data.related,'r')}:{themes:[],periods:[],related:[]};
  ui.refine=null;if(engine()==='crossref')draw();else search(1);
 }
 const activeList=()=>[...ui.active.themes.map(x=>['themes',x]),...ui.active.periods.map(x=>['periods',x]),...ui.active.related.map(x=>['related',x])];
 function refinePanel(){
  const r=ui.refine,d=r.data,chip=(x,g)=>{const on=r.sel.has(`${g}:${x.id}`);return`<button class="${on?'on':''}" aria-pressed="${on}" data-refine-pick="${g}:${esc(x.id)}">${esc(x.name)} <small>${x.count.toLocaleString()}</small></button>`;};
  const group=(title,list,g,hint)=>list?.length?`<div class="lit-refine-group"><h4>${title}${hint?` <small>${hint}</small>`:''}</h4><div class="lit-fields">${list.map(x=>chip(x,g)).join('')}</div></div>`:'';
  const n=r.sel.size;
  return`<section class="lit-refine" aria-label="Refine the search"><h3>Refine “${esc(r.query)}”?</h3>
  ${r.loading?'<p class="lit-hint">Looking at how the literature on this term splits…</p>':r.error?`<p class="lit-error">${esc(r.error)}</p>`:d.total?`<p class="lit-hint">${d.fromPool?`${d.total.toLocaleString()} works match in Crossref; the suggestions describe the ${d.pool} most relevant, already loaded. Pick periods, themes or related subjects to narrow them, or show everything.`:`${d.total.toLocaleString()} works match in the selected fields. Pick periods, themes or related subjects to narrow them, or search everything.`}</p>`:'<p class="lit-hint">No works match this exact phrase in the selected fields; a broader search may still find some.</p>'}
  <div class="lit-refine-actions"><button class="btn" data-refine-run="all">${d?.fromPool?'Show all results':'Search all of'} “${esc(r.query)}”${d?.total?` · ${d.total.toLocaleString()}`:''}</button>${d?`<button class="btn outline" data-refine-run="selected" ${n?'':'disabled'}>Search with ${n||'no'} refinement${n===1?'':'s'}</button>`:''}<button class="lit-textbtn" data-refine-run="cancel">Cancel</button></div>
  ${d?group('Periods',d.periods,'p','in time order')+group('Themes',d.themes,'t','research topics')+group('Related subjects',d.related,'r','')+`<p class="lit-hint">Choices in the same group are alternatives; choices in different groups must all match. Counts are ${d.fromPool?'among the loaded results':'works in OpenAlex'}.</p>`:''}</section>`;
 }
 function activeBar(){
  const list=activeList();if(!ui.records.length&&!ui.busy)return'';
  if(!list.length)return ui.busy?'':`<div class="lit-active"><button class="lit-textbtn" data-refine-open>Refine “${esc(ui.query)}” by period, theme or subject…</button></div>`;
  return`<div class="lit-active"><span>Refined by</span>${list.map(([g,x])=>`<button class="pill" data-unrefine="${g}:${esc(x.id)}" title="Remove this refinement">${esc(x.name)} ×</button>`).join('')}<button class="lit-textbtn" data-unrefine="all">Search all instead</button></div>`;
 }

 // ---- rendering --------------------------------------------------------------------------
 const scoreClass=s=>s>=80?'strong':s>=60?'good':s>=40?'moderate':'weak';
 function card(r,{corpusItem=null}={}){
  const inZotero=added()[r.id],busy=ui.zoteroBusy.has(r.id),meta=[r.authors.slice(0,3).join(', ')+(r.authors.length>3?' et al.':''),r.year,['article','review'].includes(r.type)?r.venue:r.publisher||r.venue,languageName(r.language)!=='Unknown'?languageName(r.language):''].filter(Boolean);
  const full=r.links.map(l=>l.kind==='openalex-pdf'?`<button class="lit-link" data-oa-pdf="${esc(l.url)}">${esc(l.label)}</button>`:`<a class="lit-link ${l.kind}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('');
  const cites=r.source==='openlibrary'?`${r.editions} edition${r.editions===1?'':'s'}`:`${r.citations.toLocaleString()} citation${r.citations===1?'':'s'}${r.top1?' · top 1%':r.top10?' · top 10%':''}`;
  const reviews=cachedReviews(r.id)||corpusItem?.reviews||null,rvOpen=ui.reviewsOpen.has(r.id),rvBusy=ui.reviewBusy.has(r.id);
  const saved=o.corpus&&inCorpus(r.id);
  return`<article class="lit-item ${corpusItem?.status==='excluded'?'excluded':''}" data-rec="${esc(r.id)}">
  <div class="lit-top"><span class="lit-score ${scoreClass(r.score)}" title="${esc(r.scoreBasis)}"><b>${r.score}</b>${esc(r.scoreLabel)}</span><div class="lit-head"><a class="lit-title" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><p class="lit-meta">${esc(meta.join(' · '))}</p><p class="lit-signal">${esc(TYPE_NAME[r.type]||'')} · ${esc(cites)}${r.subfield?` · ${esc(r.subfield)}`:''}${r.young?' · <span class="lit-young">recent</span>':''}${r.retracted?' · <strong class="lit-retracted">RETRACTED</strong>':''} · <span class="lit-src">${{openalex:'OpenAlex',crossref:r.openalexId?'Crossref + OpenAlex':'Crossref',openlibrary:'Open Library'}[r.source]}</span></p>${reviews?`<p class="lit-rv-line">${reviewSummary(reviews)}</p>`:''}</div></div>
  ${r.abstract?`<details class="lit-abstract" ${ui.open.has(r.id)?'open':''}><summary>Abstract</summary><p>${esc(r.abstract)}</p></details>`:''}
  ${rvOpen&&reviews?`<div class="lit-reviews">${reviewList(reviews)}</div>`:''}
  ${corpusItem?`<div class="lit-corpus-fields"><label>Status<select data-status="${esc(r.id)}">${STATUSES.map(([v,l])=>`<option value="${v}" ${corpusItem.status===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="lit-note">Note<textarea data-note="${esc(r.id)}" rows="2" placeholder="Why it matters, what to check, where it disagrees…">${esc(corpusItem.note||'')}</textarea></label></div>`:''}
  <div class="lit-actions">${full}${r.doi?`<a class="lit-link" href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">DOI ↗</a>`:''}<button class="lit-link" data-reviews="${esc(r.id)}" ${rvBusy?'disabled':''}>${rvBusy?'Looking for reviews…':reviews?(rvOpen?'Hide reviews':'Reviews & responses'):'Find reviews'}</button><details class="lit-find"><summary>Find a copy</summary>${findLinks(r,localStorage.getItem(LIB_KEY)||'').map(l=>`<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</details>
  <span class="lit-spacer"></span>${o.corpus?`<button class="lit-corpus-btn ${saved?'done':''}" data-corpus="${esc(r.id)}" title="${saved?'Remove from':'Save to'} the corpus">${saved?'★ In corpus':'☆ Corpus'}</button>`:''}<button class="lit-ris" data-ris="${esc(r.id)}" title="Download a citation file">RIS</button><button class="lit-zotero ${inZotero?'done':''}" data-zotero="${esc(r.id)}" ${busy||inZotero?'disabled':''}>${inZotero?'✓ In Zotero':busy?'Adding…':'+ Zotero'}</button></div></article>`;
 }
 function settings(){
  const z=zcfg();
  return`<details class="lit-settings" ${ui.showSettings?'open':''}><summary>Settings · OpenAlex, Zotero, library</summary>
  <div class="lit-setting"><h4>OpenAlex key <small>(optional, free · shared by your apps)</small></h4><p class="lit-hint">Without a key OpenAlex allows about 100 searches a day from this browser. A free key from openalex.org raises that and opens OpenAlex’s cached PDFs. Stored only in this browser.</p><div class="lit-row"><input id="lit-oa-key" type="password" autocomplete="off" placeholder="${oaKey()?'Saved · paste to replace':'OpenAlex API key'}"><button class="btn outline" id="lit-oa-save">Save</button>${oaKey()?'<button class="lit-textbtn" id="lit-oa-clear">Remove</button>':''}</div></div>
  <div class="lit-setting"><h4>Zotero ${z.apiKey?`<small>· connected as ${esc(z.username||z.userID)} → “${esc(z.collection.name)}”</small>`:''}</h4><p class="lit-hint">Create a key at <a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noopener">zotero.org/settings/keys</a> with “Allow library access” and “Allow write access”. The key is shared by your apps; each app sends items to its own collection (created if missing), tagged with your search, with open-access PDFs attached as links.</p><div class="lit-row"><input id="lit-zotero-key" type="password" autocomplete="off" placeholder="${z.apiKey?'Saved · paste to replace':'Zotero API key'}"><input id="lit-zotero-collection" value="${esc(z.collection.name||o.collection)}" aria-label="Zotero collection name"><button class="btn outline" id="lit-zotero-save">${z.apiKey?'Update':'Connect'}</button>${z.apiKey?'<button class="lit-textbtn" id="lit-zotero-clear">Disconnect</button>':''}</div></div>
  <div class="lit-setting"><h4>Search engine</h4><label class="lit-check"><input type="radio" name="lit-engine" value="crossref" ${engine()==='crossref'?'checked':''}> Crossref, enriched by OpenAlex <small>(recommended: no daily limit; about 500 searches a day get OpenAlex details without a key, 5,000 with one)</small></label><label class="lit-check"><input type="radio" name="lit-engine" value="openalex" ${engine()==='openalex'?'checked':''}> OpenAlex search <small>(sharper topic matching and Italian-language results; about 100 searches a day without a key, 1,000 with one)</small></label></div>
  <div class="lit-setting"><h4>Refine before searching</h4><label class="lit-check"><input type="checkbox" id="lit-refine-toggle" ${refineOn()?'checked':''}> Suggest periods, themes and related subjects for a term before searching it</label></div>
  <div class="lit-setting"><h4>My library search <small>(optional)</small></h4><p class="lit-hint">Paste your university library’s search address with <code>{query}</code> where the search terms go; a “My library” link then appears under “Find a copy”.</p><div class="lit-row"><input id="lit-library" value="${esc(localStorage.getItem(LIB_KEY)||'')}" placeholder="https://…?q={query}"><button class="btn outline" id="lit-library-save">Save</button></div></div>
  <p class="lit-hint">Full texts come only from legal sources: open-access copies listed by OpenAlex, OpenAlex’s cached PDFs, and Internet Archive reading or lending. Everything else links to the publisher page, your library, WorldCat and Google Scholar.</p></details>`;
 }
 const opt=(v,l,cur)=>`<option value="${esc(v)}" ${String(v)===String(cur)?'selected':''}>${esc(l)}</option>`;
 function results(){
  const base=visible();if(!base.length)return ui.pool.length&&!ui.busy?'<p class="lit-empty">No loaded result matches these fields and refinements. Load more results or remove a refinement.</p>'+(ui.busy?'':`<div class="lit-more"><button class="btn outline" id="lit-more">Load more results</button></div>`):'';
  const f=ui.filters,fc=facets(base),shown=filterRecords(base,f);
  const controls=`<div class="lit-filters">
   <div class="lit-tabs" role="tablist">${[['all',`All · ${base.length}`],...fc.types.map(([t,n])=>[t,`${TYPE_NAME[t]} · ${n}`])].map(([t,l])=>`<button role="tab" aria-selected="${f.type===t}" class="${f.type===t?'on':''}" data-lit-type="${t}">${esc(l)}</button>`).join('')}</div>
   <div class="lit-selects"><label>Sort<select data-lit-filter="sort">${opt('relevance','Relevance',f.sort)}${opt('score','Scholarly signal',f.sort)}${opt('citations','Most cited',f.sort)}${opt('newest','Newest',f.sort)}${opt('oldest','Oldest',f.sort)}</select></label>
   <label>Field<select data-lit-filter="subfield">${opt('','All fields',f.subfield)}${fc.subfields.map(([s,n])=>opt(s,`${s} · ${n}`,f.subfield)).join('')}</select></label>
   <label>Language<select data-lit-filter="language">${opt('','Any',f.language)}${fc.languages.map(([s,n])=>opt(s,`${s} · ${n}`,f.language)).join('')}</select></label>
   <label>Signal<select data-lit-filter="minScore">${[[0,'Any'],[40,'Moderate +'],[60,'Good +'],[80,'Strong']].map(([v,l])=>opt(v,l,f.minScore)).join('')}</select></label>
   <label class="lit-check"><input type="checkbox" data-lit-check="openOnly" ${f.openOnly?'checked':''}> Free full text · ${fc.openFull}</label>
   <label class="lit-check"><input type="checkbox" data-lit-check="withAbstract" ${f.withAbstract?'checked':''}> With abstract</label></div></div>`;
  const body=!shown.length?'<p class="lit-empty">No result matches these filters.</p>':f.type==='all'&&f.sort==='relevance'?groupByType(shown).map(([t,name,list])=>`<section class="lit-group"><h3>${esc(name)} <span class="pill">${list.length}</span></h3>${list.map(r=>card(r)).join('')}</section>`).join(''):shown.map(r=>card(r)).join('');
  return controls+`<p class="lit-hint lit-count">Showing ${shown.length} of ${base.length}${engine()==='crossref'&&base.length<ui.pool.length?` (${ui.pool.length} loaded)`:''}. The signal score (0–100) weighs field-normalised citations, venue, work type and identifiers; hover it for the basis. It sorts the evidence, it does not judge the argument. “Find reviews” looks for published reviews, comments and corrections.</p>`+body+(ui.busy?'':`<div class="lit-more"><button class="btn outline" id="lit-more">Load more results</button></div>`);
 }
 function searchView(){
  const chips=o.showFields?`<div class="lit-fields" role="group" aria-label="Subject fields"><button class="${ui.fields.length?'':'on'}" data-lit-field="">Any field</button>${FIELDS.map(([id,name])=>`<button class="${ui.fields.includes(id)?'on':''}" data-lit-field="${id}" aria-pressed="${ui.fields.includes(id)}">${esc(name)}</button>`).join('')}</div>`:'';
  return`<form class="lit-search" id="lit-form"><input id="lit-query" type="search" value="${esc(ui.query)}" placeholder="${esc(o.placeholder)}" aria-label="Topic"><button class="btn" ${ui.busy?'disabled':''}>${ui.busy?'Searching…':'Search'}</button></form>
  ${chips}<div class="lit-options"><label>From<input id="lit-from" inputmode="numeric" maxlength="4" value="${esc(ui.from)}" placeholder="year"></label><label>To<input id="lit-to" inputmode="numeric" maxlength="4" value="${esc(ui.to)}" placeholder="year"></label>${o.showFields?'':`<label class="lit-check"><input type="checkbox" id="lit-humanities" ${ui.fields.length?'checked':''}> Humanities & social sciences only</label>`}<label class="lit-check"><input type="checkbox" id="lit-books" ${ui.books?'checked':''}> Include Open Library books</label></div>
  ${ui.refine?refinePanel():`${!ui.records.length&&!ui.busy&&o.presets.length?`<p class="lit-empty">Start from a topic, or try one of these:</p><div class="lit-presets">${o.presets.map(p=>`<button class="pill" data-lit-preset="${esc(p)}">${esc(p)}</button>`).join('')}</div>`:''}${activeBar()}<div class="lit-results">${results()}</div>`}`;
 }
 function corpusView(){
  const d=corpusData(),c=activeCorpus(d),items=Object.values(c.items),f=ui.corpusFilters;
  let list=items.filter(x=>(!f.status||x.status===f.status)&&(f.type==='all'||x.record.type===f.type));
  const by={added:(a,b)=>b.addedAt-a.addedAt,score:(a,b)=>b.record.score-a.record.score,year:(a,b)=>(b.record.year||0)-(a.record.year||0),title:(a,b)=>a.record.title.localeCompare(b.record.title)}[f.sort];list.sort(by);
  const count=s=>items.filter(x=>x.status===s).length,reviewed=items.filter(x=>(cachedReviews(x.record.id)||x.reviews)?.length).length,checked=items.filter(x=>cachedReviews(x.record.id)||x.reviews).length;
  const types=[...new Set(items.map(x=>x.record.type))];
  return`<div class="lit-corpus-head"><label>Corpus<select id="lit-corpus-select">${d.corpora.map(k=>opt(k.id,`${k.name} · ${Object.keys(k.items).length}`,d.active)).join('')}</select></label><button class="lit-textbtn" data-corpus-act="new">New</button><button class="lit-textbtn" data-corpus-act="rename">Rename</button>${d.corpora.length>1?'<button class="lit-textbtn danger" data-corpus-act="delete">Delete</button>':''}</div>
  <p class="lit-hint">${items.length} source${items.length===1?'':'s'} · ${STATUSES.map(([v,l])=>`${count(v)} ${l.toLowerCase()}`).join(' · ')} · reviews checked for ${checked}, found for ${reviewed}. Saved with Reading Room’s data and included in its backups.</p>
  <div class="lit-actions lit-corpus-actions"><button class="lit-link" data-corpus-act="reviews" ${items.length?'':'disabled'}>Find reviews for all</button><button class="lit-zotero" data-corpus-act="zotero" ${items.length?'':'disabled'}>Send all to Zotero</button><button class="lit-ris" data-corpus-act="bib" ${items.length?'':'disabled'}>BibTeX</button><button class="lit-ris" data-corpus-act="ris" ${items.length?'':'disabled'}>RIS</button><button class="lit-ris" data-corpus-act="csv" ${items.length?'':'disabled'}>CSV</button></div>
  ${ui.batch?`<p class="lit-status" role="status">${esc(ui.batch)}</p>`:''}
  ${items.length?`<div class="lit-selects"><label>Status<select data-corpus-filter="status">${opt('','All',f.status)}${STATUSES.map(([v,l])=>opt(v,`${l} · ${count(v)}`,f.status)).join('')}</select></label><label>Type<select data-corpus-filter="type">${opt('all','All types',f.type)}${types.map(t=>opt(t,TYPE_NAME[t],f.type)).join('')}</select></label><label>Sort<select data-corpus-filter="sort">${opt('added','Recently added',f.sort)}${opt('score','Scholarly signal',f.sort)}${opt('year','Newest',f.sort)}${opt('title','Title',f.sort)}</select></label></div>`:''}
  <div class="lit-results">${list.map(x=>card({...x.record,_query:x.query},{corpusItem:x})).join('')||`<p class="lit-empty">${items.length?'No source matches these filters.':'Nothing saved yet. Use ☆ Corpus on any search result to collect it here.'}</p>`}</div>`;
 }
 function draw(){
  if(!root?.isConnected)return;
  const scroll=window.scrollY,focus=document.activeElement?.dataset?.note;
  const n=o.corpus?Object.keys(activeCorpus(corpusData()).items).length:0;
  root.innerHTML=`<div class="lit-intro"><span class="eyebrow">${esc(o.eyebrow)}</span><h2>${esc(o.title)}</h2>${o.intro?`<p class="lit-hint">${esc(o.intro)}</p>`:''}</div>
  ${o.corpus?`<div class="lit-views"><button class="${ui.view==='search'?'on':''}" data-lit-view="search">Search</button><button class="${ui.view==='corpus'?'on':''}" data-lit-view="corpus">Corpus · ${n}</button></div>`:''}
  ${ui.status?`<p class="lit-status" role="status">${esc(ui.status)}</p>`:''}${ui.error?`<p class="lit-error" role="alert">${esc(ui.error)}</p>`:''}
  ${ui.view==='corpus'&&o.corpus?corpusView():searchView()}${settings()}`;
  bind();window.scrollTo(0,scroll);
  if(focus)root.querySelector(`[data-note="${CSS.escape(focus)}"]`)?.focus();
 }
 const findRec=id=>ui.records.find(r=>r.id===id)||(o.corpus?activeCorpus(corpusData()).items[id]?.record:null);
 async function corpusAction(act){
  const d=corpusData(),c=activeCorpus(d),items=Object.values(c.items),recs=items.map(x=>({...x.record,_query:x.query}));
  if(act==='new'){const name=prompt('Name of the new corpus','New corpus');if(!name?.trim())return;saveCorpus(dd=>{const id=crypto.randomUUID();dd.corpora.push({id,name:name.trim(),createdAt:Date.now(),items:{}});dd.active=id;});draw();return;}
  if(act==='rename'){const name=prompt('Rename this corpus',c.name);if(!name?.trim())return;saveCorpus((dd,cc)=>{cc.name=name.trim();});draw();return;}
  if(act==='delete'){if(!confirm(`Delete the corpus “${c.name}” and its ${items.length} saved source(s)? Zotero is unaffected.`))return;saveCorpus(dd=>{dd.corpora=dd.corpora.filter(k=>k.id!==c.id);dd.active=dd.corpora[0]?.id;});draw();return;}
  const base=`${slug(c.name)}-${new Date().toISOString().slice(0,10)}`;
  if(act==='bib')return download(`${base}.bib`,recs.map(toBibtex).join('\n'),'application/x-bibtex');
  if(act==='ris')return download(`${base}.ris`,recs.map(r=>toRis(r,o.tag)).join(''),'application/x-research-info-systems');
  if(act==='csv')return download(`${base}.csv`,toCsv(items.map(x=>({...x.record,authors:x.record.authors,status:x.status,note:x.note,reviews:cachedReviews(x.record.id)||x.reviews}))),'text/csv');
  if(act==='zotero'){ui.batch='Sending to Zotero…';ui.error='';draw();try{const n=await sendToZotero(recs);ui.status=n?`${n} source${n>1?'s':''} sent to Zotero · ${zcfg().collection.name}.`:'Everything in this corpus is already in Zotero.';}catch(e){ui.error=e.message;}ui.batch='';draw();return;}
  if(act==='reviews'){
   const todo=recs.filter(r=>!cachedReviews(r.id));let done=0,found=0;
   for(const r of todo){ui.batch=`Looking for reviews · ${done+1} of ${todo.length}…`;draw();try{const items=await loadReviews(r,{quiet:true});if(items?.length)found++;}catch(e){ui.error=`Stopped: ${e.message}`;break;}done++;}
   for(const r of recs){const items=cachedReviews(r.id);if(items)saveCorpus((dd,cc)=>{if(cc.items[r.id])cc.items[r.id].reviews=items;});}
   ui.batch='';ui.status=todo.length?`Checked ${done} source${done===1?'':'s'}; reviews or responses found for ${found}.`:'Reviews were already checked for every source.';draw();
  }
 }
 function bind(){
  const $=s=>root.querySelector(s),$$=s=>root.querySelectorAll(s);
  $$('[data-lit-view]').forEach(b=>b.onclick=()=>{ui.view=b.dataset.litView;ui.status='';ui.error='';draw();});
  const form=$('#lit-form');
  if(form)form.onsubmit=e=>{e.preventDefault();ui.query=$('#lit-query').value;ui.from=$('#lit-from').value.replace(/\D/g,'');ui.to=$('#lit-to').value.replace(/\D/g,'');const hum=$('#lit-humanities');if(hum){ui.fields=hum.checked?o.fields:[];}ui.books=$('#lit-books').checked;ui.filters={...ui.filters,type:'all',subfield:'',language:''};startRefine();};
  $$('[data-lit-field]').forEach(b=>b.onclick=()=>{const id=b.dataset.litField;ui.fields=!id?[]:ui.fields.includes(id)?ui.fields.filter(x=>x!==id):[...ui.fields,id];set(localStorage,FIELDS_KEY,ui.fields);draw();});
  $$('[data-lit-preset]').forEach(b=>b.onclick=()=>{ui.query=b.dataset.litPreset;startRefine();});
  $$('[data-refine-pick]').forEach(b=>b.onclick=()=>{const k=b.dataset.refinePick;ui.refine.sel.has(k)?ui.refine.sel.delete(k):ui.refine.sel.add(k);draw();});
  $$('[data-refine-run]').forEach(b=>b.onclick=()=>{const m=b.dataset.refineRun;if(m==='cancel'){ui.refine=null;draw();}else runRefine(m==='selected');});
  $$('[data-refine-open]').forEach(b=>b.onclick=startRefineForced);
  $$('[data-unrefine]').forEach(b=>b.onclick=()=>{const v=b.dataset.unrefine;if(v==='all')ui.active={themes:[],periods:[],related:[]};else{const [g,id]=[v.slice(0,v.indexOf(':')),v.slice(v.indexOf(':')+1)];ui.active={...ui.active,[g]:ui.active[g].filter(x=>x.id!==id)};}if(engine()==='crossref')draw();else search(1);});
  $$('[name="lit-engine"]').forEach(r=>r.onchange=()=>{try{localStorage.setItem(ENGINE_KEY,r.value);}catch{}ui.pool=[];ui.records=[];ui.active={themes:[],periods:[],related:[]};ui.status=r.value==='crossref'?'Crossref will search; OpenAlex adds details by DOI.':'OpenAlex will search.';draw();});
  const refineToggle=$('#lit-refine-toggle');if(refineToggle)refineToggle.onchange=()=>{try{localStorage.setItem(REFINE_KEY,refineToggle.checked?'on':'off');}catch{}};
  $$('[data-lit-type]').forEach(b=>b.onclick=()=>{ui.filters.type=b.dataset.litType;draw();});
  $$('[data-lit-filter]').forEach(s=>s.onchange=()=>{const k=s.dataset.litFilter;ui.filters[k]=k==='minScore'?Number(s.value):s.value;draw();});
  $$('[data-lit-check]').forEach(c=>c.onchange=()=>{ui.filters[c.dataset.litCheck]=c.checked;draw();});
  $$('.lit-abstract').forEach(d=>d.ontoggle=()=>{const id=d.closest('[data-rec]').dataset.rec;d.open?ui.open.add(id):ui.open.delete(id);});
  $$('[data-zotero]').forEach(b=>b.onclick=()=>addOne(findRec(b.dataset.zotero)));
  $$('[data-ris]').forEach(b=>b.onclick=()=>{const r=findRec(b.dataset.ris);download(`${slug(r.title)}.ris`,toRis(r,o.tag),'application/x-research-info-systems');});
  $$('[data-corpus]').forEach(b=>b.onclick=()=>toggleCorpus(findRec(b.dataset.corpus)));
  $$('[data-reviews]').forEach(b=>b.onclick=async()=>{const id=b.dataset.reviews,r=findRec(id);if(ui.reviewsOpen.has(id)){ui.reviewsOpen.delete(id);draw();return;}ui.reviewsOpen.add(id);try{await loadReviews(r);}catch{}draw();});
  $$('[data-oa-pdf]').forEach(b=>b.onclick=async()=>{const key=oaKey();if(!key){ui.showSettings=true;ui.error='OpenAlex’s cached PDFs need a free OpenAlex key (settings below).';draw();return;}b.disabled=true;b.textContent='Opening…';const tab=window.open('','_blank');try{const blob=await fetchOpenPdf(b.dataset.oaPdf,key);if(tab){tab.opener=null;tab.location.href=URL.createObjectURL(blob);}else window.location.assign(URL.createObjectURL(blob));b.disabled=false;b.textContent='OpenAlex PDF';}catch(e){tab?.close();ui.error=e.message;draw();}});
  $$('[data-status]').forEach(s=>s.onchange=()=>{saveCorpus((d,c)=>{c.items[s.dataset.status].status=s.value;});draw();});
  $$('[data-note]').forEach(t=>t.onchange=()=>saveCorpus((d,c)=>{c.items[t.dataset.note].note=t.value.slice(0,4000);}));
  $$('[data-corpus-act]').forEach(b=>b.onclick=()=>corpusAction(b.dataset.corpusAct));
  $$('[data-corpus-filter]').forEach(s=>s.onchange=()=>{ui.corpusFilters[s.dataset.corpusFilter]=s.value;draw();});
  const sel=$('#lit-corpus-select');if(sel)sel.onchange=()=>{saveCorpus(d=>{d.active=sel.value;});draw();};
  const more=$('#lit-more');if(more)more.onclick=()=>search(ui.page+1);
  $('#lit-oa-save').onclick=()=>{const v=$('#lit-oa-key').value.trim();if(!v)return;try{localStorage.setItem(OA_KEY,v);}catch{}ui.status='OpenAlex key saved in this browser.';ui.error='';draw();};
  const oaClear=$('#lit-oa-clear');if(oaClear)oaClear.onclick=()=>{try{localStorage.removeItem(OA_KEY);}catch{}ui.status='OpenAlex key removed.';draw();};
  $('#lit-zotero-save').onclick=async()=>{const key=$('#lit-zotero-key').value.trim()||zcfg().apiKey,name=$('#lit-zotero-collection').value.trim()||o.collection;if(!key){ui.error='Paste a Zotero API key first.';draw();return;}ui.status='Connecting to Zotero…';ui.error='';draw();try{await connectZotero(key,name);ui.status=`Zotero connected: items will go to “${zcfg().collection.name}”.`;ui.showSettings=false;}catch(e){ui.error=e.message;ui.status='';}draw();};
  const zClear=$('#lit-zotero-clear');if(zClear)zClear.onclick=()=>{set(localStorage,ZOTERO_KEY,null);ui.status='Zotero disconnected from this browser (all apps).';draw();};
  $('#lit-library-save').onclick=()=>{const v=$('#lit-library').value.trim();if(v&&!/^https:\/\/.+\{query\}/.test(v)){ui.error='Use an https:// address containing {query}.';draw();return;}try{v?localStorage.setItem(LIB_KEY,v):localStorage.removeItem(LIB_KEY);}catch{}ui.status=v?'Library search saved.':'Library search removed.';ui.error='';draw();};
  root.querySelector('.lit-settings').ontoggle=e=>{ui.showSettings=e.target.open;};
 }
 draw();
}
