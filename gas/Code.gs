/**
 * 業務管理（案件・ステータス・期限・対応履歴・引き継ぎ）Google Apps Script Webアプリ
 *
 * 保存先: このスクリプトが紐付くGoogleスプレッドシート（台帳4種）
 * 画面:   Index.html（HtmlService）。台帳シートは画面からだけ触る
 *
 * 台帳
 *   利用者 / 取引先 / 案件 / 対応履歴
 */

var CONFIG = {
  TIMEZONE: 'Asia/Tokyo',
  DEMO_MODE: true,          // true のとき、台帳が空ならサンプルを入れる
  STATUSES: ['未着手', '進行中', '確認待ち', '保留', '完了'],
  KINDS: ['電話', 'メール', '打ち合わせ', '作業', 'メモ'],   // 人が選ぶ対応の種別
  TITLE_MAX: 100,
  TEXT_MAX: 2000,
  FEED_LIMIT: 200,          // 一覧の右に出す対応履歴の件数
  HISTORY_LIMIT: 300        // 対応履歴の画面に出す件数
};

// 操作に合わせて仕組みが書く種別（人は選べない）
var KIND_STATUS = 'ステータス変更';
var KIND_DUE = '期限変更';
var KIND_HANDOVER = '引き継ぎ';

var SHEETS = {
  users:   { name: '利用者',   headers: ['メール', '表示名', '権限'] },
  clients: { name: '取引先',   headers: ['取引先ID', '名称', '先方担当者', '電話', 'メール', '住所', '備考', '登録日時'] },
  cases:   { name: '案件',     headers: ['案件番号', '案件名', '取引先ID', '担当者', 'ステータス', '期限', '内容', '登録者', '登録日時', '更新日時'] },
  history: { name: '対応履歴', headers: ['履歴ID', '案件番号', '日時', '記入者', '種別', '内容', '変更前', '変更後'] }
};

// スプレッドシートが日時に変えてしまう列。読むときは 'yyyy-MM-dd HH:mm' の文字に戻す
var DATETIME_COLUMNS = ['日時', '登録日時', '更新日時'];

/* ============================================================
 * 画面
 * ============================================================ */

