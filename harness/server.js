'use strict';
/**
 * ローカル実行サーバ。gas/Code.gs と gas/Index.html を、Google環境なしでブラウザから動かす。
 *   node harness/server.js [--port 8795] [--user yamamoto@example.jp] [--now 2026-09-17]
 * GET  /            … Index.html（include展開＋ google.script.run の代替を注入）
 * POST /rpc         … {fn, args} → Code.gs の api* 関数を呼ぶ
 * POST /reset       … 台帳を初期状態（サンプル）に戻す
 * POST /user        … {email} ログインしている利用者を切り替える（録画と検証用）
 * GET  /state       … シートの中身（検証用）
 */
const http = require('http');
const { loadCode, renderIndex } = require('./load-code');

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; }
const PORT = Number(arg('port', 8795));
const USER = arg('user', 'yamamoto@example.jp');
const NOW = arg('now', '');

let app = null;
function boot() {
  const nowMs = NOW ? new Date(NOW + 'T13:00:00+09:00').getTime() : undefined; // 日付だけ渡すと13時に固定
  app = loadCode({ userEmail: USER, nowMs });
  app.context.apiBootstrap(); // シート作成とサンプル投入
}
boot();

const SHIM = `<script>
window.google = { script: { run: (function(){
  function mk(ok, ng){
    var h = { withSuccessHandler: function(f){ return mk(f, ng); }, withFailureHandler: function(f){ return mk(ok, f); } };
    return new Proxy(h, { get: function(t, p){
      if (p in t) return t[p];
      return function(){
        var args = Array.prototype.slice.call(arguments);
        return fetch('/rpc', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ fn: p, args: args }) })
          .then(function(r){ return r.json(); })
          .then(function(j){ if (j.error) { ng && ng(new Error(j.error)); } else { ok && ok(j.result); } })
          .catch(function(e){ ng && ng(e); });
      };
    }});
  }
  return mk(null, null);
})(), host: { close: function(){} } } };
</script>`;

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => cb(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    const html = renderIndex().replace('</head>', SHIM + '\n</head>');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    const out = {};
    app.ss.getSheets().forEach(s => { out[s.getName()] = s.data; });
    return send(res, 200, JSON.stringify(out, null, 1));
  }
  if (req.method === 'POST' && url.pathname === '/reset') { boot(); return send(res, 200, '{"ok":true}'); }
  if (req.method === 'POST' && url.pathname === '/user') {
    return readBody(req, body => { app.state.userEmail = JSON.parse(body || '{}').email || USER; send(res, 200, '{"ok":true}'); });
  }
  if (req.method === 'POST' && url.pathname === '/rpc') {
    return readBody(req, body => {
      try {
        const { fn, args } = JSON.parse(body || '{}');
        if (!/^api[A-Z]/.test(String(fn)) || typeof app.context[fn] !== 'function') return send(res, 400, JSON.stringify({ error: '関数 ' + fn + ' は公開されていません' }));
        const result = app.context[fn].apply(null, args || []);
        send(res, 200, JSON.stringify({ result: result === undefined ? null : result }));
      } catch (e) {
        send(res, 200, JSON.stringify({ error: (e && e.message) ? e.message : String(e) }));
      }
    });
  }
  send(res, 404, 'not found', 'text/plain');
});

server.listen(PORT, () => {
  console.log('task-case-manager server: http://localhost:' + PORT + '  user=' + USER + (NOW ? ' now=' + NOW : ''));
});
