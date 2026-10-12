'use strict';
/**
 * gas/Code.gs の自動テスト（Node標準のみ）。
 *   node harness/run-tests.js
 * 固定日時 2026-09-17（木）13:00 で動かす。サンプルの日付は今日からの日数で入る。
 */
const assert = require('assert');
const { loadCode } = require('./load-code');

const NOW = new Date('2026-09-17T13:00:00+09:00').getTime();
const ME = 'yamamoto@example.jp';
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e)); }
}
function fresh(userEmail) {
  const app = loadCode({ nowMs: NOW, userEmail: userEmail || ME });
  app.context.apiBootstrap();
  return app;
}
function throwsWith(fn, substr) {
  let msg = '';
  try { fn(); } catch (e) { msg = e.message || String(e); }
  assert.ok(msg.indexOf(substr) >= 0, '期待した文言「' + substr + '」が無い。実際: ' + (msg || '(例外なし)'));
}
const caseOf = (c, no) => c.apiListCases().cases.filter(x => x.no === no)[0];
// vm の中で作られた配列とオブジェクトは deepStrictEqual で型が合わないので、比べる前に素の値にする
const plain = x => JSON.parse(JSON.stringify(x));

console.log('業務管理 Code.gs テスト');

test('起動で台帳4種が作られ、サンプルが入る', () => {
  const app = fresh();
  const b = app.context.apiBootstrap();
  assert.strictEqual(app.ss.getSheets().length, 4);
  assert.strictEqual(b.users.length, 6);
  assert.strictEqual(b.clients.length, 8);
  assert.strictEqual(b.today, '2026-09-17');
  assert.deepStrictEqual(plain(b.user), { email: ME, name: '山本 恵', short: '山本', role: '入力' });
  const l = app.context.apiListCases();
  assert.strictEqual(l.cases.length, 14);
  assert.strictEqual(l.history.length, 24);
});

test('2回起動してもサンプルは増えない', () => {
  const app = fresh();
  app.context.apiBootstrap();
  assert.strictEqual(app.context.apiListCases().cases.length, 14);
});

test('サンプルの期限は今日からの日数で入り、期限切れ2件・7日以内3件になる', () => {
  const cases = fresh().context.apiListCases().cases;
  const open = cases.filter(c => c.status !== '完了');
  const late = open.filter(c => c.due < '2026-09-17').map(c => c.no).sort();
  const soon = open.filter(c => c.due >= '2026-09-17' && c.due <= '2026-09-24').map(c => c.no).sort();
  assert.deepStrictEqual(plain(late), ['A-0002', 'A-0003']);
  assert.deepStrictEqual(plain(soon), ['A-0001', 'A-0004', 'A-0005']);
});

test('一覧の最新の対応は人が書いた記録から取り、ステータス変更は飛ばす', () => {
  const c = fresh().context;
  const a4 = caseOf(c, 'A-0004');
  assert.strictEqual(a4.last.kind, 'メール', 'A-0004 はメールの1分後にステータス変更がある');
  assert.ok(a4.last.text.indexOf('9月17日までに返事') >= 0);
  const a5 = caseOf(c, 'A-0005');
  assert.strictEqual(a5.last.kind, '引き継ぎ');
  assert.strictEqual(a5.handover.beforeName, '鈴木');
  assert.strictEqual(a5.handover.afterName, '山本');
  assert.strictEqual(caseOf(c, 'A-0001').handover, null);
});

test('右の対応履歴は新しい順で、案件名と取引先が付く。今日の分は今の時刻より前に入る', () => {
  const h = fresh().context.apiListCases().history;
  assert.ok(h[0].at <= '2026-09-17 13:00', '先頭が今より後: ' + h[0].at);
  assert.strictEqual(h[0].at, '2026-09-17 12:00');
  for (let i = 1; i < h.length; i++) assert.ok(h[i - 1].at >= h[i].at, (i) + '件目の並びが逆');
  assert.strictEqual(h[0].caseTitle, 'メールサーバの移行');
  assert.strictEqual(h[0].clientName, '東和精機株式会社');
});

