// Scholarly literature browser, shared by Reading Room (any subject) and Italiano
// (Italian history): pure logic only, no DOM, no storage. It builds OpenAlex and Open
// Library queries, normalises results into one record shape, scores how well cited and
// how reputable each work is, finds published reviews of and responses to a work,
// groups results, and maps records to Zotero items, RIS, BibTeX or CSV.
//
// Full-text links are limited to legal sources: open-access PDFs and repository
// copies listed by OpenAlex, OpenAlex's own cached PDFs (with a free key), and
// Internet Archive reading or lending for books found through Open Library.

export const OPENALEX='https://api.openalex.org/works';
export const OPENLIBRARY='https://openlibrary.org/search.json';
export const TYPES=[['book','Books'],['chapter','Book chapters'],['article','Journal articles'],['review','Reviews & surveys'],['working','Working papers & preprints'],['thesis','Theses'],['other','Other']];
const TYPE_OF={book:'book','book-chapter':'chapter',article:'article',review:'review','book-review':'review',dissertation:'thesis',preprint:'working',report:'working'};
const SELECT='id,doi,title,display_name,publication_year,type,cited_by_count,fwci,citation_normalized_percentile,primary_location,best_oa_location,open_access,primary_topic,language,authorships,abstract_inverted_index,is_retracted,biblio,has_content';
// OpenAlex fields (primary topic). Limiting fields keeps "Venice" from returning lagoon chemistry.
export const FIELDS=[['12','Humanities'],['33','Social sciences'],['20','Economics & econometrics'],['32','Psychology'],['14','Business & management'],['17','Computer science'],['26','Mathematics & statistics'],['27','Medicine & health'],['16|31|19|13','Natural sciences'],['22','Engineering']];
const WORK_TYPES='type:article|book|book-chapter|review|book-review|dissertation|preprint|report';
const PRESS=/\b(cambridge|oxford|princeton|harvard|yale|stanford|cornell|johns hopkins|pennsylvania|chicago|california|columbia|toronto|edinburgh|manchester|toronto|chicago|duke|brill|de gruyter|routledge|palgrave|springer|bloomsbury|peter lang|il mulino|laterza|einaudi|carocci|viella|donzelli|olschki|feltrinelli|mondadori|bollati boringhieri|franco ?angeli|edizioni di storia e letteratura|firenze university press|ca' ?foscari|rubbettino|salerno editrice|university press|presses universitaires|école française de rome|istituto storico)\b/i;

const clean=(v,max=600)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,max);
export const norm=v=>clean(v,400).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

// ---- queries -----------------------------------------------------------------
// Filters shared by searches and by the refinement suggestions. Topics are alternatives
// (OR). Keywords come in groups (e.g. periods, related subjects): alternatives within a
// group, every group required (AND), as are the other filters.
function baseFilters({from='',to='',fields=[],topics=[],keywords=[]}){
 const years=[from&&`from_publication_date:${Number(from)}-01-01`,to&&`to_publication_date:${Number(to)}-12-31`].filter(Boolean);
 const ids=[...new Set((fields||[]).flatMap(f=>String(f).split('|')).filter(x=>/^\d+$/.test(x)))];
 const topicIds=(topics||[]).map(t=>String(t).split('/').pop()).filter(t=>/^T\d+$/.test(t));
 const keywordGroups=(keywords||[]).map(g=>(Array.isArray(g)?g:[g]).map(k=>String(k).split('/').pop()).filter(k=>/^[a-z0-9-]+$/.test(k))).filter(g=>g.length);
 return[WORK_TYPES,ids.length&&`primary_topic.field.id:${ids.join('|')}`,topicIds.length&&`primary_topic.id:${topicIds.join('|')}`,...keywordGroups.map(g=>`keywords.id:${g.join('|')}`),...years].filter(Boolean);
}
/**
 * OpenAlex searches for one topic: overall relevance and books/chapters, plus one
 * restricted to `language` when given (Italiano adds Italian-language work).
 * `fields` is a list of OpenAlex field ids (see FIELDS); empty means any field.
 */
export function openAlexUrls(query,{key='',from='',to='',fields=['12','33'],language='',page=1,perPage=50,topics=[],keywords=[]}={}){
 const base=baseFilters({from,to,fields,topics,keywords});
 const url=(extra,n,p=1)=>{const params=new URLSearchParams({search:query,filter:[...base,...extra].join(','),per_page:String(n),page:String(p),select:SELECT});if(key)params.set('api_key',key);return`${OPENALEX}?${params}`;};
 if(page>1)return[url([],perPage,page)];
 return[url([],perPage),url(['type:book|book-chapter'],30),...(language?[url([`language:${language}`],30)]:[])];
}
export function openLibraryUrl(query,{from='',to=''}={}){
 const params=new URLSearchParams({q:query,limit:'30',fields:'key,title,subtitle,author_name,first_publish_year,isbn,ebook_access,ia,edition_count,publisher,language,number_of_pages_median'});
 if(from||to)params.set('q',`${query} first_publish_year:[${from||'*'} TO ${to||'*'}]`);
 return`${OPENLIBRARY}?${params}`;
}

// ---- normalising --------------------------------------------------------------
export function restoreAbstract(index){
 if(!index||typeof index!=='object')return'';
 const words=[];for(const [word,places] of Object.entries(index))for(const p of places||[])if(Number.isSafeInteger(p)&&p>=0&&p<4000)words[p]=word;
 return clean(words.filter(Boolean).join(' '),5000);
}
const LANG={en:'English',it:'Italian',fr:'French',de:'German',es:'Spanish',pt:'Portuguese',pl:'Polish',nl:'Dutch',la:'Latin',eng:'English',ita:'Italian',fre:'French',fra:'French',ger:'German',deu:'German',spa:'Spanish',lat:'Latin'};
export const languageName=code=>LANG[String(code||'').toLowerCase()]||(code?String(code).toUpperCase():'Unknown');
function splitName(name){const parts=clean(name,120).split(' ');return parts.length<2?{name:parts[0]||''}:{firstName:parts.slice(0,-1).join(' '),lastName:parts.at(-1)};}

