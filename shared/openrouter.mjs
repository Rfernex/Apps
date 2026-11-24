// One OpenRouter transport for every app on this origin (Reading Room, Italiano,
// GRE Quest). The apps keep their own prompts and answer validation; this file
// owns everything between "send these messages" and "here is the model's text":
// pacing, timeouts, retries, falling back to another free model, and turning
// OpenRouter's many failure shapes into a message that says what actually
// happened. No key, prompt or reply is ever written to storage — only a short
// failure log (time, app, model, status, OpenRouter's own error text).

export const API='https://openrouter.ai/api/v1/chat/completions';
export const MODELS_API='https://openrouter.ai/api/v1/models';
export const FREE_ROUTE='openrouter/free';
export const SETTINGS_KEY='reading-room.openrouter.v1';
const LOG_KEY='openrouter.failures.v1',MODELS_KEY='openrouter.free-models.v1',PACE_KEY='openrouter.pace.v1';
const MODELS_TTL=12*3600e3,COOLDOWN=10*60e3,PACE_WINDOW=60e3,PACE_LIMIT=16,LOG_SIZE=40;
const PRIVACY_URL='https://openrouter.ai/settings/privacy';

// Tests swap these out so retries do not sleep for real.
const env={pace:true,sleep:(ms,signal)=>new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(new DOMException('Request cancelled','AbortError'));},{once:true});}),now:()=>Date.now()};
export function configure(overrides={}){Object.assign(env,overrides);}

const memory=new Map();
function store(storage){
 try{if(storage&&typeof storage.getItem==='function'){storage.getItem('x');return storage;}}catch{}
 return{getItem:k=>memory.has(k)?memory.get(k):null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)};
}
function readJson(storage,key,fallback){try{return JSON.parse(store(storage).getItem(key)||'null')??fallback;}catch{return fallback;}}
function writeJson(storage,key,value){try{store(storage).setItem(key,JSON.stringify(value));}catch{}}
const trim=(value,max=300)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
const redact=text=>trim(text,400).replace(/sk-or-[a-z0-9-]+/gi,'[redacted key]');

export function savedToken(storage=globalThis.localStorage){return trim(readJson(storage,SETTINGS_KEY,{})?.token,500);}
export function saveToken(token,storage=globalThis.localStorage){writeJson(storage,SETTINGS_KEY,{...readJson(storage,SETTINGS_KEY,{}),token:trim(token,500)});}

export class OpenRouterError extends Error{
 constructor(message,{kind='unknown',status=0,model='',detail='',retryAt=0,tried=[]}={}){super(message);this.name='OpenRouterError';Object.assign(this,{kind,status,model,detail,retryAt,tried});}
}

// ---- failure log -----------------------------------------------------------
export function recentFailures(storage=globalThis.localStorage){const list=readJson(storage,LOG_KEY,[]);return Array.isArray(list)?list.filter(x=>x&&typeof x==='object'):[];}
export function clearFailures(storage=globalThis.localStorage){try{store(storage).removeItem(LOG_KEY);}catch{}}
function logFailure(storage,entry){const list=recentFailures(storage);list.unshift({at:new Date(env.now()).toISOString(),...entry});writeJson(storage,LOG_KEY,list.slice(0,LOG_SIZE));}

// ---- pacing across apps and tabs ------------------------------------------
// OpenRouter allows about 20 free requests a minute per account. Every app on
// this origin shares the key, so they share one budget kept in localStorage.
async function pace(storage,signal,onProgress){
 if(env.pace===false)return;
 for(;;){
  const now=env.now(),stamps=readJson(storage,PACE_KEY,[]),recent=(Array.isArray(stamps)?stamps:[]).filter(t=>Number.isFinite(t)&&now-t<PACE_WINDOW);
  if(recent.length<PACE_LIMIT){recent.push(now);writeJson(storage,PACE_KEY,recent);return;}
  const wait=Math.max(500,recent[0]+PACE_WINDOW-now);
  onProgress(`Pacing requests to stay under the free per-minute limit · ${Math.ceil(wait/1000)}s`);
  await env.sleep(Math.min(wait,5000),signal);
 }
}