test('案件の登録: 空欄では登録できず、理由が全部返る', () => {
  const c = fresh().context;
  const empty = { title: '', clientId: '', due: '', owner: '' };
  throwsWith(() => c.apiSaveCase(empty), '案件名を入力してください');
  throwsWith(() => c.apiSaveCase(empty), '取引先を選んでください');
  throwsWith(() => c.apiSaveCase(empty), '期限を入力してください');
  throwsWith(() => c.apiSaveCase(empty), '担当者を選んでください');
  const base = { title: 'x', clientId: 'T-001', due: '2026-10-01', owner: ME };
  throwsWith(() => c.apiSaveCase(Object.assign({}, base, { clientId: 'T-999' })), '選んだ取引先が見つかりません');
  throwsWith(() => c.apiSaveCase(Object.assign({}, base, { due: '2026-02-30' })), '期限の日付が正しくありません');
  throwsWith(() => c.apiSaveCase(Object.assign({}, base, { owner: 'kobayashi@example.jp' })), '入力か管理の権限を持つ利用者');
  throwsWith(() => c.apiSaveCase(Object.assign({}, base, { status: '対応中' })), 'ステータスは 未着手 / 進行中 / 確認待ち / 保留 / 完了');
  throwsWith(() => c.apiSaveCase(Object.assign({}, base, { title: 'あ'.repeat(101) })), '案件名は100文字までです');
  assert.strictEqual(c.apiListCases().cases.length, 14, '失敗した登録で行が増えていない');
});

test('案件の登録: 番号が振られ、ステータスは未着手、登録者は自分', () => {
  const c = fresh().context;
  const r = c.apiSaveCase({ title: '  社内ポータルの立ち上げ  ', clientId: 'T-001', due: '2026-10-30', owner: 'ITO@example.jp', note: '部署ごとのお知らせを1か所にまとめる。' });
  assert.strictEqual(r.no, 'A-0015');
  const got = c.apiGetCase('A-0015');
  assert.strictEqual(got.title, '社内ポータルの立ち上げ', '前後の空白は落とす');
  assert.strictEqual(got.status, '未着手');
  assert.strictEqual(got.owner, 'ito@example.jp', 'メールは小文字にそろえる');
  assert.strictEqual(got.ownerName, '伊藤');
  assert.strictEqual(got.createdBy, '山本');
  assert.strictEqual(got.createdAt, '2026-09-17 13:00');
  assert.strictEqual(got.client.name, '東和精機株式会社');
  assert.deepStrictEqual(plain(got.history), []);
});

test('案件の編集: 期限を変えると変更前と変更後が対応履歴に残る。期限を変えなければ残らない', () => {
  const c = fresh().context;
  const before = c.apiGetCase('A-0007');
  c.apiSaveCase({ no: 'A-0007', title: before.title, clientId: before.clientId, due: before.due, note: '受付の端末2台を入れ替える。' });
  assert.strictEqual(c.apiGetCase('A-0007').history.length, before.history.length, '期限が同じなら履歴は増えない');
  c.apiSaveCase({ no: 'A-0007', title: before.title, clientId: before.clientId, due: '2026-10-02', note: '受付の端末2台を入れ替える。' });
  const after = c.apiGetCase('A-0007');
  assert.strictEqual(after.due, '2026-10-02');
  assert.strictEqual(after.note, '受付の端末2台を入れ替える。');
  assert.strictEqual(after.history[0].kind, '期限変更');
  assert.strictEqual(after.history[0].before, '2026-09-25');
  assert.strictEqual(after.history[0].after, '2026-10-02');
  assert.strictEqual(after.owner, 'ito@example.jp', '編集で担当者は変わらない');
  throwsWith(() => c.apiSaveCase({ no: 'A-9999', title: 'x', clientId: 'T-001', due: '2026-10-01' }), '案件 A-9999 が見つかりません');
});

test('ステータスの切り替え: 変更前と変更後が残る。同じステータスと一覧に無い値は止まる', () => {
  const c = fresh().context;
  const r = c.apiSetStatus('A-0009', '進行中', '機種が決まったので着手');
  assert.strictEqual(r.status, '進行中');
  const got = c.apiGetCase('A-0009');
  assert.strictEqual(got.status, '進行中');
  assert.deepStrictEqual(plain([got.history[0].kind, got.history[0].before, got.history[0].after, got.history[0].text, got.history[0].byName]),
    ['ステータス変更', '未着手', '進行中', '機種が決まったので着手', '山本']);
  throwsWith(() => c.apiSetStatus('A-0009', '進行中'), 'すでに「進行中」です');
  throwsWith(() => c.apiSetStatus('A-0009', '対応中'), 'ステータスは');
  assert.strictEqual(caseOf(c, 'A-0009').last.kind, 'メモ', 'ステータス変更は最新の対応に出さない');
});

