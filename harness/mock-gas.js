'use strict';
/**
 * GAS グローバルAPIの最小モック（業務管理 用）。
 * gas/Code.gs を Node の vm 上でそのまま動かす。Node標準のみ。
 * スプレッドシートと同じく、先頭に ' を付けて書いた文字列は ' を外して読み出す（数式に見える入力を文字として残すため）。
 */
const fs = require('fs');
const path = require('path');

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows || 1; this.numCols = numCols || 1;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const rowArr = this.sheet.data[this.row - 1 + i] || [];
      const vals = [];
      for (let j = 0; j < this.numCols; j++) {
        const v = rowArr[this.col - 1 + j];
        vals.push(v === undefined ? '' : (typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v));
      }
      out.push(vals);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    for (let i = 0; i < this.numRows; i++) {
      const rowIdx = this.row - 1 + i;
      while (this.sheet.data.length <= rowIdx) this.sheet.data.push([]);
      const rowArr = this.sheet.data[rowIdx];
      for (let j = 0; j < this.numCols; j++) {
        const colIdx = this.col - 1 + j;
        while (rowArr.length <= colIdx) rowArr.push('');
        rowArr[colIdx] = values[i][j];
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  getRange(row, col, numRows, numCols) { return new Range(this, row, col, numRows, numCols); }
  getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getLastRow() { return this.data.length; }
  getLastColumn() { let m = 0; this.data.forEach(r => { if (r.length > m) m = r.length; }); return m; }
  appendRow(values) { this.data.push(values.slice()); return this; }
  setFrozenRows() { return this; }
  setColumnWidth() { return this; }
  rows() { return this.data.slice(1); }
}

class Spreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) { const s = new Sheet(name); this.sheets[name] = s; return s; }
  getSheets() { return Object.keys(this.sheets).map(k => this.sheets[k]); }
}

function formatDate(d, tz, fmt) {
  const p = (n, w) => String(n).padStart(w || 2, '0');
  const map = { yyyy: String(d.getFullYear()), MM: p(d.getMonth() + 1), dd: p(d.getDate()), HH: p(d.getHours()), mm: p(d.getMinutes()), ss: p(d.getSeconds()) };
  return String(fmt).replace(/yyyy|MM|dd|HH|mm|ss/g, t => map[t]);
}

function makeFixedDate(nowMs) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
    static now() { return nowMs; }
  }
  return FixedDate;
}

/**
 * opts:
 *   nowMs      … new Date() の固定時刻（省略で実時刻）
 *   userEmail  … Session.getActiveUser().getEmail()
 *   pdfDir     … PDF保存先（省略でメモリ上だけ）
 *   pdfUrlBase … getUrl() の接頭辞（省略で '/pdf/'）
 */
function buildSandbox(opts) {
  opts = opts || {};
  const ss = new Spreadsheet();
  const folders = {};
  const files = [];
  const state = { userEmail: opts.userEmail === undefined ? 'demo@example.jp' : opts.userEmail, lockCount: 0 };
  const pdfDir = opts.pdfDir || null;
  const urlBase = opts.pdfUrlBase || '/pdf/';
  if (pdfDir) fs.mkdirSync(pdfDir, { recursive: true });

  function makeBlob(content, type, name) {
    return {
      getName() { return name; }, getContentText() { return String(content); }, getContentType() { return type; },
      setName(n) { name = n; return this; },
      getAs(t) { return makeBlob(content, t, name); }
    };
  }

  class DriveFile {
    constructor(name, blob) {
      this.name = name; this.blob = blob;
      const safe = name.replace(/\.pdf$/i, '') + '.html';
      this.fileName = safe;
      if (pdfDir) fs.writeFileSync(path.join(pdfDir, safe), blob.getContentText(), 'utf8');
    }
    getName() { return this.name; }
    getUrl() { return urlBase + encodeURIComponent(this.fileName); }
  }
  class DriveFolder {
    constructor(name) { this.name = name; this.files = []; }
    getName() { return this.name; }
    createFile(blob) { const f = new DriveFile(blob.getName(), blob); this.files.push(f); files.push(f); return f; }
  }

  const SpreadsheetApp = { getActiveSpreadsheet: () => ss, openById: () => ss };
  const Utilities = { newBlob: (c, t, n) => makeBlob(c, t, n), formatDate };
  const DriveApp = {
    getFoldersByName: (name) => { const hit = folders[name] ? [folders[name]] : []; let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
    createFolder: (name) => { folders[name] = new DriveFolder(name); return folders[name]; }
  };
  const Session = { getActiveUser: () => ({ getEmail: () => state.userEmail }), getEffectiveUser: () => ({ getEmail: () => state.userEmail }) };
  const LockService = { getScriptLock: () => ({ waitLock() { state.lockCount++; }, releaseLock() { state.lockCount--; }, tryLock() { return true; }, hasLock() { return true; } }) };
  const HtmlService = {
    createTemplateFromFile: (name) => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, getContent: () => '<!-- template ' + name + ' -->' }) }),
    createHtmlOutputFromFile: (name) => ({ getContent: () => '<!-- file ' + name + ' -->' }),
    createHtmlOutput: (html) => ({ getContent: () => html, getBlob: () => makeBlob(html, 'text/html', 'out.html') })
  };
  const Logger = { log: () => {} };
  const console_ = { log: () => {}, error: () => {}, warn: () => {} };

  const sandbox = { SpreadsheetApp, Utilities, DriveApp, Session, LockService, HtmlService, Logger, console: console_, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent };
  sandbox.Date = opts.nowMs ? makeFixedDate(opts.nowMs) : Date;
  return { sandbox, ss, folders, files, state };
}

module.exports = { buildSandbox, Sheet, Spreadsheet };
