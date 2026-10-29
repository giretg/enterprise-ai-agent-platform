/**
 * #1016 D9/D11/D18/D19: a nyilvános chat egyetlen oldala (`/c/<slug>`) — önálló HTML, React és Clerk
 * nélkül, hogy idegen oldal iframe-jében is süti nélkül, gyorsan töltsön. A link ezt mutatja teljes
 * oldalon, a widget ugyanezt egy buborék mögötti iframe-ben.
 */
import type { PublicAssistantState } from './service'
import { MAX_VISITOR_MESSAGE_CHARS, SESSION_RETENTION_DAYS } from './config'

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** JSON a `<script>`-be: a `</script>` és a HTML-komment nem törheti meg. */
const jsonForScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

export function publicChatCsp(input: { nonce: string; frameAncestors: string; turnstile: boolean }): string {
  const cf = input.turnstile ? ' https://challenges.cloudflare.com' : ''
  return [
    "default-src 'none'",
    `script-src 'nonce-${input.nonce}'${cf}`,
    `style-src 'nonce-${input.nonce}'`,
    "img-src https: data:",
    "connect-src 'self'",
    `frame-src${cf || " 'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    input.frameAncestors,
  ].join('; ')
}

const STYLE = `
*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;color:#111827;background:#fff}
#app{display:flex;flex-direction:column;height:100%}
header{display:flex;align-items:center;gap:10px;padding:12px 14px;color:#fff;background:var(--c)}
header img{width:32px;height:32px;border-radius:50%;object-fit:cover;background:#fff}
header .name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header button{background:rgba(255,255,255,.18);color:#fff;border:0;border-radius:8px;padding:6px 9px;font-size:13px;cursor:pointer}
.badge{background:#fde68a;color:#78350f;font-size:11px;font-weight:700;padding:2px 6px;border-radius:6px}
#log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f9fafb}
.msg{max-width:85%;padding:9px 12px;border-radius:14px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}
.bot{align-self:flex-start;background:#fff;border:1px solid #e5e7eb}
.me{align-self:flex-end;background:var(--c);color:#fff}
.note{align-self:center;font-size:12px;color:#6b7280;text-align:center;max-width:95%}
.note a{color:inherit}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips button{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:999px;padding:6px 10px;font-size:13px;cursor:pointer}
form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}
textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px 10px;font:inherit;max-height:120px}
form button{background:var(--c);color:#fff;border:0;border-radius:10px;padding:0 14px;font-weight:600;cursor:pointer}
form button:disabled{opacity:.5;cursor:default}
.center{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#374151}
.typing{color:#6b7280;font-style:italic}
`

export function renderPublicChatPage(input: {
  state: PublicAssistantState
  slug: string
  nonce: string
  testToken: string | null
  turnstileSiteKey: string | null
}): string {
  const { state, nonce } = input
  if (state.state !== 'ready') {
    const title = state.state === 'unavailable' ? state.displayName : 'Nem található'
    const body =
      state.state === 'unavailable'
        ? `Az asszisztens most nem érhető el.${state.supportEmail ? ` Írj nekünk ide: <a href="mailto:${esc(state.supportEmail)}">${esc(state.supportEmail)}</a>` : ''}`
        : 'Ez a beszélgetés-link nem él, vagy már megszűnt.'
    return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><div id="app"><div class="center"><div><p><strong>${esc(title)}</strong></p><p>${body}</p></div></div></div></body></html>`
  }
  const boot = {
    slug: input.slug,
    view: state.view,
    isTest: state.isTest,
    testToken: input.testToken,
    turnstileSiteKey: input.turnstileSiteKey,
    maxChars: MAX_VISITOR_MESSAGE_CHARS,
    retentionDays: SESSION_RETENTION_DAYS,
  }
  const turnstile = input.turnstileSiteKey
    ? `<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>`
    : ''
  return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(state.view.displayName)}</title><style nonce="${nonce}">${STYLE}</style>${turnstile}</head><body><div id="app"></div><div id="ts"></div><script nonce="${nonce}">window.__PUBLIC_CHAT__=${jsonForScript(boot)};</script><script nonce="${nonce}">${CLIENT_SCRIPT}</script></body></html>`
}

/** A látogatói kliens: vanilla JS, a szerver `/api/public-chat/<slug>` végpontját hívja. */
const CLIENT_SCRIPT = String.raw`(function(){
var B=window.__PUBLIC_CHAT__,V=B.view,hu=(navigator.language||'hu').toLowerCase().indexOf('hu')===0;
var T=hu?{send:'Küldés',ph:'Írd ide a kérdésed…',fresh:'Új beszélgetés',del:'Törlés',delQ:'Biztosan törlöd a beszélgetést? Nálunk sem marad meg.',deleted:'A beszélgetést töröltük.',typing:'Gépel…',err:'Valami hiba történt. Próbáld újra.',privacy:'A beszélgetést a kérdésed megválaszolásához és '+B.retentionDays+' napig ügyfélszolgálati visszanézéshez tároljuk.',policy:'Adatkezelési tájékoztató',test:'TESZT',handoff:'Továbbítottuk egy munkatársnak — hamarosan jelentkezik.'}
:{send:'Send',ph:'Type your question…',fresh:'New chat',del:'Delete',delQ:'Delete this conversation? We will not keep it either.',deleted:'The conversation was deleted.',typing:'Typing…',err:'Something went wrong. Please try again.',privacy:'We store this conversation to answer you and keep it for '+B.retentionDays+' days for customer-service review.',policy:'Privacy notice',test:'TEST',handoff:'We forwarded this to a colleague — they will contact you soon.'};
var K='exc-chat:'+B.slug+(B.isTest?':test':'')+':',mem={};
function get(k){try{return localStorage.getItem(K+k)}catch(e){return mem[k]||null}}
function set(k,v){try{v===null?localStorage.removeItem(K+k):localStorage.setItem(K+k,v)}catch(e){v===null?delete mem[k]:mem[k]=v}}
function rid(){var a=new Uint8Array(24);crypto.getRandomValues(a);return Array.from(a,function(x){return('0'+x.toString(16)).slice(-2)}).join('')}
var visitor=get('visitor');if(!visitor){visitor=rid();set('visitor',visitor)}
var session=get('session'),context=null,busy=false,tsToken=null,tsId=null;
var app=document.getElementById('app');
function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}
var head=el('header'),av=el('img'),nm=el('div','name'),bNew=el('button',null,T.fresh),bDel=el('button',null,T.del);
av.alt='';head.append(av,nm);if(B.isTest)head.append(el('span','badge',T.test));head.append(bNew,bDel);
var log=el('div');log.id='log';var form=el('form'),ta=el('textarea'),send=el('button',null,T.send);
ta.rows=1;ta.maxLength=B.maxChars;ta.placeholder=T.ph;send.type='submit';form.append(ta,send);app.append(head,log,form);
function paint(){document.documentElement.style.setProperty('--c',V.color);nm.textContent=V.displayName;av.style.display=V.avatarUrl?'':'none';if(V.avatarUrl)av.src=V.avatarUrl;document.title=V.displayName}
function scroll(){log.scrollTop=log.scrollHeight}
function add(role,text){var m=el('div','msg '+(role==='user'?'me':'bot'),text);log.append(m);scroll();return m}
function intro(){log.textContent='';var n=el('div','note',T.privacy+' ');if(V.privacyUrl){var a=el('a',null,T.policy);a.href=V.privacyUrl;a.target='_blank';a.rel='noopener';n.append(a)}log.append(n);if(V.welcome)add('assistant',V.welcome);if(V.suggestions&&V.suggestions.length){var c=el('div','chips');V.suggestions.forEach(function(s){var b=el('button',null,s);b.type='button';b.onclick=function(){c.remove();ask(s)};c.append(b)});log.append(c)}}
function api(body){body.testToken=B.testToken||undefined;return fetch('/api/public-chat/'+encodeURIComponent(B.slug),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){j.__status=r.status;return j})})}
function turnstile(){if(!B.turnstileSiteKey||session)return Promise.resolve(null);if(tsToken)return Promise.resolve(tsToken);
return new Promise(function(res){var tries=0;(function wait(){if(window.turnstile){if(tsId===null)tsId=window.turnstile.render('#ts',{sitekey:B.turnstileSiteKey,execution:'execute',appearance:'interaction-only',callback:function(t){tsToken=t;res(t)},'error-callback':function(){res(null)}});window.turnstile.execute('#ts')}else if(tries++<50)setTimeout(wait,100);else res(null)})()})}
function ask(text){text=(text||'').trim();if(!text||busy)return;busy=true;send.disabled=true;add('user',text);var t=add('assistant',T.typing);t.classList.add('typing');
turnstile().then(function(tok){return api({op:'send',visitorId:visitor,sessionId:session||undefined,message:text,context:context||undefined,turnstileToken:tok||undefined})}).then(function(j){
t.remove();if(j.sessionId){session=j.sessionId;set('session',session)}tsToken=null;
add('assistant',j.reply||j.message||T.err);if(j.handoff)log.append(el('div','note',T.handoff));scroll()}).catch(function(){t.remove();add('assistant',T.err)}).finally(function(){busy=false;send.disabled=false;ta.focus()})}
form.onsubmit=function(e){e.preventDefault();var v=ta.value;ta.value='';ask(v)};
ta.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();form.requestSubmit()}};
bNew.onclick=function(){session=null;set('session',null);intro()};
bDel.onclick=function(){if(!confirm(T.delQ))return;api({op:'delete',visitorId:visitor}).finally(function(){session=null;set('session',null);intro();log.append(el('div','note',T.deleted))})};
window.addEventListener('message',function(e){var d=e.data;if(!d||typeof d!=='object')return;
if(d.type==='excellence-chat:context'&&d.context&&typeof d.context==='object'){context=d.context}
if(d.type==='excellence-chat:preview'&&e.origin===location.origin&&B.isTest&&d.view){V=Object.assign({},V,d.view);paint();if(!session)intro()}});
paint();intro();
if(session){api({op:'history',visitorId:visitor,sessionId:session}).then(function(j){if(j.sessionId&&j.messages&&j.messages.length){intro();j.messages.forEach(function(m){add(m.role,m.content)})}else{session=null;set('session',null)}})}
var embed='';try{embed=window.top!==window?(document.referrer||''):location.origin}catch(e){embed=document.referrer||''}
api({op:'ping',embedOrigin:embed});
if(window.parent!==window)window.parent.postMessage({type:'excellence-chat:ready'},'*');
})();`