test('対応履歴: 空と種別外は止まり、書くと最新の対応が変わる', () => {
  const c = fresh().context;
  throwsWith(() => c.apiAddHistory('A-0003', { kind: '電話', text: '   ' }), '対応した内容を書いてください');
  throwsWith(() => c.apiAddHistory('A-0003', { kind: '引き継ぎ', text: 'x' }), '種別は 電話 / メール / 打ち合わせ / 作業 / メモ');
  throwsWith(() => c.apiAddHistory('A-0003', { kind: '電話', text: 'あ'.repeat(2001) }), '内容は2000文字までです');
  throwsWith(() => c.apiAddHistory('A-9999', { kind: '電話', text: 'x' }), '案件 A-9999 が見つかりません');
  c.apiAddHistory('A-0003', { kind: '電話', text: '配線図の提出が遅れていることを村井様に連絡。\n9月18日に出すと約束した。' });
  const a3 = caseOf(c, 'A-0003');
  assert.strictEqual(a3.last.kind, '電話');
  assert.strictEqual(a3.last.byName, '山本');
  assert.strictEqual(a3.last.at, '2026-09-17 13:00');
  assert.strictEqual(a3.last.text, '配線図の提出が遅れていることを村井様に連絡。\n9月18日に出すと約束した。', '改行はそのまま残る');
  assert.strictEqual(a3.updatedAt, '2026-09-17 13:00');
  assert.strictEqual(c.apiListCases().history[0].caseNo, 'A-0003', '右の対応履歴の先頭に出る');
});

test('数式に見える書き込みは、文字のまま保存して文字のまま読める', () => {
  const app = fresh();
  const c = app.context;
  c.apiAddHistory('A-0001', { kind: 'メモ', text: '=IMPORTXML("http://example.jp","//a")' });
  const sheet = app.ss.getSheetByName('対応履歴').data;
  assert.strictEqual(sheet[sheet.length - 1][5].charAt(0), "'", 'シートには先頭に \' を付けて書く');
  assert.strictEqual(c.apiGetCase('A-0001').history[0].text, '=IMPORTXML("http://example.jp","//a")');
  // 別の列を更新しても ' が外れない
  c.apiSetStatus('A-0001', '確認待ち');
  const row = app.ss.getSheetByName('対応履歴').data.filter(r => r[5] && String(r[5]).indexOf('IMPORTXML') >= 0)[0];
  assert.strictEqual(row[5].charAt(0), "'");
  c.apiSaveCase({ no: 'A-0001', title: '-先頭がハイフンの案件名', clientId: 'T-001', due: '2026-09-18', note: '@メンション風' });
  const saved = c.apiGetCase('A-0001');
  assert.strictEqual(saved.title, '-先頭がハイフンの案件名');
  assert.strictEqual(saved.note, '@メンション風');
});

test('引き継ぎ: 申し送りが無い・同じ人・閲覧の人へは止まる', () => {
  const c = fresh().context;
  throwsWith(() => c.apiHandover('A-0004', { to: '', memo: '' }), '新しい担当者を選んでください');
  throwsWith(() => c.apiHandover('A-0004', { to: '', memo: '' }), '申し送りを書いてください');
  throwsWith(() => c.apiHandover('A-0004', { to: 'takahashi@example.jp', memo: '  ' }), '申し送りを書いてください');
  throwsWith(() => c.apiHandover('A-0004', { to: ME, memo: 'x' }), '今の担当者と同じ人です');
  throwsWith(() => c.apiHandover('A-0004', { to: 'kobayashi@example.jp', memo: 'x' }), '入力か管理の権限を持つ利用者');
  throwsWith(() => c.apiHandover('A-0004', { to: 'nobody@example.jp', memo: 'x' }), '入力か管理の権限を持つ利用者');
  assert.strictEqual(c.apiGetCase('A-0004').owner, ME, '止まったときは担当者が変わらない');
});

test('引き継ぎ: 担当者が替わり、申し送りが対応履歴に残り、新しい担当者の「自分の担当」に入る', () => {
  const app = fresh();
  const c = app.context;
  const memo = 'デザイン案は2案とも送付済み。返事の期限は今日。先方の広報の中村様は午後に連絡がつきやすい。';
  const r = c.apiHandover('A-0004', { to: 'Takahashi@example.jp', memo: memo });
  assert.strictEqual(r.owner, 'takahashi@example.jp');
  const got = c.apiGetCase('A-0004');
  assert.strictEqual(got.ownerName, '高橋');
  const h = got.history[0];
  assert.deepStrictEqual(plain([h.kind, h.beforeName, h.afterName, h.byName, h.text]), ['引き継ぎ', '山本', '高橋', '山本', memo]);
  assert.strictEqual(got.history.length, 3, '過去のメールとステータス変更も残っている');

  const mine = c.apiListCases().cases.filter(x => x.owner === ME && x.status !== '完了').map(x => x.no);
  assert.deepStrictEqual(plain(mine), ['A-0001', 'A-0005', 'A-0010'], '山本の担当から外れる');

  app.state.userEmail = 'takahashi@example.jp';
  const b = c.apiBootstrap();
  assert.strictEqual(b.user.short, '高橋');
  const list = c.apiListCases().cases;
  const takahashi = list.filter(x => x.owner === b.user.email && x.status !== '完了').map(x => x.no);
  assert.deepStrictEqual(plain(takahashi), ['A-0004', 'A-0006', 'A-0009'], '高橋の担当に入る');
  const a4 = list.filter(x => x.no === 'A-0004')[0];
  assert.strictEqual(a4.handover.at, '2026-09-17 13:00');
  assert.strictEqual(a4.last.text, memo, '一覧の最新の対応に申し送りが出る');
});

