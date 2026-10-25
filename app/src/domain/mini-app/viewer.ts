/**
 * MCP Apps néző (#967 §3.8/2, WP-6c): `ui://mini-app/viewer`.
 *
 * A kliens (pl. Claude Desktop / claude.ai) ezt a saját sandboxolt keretében
 * jeleníti meg a tool-eredmény mellett. A néző a tool-eredményből kiolvassa a
 * gyors linket, és a platform keretoldalát (információs sáv + izolált app)
 * tölti be. Lejárt linknél a „Frissítés" gomb a kliensen át újra meghívja a
 * `platform.mini_app.get`-et. Agent-tartalom ide nem kerül.
 *
 * Protokoll: JSON-RPC 2.0 postMessage-en (MCP Apps, SEP-1865): `ui/initialize` →
 * `ui/notifications/initialized`; a host `ui/notifications/tool-result`-ot küld;
 * a néző `tools/call`-t és `ui/open-link`-et kérhet.
 * ponytail: a pontos mezőneveket élő kliensen kell igazolni (spec §3.8) — nem
 * támogató kliensnél a tool-válasz linkje marad, semmi nem törik.
 */
import { miniAppOrigin } from '@/lib/mini-app-origin'

export function miniAppViewerResourceMeta() {
  return {
    ui: {
      csp: { frameDomains: [miniAppOrigin()], connectDomains: [], resourceDomains: [] },
      prefersBorder: true,
    },
  }
}

export const MINI_APP_VIEWER_HTML = `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mini app</title>
<style>
  html,body{margin:0;height:100%;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2933;background:#fff}
  body{display:flex;flex-direction:column;min-height:480px}
  .tools{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid #e4e7eb;font-size:12px;color:#52606d}
  .tools button{font:inherit;border:1px solid #cbd2d9;background:#fff;border-radius:6px;padding:3px 10px;cursor:pointer}
  .tools .spacer{flex:1}
  iframe{flex:1;border:0;width:100%;min-height:440px}
  .empty{padding:24px;color:#52606d}
  .expired{padding:24px}
  .expired button{background:#e4572e;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
</style>
</head>
<body>
<div class="tools" id="tools" hidden>
  <span id="status"></span><span class="spacer"></span>
  <button type="button" id="refresh">Frissítés</button>
  <button type="button" id="open">Megnyitás böngészőben</button>
</div>
<div id="main" class="empty">A mini app betöltése…</div>
<script>
(function(){
  var nextId = 1, pending = {}, state = { appId: null, openUrl: null, permanentUrl: null, expiresAt: 0 };
  function send(msg){ window.parent.postMessage(msg, '*'); }
  function request(method, params){
    var id = nextId++;
    send({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    return new Promise(function(resolve, reject){ pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params){ send({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function parseResult(result){
    var content = (result && result.content) || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i] && content[i].type === 'text') {
        try { var data = JSON.parse(content[i].text); if (data && (data.openUrl || data.appId)) return data; } catch (e) {}
      }
    }
    return null;
  }
  function render(){
    var main = document.getElementById('main');
    var tools = document.getElementById('tools');
    if (!state.openUrl) { main.className = 'empty'; main.textContent = 'Ehhez a válaszhoz nem tartozik megnyitható mini app.'; tools.hidden = true; return; }
    tools.hidden = false;
    if (Date.now() > state.expiresAt) {
      document.getElementById('status').textContent = 'A gyors link lejárt.';
      main.className = 'expired';
      main.innerHTML = '<p><strong>A megnyitási link lejárt.</strong> Egy kattintással új linket kérhetsz.</p><p><button type="button" id="refresh2">Frissítés</button></p>';
      document.getElementById('refresh2').onclick = refresh;
      return;
    }
    document.getElementById('status').textContent = 'Gyors link érvényes: ' + new Date(state.expiresAt).toLocaleString('hu-HU');
    main.className = '';
    main.innerHTML = '';
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = 'Mini app';
    frame.src = state.openUrl;
    main.appendChild(frame);
  }
  function apply(data){
    if (!data) return;
    state.appId = data.appId || (data.app && data.app.appId) || state.appId;
    state.openUrl = data.openUrl || state.openUrl;
    state.permanentUrl = data.permanentUrl || state.permanentUrl;
    state.expiresAt = data.openUrlExpiresAt ? Date.parse(data.openUrlExpiresAt) : state.expiresAt;
    render();
  }
  function refresh(){
    if (!state.appId) return;
    document.getElementById('status').textContent = 'Új link kérése…';
    request('tools/call', { name: 'platform.mini_app.get', arguments: { appId: state.appId, include: 'link' } })
      .then(function(result){ apply(parseResult(result)); })
      .catch(function(){ document.getElementById('status').textContent = 'Nem sikerült új linket kérni — kérd meg az AI munkatársat.'; });
  }
  document.getElementById('refresh').onclick = refresh;
  document.getElementById('open').onclick = function(){
    var url = Date.now() > state.expiresAt ? state.permanentUrl : state.openUrl;
    if (url) request('ui/open-link', { url: url }).catch(function(){ window.open(url, '_blank', 'noopener'); });
  };
  window.addEventListener('message', function(event){
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && pending[msg.id] && !msg.method) {
      var p = pending[msg.id]; delete pending[msg.id];
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result') apply(parseResult(msg.params));
  });
  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'mini-app-viewer', version: '1.0.0' },
    appCapabilities: {}
  }).then(function(){ notify('ui/notifications/initialized'); }).catch(function(){});
  setInterval(function(){ if (state.openUrl && Date.now() > state.expiresAt && document.querySelector('iframe')) render(); }, 30000);
})();
</script>
</body>
</html>`