function doGet() {
  ensureSheets_();
  var t = HtmlService.createTemplateFromFile('Index');
  return t.evaluate()
    .setTitle('業務管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** 画面の初期表示に要るものを1回で返す */
function apiBootstrap() {
  ensureSheets_();
  return {
    user: currentUser_(),
    users: listUsers_(),
    clients: readClients_(),
    statuses: CONFIG.STATUSES,
    kinds: CONFIG.KINDS,
    today: fmtDate_(new Date())
  };
}

/* ============================================================
 * 案件
 * ============================================================ */

/** 案件一覧と、一覧の右に出す最近の対応履歴 */
function apiListCases() {
  var users = userIndex_();
  var clients = indexBy_(readClients_(), 'id');
  var history = readHistory_(users);
  var lastByCase = {};
  var handoverByCase = {};
  history.forEach(function (h) {
    // 最新の対応は人が書いた記録から取る。ステータスと期限は一覧の列に今の値が出ている
    if (!isSystemKind_(h.kind) && !lastByCase[h.caseNo]) lastByCase[h.caseNo] = h;
    if (h.kind === KIND_HANDOVER && !handoverByCase[h.caseNo]) handoverByCase[h.caseNo] = h;
  });
  var cases = readRows_(SHEETS.cases).map(function (r) {
    var c = caseOut_(r, users, clients);
    c.last = lastByCase[c.no] || null;
    c.handover = handoverByCase[c.no] || null;
    return c;
  });
  var byNo = indexBy_(cases, 'no');
  return {
    cases: cases,
    history: history.slice(0, CONFIG.FEED_LIMIT).map(function (h) { return withCase_(h, byNo); })
  };
}

/** 案件1件と、その案件の対応履歴（新しい順） */
function apiGetCase(no) {
  var users = userIndex_();
  var clients = indexBy_(readClients_(), 'id');
  var c = caseOut_(findCase_(no), users, clients);
  c.client = clients[c.clientId] || null;
  c.history = readHistory_(users).filter(function (h) { return h.caseNo === c.no; });
  return c;
}

/**
 * 案件の登録（no なし）と編集（no あり）。
 * 担当者とステータスは登録のときだけ受け取る。あとから変えるときは引き継ぎとステータスの操作を使い、対応履歴に残す
 */
function apiSaveCase(p) {
  requireRole_('入力');
  p = p || {};
  var isNew = !trim_(p.no);
  var v = {
    title: trim_(p.title), clientId: trim_(p.clientId), due: trim_(p.due), note: trim_(p.note),
    owner: trim_(p.owner).toLowerCase(), status: trim_(p.status) || CONFIG.STATUSES[0]
  };
  var errors = [];
  if (!v.title) errors.push('案件名を入力してください');
  else if (v.title.length > CONFIG.TITLE_MAX) errors.push('案件名は' + CONFIG.TITLE_MAX + '文字までです');
  if (!v.clientId) errors.push('取引先を選んでください');
  else if (!readClients_().some(function (c) { return c.id === v.clientId; })) errors.push('選んだ取引先が見つかりません');
  if (!v.due) errors.push('期限を入力してください');
  else if (!isYmd_(v.due)) errors.push('期限の日付が正しくありません');
  if (v.note.length > CONFIG.TEXT_MAX) errors.push('内容は' + CONFIG.TEXT_MAX + '文字までです');
  if (isNew) {
    if (!v.owner) errors.push('担当者を選んでください');
    else if (!canOwn_(v.owner)) errors.push('担当者に選べるのは、入力か管理の権限を持つ利用者です');
    if (CONFIG.STATUSES.indexOf(v.status) < 0) errors.push(statusError_());
  }
  if (errors.length) throw new Error(errors.join('\n'));

  var me = currentUser_();
  var now = fmtDateTime_(new Date());
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (isNew) {
      var no = nextSeq_(SHEETS.cases, '案件番号', 'A', 4);
      appendRow_(SHEETS.cases, {
        '案件番号': no, '案件名': v.title, '取引先ID': v.clientId, '担当者': v.owner, 'ステータス': v.status,
        '期限': v.due, '内容': v.note, '登録者': me.email, '登録日時': now, '更新日時': now
      });
      return { no: no };
    }
    var row = findCase_(p.no);
    updateRow_(SHEETS.cases, row.__row, { '案件名': v.title, '取引先ID': v.clientId, '期限': v.due, '内容': v.note, '更新日時': now });
    if (row['期限'] !== v.due) appendHistory_(row['案件番号'], me.email, KIND_DUE, '', row['期限'], v.due, now);
    return { no: row['案件番号'] };
  } finally {
    lock.releaseLock();
  }
}

/** ステータスの切り替え。変更前と変更後を対応履歴に残す */
function apiSetStatus(no, status, memo) {
  requireRole_('入力');
  status = trim_(status);
  memo = trim_(memo);
  if (CONFIG.STATUSES.indexOf(status) < 0) throw new Error(statusError_());
  if (memo.length > CONFIG.TEXT_MAX) throw new Error('メモは' + CONFIG.TEXT_MAX + '文字までです');

  var me = currentUser_();
  var now = fmtDateTime_(new Date());
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var row = findCase_(no);
    if (row['ステータス'] === status) throw new Error('すでに「' + status + '」です');
    updateRow_(SHEETS.cases, row.__row, { 'ステータス': status, '更新日時': now });
    appendHistory_(row['案件番号'], me.email, KIND_STATUS, memo, row['ステータス'], status, now);
    return { no: row['案件番号'], status: status };
  } finally {
    lock.releaseLock();
  }
}

