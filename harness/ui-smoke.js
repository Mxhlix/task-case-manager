'use strict';
/**
 * 画面の通し検証（Playwright・headless）。サーバはこのスクリプトが 8796 番で起動して、終わったら止める。
 *   node harness/ui-smoke.js
 * 絞り込み → 案件を開く → 空の対応履歴で止まる → 記録 → ステータス変更 → 申し送りなしで止まる → 引き継ぎ →
 * 一覧で担当と印が変わる → 引き継いだ人で開いて自分の担当に入る → 案件の登録（空欄で止まる → 登録）→
 * 閲覧の権限では書けない → 取引先と対応履歴の画面、を実際に操作し、場面ごとの画像を harness/out/shots/ に保存する。
 * 文言と件数は画面から読んで assert する。
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 8796;
const BASE = 'http://localhost:' + PORT;
const SHOTS = path.join(__dirname, 'out', 'shots');

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', String(PORT), '--now', '2026-09-17'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', d => { if (String(d).indexOf('http://localhost') >= 0) resolve(p); });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => reject(new Error('server exited ' + code + ' ' + err)));
  });
}
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

(async () => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  let n = 0;
  const shot = async (page, name) => { n++; await page.screenshot({ path: path.join(SHOTS, String(n).padStart(2, '0') + '-' + name + '.png') }); };

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const rows = () => page.$$eval('#tblCases tbody tr[data-no]', trs => trs.length);
    const kpis = () => page.$$eval('.kpi .v', els => els.map(e => e.textContent));
    const text = sel => page.textContent(sel).then(t => t.trim());
    // 前の通知が残っていることがあるので、文言が期待どおりになるまで待つ（5秒で失敗）
    const toastSays = s => page.waitForFunction(want => {
      const t = document.querySelector('#toast');
      return t && !t.classList.contains('hidden') && t.textContent === want;
    }, s, { timeout: 5000 });
    const openRow = async title => { await page.click('#tblCases tbody tr:has-text("' + title + '")'); await page.waitForSelector('#view-case:not(.hidden)'); };
    const backToList = async () => { await page.click('#btnBack'); await page.waitForSelector('#view-cases:not(.hidden)'); };
    // 子の要素が親の枠からはみ出していないか（右端と左端を測る）
    const inside = (child, parent) => page.evaluate(([c, p]) => {
      const a = document.querySelector(c).getBoundingClientRect(), b = document.querySelector(p).getBoundingClientRect();
      return a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
    }, [child, parent]);

    // 1. TOP
    await page.goto(BASE + '/');
    await page.waitForSelector('#tblCases tbody tr[data-no]');
    assert.strictEqual(await text('#userName'), '山本 恵');
    assert.deepStrictEqual(await kpis(), ['4件', '2件', '3件', '3件']);
    assert.strictEqual(await rows(), 12);
    await shot(page, 'top');

    // 2. 絞り込み: 自分の担当 → 期限切れ → 0件 → 解除
    await page.click('[data-kpi="mine"]');
    assert.strictEqual(await rows(), 4);
    await page.click('#fStatus [data-status="保留"]');
    assert.strictEqual(await rows(), 0);
    assert.strictEqual(await text('#tblCases tbody .empty'), '条件に合う案件はありません');
    await page.click('#fClear');
    assert.strictEqual(await rows(), 12);

    // 3. 案件を開く
    await openRow('コーポレートサイトの改修');
    assert.strictEqual(await text('#cTitle'), 'コーポレートサイトの改修');
    assert.strictEqual(await text('#cDue .badge'), '今日まで');
    assert.strictEqual(await page.$$eval('#cTimeline li', li => li.length), 2);
    assert.ok(await inside('#cStatus', '#view-case .detail .card'), 'ステータスの切り替えが基本情報の枠からはみ出している');
    await shot(page, 'case');

    // 4. 空の対応履歴は記録できない
    await page.click('#btnAddLog');
    await page.waitForSelector('#hAlert:not(.hidden)');
    assert.strictEqual(await text('#hAlert'), '対応した内容を書いてください');
    await shot(page, 'log-empty');

    // 5. 電話を記録する
    await page.click('#hKinds [data-kind="電話"]');
    await page.fill('#hText', '中村様から電話。デザインはA案で進めてほしいとのこと。会社概要ページの写真は来週届く。');
    await page.click('#btnAddLog');
    await toastSays('対応履歴に記録しました');
    await page.waitForFunction(() => document.querySelectorAll('#cTimeline li').length === 3);
    assert.ok((await text('#cTimeline li:first-child .fi-text')).indexOf('A案で進めて') >= 0);
    assert.strictEqual(await text('#cTimeline li:first-child .kind'), '電話');
    assert.ok(await page.$eval('#hAlert', e => e.classList.contains('hidden')), 'エラー表示が消える');

    // 6. ステータスを進行中に戻す
    await page.click('#cStatus [data-status="進行中"]');
    await toastSays('ステータスを「進行中」にしました');
    await page.waitForFunction(() => document.querySelector('#cStatus button.on').textContent === '進行中');
    assert.strictEqual(await text('#cTimeline li:first-child .kind'), 'ステータス変更');
    await shot(page, 'logged-and-status');

    // 7. 申し送りなしでは引き継げない → 高橋に引き継ぐ
    await page.click('#btnHandover');
    await page.waitForSelector('#modal:not(.hidden) #hoSave');
    await page.click('#hoSave');
    await page.waitForSelector('#hoAlert:not(.hidden)');
    assert.strictEqual(await text('#hoAlert'), '新しい担当者を選んでください\n申し送りを書いてください');
    assert.ok(await page.$eval('#hoMemo', e => e.classList.contains('bad')));
    await page.selectOption('#hoTo', 'takahashi@example.jp');
    await page.fill('#hoMemo', 'デザインはA案で確定。会社概要ページの写真が来週届くので、届いたら差し替えて先方に確認を出す。中村様は午後なら電話がつながりやすい。');
    assert.ok(await page.$eval('#hoAlert', e => e.classList.contains('hidden')), '入力し直したらエラー文が消える');
    assert.ok(!(await page.$eval('#hoMemo', e => e.classList.contains('bad'))), '入力し直したら赤枠が消える');
    await shot(page, 'handover-form');
    await page.click('#hoSave');
    await toastSays('高橋さんに引き継ぎました');
    await page.waitForFunction(() => document.querySelector('#cOwner').textContent.indexOf('高橋') >= 0);
    assert.strictEqual(await text('#cTimeline li:first-child .kind'), '引き継ぎ');
    await shot(page, 'handed-over');

    // 8. 一覧に戻ると、山本の担当が1件減り、印が付く
    await backToList();
    assert.deepStrictEqual(await kpis(), ['3件', '2件', '3件', '2件']);
    const row = '#tblCases tbody tr:has-text("コーポレートサイトの改修")';
    assert.strictEqual(await text(row + ' .owner span:not(.av)'), '高橋');
    assert.strictEqual(await text(row + ' .b-hand'), '9/17 引き継ぎ');
    assert.strictEqual(await text(row + ' .last-h .kind'), '引き継ぎ');
    assert.strictEqual(await text('#feed li:first-child .kind'), '引き継ぎ');

    // 9. 高橋で開くと、自分の担当に入っていて申し送りが読める
    await post('/user', { email: 'takahashi@example.jp' });
    await page.goto(BASE + '/');
    await page.waitForSelector('#tblCases tbody tr[data-no]');
    assert.strictEqual(await text('#userName'), '高橋 直子');
    await page.click('[data-kpi="mine"]');
    assert.strictEqual(await rows(), 3);
    assert.ok((await page.$$eval('#tblCases .case-t', e => e.map(x => x.textContent))).indexOf('コーポレートサイトの改修') >= 0);
    await shot(page, 'takahashi-mine');
    await openRow('コーポレートサイトの改修');
    assert.ok((await text('#cTimeline li:first-child .fi-text')).indexOf('デザインはA案で確定') >= 0);
    assert.strictEqual(await page.$$eval('#cTimeline li', li => li.length), 5, '引き継ぎ前の履歴も読める');
    await shot(page, 'takahashi-reads');

    // 10. 案件の登録: 空欄で止まる → 登録
    await page.click('#btnNewCase');
    await page.waitForSelector('#modal:not(.hidden) #fSave');
    assert.strictEqual(await page.$eval('#fOwner2', s => s.value), 'takahashi@example.jp', '担当者は自分が最初から入っている');
    await page.click('#fSave');
    await page.waitForSelector('#fAlert:not(.hidden)');
    assert.strictEqual(await text('#fAlert'), '案件名を入力してください\n取引先を選んでください\n期限を入力してください');
    await shot(page, 'new-case-empty');
    await page.fill('#fTitle', '社内ポータルの立ち上げ');
    await page.selectOption('#fClient', 'T-001');
    await page.fill('#fDue', '2026-10-30');
    await page.fill('#fNote', '部署ごとのお知らせと共有ファイルを1か所にまとめる。');
    await page.click('#fSave');
    await toastSays('案件を登録しました');
    await page.waitForFunction(() => document.querySelector('#cTitle').textContent === '社内ポータルの立ち上げ');
    assert.strictEqual(await text('#cSub'), '東和精機株式会社　案件番号 A-0015');
    assert.strictEqual(await page.$eval('#cStatus button.on', b => b.textContent), '未着手');

    // 11. 期限を変えると期限変更が残る
    await page.click('#btnEditCase');
    await page.waitForSelector('#modal:not(.hidden) #fSave');
    await page.fill('#fDue', '2026-11-13');
    await page.click('#fSave');
    await toastSays('案件を保存しました');
    await page.waitForFunction(() => document.querySelector('#cTimeline li:first-child .kind') && document.querySelector('#cTimeline li:first-child .kind').textContent === '期限変更');
    assert.strictEqual(await text('#cTimeline li:first-child .fi-change'), '10/30（金）→11/13（金）');
    await shot(page, 'due-changed');
    await backToList();
    // 絞り込み（高橋の自分の担当）は一覧に戻っても残る。登録した案件がそこに増える
    assert.strictEqual(await rows(), 4);
    assert.ok((await page.$$eval('#tblCases .case-t', e => e.map(x => x.textContent))).indexOf('社内ポータルの立ち上げ') >= 0);

    // 12. 閲覧の権限: 登録のボタンが出ず、詳細では書けない
    await post('/user', { email: 'kobayashi@example.jp' });
    await page.goto(BASE + '/');
    await page.waitForSelector('#tblCases tbody tr[data-no]');
    assert.strictEqual(await text('#userRole'), '権限: 閲覧');
    assert.ok(await page.$eval('#btnNewCase', b => b.classList.contains('hidden')));
    await openRow('メールサーバの移行');
    assert.ok(await page.$eval('#btnAddLog', b => b.disabled));
    assert.ok(await page.$eval('#btnHandover', b => b.disabled));
    assert.ok(await page.$eval('#hText', b => b.disabled));
    assert.ok(await page.$$eval('#cStatus button', bs => bs.every(b => b.disabled)));
    await shot(page, 'viewer');

    // 13. 取引先と対応履歴の画面
    await post('/user', { email: 'yamamoto@example.jp' });
    await page.goto(BASE + '/');
    await page.waitForSelector('#tblCases tbody tr[data-no]');
    await page.click('.nav-item[data-view="clients"]');
    await page.waitForSelector('#view-clients:not(.hidden)');
    assert.strictEqual(await page.$$eval('#tblClients tbody tr[data-id]', t => t.length), 8);
    await page.click('#btnNewClient');
    await page.waitForSelector('#modal:not(.hidden) #cfSave');
    await page.fill('#cfName', '東和精機株式会社');
    await page.click('#cfSave');
    await page.waitForSelector('#cfAlert:not(.hidden)');
    assert.strictEqual(await text('#cfAlert'), '同じ名称の取引先がすでにあります');
    await page.fill('#cfName', '新規商事株式会社');
    await page.click('#cfSave');
    await toastSays('取引先を登録しました');
    await page.waitForFunction(() => document.querySelectorAll('#tblClients tbody tr[data-id]').length === 9);
    await shot(page, 'clients');

    await page.click('.nav-item[data-view="history"]');
    await page.waitForSelector('#view-history:not(.hidden)');
    const all = await page.$$eval('#histList li[data-no]', l => l.length);
    assert.strictEqual(all, 28, 'サンプル24件 + この検証で足した電話・ステータス変更・引き継ぎ・期限変更の4件');
    await page.selectOption('#hKind', '引き継ぎ');
    assert.strictEqual(await page.$$eval('#histList li[data-no]', l => l.length), 2);
    await shot(page, 'history-handover');

    assert.deepStrictEqual(errors, []);
    console.log('ok: ' + n + ' shots in ' + SHOTS);
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