test('管理の権限の人は、他人の案件も付け替えられる。記入者は付け替えた人になる', () => {
  const c = fresh('sato@example.jp').context;
  c.apiHandover('A-0002', { to: 'ito@example.jp', memo: '鈴木さんの休暇中は伊藤さんが見る。' });
  const h = c.apiGetCase('A-0002').history[0];
  assert.deepStrictEqual(plain([h.beforeName, h.afterName, h.byName]), ['鈴木', '伊藤', '佐藤']);
});

test('閲覧の権限では書き込みが全部止まり、読むことはできる', () => {
  const c = fresh('kobayashi@example.jp').context;
  const msg = 'この操作には入力の権限が必要です（今の権限: 閲覧）';
  throwsWith(() => c.apiSaveCase({ title: 'x', clientId: 'T-001', due: '2026-10-01', owner: ME }), msg);
  throwsWith(() => c.apiSetStatus('A-0001', '完了'), msg);
  throwsWith(() => c.apiAddHistory('A-0001', { kind: 'メモ', text: 'x' }), msg);
  throwsWith(() => c.apiHandover('A-0001', { to: 'ito@example.jp', memo: 'x' }), msg);
  throwsWith(() => c.apiSaveClient({ name: '新しい会社' }), msg);
  assert.strictEqual(c.apiListCases().cases.length, 14);
  assert.strictEqual(c.apiGetCase('A-0001').history.length, 3);
  assert.strictEqual(c.apiListHistory().length, 24);
});

test('利用者シートに無い人は閲覧の扱い', () => {
  const c = fresh('stranger@example.jp').context;
  assert.strictEqual(c.apiBootstrap().user.role, '閲覧');
  throwsWith(() => c.apiAddHistory('A-0001', { kind: 'メモ', text: 'x' }), '入力の権限が必要です');
});

test('取引先: 名称は必須、同じ名称は止まる、登録すると番号が振られ、進行中の案件数が数えられる', () => {
  const c = fresh().context;
  throwsWith(() => c.apiSaveClient({ name: '' }), '名称を入力してください');
  throwsWith(() => c.apiSaveClient({ name: '東和精機株式会社' }), '同じ名称の取引先がすでにあります');
  throwsWith(() => c.apiSaveClient({ name: '新規商事', email: 'abc' }), 'メールアドレスの形が正しくありません');
  const r = c.apiSaveClient({ name: '新規商事株式会社', contact: '総務 田村様', phone: '03-0000-0909', email: 'tamura@example.jp' });
  assert.strictEqual(r.id, 'T-009');
  c.apiSaveClient({ id: 'T-009', name: '新規商事株式会社', contact: '総務 田村様（9月から）' });
  const list = c.apiListClients();
  assert.strictEqual(list.length, 9);
  assert.strictEqual(list.filter(x => x.id === 'T-009')[0].contact, '総務 田村様（9月から）');
  assert.strictEqual(list.filter(x => x.id === 'T-004')[0].openCases, 1, 'イロハ不動産は改修が進行中・採用ページは完了');
  assert.strictEqual(list.filter(x => x.id === 'T-006')[0].openCases, 2);
  throwsWith(() => c.apiSaveClient({ id: 'T-999', name: 'どこか' }), '取引先 T-999 が見つかりません');
});

test('対応履歴の画面: 全案件の履歴が新しい順で、案件名が付く', () => {
  const h = fresh().context.apiListHistory();
  assert.strictEqual(h.length, 24);
  assert.strictEqual(h[h.length - 1].caseTitle, '防犯カメラの遠隔確認の設定');
  assert.ok(h.every((x, i) => i === 0 || h[i - 1].at >= x.at));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