// ---- fallback models --------------------------------------------------------
const PREFERRED=['deepseek','qwen3','qwen','gemma-4','gemma','llama-4','llama','nemotron-3-ultra','nemotron-3-super','gpt-oss','glm','kimi','mistral'];
const EXCLUDED=/content-safety|guard|lyria|embed|tts|whisper|rerank|lfm-2\.5-2|\bxs\b|mini-code|thinkingmachines\/inkling/i;
export function rankFreeModels(list,{images=false,minContext=32000}={}){
 const score=id=>{const i=PREFERRED.findIndex(p=>id.includes(p));return i<0?PREFERRED.length:i;};
 return list.filter(m=>m&&/:free$/.test(m.id)&&!EXCLUDED.test(m.id)&&(m.context||0)>=minContext&&(m.output||['text']).includes('text')&&(!images||(m.input||[]).includes('image')))
  .sort((a,b)=>score(a.id)-score(b.id)||(b.context||0)-(a.context||0)).map(m=>m.id);
}
async function freeModels(storage,fetcher,signal){
 const cached=readJson(storage,MODELS_KEY,null);
 if(cached&&env.now()-cached.at<MODELS_TTL&&Array.isArray(cached.models))return cached.models;
 const fallback=Array.isArray(cached?.models)?cached.models:[];
 try{
  // The list is only a nicety: give up after a few seconds rather than stall.
  const controller=new AbortController(),stop=()=>controller.abort(),timer=setTimeout(stop,6000);
  signal?.addEventListener('abort',stop,{once:true});
  const late=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve(null),{once:true}));
  let data;
  try{data=await Promise.race([late,(async()=>{const response=await fetcher(MODELS_API,{credentials:'omit',cache:'no-store',signal:controller.signal});return response?.ok?response.json():null;})()]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
  if(signal?.aborted)throw new DOMException('Request cancelled','AbortError');
  if(!data)return fallback;
  const models=(data?.data||[]).filter(m=>String(m?.pricing?.prompt)==='0'&&String(m?.pricing?.completion)==='0')
   .map(m=>({id:m.id,context:m.context_length||0,input:m.architecture?.input_modalities||['text'],output:m.architecture?.output_modalities||['text']}));
  writeJson(storage,MODELS_KEY,{at:env.now(),models});
  return models;
 }catch(error){if(signal?.aborted)throw error;return fallback;}
}
const cooling=new Map();
function cool(model){if(model&&model!==FREE_ROUTE)cooling.set(model,env.now()+COOLDOWN);}
const isCool=model=>(cooling.get(model)||0)>env.now();

// ---- classifying an OpenRouter answer --------------------------------------
function resetTime(headers,error){
 const raw=Number(headers?.get?.('X-RateLimit-Reset')||error?.metadata?.headers?.['X-RateLimit-Reset']||0);
 if(raw>1e12)return raw;if(raw>1e9)return raw*1000;
 const after=Number(headers?.get?.('Retry-After')||0);return after>0?env.now()+after*1000:0;
}
export function classify(status,error,headers){
 const message=trim(error?.message||'',400),raw=trim(error?.metadata?.raw||'',300),text=`${message} ${raw}`,provider=trim(error?.metadata?.provider_name||'',60);
 // Retry a 401 only when OpenRouter explicitly attributes it to a provider.
 // "Missing Authentication header" alone is also OpenRouter's own 401 text.
 if(status===401&&provider)return{kind:'provider-auth',next:true};
 if(status===401)return{kind:'auth',fatal:true};
 if(status===402)return{kind:'credits',fatal:true};
 if(status===403&&/key|disabled|unauthori[sz]ed/i.test(text)&&!/flag|moderat/i.test(text))return{kind:'auth',fatal:true};
 if(status===403&&/content.filter|moderat|flagged|unsafe/i.test(text))return{kind:'moderation',next:true};
 if(status===403)return{kind:'restricted',next:true};
 if(status===404&&/data policy|privacy|training/i.test(text))return{kind:'policy',next:true};
 if(status===404)return{kind:'unavailable',next:true};
 if(status===429){
  if(/per.?day|daily|free-models-per-day|requests\/day|24.?hour/i.test(text))return{kind:'daily',fatal:true,retryAt:resetTime(headers,error)};
  if(provider||/upstream|provider|temporarily/i.test(text))return{kind:'upstream',next:true};
  return{kind:'minute',wait:true,retryAt:resetTime(headers,error)};
 }
 if(status===400&&/context|too long|maximum.*tokens|max_tokens|token limit/i.test(text))return{kind:'too-long',next:true,shrink:true};
 if(status===400)return{kind:'rejected',next:true,simplify:true};
 if(status===408||status===499||status>=500)return{kind:'server',next:true};
 return{kind:'unknown',next:true};
}
function when(ms){if(!ms)return'';try{return new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}catch{return'';}}
export function explain(kind,{detail='',retryAt=0,tried=[]}={}){
 const triedText=tried.length>1?` Tried ${tried.length} models: ${tried.join(', ')}.`:'';
 const quoted=detail?` OpenRouter said: “${detail}”`:'';
 switch(kind){
  case'missing-key':return'Add your OpenRouter key in Settings first (it is shared by Reading Room, Italiano and GRE Quest).';
  case'auth':return`OpenRouter rejected the key saved in this browser. Replace it in Reading Room → Settings and run “Check API key” before retrying.${quoted}`;
  case'provider-auth':return`A free model provider reported an authentication error, despite the app sending your OpenRouter key. Your saved key is not known to be invalid; try again later.${triedText}${quoted}`;
  case'credits':return`OpenRouter refused the request for billing reasons (402). A negative balance blocks even free models; check openrouter.ai/credits.${quoted}`;
  case'daily':return`The free daily allowance is used up for this key (50 requests a day, or 1,000 once the account has bought at least $10 of credits). It is shared by all your apps.${retryAt?` It resets around ${when(retryAt)}.`:' It resets at midnight UTC.'}`;
  case'minute':return`OpenRouter’s per-minute limit kept refusing requests even after waiting.${retryAt?` Try again after ${when(retryAt)}.`:' Wait a minute, then try again.'}${quoted}`;
  case'upstream':return`Every free model tried was busy at its provider (upstream rate limit). This is on their side, not your key; try again in a few minutes.${triedText}`;
  case'policy':return`Your OpenRouter privacy settings block the free models. Free endpoints require “Enable free endpoints that may publish prompts” / model training to be allowed at ${PRIVACY_URL}.${quoted}`;
  case'moderation':return`A model’s content filter refused this request. Another free model may accept it.${triedText}${quoted}`;
  case'restricted':return`A free model refused this app or account (403); this does not mean your exercise was flagged. No eligible fallback answered.${triedText}${quoted}`;
  case'unavailable':return`No free model was available for this request right now (404).${triedText}${quoted}`;
  case'too-long':return`The request was too long for the free models available.${quoted}`;
  case'rejected':return`The free models rejected this request (400).${triedText}${quoted}`;
  case'server':return`OpenRouter or its providers had a server error.${triedText} Try again shortly.${quoted}`;
  case'network':return'OpenRouter could not be reached. Check your connection and try again.';
  case'timeout':return`The free models did not answer in time.${triedText} Try again.`;
  case'empty':return`The free models returned no usable answer.${triedText} Try again.`;
  default:return`OpenRouter returned an unexpected error.${triedText}${quoted}`;
 }
}
function completionText(message){
 const content=message?.content;
 if(typeof content==='string')return content;
 if(Array.isArray(content))return content.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n');
 return'';
}