export function normalizeOpenAlex(w){
 const loc=w.primary_location||{},src=loc.source||{},best=w.best_oa_location||{};
 const doi=clean(w.doi||'',200).replace(/^https?:\/\/doi\.org\//i,'');
 const links=[];
 const pdf=best.pdf_url||loc.pdf_url||'';
 if(pdf)links.push({kind:'pdf',label:'Open-access PDF',url:pdf});
 const oa=w.open_access?.oa_url||best.landing_page_url||'';
 if(oa&&oa!==pdf)links.push({kind:'oa',label:'Free to read',url:oa});
 if(w.has_content?.pdf)links.push({kind:'openalex-pdf',label:'OpenAlex PDF',url:`https://content.openalex.org/works/${String(w.id).split('/').pop()}.pdf`});
 const landing=doi?`https://doi.org/${doi}`:loc.landing_page_url||w.id;
 const topic=w.primary_topic||{};
 return{
  id:`oa:${String(w.id).split('/').pop()}`,source:'openalex',openalexId:w.id,
  title:clean(w.title||w.display_name,400),
  authors:(w.authorships||[]).map(a=>clean(a.author?.display_name,120)).filter(Boolean).slice(0,12),
  orcids:(w.authorships||[]).filter(a=>a.author?.orcid).length,
  year:Number(w.publication_year)||null,
  type:TYPE_OF[w.type]||'other',rawType:w.type||'',
  venue:clean(src.display_name,200),venueType:clean(src.type,40),publisher:clean(src.host_organization_name,200),
  inCore:!!src.is_core,inDoaj:!!src.is_in_doaj,
  doi,url:landing,abstract:restoreAbstract(w.abstract_inverted_index),
  language:w.language||'',field:clean(topic.field?.display_name,80),subfield:clean(topic.subfield?.display_name,80),topic:clean(topic.display_name,120),
  citations:Number(w.cited_by_count)||0,percentile:Number.isFinite(w.citation_normalized_percentile?.value)?w.citation_normalized_percentile.value:null,
  top10:!!w.citation_normalized_percentile?.is_in_top_10_percent,top1:!!w.citation_normalized_percentile?.is_in_top_1_percent,fwci:Number.isFinite(w.fwci)?w.fwci:null,
  retracted:!!w.is_retracted,oaStatus:w.open_access?.oa_status||'closed',
  biblio:{volume:clean(w.biblio?.volume,20),issue:clean(w.biblio?.issue,20),pages:[w.biblio?.first_page,w.biblio?.last_page].filter(Boolean).join('–')},
  isbn:'',links
 };
}
export function normalizeOpenLibrary(d){
 const ia=(d.ia||[])[0],links=[];
 if(ia&&d.ebook_access==='public')links.push({kind:'pdf',label:'Read free · Internet Archive',url:`https://archive.org/details/${ia}`});
 else if(ia&&d.ebook_access==='borrowable')links.push({kind:'oa',label:'Borrow free · Internet Archive',url:`https://archive.org/details/${ia}`});
 const isbn=(d.isbn||[]).find(x=>/^97[89]\d{10}$/.test(x))||(d.isbn||[])[0]||'';
 return{
  id:`ol:${String(d.key).split('/').pop()}`,source:'openlibrary',title:clean([d.title,d.subtitle].filter(Boolean).join(': '),400),
  authors:(d.author_name||[]).map(a=>clean(a,120)).slice(0,8),orcids:0,year:Number(d.first_publish_year)||null,
  type:'book',rawType:'book',venue:'',venueType:'',publisher:clean((d.publisher||[])[0],200),publishers:(d.publisher||[]).slice(0,6),inCore:false,inDoaj:false,
  doi:'',url:`https://openlibrary.org${d.key}`,abstract:'',language:(d.language||[])[0]||'',field:'',subfield:'',topic:'',
  citations:0,percentile:null,top10:false,top1:false,fwci:null,retracted:false,oaStatus:links.length?'archive':'closed',
  editions:Number(d.edition_count)||0,pages:Number(d.number_of_pages_median)||0,biblio:{},isbn,links
 };
}

// ---- scoring ------------------------------------------------------------------
/**
 * Scholarly signal, 0–100: how much evidence there is that a work is well cited and
 * published somewhere reputable. It is a heuristic for sorting, not a quality verdict.
 * OpenAlex: field- and year-normalised citation percentile (55), venue (25), type (12),
 * persistent identifiers (8). Open Library has no citations, so books found only there
 * are scored on editions and publisher and labelled as such.
 */
export function scoreWork(r,now=new Date().getFullYear()){
 if(r.retracted)return{score:0,label:'Retracted',basis:'This work has been retracted.',parts:{}};
 const age=r.year?now-r.year:null,young=age!==null&&age<=2;
 if(r.source==='openlibrary'){
  const editions=Math.min(1,Math.log10(1+r.editions)/Math.log10(31)),press=(r.publishers||[r.publisher]).some(p=>PRESS.test(p||''))?1:0.4;
  const score=Math.round(55*editions*0.8+25*press+12+(r.isbn?5:0));
  return{score:Math.min(score,85),label:label(Math.min(score,85)),basis:`Library signal: ${r.editions} edition${r.editions===1?'':'s'}${press===1?', academic or established publisher':''}. No citation data for books found only in Open Library.`,parts:{editions,press}};
 }
 const impact=r.percentile!==null?r.percentile:Math.min(1,Math.log10(1+r.citations)/3);
 const venue=r.venueType==='journal'?(r.inCore?1:r.inDoaj?0.75:0.7):(['book','chapter'].includes(r.type)&&PRESS.test(`${r.publisher} ${r.venue}`))?1:['ebook platform','book series'].includes(r.venueType)?0.6:r.venueType==='repository'?0.3:r.venue?0.5:0.2;
 const kind={book:1,chapter:1,article:1,review:1,working:0.5,thesis:0.6,other:0.3}[r.type];
 const ids=(r.doi?0.6:0)+(r.orcids?0.4:0);
 let score=Math.round(55*impact+25*venue+12*kind+8*ids);
 const notes=[r.percentile!==null?`citation percentile ${Math.round(r.percentile*100)} in its field and year`:`${r.citations} citations`,r.top1?'top 1% cited':r.top10?'top 10% cited':'',venue>=1?(r.venueType==='journal'?'core journal':'academic press'):venue>=0.7?'peer-reviewed journal':'',young?'recent: citations still accruing':''].filter(Boolean);
 return{score,label:label(score),basis:notes.join(' · '),parts:{impact,venue,kind,ids},young};
}
const label=s=>s>=80?'Strong':s>=60?'Good':s>=40?'Moderate':'Weak';

// ---- merging, grouping, filtering ------------------------------------------------
const key=r=>r.doi?`doi:${r.doi.toLowerCase()}`:`t:${norm(r.title).slice(0,80)}|${norm(r.authors[0]||'').split(' ').pop()||''}`;
/** Merge result lists; OpenAlex wins over Open Library, but keeps any Internet Archive link. */
export function mergeResults(...lists){
 const out=new Map();
 for(const r of lists.flat()){
  if(!r?.title)continue;
  const k=key(r),seen=out.get(k);
  if(!seen){out.set(k,r);continue;}
  if(seen.source==='openalex'&&r.source==='openlibrary'){for(const l of r.links)if(!seen.links.some(x=>x.url===l.url))seen.links.push(l);seen.isbn||=r.isbn;}
  else if(seen.source==='openlibrary'&&r.source==='openalex'){r.links.push(...seen.links.filter(l=>!r.links.some(x=>x.url===l.url)));r.isbn||=seen.isbn;out.set(k,r);}
 }
 return[...out.values()].map(r=>({...r,...withScore(r)}));
}
function withScore(r){const s=scoreWork(r);return{score:s.score,scoreLabel:s.label,scoreBasis:s.basis,young:!!s.young};}

export function facets(records){
 const count=(f)=>{const m=new Map();for(const r of records){const v=f(r);if(v)m.set(v,(m.get(v)||0)+1);}return[...m].sort((a,b)=>b[1]-a[1]);};
 return{types:count(r=>r.type),subfields:count(r=>r.subfield),languages:count(r=>languageName(r.language)),openFull:records.filter(r=>r.links.some(l=>l.kind==='pdf'||l.kind==='oa')).length};
}
export function filterRecords(records,{type='all',subfield='',language='',openOnly=false,minScore=0,sort='relevance',withAbstract=false}={}){
 let list=records.map((r,i)=>({r,i})).filter(({r})=>(type==='all'||r.type===type)&&(!subfield||r.subfield===subfield)&&(!language||languageName(r.language)===language)&&(!openOnly||r.links.some(l=>l.kind==='pdf'||l.kind==='oa'))&&r.score>=minScore&&(!withAbstract||r.abstract));
 const by={score:(a,b)=>b.r.score-a.r.score,citations:(a,b)=>b.r.citations-a.r.citations,newest:(a,b)=>(b.r.year||0)-(a.r.year||0),oldest:(a,b)=>(a.r.year||9999)-(b.r.year||9999),relevance:(a,b)=>a.i-b.i}[sort]||((a,b)=>a.i-b.i);
 return list.sort((a,b)=>by(a,b)||a.i-b.i).map(x=>x.r);
}
export function groupByType(records){
 return TYPES.map(([t,name])=>[t,name,records.filter(r=>r.type===t)]).filter(g=>g[2].length);
}

// ---- links ---------------------------------------------------------------------
export function findLinks(r,libraryTemplate=''){
 const q=[r.title,r.authors[0]].filter(Boolean).join(' ');
 const out=[{label:'Google Scholar',url:`https://scholar.google.com/scholar?q=${encodeURIComponent(r.title)}`},{label:'WorldCat',url:r.isbn?`https://search.worldcat.org/search?q=bn:${r.isbn}`:`https://search.worldcat.org/search?q=${encodeURIComponent(q)}`}];
 if(libraryTemplate&&/\{query\}/.test(libraryTemplate)){try{const u=new URL(libraryTemplate.replace('{query}',encodeURIComponent(r.doi||q)));if(u.protocol==='https:')out.unshift({label:'My library',url:u.href});}catch{}}
 return out;
}

// ---- Zotero and RIS ----------------------------------------------------------------
const ZOTERO_TYPE={book:'book',chapter:'bookSection',article:'journalArticle',review:'journalArticle',working:'preprint',thesis:'thesis',other:'document'};
export function zoteroItem(r,{collection='',tags=[],label='Literature browser'}={}){
 const itemType=ZOTERO_TYPE[r.type]||'document';
 const item={itemType,title:r.title,creators:r.authors.map(a=>({creatorType:'author',...splitName(a)})),date:r.year?String(r.year):'',url:r.url,abstractNote:r.abstract,language:r.language,
  tags:[{tag:label},...tags.filter(Boolean).map(tag=>({tag:clean(tag,100)}))],collections:collection?[collection]:[],relations:{},extra:[r.openalexId?`OpenAlex: ${r.openalexId}`:'',r.citations?`Cited by: ${r.citations} (OpenAlex)`:''].filter(Boolean).join('\n')};
 if(itemType==='journalArticle')Object.assign(item,{publicationTitle:r.venue,volume:r.biblio.volume||'',issue:r.biblio.issue||'',pages:r.biblio.pages||''});
 if(itemType==='bookSection')Object.assign(item,{bookTitle:r.venue,publisher:r.publisher,pages:r.biblio.pages||''});
 if(itemType==='book')Object.assign(item,{publisher:r.publisher,ISBN:r.isbn||''});
 if(itemType==='thesis')item.university=r.publisher||r.venue||'';
 if(itemType==='preprint')item.repository=r.venue||r.publisher||'';
 // Only journal articles have a DOI field in Zotero's schema; elsewhere Zotero reads "DOI:" from Extra.
 if(r.doi&&(itemType==='journalArticle'||itemType==='preprint'))item.DOI=r.doi;
 else if(r.doi)item.extra=[`DOI: ${r.doi}`,item.extra].filter(Boolean).join('\n');
 return item;
}
export function pdfAttachment(url,parentItem){return{itemType:'attachment',parentItem,linkMode:'linked_url',title:'Full text (PDF)',url,contentType:'application/pdf',tags:[],relations:{}};}
export function toRis(r,label='Literature browser'){
 const ty={book:'BOOK',chapter:'CHAP',article:'JOUR',review:'JOUR',working:'RPRT',thesis:'THES',other:'GEN'}[r.type]||'GEN';
 const lines=[['TY',ty],['TI',r.title],...r.authors.map(a=>['AU',(n=>n.lastName?`${n.lastName}, ${n.firstName}`:n.name)(splitName(a))]),['PY',r.year||''],['T2',r.venue],['PB',r.publisher],['DO',r.doi],['SN',r.isbn],['UR',r.url],['AB',r.abstract],['LA',r.language],['VL',r.biblio?.volume],['IS',r.biblio?.issue],['SP',r.biblio?.pages],['KW',label]];
 return lines.filter(([,v])=>v).map(([k,v])=>`${k}  - ${String(v).replace(/\n/g,' ')}`).join('\r\n')+'\r\nER  - \r\n';
}

// ---- OpenAlex cached PDFs (need a free key) ------------------------------------------
export function isOpenAlexPdf(url){return /^https:\/\/content\.openalex\.org\/works\/W\d+\.pdf$/.test(String(url||''));}
export async function fetchOpenPdf(url,key,fetcher=globalThis.fetch){
 if(!isOpenAlexPdf(url))throw Error('This PDF link is not an OpenAlex content link.');
 if(!key)throw Error('OpenAlex’s cached PDFs need a free OpenAlex key (settings).');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
 try{
  const response=await fetcher(url,{headers:{Authorization:`Bearer ${key}`},credentials:'omit',signal:controller.signal});
  if(!response.ok)throw Error(response.status===401?'OpenAlex rejected this key. Check that it was copied in full.':`OpenAlex PDF returned ${response.status}.`);
  if(Number(response.headers?.get('content-length')||0)>50e6)throw Error('This PDF is larger than the 50 MB browser limit.');
  const blob=await response.blob();
  if(blob.size>50e6)throw Error('This PDF is larger than the 50 MB browser limit.');
  if(!/^application\/pdf/i.test(blob.type)&&await blob.slice(0,5).text()!=='%PDF-')throw Error('OpenAlex did not return a PDF file.');
  return blob.type==='application/pdf'?blob:new Blob([blob],{type:'application/pdf'});
 }catch(error){if(error.name==='AbortError')throw Error('The PDF download timed out. Try again later.');throw error;}
 finally{clearTimeout(timer);}
}

// ---- reviews of and responses to a work ----------------------------------------------
// Book reviews are indexed as works whose title repeats the book's title (often with
// "(review)" or "By <author>"); comments, replies and corrections usually cite the
// work they answer. Both are found with at most two OpenAlex requests per work.
const REVIEW_SELECT='id,doi,title,type,publication_year,primary_location,best_oa_location,open_access,authorships,abstract_inverted_index,is_retracted';
const REVIEW_MARK=/\b(review|reviewed|reseña|recensione|recension|compte[- ]rendu|rezension|besprechung|book note|critical notice|review essay)\b/i;
const LIT_REVIEW=/\b(a|systematic|literature|scoping|narrative|integrative|meta|umbrella)[- ]review\b|\breview of (the )?(literature|evidence|research)\b/i;
const RESPONSE_MARK=/^(comment|comments|reply|a reply|response|a response|rejoinder|critique|a critique|erratum|errata|correction|corrigendum|retraction|expression of concern)\b|\b(comment on|reply to|response to|a critique of|rejoinder to|reconsider(?:ed|ing)?|revisit(?:ed|ing)?|reassess(?:ed|ing|ment)?|replicat(?:ed|ion|ing))\b/i;
/** The title part used to find reviews: the main title before a subtitle, if it is long enough to be specific. */
export function reviewTitle(r){
 const t=clean(r.title,300),main=t.split(/[:.?!]\s/)[0];
 return norm(main).split(' ').length>=3||norm(main).length>=18?main:t;
}
export function reviewUrls(r,{key='',useTitleSearch=true}={}){
 const urls=[],title=reviewTitle(r).replace(/"/g,'');
 const add=filter=>{const params=new URLSearchParams({filter,per_page:'40',select:REVIEW_SELECT});if(key)params.set('api_key',key);urls.push(`${OPENALEX}?${params}`);};
 // Title search costs a full OpenAlex search; with useTitleSearch=false only the cheap
 // citing-works filter runs here and Crossref does the free title search.
 if(useTitleSearch&&norm(title).length>=12)add(`title.search:"${title}"`);
 if(r.openalexId)add(`cites:${String(r.openalexId).split('/').pop()}`);
 return urls;
}
// A trailing * marks a stem (oversimplif* matches oversimplified, oversimplifies).
const CUES=['fails','failure','flawed','flaw','weak','weakness','problematic','unconvincing','overlooks','neglects','ignores','lacks','omits','questionable','misleading','errors','inaccurate','inaccuracies','limitations','disappointing','superficial','oversimplif*','selective','tendentious','unpersuasive','uneven','partisan','anachronis*','lacuna','lacune','carenze','debolezz*','discutibil*','purtroppo','lacunes','faiblesse*','discutable','malheureusement'];
/** Critical wording in a review's title or opening text: a keyword hint, not a reading. */
export function criticalCues(text){
 const words=norm(text).split(' ');
 return CUES.filter(c=>c.endsWith('*')?words.some(w=>w.startsWith(c.slice(0,-1))):words.includes(c)).map(c=>c.replace('*','…'));
}
/** Keep the works that are reviews of, or responses to, r; newest first. */
export function classifyReviews(r,works){
 const want=norm(reviewTitle(r)),self=r.openalexId?String(r.openalexId).split('/').pop():'',authors=new Set(r.authors.map(a=>norm(a).split(' ').pop()).filter(Boolean)),seen=new Set(),out=[];
 for(const w of works||[]){
  const id=String(w.id||'').split('/').pop(),title=clean(w.title,400),nt=norm(title),dupKey=`${nt}|${w.publication_year||''}`;
  if(!title||id===self||seen.has(id)||seen.has(dupKey)||(r.doi&&String(w.doi||'').toLowerCase().endsWith(r.doi.toLowerCase())))continue;
  const by=(w.authorships||[]).map(a=>norm(a.author?.display_name).split(' ').pop()),sameAuthor=by.some(a=>authors.has(a));
  const mentions=want&&nt.includes(want),namesAuthor=[...authors].some(a=>a&&nt.includes(a));
  const bookLike=['book','chapter'].includes(r.type),src=w.primary_location?.source||{},journal=src.type==='journal';
  // A review is never itself a book, chapter or thesis.
  const canReview=!['book','book-chapter','dissertation'].includes(w.type);
  // Journals title many reviews with the bare book title, sometimes followed by its publication details.
  const exact=nt===want,biblioTail=nt.startsWith(want)&&/\b(by|press|university|pp|pages|isbn|hardback|paperback|cloth|edited|eds?)\b/.test(nt.slice(want.length));
  let kind='';
  // A response must name the work (its title or its authors), not merely cite it.
  if(RESPONSE_MARK.test(title)&&(mentions||namesAuthor))kind=/^(erratum|errata|correction|corrigendum)/i.test(title)?'Correction':/^(retraction|expression of concern)/i.test(title)?'Retraction notice':'Response';
  else if(canReview&&w.type==='book-review'&&(mentions||namesAuthor))kind='Review';
  // "Review" wording counts only when the book's title opens the candidate's title (after a
  // "Review of:" style prefix) or its author is named; literature reviews are not book reviews.
  else if(canReview&&mentions&&!sameAuthor&&(namesAuthor||(REVIEW_MARK.test(title)&&!LIT_REVIEW.test(title)&&nt.indexOf(want)<=24)))kind='Review';
  else if(canReview&&bookLike&&journal&&!sameAuthor&&!LIT_REVIEW.test(title)&&(exact||biblioTail||(/review/i.test(src.display_name||'')&&nt.startsWith(want)&&nt.length<=want.length+60)))kind='Review';
  if(!kind)continue;
  if(r.year&&w.publication_year&&w.publication_year<r.year-1)continue;
  seen.add(id);seen.add(dupKey);
  const excerpt=(restoreAbstract(w.abstract_inverted_index)||clean(w.abstract,5000)).slice(0,700),doi=clean(w.doi||'',200).replace(/^https?:\/\/doi\.org\//i,'');
  out.push({id,kind,title,year:Number(w.publication_year)||null,venue:clean(src.display_name,200),authors:(w.authorships||[]).map(a=>clean(a.author?.display_name,80)).filter(Boolean).slice(0,3),
   url:doi?`https://doi.org/${doi}`:w.primary_location?.landing_page_url||w.id,free:w.best_oa_location?.pdf_url||w.open_access?.oa_url||'',excerpt,cues:criticalCues(`${title} ${excerpt}`)});
 }
 const rank={'Retraction notice':0,Correction:1,Response:2,Review:3};
 return out.sort((a,b)=>rank[a.kind]-rank[b.kind]||(b.year||0)-(a.year||0)).slice(0,20);
}

// ---- BibTeX and CSV ---------------------------------------------------------------
const BIB_TYPE={book:'book',chapter:'incollection',article:'article',review:'article',working:'techreport',thesis:'phdthesis',other:'misc'};
const bibEscape=v=>String(v??'').replace(/([{}\\])/g,'\\$1').replace(/[&%$#_]/g,'\\$&');
export function bibKey(r){return`${norm(r.authors[0]||'anon').split(' ').pop()||'anon'}${r.year||'nd'}${norm(r.title).split(' ').find(w=>w.length>3)||'work'}`;}
export function toBibtex(r){
 const f=[['title',r.title],['author',r.authors.join(' and ')],['year',r.year],[r.type==='chapter'?'booktitle':r.type==='article'||r.type==='review'?'journal':'',r.venue],['publisher',['book','chapter'].includes(r.type)?r.publisher:''],['institution',r.type==='working'?r.publisher||r.venue:''],['school',r.type==='thesis'?r.publisher||r.venue:''],['volume',r.biblio?.volume],['number',r.biblio?.issue],['pages',(r.biblio?.pages||'').replace('–','--')],['doi',r.doi],['isbn',r.isbn],['url',r.url],['abstract',r.abstract]];
 return`@${BIB_TYPE[r.type]||'misc'}{${bibKey(r)},\n${f.filter(([k,v])=>k&&v).map(([k,v])=>`  ${k} = {${bibEscape(v)}}`).join(',\n')}\n}\n`;
}
export function toCsv(rows){
 const cols=['title','authors','year','type','venue','publisher','doi','url','score','citations','language','status','note','reviews'];
 const cell=v=>{const s=Array.isArray(v)?v.join('; '):String(v??'');return/[",\n;]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
 return[cols.join(','),...rows.map(r=>cols.map(c=>cell(c==='reviews'?(r.reviews||[]).map(x=>`${x.kind}: ${x.venue||x.title} ${x.year||''}`.trim()):r[c])).join(','))].join('\n')+'\n';
}

// ---- refining a search ------------------------------------------------------------
// Before searching a broad term ("venice"), OpenAlex can say how its literature splits:
// by research topic and by keyword (which include periods such as "16th century").
export function suggestionUrls(query,{key='',from='',to='',fields=[]}={}){
 const filter=baseFilters({from,to,fields}).join(',');
 // Counts are over every match, so a multi-word term is searched as a phrase; otherwise
 // "state capacity" would also count everything about any "state" or any "capacity".
 const phrase=/["()]|\b(AND|OR|NOT)\b/.test(query)||!/[\s-]/.test(query.trim())?query:`"${query.trim()}"`;
 return['primary_topic.id','keywords.id'].map(group=>{const params=new URLSearchParams({search:phrase,filter,group_by:group});if(key)params.set('api_key',key);return`${OPENALEX}?${params}`;});
}
const ORDINAL=/^(\d{1,2})(?:st|nd|rd|th) century$/i;
const NAMED_PERIODS=[[/holy roman empire/i,11],[/prehistor/i,-50],[/bronze age|iron age/i,-10],[/classical antiquity|ancient (rome|greece|history)|antiquity|roman empire|roman republic/i,0],[/late antiquity/i,4],[/early middle ages|early medieval/i,7],[/carolingian/i,8],[/crusade/i,11.5],[/high middle ages|middle ages|medieval/i,12],[/late middle ages|late medieval/i,14.5],[/renaissance/i,15],[/reformation|counter-reformation/i,16.3],[/early modern/i,16.5],[/thirty years/i,16.9],[/baroque/i,17],[/enlightenment/i,18],[/french revolution/i,18.8],[/napoleonic/i,18.95],[/risorgimento|unification of italy/i,19.5],[/industrial revolution/i,19],[/victorian/i,19.6],[/world war i\b|first world war|great war/i,20.15],[/interwar|fascis|nazi/i,20.3],[/world war ii|second world war|holocaust/i,20.42],[/cold war/i,20.7],[/post-?war/i,20.5],[/decoloni/i,20.6],[/contemporary history|twenty-first century/i,21]];
/** Where a keyword sits in time, in centuries (16.5 = mid-16th century), or null. */
export function periodOrder(name){
 const m=String(name).trim().match(ORDINAL);if(m)return Number(m[1])-0.5;
 const hit=NAMED_PERIODS.find(([rx])=>rx.test(name));return hit?hit[1]:null;
}
export function parseSuggestions(query,topicGroups=[],keywordGroups=[],total=0){
 const q=norm(query),words=new Set(q.split(' '));
 const isQuery=name=>{const n=norm(name);return n===q||n.split(' ').every(w=>words.has(w));};
 const themes=topicGroups.filter(g=>g.key&&g.count>0).slice(0,12).map(g=>({id:String(g.key).split('/').pop(),name:g.key_display_name,count:g.count}));
 const kws=keywordGroups.filter(g=>g.key&&g.count>0&&!isQuery(g.key_display_name)).map(g=>({id:String(g.key).split('/').pop(),name:g.key_display_name,count:g.count,order:periodOrder(g.key_display_name)}));
 const periods=kws.filter(k=>k.order!==null).slice(0,12).sort((a,b)=>a.order-b.order);
 const related=kws.filter(k=>k.order===null).slice(0,12);
 return{query,total,themes,periods,related};
}

// ---- Crossref as the search engine ---------------------------------------------------
// Crossref has no daily allowance (about 3 requests a second), so it does the searching.
// OpenAlex then enriches the results by DOI in batches of 50, a "list" request that costs
// a tenth of an OpenAlex search, adding field-normalised citations, subjects, keywords,
// open-access links and abstracts. Refinement suggestions come from those enriched results.
export const CROSSREF='https://api.crossref.org/works';
const CR_TYPES='type:journal-article,type:book,type:monograph,type:edited-book,type:reference-book,type:book-chapter,type:posted-content,type:report,type:dissertation';
const CR_SELECT='DOI,title,subtitle,type,author,editor,container-title,publisher,published,issued,is-referenced-by-count,ISBN,abstract,volume,issue,page,score';
const CR_TYPE_OF={'journal-article':'article',book:'book',monograph:'book','edited-book':'book','reference-book':'book','book-chapter':'chapter','posted-content':'working',report:'working',dissertation:'thesis'};
export function crossrefUrls(query,{from='',to='',page=1,rows=100}={}){
 const filter=[CR_TYPES,from&&`from-pub-date:${Number(from)}`,to&&`until-pub-date:${Number(to)}`].filter(Boolean).join(',');
 const url=(f,n,offset)=>`${CROSSREF}?${new URLSearchParams({'query.bibliographic':query,filter:f,rows:String(n),offset:String(offset),select:CR_SELECT})}`;
 if(page>1)return[url(filter,rows,(page-1)*rows)];
 // Crossref's ranking favours book chapters, so books and journal articles also get a query of their own.
 return[url(filter,rows,0),url(filter.replace(CR_TYPES,'type:book,type:monograph,type:edited-book,type:book-chapter'),40,0),url(filter.replace(CR_TYPES,'type:journal-article'),40,0)];
}
// Crossref titles and abstracts can carry HTML/JATS markup and entities.
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
const decode=v=>String(v||'').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e)=>e[0]==='#'?String.fromCodePoint(parseInt(e.slice(e[1]==='x'||e[1]==='X'?2:1),e[1]==='x'||e[1]==='X'?16:10)):ENTITIES[e.toLowerCase()]??m);
const plain=v=>decode(decode(String(v||'')).replace(/<[^>]+>/g,' ')).replace(/<[^>]+>/g,' ');
const stripTags=v=>clean(plain(v).replace(/^\s*abstract\s*/i,''),5000);
const crPerson=p=>clean(p?.name||[p?.given,p?.family].filter(Boolean).join(' '),120);
export function normalizeCrossref(item){
 const doi=clean(item.DOI,200).toLowerCase(),type=CR_TYPE_OF[item.type]||'other';
 const year=(item.published||item.issued)?.['date-parts']?.[0]?.[0];
 const people=(item.author?.length?item.author:item.editor||[]).map(crPerson).filter(Boolean);
 return{
  id:`doi:${doi}`,source:'crossref',openalexId:'',
  title:clean([item.title?.[0],item.subtitle?.[0]].filter(Boolean).map(plain).join(': '),400),
  authors:people.slice(0,12),orcids:(item.author||[]).filter(a=>a.ORCID).length,year:Number(year)||null,type,rawType:item.type||'',
  venue:clean(item['container-title']?.[0],200),venueType:type==='article'?'journal':type==='working'?'repository':'',publisher:clean(item.publisher,200),inCore:false,inDoaj:false,
  doi,url:`https://doi.org/${doi}`,abstract:stripTags(item.abstract),language:clean(item.language,8),field:'',fieldId:'',subfield:'',topic:'',topicId:'',keywords:[],
  citations:Number(item['is-referenced-by-count'])||0,percentile:null,top10:false,top1:false,fwci:null,retracted:false,oaStatus:'closed',
  biblio:{volume:clean(item.volume,20),issue:clean(item.issue,20),pages:clean(item.page,30).replace('-','–')},isbn:clean((item.ISBN||[])[0],20).replace(/-/g,''),links:[],relevance:Number(item.score)||0
 };
}
/** OpenAlex "list by DOI" requests for a set of records, 50 DOIs each. */
export function enrichUrls(records,{key=''}={}){
 const dois=[...new Set(records.filter(r=>r.doi&&!r.openalexId).map(r=>r.doi.toLowerCase()).filter(d=>!/[|,]/.test(d)))],urls=[];
 for(let i=0;i<dois.length;i+=50){const params=new URLSearchParams({filter:`doi:${dois.slice(i,i+50).join('|')}`,per_page:'50',select:`${SELECT},keywords`});if(key)params.set('api_key',key);urls.push(`${OPENALEX}?${params}`);}
 return urls;
}
/** Fill Crossref records with what OpenAlex knows about the same DOI, then rescore. */
export function applyEnrichment(records,works){
 const byDoi=new Map((works||[]).map(w=>[clean(w.doi,200).replace(/^https?:\/\/doi\.org\//i,'').toLowerCase(),w]));
 return records.map(r=>{
  const w=r.doi&&byDoi.get(r.doi.toLowerCase());if(!w)return r;
  const oa=normalizeOpenAlex(w),topic=w.primary_topic||{};
  const merged={...r,openalexId:oa.openalexId,percentile:oa.percentile,top10:oa.top10,top1:oa.top1,fwci:oa.fwci,retracted:oa.retracted,oaStatus:oa.oaStatus,
   field:oa.field,fieldId:String(topic.field?.id||'').split('/').pop(),subfield:oa.subfield,topic:oa.topic,topicId:String(topic.id||'').split('/').pop(),
   keywords:(w.keywords||[]).map(k=>({id:String(k.id).split('/').pop(),name:clean(k.display_name,80)})).filter(k=>k.id),
   abstract:r.abstract||oa.abstract,language:r.language||oa.language,authors:r.authors.length?r.authors:oa.authors,orcids:Math.max(r.orcids,oa.orcids),
   citations:Math.max(r.citations,oa.citations),venueType:oa.venueType||r.venueType,inCore:oa.inCore,inDoaj:oa.inDoaj,publisher:r.publisher||oa.publisher,venue:r.venue||oa.venue,
   links:[...oa.links,...r.links.filter(l=>!oa.links.some(x=>x.url===l.url))]};
  return{...merged,...withScore(merged)};
 });
}
const STOP=new Set('a an and are as at be by de del della di du e el en et for from il in is la las le les los of on or per the to un una und von with'.split(' '));
/** Share of the query's words found in a title, and whether the whole phrase is there. */
const stem=w=>w.replace(/ies$/,'y').replace(/([^s])s$/,'$1');
export function titleMatch(query,title){
 const q=norm(query),raw=q.split(' ').filter(w=>w&&!STOP.has(w)),words=[...new Set(raw.map(stem))];
 if(!words.length)return{coverage:1,phrase:true};
 const have=new Set(norm(title).split(' ').map(stem));
 return{coverage:words.filter(w=>have.has(w)).length/words.length,phrase:raw.length>1&&` ${norm(title)} `.includes(` ${q} `)};
}
/**
 * Best match for the Crossref engine: Crossref's text relevance, weighted by how much of
 * the query the title carries (the exact phrase counts extra) and by citations. Open Library
 * books have no relevance score and loose matching, so those whose titles carry under half
 * of the query are dropped.
 */
export function rankBestMatch(records,query=''){
 const top=Math.max(1,...records.map(r=>r.relevance||0));
 const scored=records.map((r,i)=>{
  const m=titleMatch(query,`${r.title} ${r.source==='crossref'&&r.type==='chapter'?r.venue:''}`);
  // A multi-word query found only as scattered words is a weaker match than the phrase.
  const multi=norm(query).split(' ').filter(w=>w&&!STOP.has(w)).length>1;
  const rel=r.source==='openlibrary'?0.75:(r.relevance||0)/top,boost=(0.3+0.7*m.coverage)*(m.phrase?1.6:multi?0.75:1);
  return{r,i,m,k:rel*boost*(1+0.35*Math.log10(1+(r.citations||r.editions||0)))};
 }).filter(x=>!(x.r.source==='openlibrary'&&query&&x.m.coverage<0.5));
 return scored.sort((a,b)=>(b.k-a.k)||(a.i-b.i)).map(x=>x.r);
}
/** Keep records in the chosen OpenAlex fields; records OpenAlex could not place are kept. */
export function inFields(r,fields=[]){
 const ids=new Set((fields||[]).flatMap(f=>String(f).split('|')));
 return!ids.size||!r.fieldId||ids.has(r.fieldId);
}
// Periods named in titles ("…, 1498–1600", "c. 1450") become century keywords too.
const ordinal=n=>`${n}${n%100>=11&&n%100<=13?'th':['th','st','nd','rd'][n%10]||'th'}`;
export function titleCenturies(title){
 const out=new Set(),t=String(title||'');
 for(const m of t.matchAll(/\b(1[0-9]{3})\s*[–-]\s*(1[0-9]{3}|[0-9]{2})\b/g)){const a=Number(m[1]),b=Number(m[2].length===2?m[1].slice(0,2)+m[2]:m[2]);if(b>=a&&b-a<400)for(let c=Math.floor(a/100)+1;c<=Math.floor((b-1)/100)+1;c++)out.add(c);}
 for(const m of t.matchAll(/\b(?:c\.|ca\.|circa|in|around|after|before)\s*(1[0-9]{3})\b/gi))out.add(Math.floor(Number(m[1])/100)+1);
 return[...out].map(c=>({id:`${ordinal(c)}-century`,name:`${ordinal(c)} century`}));
}
/** Refinement suggestions from the fetched results themselves: no extra requests. */
export function poolSuggestions(query,records,total=records.length){
 const topics=new Map(),kws=new Map();
 for(const r of records){
  if(r.topicId){const t=topics.get(r.topicId)||{key:r.topicId,key_display_name:r.topic,count:0};t.count++;topics.set(r.topicId,t);}
  const seen=new Set();
  for(const k of [...(r.keywords||[]),...titleCenturies(r.title)]){if(seen.has(k.id))continue;seen.add(k.id);const e=kws.get(k.id)||{key:k.id,key_display_name:k.name,count:0};e.count++;kws.set(k.id,e);}
 }
 const sorted=m=>[...m.values()].filter(x=>x.count>=2).sort((a,b)=>b.count-a.count);
 return{...parseSuggestions(query,sorted(topics),sorted(kws),total),pool:records.length};
}
export function refineMatch(r,{themes=[],periods=[],related=[]}={}){
 const kw=new Set([...(r.keywords||[]).map(k=>k.id),...titleCenturies(r.title).map(k=>k.id)]);
 return(!themes.length||themes.some(t=>t.id===r.topicId))&&(!periods.length||periods.some(p=>kw.has(p.id)))&&(!related.length||related.some(x=>kw.has(x.id)));
}
// Book reviews in Crossref: a free title search, shaped like OpenAlex works for classifyReviews.
export function crossrefReviewUrl(r){
 const title=reviewTitle(r);if(norm(title).length<12)return'';
 return`${CROSSREF}?${new URLSearchParams({'query.title':title,rows:'40',filter:'type:journal-article,type:book-chapter,type:other',select:'DOI,title,type,author,container-title,published,issued,abstract'})}`;
}
export function crossrefAsWork(item){
 const doi=clean(item.DOI,200).toLowerCase();
 return{id:`doi:${doi}`,doi:`https://doi.org/${doi}`,title:clean(plain(item.title?.[0]),400),type:item.type==='journal-article'?'article':item.type,publication_year:(item.published||item.issued)?.['date-parts']?.[0]?.[0]||null,
  authorships:(item.author||[]).map(a=>({author:{display_name:crPerson(a)}})),primary_location:{landing_page_url:`https://doi.org/${doi}`,source:{display_name:clean(item['container-title']?.[0],200),type:item.type==='journal-article'?'journal':''}},abstract:stripTags(item.abstract)};
}
