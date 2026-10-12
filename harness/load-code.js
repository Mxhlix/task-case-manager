'use strict';
// gas/Code.gs を vm でロードし、モックしたGASグローバルの上で実行できる状態にして返す。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildSandbox } = require('./mock-gas');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const CODE_PATH = path.join(GAS_DIR, 'Code.gs');

// GAS では Date のローカル時刻がスクリプトのタイムゾーンになる。
// Node でも appsscript.json の timeZone にそろえ、実行するPCや CI のタイムゾーンで結果が変わらないようにする。
process.env.TZ = JSON.parse(fs.readFileSync(path.join(GAS_DIR, 'appsscript.json'), 'utf8')).timeZone;

function loadCode(mockOpts) {
  const src = fs.readFileSync(CODE_PATH, 'utf8');
  const built = buildSandbox(mockOpts);
  const context = vm.createContext(Object.assign({}, built.sandbox));
  vm.runInContext(src, context, { filename: 'Code.gs' });
  return Object.assign({ context }, built);
}

/** Index.html の <?!= include('x') ?> を gas/x.html の中身で置き換えた HTML を返す */
function renderIndex() {
  let html = fs.readFileSync(path.join(GAS_DIR, 'Index.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('([^']+)'\)\s*\?>/g, (m, name) => fs.readFileSync(path.join(GAS_DIR, name + '.html'), 'utf8'));
  return html;
}

module.exports = { loadCode, renderIndex, CODE_PATH, GAS_DIR };