/** 対応履歴を書き足す */
function apiAddHistory(no, p) {
  requireRole_('入力');
  p = p || {};
  var kind = trim_(p.kind);
  var text = trim_(p.text);
  var errors = [];
  if (CONFIG.KINDS.indexOf(kind) < 0) errors.push('種別は ' + CONFIG.KINDS.join(' / ') + ' のどれかを選んでください');
  if (!text) errors.push('対応した内容を書いてください');
  else if (text.length > CONFIG.TEXT_MAX) errors.push('内容は' + CONFIG.TEXT_MAX + '文字までです');
  if (errors.length) throw new Error(errors.join('\n'));

  var me = currentUser_();
  var now = fmtDateTime_(new Date());
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var row = findCase_(no);
    var id = appendHistory_(row['案件番号'], me.email, kind, text, '', '', now);
    updateRow_(SHEETS.cases, row.__row, { '更新日時': now });
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 担当者の付け替え。申し送りが無いと付け替えない。
 * 申し送りは種別「引き継ぎ」で対応履歴に残り、新しい担当者は過去の履歴と一緒に読める
 */
function apiHandover(no, p) {
  requireRole_('入力');
  p = p || {};
  var to = trim_(p.to).toLowerCase();
  var memo = trim_(p.memo);
  var row = findCase_(no);
  var errors = [];
  if (!to) errors.push('新しい担当者を選んでください');
  else if (to === String(row['担当者']).toLowerCase()) errors.push('今の担当者と同じ人です');
  else if (!canOwn_(to)) errors.push('担当者に選べるのは、入力か管理の権限を持つ利用者です');
  if (!memo) errors.push('申し送りを書いてください');
  else if (memo.length > CONFIG.TEXT_MAX) errors.push('申し送りは' + CONFIG.TEXT_MAX + '文字までです');
  if (errors.length) throw new Error(errors.join('\n'));

  var me = currentUser_();
  var now = fmtDateTime_(new Date());
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var fresh = findCase_(no);
    if (String(fresh['担当者']).toLowerCase() === to) throw new Error('今の担当者と同じ人です');
    updateRow_(SHEETS.cases, fresh.__row, { '担当者': to, '更新日時': now });
    appendHistory_(fresh['案件番号'], me.email, KIND_HANDOVER, memo, String(fresh['担当者']).toLowerCase(), to, now);
    return { no: fresh['案件番号'], owner: to };
  } finally {
    lock.releaseLock();
  }
}

/** 対応履歴（全案件・新しい順） */
function apiListHistory() {
  var users = userIndex_();
  var clients = indexBy_(readClients_(), 'id');
  var byNo = {};
  readRows_(SHEETS.cases).forEach(function (r) {
    var c = caseOut_(r, users, clients);
    byNo[c.no] = c;
  });
  return readHistory_(users).slice(0, CONFIG.HISTORY_LIMIT).map(function (h) { return withCase_(h, byNo); });
}

function caseOut_(r, users, clients) {
  var owner = userOut_(r['担当者'], users);
  var creator = userOut_(r['登録者'], users);
  var client = clients[r['取引先ID']] || {};
  return {
    no: r['案件番号'], title: r['案件名'], clientId: r['取引先ID'], clientName: client.name || r['取引先ID'],
    owner: owner.email, ownerName: owner.short, ownerFull: owner.name,
    status: r['ステータス'], due: r['期限'], note: r['内容'],
    createdBy: creator.short, createdAt: r['登録日時'], updatedAt: r['更新日時']
  };
}

function findCase_(no) {
  var key = trim_(no);
  var hit = readRows_(SHEETS.cases).filter(function (r) { return r['案件番号'] === key; })[0];
  if (!hit) throw new Error('案件 ' + (key || '（番号なし）') + ' が見つかりません');
  return hit;
}

function statusError_() {
  return 'ステータスは ' + CONFIG.STATUSES.join(' / ') + ' のどれかを選んでください';
}

/* ============================================================
 * 対応履歴
 * ============================================================ */

/** 対応履歴を新しい順で返す。同じ時刻なら後から書いたものを先にする */
function readHistory_(users) {
  return readRows_(SHEETS.history).map(function (r) {
    var by = userOut_(r['記入者'], users);
    var h = {
      id: r['履歴ID'], caseNo: r['案件番号'], at: String(r['日時']), by: by.email, byName: by.short,
      kind: r['種別'], text: r['内容'], before: String(r['変更前']), after: String(r['変更後']), beforeName: '', afterName: ''
    };
    if (h.kind === KIND_HANDOVER) {
      h.before = h.before.toLowerCase();
      h.after = h.after.toLowerCase();
      h.beforeName = userOut_(h.before, users).short;
      h.afterName = userOut_(h.after, users).short;
    }
    return h;
  }).sort(function (a, b) {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return String(b.id).localeCompare(String(a.id));
  });
}

function appendHistory_(caseNo, by, kind, text, before, after, at) {
  var id = nextSeq_(SHEETS.history, '履歴ID', 'H', 6);
  appendRow_(SHEETS.history, { '履歴ID': id, '案件番号': caseNo, '日時': at, '記入者': by, '種別': kind, '内容': text, '変更前': before, '変更後': after });
  return id;
}

function isSystemKind_(kind) {
  return kind === KIND_STATUS || kind === KIND_DUE;
}