// ---- the request -----------------------------------------------------------
/**
 * Send one chat completion with retries and model fallback.
 * Resolves {content, model, finishReason, tried}. A reply cut off by the length
 * limit is returned (finishReason 'length') so callers can decide; an empty
 * reply is retried on another model. Rejects with OpenRouterError.
 */
export async function chat({
 token,messages,model=FREE_ROUTE,temperature=0.2,maxTokens=4096,reasoning={effort:'low',exclude:true},
 responseFormat=null,provider=null,images=false,app='app',referer='',title='',
 signal,timeoutMs=90000,maxAttempts=4,onProgress=()=>{},fetcher=globalThis.fetch,storage=globalThis.localStorage
}={}){
 if(!token)throw new OpenRouterError(explain('missing-key'),{kind:'missing-key'});
 const tried=[];let current=model,lastKind='unknown',lastDetail='',lastStatus=0,lastRetryAt=0,optional={reasoning,responseFormat,provider},budget=maxTokens,waited=0,fallbacks=null,networkRetries=0;
 const headers={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
 if(referer)headers['HTTP-Referer']=referer;if(title)headers['X-Title']=title;
 const nextModel=async()=>{
  if(!fallbacks){
   const minContext=Math.min(64000,Math.ceil(JSON.stringify(messages).length/3)+budget);
   fallbacks=rankFreeModels(await freeModels(storage,fetcher,signal),{images,minContext});
  }
  const fresh=fallbacks.filter(id=>!tried.includes(id)),pick=fresh.find(id=>!isCool(id))||fresh[0];
  return pick||(tried.includes(FREE_ROUTE)?model:FREE_ROUTE);
 };
 for(let attempt=0;attempt<maxAttempts;attempt++){
  if(signal?.aborted)throw new DOMException('Request cancelled','AbortError');
  tried.push(current);
  if(attempt)onProgress(`Retrying with ${current} (attempt ${attempt+1}/${maxAttempts})…`);
  await pace(storage,signal,onProgress);
  const controller=new AbortController(),stop=()=>controller.abort();
  signal?.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(stop,timeoutMs);
  let response,data,status=0;
  try{
   const body={model:current,messages,temperature,max_tokens:budget};
   if(optional.reasoning)body.reasoning=optional.reasoning;
   if(optional.responseFormat)body.response_format=optional.responseFormat;
   if(optional.provider)body.provider=optional.provider;
   // Race the whole exchange against the timer: a provider can stall after
   // sending headers, and a stalled body would otherwise hang forever.
   const stalled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError')),{once:true}));
   stalled.catch(()=>{});
   [response,data]=await Promise.race([stalled,(async()=>{const r=await fetcher(API,{method:'POST',headers,body:JSON.stringify(body),credentials:'omit',cache:'no-store',signal:controller.signal});return[r,await r.json().catch(()=>({}))];})()]);
   status=response.status;
  }catch(error){
   clearTimeout(timer);signal?.removeEventListener('abort',stop);
   if(signal?.aborted)throw error;
   const kind=controller.signal.aborted?'timeout':'network';
   logFailure(storage,{app,model:current,status:0,kind,message:trim(error?.message,160)});
   lastKind=kind;lastDetail='';
   if(kind==='network'&&++networkRetries>2)break;
   await env.sleep(kind==='network'?1500:250,signal);
   current=kind==='timeout'?await nextModel():current;
   continue;
  }
  clearTimeout(timer);signal?.removeEventListener('abort',stop);
  const choice=data?.choices?.[0],error=data?.error||choice?.error;
  const effective=error&&response.ok?Number(error.code)||502:status;
  if(!response.ok||error){
   let verdict=classify(effective,error,response.headers);
   // Errors embedded in a successful OpenRouter response came from a provider.
   if(response.ok&&effective===401)verdict={kind:'provider-auth',next:true};
   // A 429 embedded in a 200 comes from the provider, not from your account.
   if(response.ok&&verdict.kind==='minute')verdict={kind:'upstream',next:true};
   const detail=redact(error?.metadata?.raw||error?.message||data?.message||'');
   logFailure(storage,{app,model:current,served:trim(data?.model,80),status:effective,kind:verdict.kind,message:detail,provider:trim(error?.metadata?.provider_name,60)});
   lastKind=verdict.kind;lastDetail=detail;lastStatus=effective;lastRetryAt=verdict.retryAt||0;
   if(verdict.fatal)break;
   if(verdict.wait){
    const wait=Math.min(Math.max((verdict.retryAt||0)-env.now(),4000*2**Math.min(waited,3)),30000);
    if(waited>=3)break;
    waited++;onProgress(`OpenRouter’s per-minute limit was reached. Waiting ${Math.ceil(wait/1000)}s, then trying again…`);
    await env.sleep(wait,signal);continue;
   }
   if(verdict.simplify&&(optional.reasoning||optional.responseFormat||optional.provider)){optional={};continue;}
   if(verdict.shrink)budget=Math.max(1024,Math.floor(budget/2));
   cool(current);
   await env.sleep(verdict.kind==='server'?1500:400,signal);
   current=await nextModel();
   continue;
  }
  if(choice?.finish_reason==='content_filter'||choice?.message?.refusal){
   logFailure(storage,{app,model:current,served:trim(data?.model,80),status:200,kind:'moderation',message:trim(choice?.message?.refusal||'content_filter',160)});
   lastKind='moderation';lastDetail=trim(choice?.message?.refusal,200);cool(data?.model);current=await nextModel();continue;
  }
  const content=completionText(choice?.message),finishReason=trim(choice?.finish_reason||choice?.native_finish_reason,30);
  if(!content.trim()&&finishReason!=='length'){
   logFailure(storage,{app,model:current,served:trim(data?.model,80),status:200,kind:'empty',message:finishReason||'no content'});
   lastKind='empty';cool(data?.model);current=await nextModel();continue;
  }
  return{content,model:trim(data?.model||current,100),finishReason,tried};
 }
 const distinct=[...new Set(tried)];
 throw new OpenRouterError(explain(lastKind,{detail:lastDetail,retryAt:lastRetryAt,tried:distinct}),{kind:lastKind,status:lastStatus,model:tried.at(-1),detail:lastDetail,retryAt:lastRetryAt,tried:distinct});
}

/** Pull the first JSON object out of a model reply (tolerates code fences and prose). */
export function parseJsonObject(text){
 const value=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 const start=value.indexOf('{'),end=value.lastIndexOf('}');
 if(start<0||end<=start)return null;
 try{return JSON.parse(value.slice(start,end+1));}catch{return null;}
}

/** HTML for a small "recent AI failures" panel any app can drop into Settings. */
export function failuresHtml(storage=globalThis.localStorage,limit=12){
 const esc=x=>String(x??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const rows=recentFailures(storage).slice(0,limit);
 if(!rows.length)return'<p class="or-log-empty">No failed AI requests recorded on this device.</p>';
 return`<ul class="or-log">${rows.map(r=>`<li><b>${esc(new Date(r.at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</b> · ${esc(r.app)} · ${esc(r.kind)}${r.status?` (${esc(r.status)})`:''} · <code>${esc(r.served||r.model)}</code>${r.provider?` via ${esc(r.provider)}`:''}${r.message?`<br><span>${esc(r.message)}</span>`:''}</li>`).join('')}</ul>`;
}
