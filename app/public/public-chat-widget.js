/*!
 * Excellence AI — nyilvános asszisztens widget (#1016 D9).
 * Beépítés:
 *   <script src="https://<platform>/public-chat-widget.js" data-slug="<slug>" async></script>
 * Opciók (data-*): data-color="#2563eb", data-position="right|left", data-label="Kérdésed van?"
 * Kontextus (megbízhatatlan információ, ≤ 8 kB): window.ExcellenceChat = { context: { ... } }
 * vagy később: window.ExcellenceChat.setContext({ ... }).
 */
(function () {
  var script = document.currentScript
  if (!script || !script.dataset.slug || window.__excellenceChatLoaded) return
  window.__excellenceChatLoaded = true
  var base = new URL(script.src).origin
  var slug = script.dataset.slug
  var color = /^#[0-9a-fA-F]{6}$/.test(script.dataset.color || '') ? script.dataset.color : '#2563eb'
  var left = script.dataset.position === 'left'
  var label = script.dataset.label || 'Kérdésed van?'
  var api = (window.ExcellenceChat = window.ExcellenceChat || {})
  var frame = null
  var ready = false
  var open = false

  function defaultContext() {
    return { pageUrl: location.href, pageTitle: document.title }
  }
  function sendContext() {
    if (!frame || !ready) return
    var ctx = Object.assign(defaultContext(), api.context || {})
    frame.contentWindow.postMessage({ type: 'excellence-chat:context', context: ctx }, base)
  }
  api.setContext = function (ctx) {
    api.context = ctx || {}
    sendContext()
  }

  var side = left ? 'left:20px' : 'right:20px'
  var button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.title = label
  button.style.cssText =
    'position:fixed;bottom:20px;' + side + ';z-index:2147483646;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.2);background:' + color + ';color:#fff;font-size:26px;line-height:56px;padding:0'
  button.textContent = '💬'

  var panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;bottom:88px;' + side + ';z-index:2147483647;width:min(380px,calc(100vw - 24px));height:min(600px,calc(100vh - 110px));' +
    'border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#fff;display:none'

  function toggle() {
    open = !open
    if (open && !frame) {
      frame = document.createElement('iframe')
      frame.src = base + '/c/' + encodeURIComponent(slug)
      frame.title = label
      frame.style.cssText = 'width:100%;height:100%;border:0'
      frame.setAttribute('allow', 'clipboard-write')
      panel.appendChild(frame)
    }
    panel.style.display = open ? 'block' : 'none'
    button.textContent = open ? '✕' : '💬'
  }
  button.addEventListener('click', toggle)
  window.addEventListener('message', function (e) {
    if (e.origin !== base || !e.data || e.data.type !== 'excellence-chat:ready') return
    ready = true
    sendContext()
  })

  function mount() {
    document.body.appendChild(panel)
    document.body.appendChild(button)
  }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)
})()