function withCase_(h, byNo) {
  var c = byNo[h.caseNo] || {};
  var o = {};
  Object.keys(h).forEach(function (k) { o[k] = h[k]; });
  o.caseTitle = c.title || h.caseNo;
  o.clientName = c.clientName || '';
  return o;
}

/* ============================================================
 * 取引先
 * ============================================================ */

/** 取引先の一覧。完了していない案件の数を付ける */
function apiListClients() {
  var open = {};
  readRows_(SHEETS.cases).forEach(function (r) {
    if (r['ステータス'] !== '完了') open[r['取引先ID']] = (open[r['取引先ID']] || 0) + 1;
  });
  return readClients_().map(function (c) { c.openCases = open[c.id] || 0; return c; });
}

function apiSaveClient(c) {
  requireRole_('入力');
  c = c || {};
  var v = { id: trim_(c.id), name: trim_(c.name), contact: trim_(c.contact), phone: trim_(c.phone), email: trim_(c.email), address: trim_(c.address), note: trim_(c.note) };
  var errors = [];
  if (!v.name) errors.push('名称を入力してください');
  else if (readClients_().some(function (x) { return x.name === v.name && x.id !== v.id; })) errors.push('同じ名称の取引先がすでにあります');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.push('メールアドレスの形が正しくありません');
  if (errors.length) throw new Error(errors.join('\n'));

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var fields = { '名称': v.name, '先方担当者': v.contact, '電話': v.phone, 'メール': v.email, '住所': v.address, '備考': v.note };
    if (v.id) {
      var existing = readRows_(SHEETS.clients).filter(function (r) { return r['取引先ID'] === v.id; })[0];
      if (!existing) throw new Error('取引先 ' + v.id + ' が見つかりません');
      updateRow_(SHEETS.clients, existing.__row, fields);
      return { id: v.id };
    }
    var id = nextSeq_(SHEETS.clients, '取引先ID', 'T', 3);
    fields['取引先ID'] = id;
    fields['登録日時'] = fmtDateTime_(new Date());
    appendRow_(SHEETS.clients, fields);
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

function readClients_() {
  return readRows_(SHEETS.clients).map(function (r) {
    return { id: r['取引先ID'], name: r['名称'], contact: r['先方担当者'], phone: r['電話'], email: r['メール'], address: r['住所'], note: r['備考'] };
  });
}

/* ============================================================
 * 利用者・権限
 * ============================================================ */

function currentUser_() {
  var email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { email = ''; }
  var users = userIndex_();
  if (users[email]) return users[email];
  if (!Object.keys(users).length) return { email: email, name: email || '利用者', short: email || '利用者', role: '入力' }; // 利用者シートが空なら全員入力可
  return { email: email, name: email || '未登録', short: email || '未登録', role: '閲覧' };
}

function requireRole_(role) {
  var u = currentUser_();
  if (role === '入力' && u.role !== '入力' && u.role !== '管理') throw new Error('この操作には入力の権限が必要です（今の権限: ' + u.role + '）');
}

/** メール（小文字）→ 利用者。short は表示名の姓（空白の前） */
function userIndex_() {
  var o = {};
  readRows_(SHEETS.users).forEach(function (r) {
    var email = String(r['メール']).toLowerCase();
    var name = String(r['表示名'] || email);
    o[email] = { email: email, name: name, short: name.split(/[\s　]+/)[0], role: r['権限'] || '閲覧' };
  });
  return o;
}

function listUsers_() {
  var idx = userIndex_();
  return Object.keys(idx).map(function (k) { return idx[k]; });
}

function userOut_(email, users) {
  var key = String(email || '').toLowerCase();
  return users[key] || { email: key, name: key, short: key, role: '' };
}

/** 担当者にできるのは入力か管理の権限を持つ利用者 */
function canOwn_(email) {
  var u = userIndex_()[String(email || '').toLowerCase()];
  return !!u && (u.role === '入力' || u.role === '管理');
}

/* ============================================================
 * シート入出力
 * ============================================================ */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function ensureSheets_() {
  var ss = ss_();
  Object.keys(SHEETS).forEach(function (k) {
    var def = SHEETS[k];
    if (!ss.getSheetByName(def.name)) {
      var sh = ss.insertSheet(def.name);
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  if (CONFIG.DEMO_MODE && readRows_(SHEETS.cases).length === 0 && readRows_(SHEETS.clients).length === 0) setupDemoData_();
}

/** シート全行をヘッダ名→値のオブジェクトで返す。__row に行番号（1始まり）を持つ */
function readRows_(def) {
  var sh = ss_().getSheetByName(def.name);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(1, 1, last, def.headers.length).getValues();
  var headers = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    var o = { __row: i + 1 };
    headers.forEach(function (h, j) { o[h] = normalize_(row[j], h); });
    out.push(o);
  }
  return out;
}

function normalize_(v, header) {
  if (v instanceof Date) return DATETIME_COLUMNS.indexOf(header) >= 0 ? fmtDateTime_(v) : fmtDate_(v);
  return v;
}

/** 数式に見える文字（= + - @ で始まる）は先頭に ' を付け、文字のまま保存する */
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function appendRow_(def, obj) {
  var sh = ss_().getSheetByName(def.name);
  sh.appendRow(def.headers.map(function (h) { return cell_(obj[h]); }));
}

function updateRow_(def, rowIndex, patch) {
  var sh = ss_().getSheetByName(def.name);
  var range = sh.getRange(rowIndex, 1, 1, def.headers.length);
  var vals = range.getValues()[0];
  // 読み戻した値は ' が外れているので、書き戻す値にも付け直す
  var next = def.headers.map(function (h, j) { return cell_(patch[h] !== undefined ? patch[h] : vals[j]); });
  range.setValues([next]);
}

/** 採番: 接頭辞-連番（桁が足りなくなったら桁が増える） */
function nextSeq_(def, column, prefix, width) {
  var head = prefix + '-';
  var max = 0;
  readRows_(def).forEach(function (r) {
    var v = String(r[column] || '');
    if (v.indexOf(head) === 0) { var n = Number(v.slice(head.length)); if (n > max) max = n; }
  });
  var s = String(max + 1);
  while (s.length < width) s = '0' + s;
  return head + s;
}

function indexBy_(arr, key) {
  var o = {};
  arr.forEach(function (x) { o[x[key]] = x; });
  return o;
}

/* ============================================================
 * 書式
 * ============================================================ */

function fmtDate_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd'); }
function fmtDateTime_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'); }
function addDays_(ymd, n) {
  var d = new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)) + n);
  return fmtDate_(d);
}
function isYmd_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return fmtDate_(d) === s;
}
function trim_(v) { return String(v === undefined || v === null ? '' : v).trim(); }

/* ============================================================
 * サンプルデータ（デモ用。実在の会社・人物とは無関係）
 * 日付は今日からの日数で入れる。今日の対応履歴は「今から何分前」で入れ、開いた時刻より後にならないようにする
 * ============================================================ */

function setupDemoData_() {
  var today = fmtDate_(new Date());
  function day(n) { return addDays_(today, n); }
  function at(n, hm) {
    if (typeof hm === 'number') return fmtDateTime_(new Date(new Date().getTime() - hm * 60000)); // hm 分前
    return day(n) + ' ' + hm;
  }
  function jpDay(n) { var d = day(n); return Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日'; }

  var U = {
    sato: 'sato@example.jp', yamamoto: 'yamamoto@example.jp', suzuki: 'suzuki@example.jp',
    takahashi: 'takahashi@example.jp', ito: 'ito@example.jp', kobayashi: 'kobayashi@example.jp'
  };
  [
    [U.sato, '佐藤 健', '管理'], [U.yamamoto, '山本 恵', '入力'], [U.suzuki, '鈴木 翔太', '入力'],
    [U.takahashi, '高橋 直子', '入力'], [U.ito, '伊藤 大輔', '入力'], [U.kobayashi, '小林 由美', '閲覧']
  ].forEach(function (r) { appendRow_(SHEETS.users, { 'メール': r[0], '表示名': r[1], '権限': r[2] }); });

  [
    ['T-001', '東和精機株式会社', '情報システム課 森様', '03-0000-0101', 'mori@towa-seiki.example.jp', '東京都○○区○○ 1-2-3'],
    ['T-002', '株式会社ひなた食品', '通販担当 上田様', '06-0000-0202', 'ueda@hinata-foods.example.jp', '大阪府○○市○○ 4-5'],
    ['T-003', '北山建設株式会社', '総務部 村井様', '045-000-0303', 'murai@kitayama-kensetsu.example.jp', '神奈川県○○市○○ 6-7-8'],
    ['T-004', '株式会社イロハ不動産', '広報 中村様', '03-0000-0404', 'nakamura@iroha-fudosan.example.jp', '東京都○○区○○ 9-10'],
    ['T-005', 'あおば歯科クリニック', '受付 井上様', '048-000-0505', 'info@aoba-dental.example.jp', '埼玉県○○市○○ 11-12'],
    ['T-006', '株式会社ミナト運輸', '業務部 石田様', '045-000-0606', 'ishida@minato-unyu.example.jp', '神奈川県○○市○○ 13'],
    ['T-007', '医療法人つばさ会', '事務長 松本様', '042-000-0707', 'matsumoto@tsubasa-kai.example.jp', '東京都○○市○○ 14-15'],
    ['T-008', '有限会社カワセ商店', '店長 川瀬様', '03-0000-0808', 'kawase@kawase-shoten.example.jp', '東京都○○区○○ 16-17']
  ].forEach(function (r) {
    appendRow_(SHEETS.clients, { '取引先ID': r[0], '名称': r[1], '先方担当者': r[2], '電話': r[3], 'メール': r[4], '住所': r[5], '備考': '', '登録日時': at(-60, '10:00') });
  });

  // [番号, 案件名, 取引先, 担当者, ステータス, 期限(今日からの日数), 内容, 登録者, 登録日(今日からの日数), 対応履歴(古い順)]
  // 対応履歴: [日(今日からの日数), 時刻（今日の分は何分前かの数）, 記入者, 種別, 内容, 変更前, 変更後]
  var cases = [
    ['A-0001', 'メールサーバの移行', 'T-001', U.yamamoto, '進行中', 1, '旧メールサーバから新サーバへ、メールアカウント42件を移す。', U.yamamoto, -6, [
      [-3, '16:10', U.yamamoto, '打ち合わせ', '移行するメールアカウントは42件。旧サーバは今月末で解約する予定。'],
      [-2, '10:00', U.yamamoto, KIND_STATUS, '', '未着手', '進行中'],
      [0, 60, U.yamamoto, '作業', '新サーバへの切り替え手順を作成。明日の業務終了後に切り替えることを、先方の情報システム担当の森様に連絡済み。']
    ]],
    ['A-0002', 'ECサイトの決済方法の変更', 'T-002', U.suzuki, '確認待ち', -6, 'ECサイトの決済を、決済代行会社の新しいプランに切り替える。', U.suzuki, -20, [
      [-7, '15:20', U.suzuki, 'メール', '決済代行会社の審査書類を先方に送付。記入した書類の返送待ち。'],
      [-7, '15:22', U.suzuki, KIND_STATUS, '', '進行中', '確認待ち']
    ]],
    ['A-0003', '社内ネットワークの更新', 'T-003', U.sato, '進行中', -2, '本社と資材置き場のLAN配線とスイッチを入れ替える。', U.sato, -15, [
      [-9, '13:30', U.sato, '打ち合わせ', '現地調査を実施。配線図を' + jpDay(-2) + 'までに提出する約束。']
    ]],
    ['A-0004', 'コーポレートサイトの改修', 'T-004', U.yamamoto, '確認待ち', 0, 'トップページと会社概要ページのデザインを新しくする。', U.yamamoto, -27, [
      [-1, '17:05', U.yamamoto, 'メール', 'トップページのデザイン案を2案送付。どちらにするか' + jpDay(0) + 'までに返事をもらう約束。'],
      [-1, '17:06', U.yamamoto, KIND_STATUS, '', '進行中', '確認待ち']
    ]],
    ['A-0005', '予約システムの保守契約の更新', 'T-005', U.yamamoto, '未着手', 7, '予約システムの保守契約を来年分に更新する。', U.suzuki, -10, [
      [-8, '11:00', U.suzuki, '電話', '契約は今月末で満了。来年も続ける意向を確認。'],
      [-1, '10:15', U.suzuki, KIND_HANDOVER, '更新の見積はまだ作っていません。先方の窓口は受付の井上様で、電話は午前中がつながりやすいです。', U.suzuki, U.yamamoto]
    ]],
    ['A-0006', '在庫管理システムのデータ移行', 'T-006', U.takahashi, '進行中', 13, '在庫管理システムの入れ替えに合わせて、商品マスタと在庫数を移す。', U.takahashi, -30, [
      [-10, '14:00', U.takahashi, '打ち合わせ', '移すのは商品マスタと在庫数。切り替えは今月末の棚卸しの後。'],
      [0, 100, U.takahashi, '作業', '旧システムから商品マスタ3,200件を取り出した。重複している38件を先方に確認中。']
    ]],
    ['A-0007', '受付端末の入れ替え', 'T-007', U.ito, '進行中', 8, '受付の端末2台を入れ替え、予約システムにつなぐ。', U.ito, -14, [
      [-2, '14:00', U.ito, '打ち合わせ', '設置場所を確認。電源の増設が必要なため、先方が手配する電気工事の日程を調整中。']
    ]],
    ['A-0008', '複合機とパソコンのリース入れ替え', 'T-008', U.sato, '保留', 22, '複合機1台とパソコン6台のリースを入れ替える。', U.sato, -21, [
      [-6, '09:50', U.sato, '電話', '社長の判断待ちのため、来月まで保留にしたいと連絡があった。'],
      [-6, '09:55', U.sato, KIND_STATUS, '', '進行中', '保留']
    ]],
    ['A-0009', '現場用タブレットの導入', 'T-003', U.takahashi, '未着手', 15, '工事現場で図面と写真を見るタブレットを導入する。', U.takahashi, -3, [
      [-3, '18:00', U.takahashi, 'メモ', '台数は20台の想定。機種の候補を3つに絞り、来週提案する。']
    ]],
    ['A-0010', 'バックアップ運用の見直し', 'T-006', U.yamamoto, '確認待ち', 11, 'サーバのバックアップの取り方と、復元の手順を見直す。', U.yamamoto, -14, [
      [-2, '11:30', U.yamamoto, 'メール', '復元テストの結果報告書を送付。運用手順の承認待ち。'],
      [-2, '11:31', U.yamamoto, KIND_STATUS, '', '進行中', '確認待ち']
    ]],
    ['A-0011', 'Wi-Fiの増設', 'T-007', U.suzuki, '進行中', 28, '2階の待合室と診察室にWi-Fiのアクセスポイントを足す。', U.suzuki, -1, [
      [0, 150, U.suzuki, '電話', '2階の待合室で電波が弱いと相談があった。来週、現地で電波の強さを測る。']
    ]],
    ['A-0012', '勤怠システムの導入支援', 'T-002', U.ito, '未着手', 33, 'ICカードで打刻する勤怠システムの導入を手伝う。', U.ito, -3, [
      [-3, '15:00', U.ito, '打ち合わせ', '打刻はICカードを希望。対象の従業員は46名。']
    ]],
    ['A-0013', '採用ページの追加', 'T-004', U.ito, '完了', -7, '採用情報のページを追加する。', U.ito, -21, [
      [-7, '16:30', U.ito, '作業', 'ページを公開し、先方に公開の連絡をした。'],
      [-7, '16:35', U.ito, KIND_STATUS, '', '進行中', '完了']
    ]],
    ['A-0014', '防犯カメラの遠隔確認の設定', 'T-008', U.sato, '完了', -13, '店舗の防犯カメラを、スマートフォンから見られるようにする。', U.sato, -20, [
      [-13, '13:15', U.sato, '作業', 'スマートフォンから映像を確認する方法を店長に説明した。'],
      [-13, '13:20', U.sato, KIND_STATUS, '', '進行中', '完了']
    ]]
  ];

  var all = [];
  cases.forEach(function (c) {
    var hs = c[9];
    var created = at(c[8], '09:30');
    var updated = hs.length ? at(hs[hs.length - 1][0], hs[hs.length - 1][1]) : created;
    appendRow_(SHEETS.cases, {
      '案件番号': c[0], '案件名': c[1], '取引先ID': c[2], '担当者': c[3], 'ステータス': c[4], '期限': day(c[5]),
      '内容': c[6], '登録者': c[7], '登録日時': created, '更新日時': updated
    });
    hs.forEach(function (h) {
      all.push({ no: c[0], at: at(h[0], h[1]), by: h[2], kind: h[3], text: h[4], before: h[5] || '', after: h[6] || '' });
    });
  });
  all.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  all.forEach(function (h, i) {
    var id = String(i + 1);
    while (id.length < 6) id = '0' + id;
    appendRow_(SHEETS.history, { '履歴ID': 'H-' + id, '案件番号': h.no, '日時': h.at, '記入者': h.by, '種別': h.kind, '内容': h.text, '変更前': h.before, '変更後': h.after });
  });
}
