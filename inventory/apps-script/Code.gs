/**
 * 월드네트웍스 자재 재고 — 구글 시트·드라이브 저장 서버 (Google Apps Script)
 *
 * 하는 일
 *  - 재고 화면(inventory/index.html)이 보내는 요청을 받아 구글 시트에 저장합니다.
 *  - 처음 설정할 때 내 구글 드라이브에 "월드네트웍스 재고관리" 폴더와 시트를 자동으로 만듭니다.
 *  - 매일 새벽 3~4시에 시트 사본을 "백업" 폴더에 자동 저장합니다 (최근 60개 보관).
 *  - 직원별 재고: 본사가 직원에게 출고하면 그 직원 재고에 입고로 잡히고, 직원이 사용·반납하면 차감됩니다.
 *    ("직원", "직원재고" 시트는 처음 쓸 때 자동으로 만들어지며 기존 "품목", "입출고" 시트는 그대로입니다.)
 *
 * 설치 방법은 같은 폴더의 설치안내.md 를 보세요.
 */

const APP_NAME = '월드네트웍스 재고관리';
const TZ = 'Asia/Seoul';
const ITEM_HEAD = ['ID', '구분', '품목명', '규격', '색상', '단위', '최소재고', '현재재고', '등록일시', '수정일시'];
const LOG_HEAD = ['ID', '날짜', '입출고', '품목ID', '품목명', '수량', '메모', '기록일시', '기록기기'];
const EMP_HEAD = ['ID', '이름', '연락처', '메모', '등록일시', '수정일시'];
const ELOG_HEAD = ['ID', '날짜', '구분', '직원ID', '직원이름', '품목ID', '품목명', '수량', '메모', '본사기록ID', '기록일시', '기록기기'];
const HEADS = { '품목': ITEM_HEAD, '입출고': LOG_HEAD, '직원': EMP_HEAD, '직원재고': ELOG_HEAD };
const KEEP_BACKUPS = 60;
const MAX_LOGS_SENT = 500;
const TOKEN_DAYS = 365;

const P = PropertiesService.getScriptProperties();

/* ---------- 입구 ---------- */
function doGet() {
  return out({ ok: true, app: 'inventory', needsSetup: !P.getProperty('PW_HASH') });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: '요청 형식이 잘못되었습니다.' }); }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    return out(handle(req));
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  const a = req.action;
  if (a === 'setup') return setup(req);
  if (a === 'login') return login(req);
  if (!checkToken(req.token)) return { ok: false, error: 'AUTH' };
  switch (a) {
    case 'logout': dropToken(req.token); return { ok: true };
    case 'list': return listAll();
    case 'saveItem': saveItem(req.item || {}, req.device); return listAll('품목을 저장했습니다.');
    case 'deleteItem': deleteItem(req.id); return listAll('품목을 삭제했습니다.');
    case 'addLog': { const m = addLog(req.log || {}, req.device); return listAll(m); }
    case 'cancelLog': cancelLog(req.id); return listAll('기록을 취소하고 재고를 되돌렸습니다.');
    case 'saveEmp': saveEmp(req.emp || {}); return listAll('직원을 저장했습니다.');
    case 'deleteEmp': deleteEmp(req.id); return listAll('직원을 삭제했습니다.');
    case 'addEmpLog': { const m = addEmpLog(req.log || {}, req.device); return listAll(m); }
    case 'cancelEmpLog': cancelEmpLog(req.id); return listAll('직원 기록을 취소하고 재고를 되돌렸습니다.');
    case 'backupNow': dailyBackup(); return listAll('지금 상태를 드라이브에 백업했습니다.');
    case 'changePassword': return changePassword(req);
  }
  return { ok: false, error: '알 수 없는 요청입니다: ' + a };
}

/* ---------- 비밀번호 / 로그인 ---------- */
function hash(pw, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function setup(req) {
  if (P.getProperty('PW_HASH')) return { ok: false, error: '이미 설정되어 있습니다. 비밀번호로 로그인해 주세요.' };
  const pw = String(req.password || '');
  if (pw.length < 4) return { ok: false, error: '비밀번호는 4자 이상으로 정해 주세요.' };
  const salt = Utilities.getUuid();
  P.setProperty('PW_SALT', salt);
  P.setProperty('PW_HASH', hash(pw, salt));
  ensureStore();
  ensureTrigger();
  return { ok: true, token: newToken(req.device) };
}

function login(req) {
  const salt = P.getProperty('PW_SALT');
  if (!salt) return { ok: false, error: '아직 처음 설정이 안 되어 있습니다.' };
  if (hash(String(req.password || ''), salt) !== P.getProperty('PW_HASH')) {
    Utilities.sleep(800);
    return { ok: false, error: '비밀번호가 맞지 않습니다.' };
  }
  ensureStore();
  return { ok: true, token: newToken(req.device) };
}

function changePassword(req) {
  const salt = P.getProperty('PW_SALT');
  if (hash(String(req.oldPassword || ''), salt) !== P.getProperty('PW_HASH')) return { ok: false, error: '지금 비밀번호가 맞지 않습니다.' };
  const pw = String(req.newPassword || '');
  if (pw.length < 4) return { ok: false, error: '새 비밀번호는 4자 이상으로 정해 주세요.' };
  const ns = Utilities.getUuid();
  P.setProperty('PW_SALT', ns);
  P.setProperty('PW_HASH', hash(pw, ns));
  P.setProperty('TOKENS', '{}');   // 다른 기기는 모두 로그아웃
  return { ok: true, token: newToken(req.device) };
}

function tokens() { try { return JSON.parse(P.getProperty('TOKENS') || '{}'); } catch (e) { return {}; } }
function newToken(device) {
  const t = tokens();
  const now = Date.now();
  Object.keys(t).forEach(k => { if (now - t[k].at > TOKEN_DAYS * 864e5) delete t[k]; });
  const keys = Object.keys(t).sort((x, y) => t[x].at - t[y].at);
  while (keys.length >= 20) delete t[keys.shift()];
  const tok = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  t[tok] = { at: now, device: String(device || '').slice(0, 40) };
  P.setProperty('TOKENS', JSON.stringify(t));
  return tok;
}
function checkToken(tok) {
  if (!tok) return false;
  const t = tokens()[tok];
  return !!t && (Date.now() - t.at) < TOKEN_DAYS * 864e5;
}
function dropToken(tok) { const t = tokens(); delete t[tok]; P.setProperty('TOKENS', JSON.stringify(t)); }

/* ---------- 드라이브 폴더 · 시트 ---------- */
function ensureStore() {
  let folder = null, ss = null;
  const fid = P.getProperty('FOLDER_ID');
  if (fid) { try { folder = DriveApp.getFolderById(fid); if (folder.isTrashed()) folder = null; } catch (e) { folder = null; } }
  if (!folder) { folder = DriveApp.createFolder(APP_NAME); P.setProperty('FOLDER_ID', folder.getId()); }

  const bid = P.getProperty('BACKUP_ID');
  let bf = null;
  if (bid) { try { bf = DriveApp.getFolderById(bid); if (bf.isTrashed()) bf = null; } catch (e) { bf = null; } }
  if (!bf) { bf = folder.createFolder('백업'); P.setProperty('BACKUP_ID', bf.getId()); }

  const sid = P.getProperty('SHEET_ID');
  if (sid) { try { ss = SpreadsheetApp.openById(sid); if (DriveApp.getFileById(sid).isTrashed()) ss = null; } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(APP_NAME + ' 시트');
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    P.setProperty('SHEET_ID', ss.getId());
    const first = ss.getSheets()[0];
    first.setName('품목');
    initSheet(first, ITEM_HEAD);
    const lg = ss.insertSheet('입출고');
    initSheet(lg, LOG_HEAD);
    lg.getRange('B:B').setNumberFormat('@');
  }
  return ss;
}

function initSheet(sh, head) {
  sh.clear();
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e2edf5');
  sh.setFrozenRows(1);
  sh.getRange('A:A').setNumberFormat('@');
}

function sheet(name) {
  const ss = ensureStore();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    initSheet(sh, HEADS[name] || LOG_HEAD);
    if (name === '입출고' || name === '직원재고') sh.getRange('B:B').setNumberFormat('@');
  }
  return sh;
}

function fmtTime(d) { return Utilities.formatDate(d || new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function fmtDay(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '');
}
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function clean(v, max) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 80); }
function newId(prefix) { return prefix + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 1e4); }

function readItems() {
  const v = sheet('품목').getDataRange().getValues();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    const x = v[r];
    if (!x[0]) continue;
    out.push({ id: String(x[0]), category: String(x[1] || '기타'), name: String(x[2] || ''), spec: String(x[3] || ''), color: String(x[4] || ''),
      unit: String(x[5] || '개'), minStock: num(x[6]), stock: num(x[7]), row: r + 1 });
  }
  return out;
}

function readLogs() {
  const sh = sheet('입출고');
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    const x = v[r];
    if (!x[0]) continue;
    out.push({ id: String(x[0]), date: fmtDay(x[1]), type: x[2] === '출고' ? 'out' : 'in', itemId: String(x[3]), itemName: String(x[4] || ''),
      qty: num(x[5]), memo: String(x[6] || ''), at: x[7] instanceof Date ? fmtTime(x[7]) : String(x[7] || ''), row: r + 1 });
  }
  return out;
}

function readEmps() {
  const v = sheet('직원').getDataRange().getValues();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    const x = v[r];
    if (!x[0]) continue;
    out.push({ id: String(x[0]), name: String(x[1] || ''), phone: String(x[2] || ''), memo: String(x[3] || ''), row: r + 1 });
  }
  return out;
}

const ETYPE = { '입고': 'in', '사용': 'use', '반납': 'return' };
const ETYPE_KO = { in: '입고', use: '사용', 'return': '반납' };
function readEmpLogs() {
  const v = sheet('직원재고').getDataRange().getValues();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    const x = v[r];
    if (!x[0]) continue;
    out.push({ id: String(x[0]), date: fmtDay(x[1]), type: ETYPE[x[2]] || 'use', empId: String(x[3]), empName: String(x[4] || ''),
      itemId: String(x[5]), itemName: String(x[6] || ''), qty: num(x[7]), memo: String(x[8] || ''), link: String(x[9] || ''),
      at: x[10] instanceof Date ? fmtTime(x[10]) : String(x[10] || ''), row: r + 1 });
  }
  return out;
}

/** 직원·품목별 받은 수량/사용/반납/잔량 (전체 기록으로 계산) */
function empBalances(elogs) {
  const m = {};
  elogs.forEach(l => {
    const k = l.empId + '|' + l.itemId;
    const b = m[k] || (m[k] = { empId: l.empId, itemId: l.itemId, itemName: l.itemName, inQty: 0, used: 0, returned: 0, bal: 0 });
    if (l.type === 'in') b.inQty += l.qty; else if (l.type === 'return') b.returned += l.qty; else b.used += l.qty;
    b.bal = b.inQty - b.used - b.returned;
  });
  return Object.keys(m).map(k => m[k]);
}
function empBal(empId, itemId) {
  const b = empBalances(readEmpLogs().filter(l => l.empId === empId && l.itemId === itemId))[0];
  return b ? b.bal : 0;
}

function itemLabel(it) { return [it.name, it.spec, it.color].filter(String).join(' · '); }

/* ---------- 읽기 ---------- */
function listAll(message) {
  const items = readItems().map(i => { delete i.row; return i; });
  const logs = readLogs();
  logs.sort((a, b) => b.row - a.row);   // 시트 아래쪽(나중에 쓴 것)이 먼저
  const sent = logs.slice(0, MAX_LOGS_SENT).map(l => { delete l.row; return l; });
  const emps = readEmps().map(e => { delete e.row; return e; });
  const elogs = readEmpLogs();
  const empStock = empBalances(elogs);
  elogs.sort((a, b) => b.row - a.row);
  const esent = elogs.slice(0, MAX_LOGS_SENT * 2).map(l => { delete l.row; return l; });
  return {
    ok: true, message: message || '', items, logs: sent, logTotal: logs.length,
    employees: emps, empLogs: esent, empLogTotal: elogs.length, empStock,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + P.getProperty('SHEET_ID'),
    folderUrl: 'https://drive.google.com/drive/folders/' + P.getProperty('FOLDER_ID'),
    lastBackup: P.getProperty('LAST_BACKUP') || '', serverTime: fmtTime()
  };
}

/* ---------- 쓰기 ---------- */
function saveItem(it, device) {
  const sh = sheet('품목');
  const data = {
    category: clean(it.category, 10) || '기타', name: clean(it.name, 40), spec: clean(it.spec, 40), color: clean(it.color, 20),
    unit: clean(it.unit, 6) || '개', minStock: Math.max(0, Math.floor(num(it.minStock)))
  };
  if (!data.name) throw new Error('품목명을 입력해 주세요.');
  const now = fmtTime();
  if (it.id) {
    const cur = readItems().find(x => x.id === it.id);
    if (!cur) throw new Error('품목을 찾지 못했습니다. 다른 기기에서 삭제했을 수 있습니다.');
    sh.getRange(cur.row, 2, 1, 6).setValues([[data.category, data.name, data.spec, data.color, data.unit, data.minStock]]);
    sh.getRange(cur.row, 10).setValue(now);
    return;
  }
  const init = Math.max(0, Math.floor(num(it.initStock)));
  const id = newId('I');
  sh.appendRow([id, data.category, data.name, data.spec, data.color, data.unit, data.minStock, init, now, now]);
  if (init > 0) {
    sheet('입출고').appendRow([newId('L'), Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), '입고', id, itemLabel(data), init, '처음 등록 (기초 재고)', now, clean(device, 40)]);
  }
}

function deleteItem(id) {
  const cur = readItems().find(x => x.id === id);
  if (!cur) return;
  sheet('품목').deleteRow(cur.row);
}

function addLog(l, device) {
  const it = readItems().find(x => x.id === l.itemId);
  if (!it) throw new Error('품목을 찾지 못했습니다. 화면을 새로고침해 주세요.');
  const qty = Math.floor(num(l.qty));
  if (!(qty > 0)) throw new Error('수량을 1 이상으로 입력해 주세요.');
  const type = l.type === 'out' ? 'out' : 'in';
  if (type === 'out' && qty > it.stock) throw new Error('현재 재고가 ' + it.stock + it.unit + '라서 ' + qty + ' 출고할 수 없습니다.');
  let emp = null;
  if (type === 'out' && l.empId) {
    emp = readEmps().find(x => x.id === l.empId);
    if (!emp) throw new Error('직원을 찾지 못했습니다. 화면을 새로고침해 주세요.');
  }
  const next = type === 'in' ? it.stock + qty : it.stock - qty;
  const day = dayOf(l.date);
  const now = fmtTime();
  const lid = newId('L');
  const memo = clean(l.memo, 80);
  sheet('입출고').appendRow([lid, day, type === 'in' ? '입고' : '출고', it.id, itemLabel(it), qty, emp ? clean('[직원 출고] ' + emp.name + (memo ? ' · ' + memo : ''), 80) : memo, now, clean(device, 40)]);
  const sh = sheet('품목');
  sh.getRange(it.row, 8).setValue(next);
  sh.getRange(it.row, 10).setValue(now);
  if (emp) {
    sheet('직원재고').appendRow([newId('E'), day, '입고', emp.id, emp.name, it.id, itemLabel(it), qty, memo || '본사 출고', lid, now, clean(device, 40)]);
    return itemLabel(it) + ' ' + qty + it.unit + ' ' + emp.name + '님에게 출고했습니다. 본사 재고 ' + next + it.unit + ', ' + emp.name + '님 재고 ' + empBal(emp.id, it.id) + it.unit;
  }
  return itemLabel(it) + ' ' + qty + it.unit + ' ' + (type === 'in' ? '입고' : '출고') + ' 기록했습니다. 현재 ' + next + it.unit;
}

function dayOf(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

function cancelLog(id) {
  const lg = readLogs().find(x => x.id === id);
  if (!lg) return;
  const it = readItems().find(x => x.id === lg.itemId);
  // 직원과 이어진 기록(직원 출고·직원 반납)은 직원 쪽 기록도 함께 지움
  const el = readEmpLogs().find(x => x.link === id);
  if (el) {
    const unit = it ? it.unit : '개';
    if (el.type === 'in' && empBal(el.empId, el.itemId) < el.qty)
      throw new Error(el.empName + '님이 이미 일부를 사용·반납해서 이 출고를 취소할 수 없습니다. 직원 재고에서 사용 기록부터 취소해 주세요. (남은 ' + empBal(el.empId, el.itemId) + unit + ')');
    if (el.type === 'return' && it && it.stock < lg.qty)
      throw new Error('본사 재고가 ' + it.stock + unit + '라서 이 반납을 취소할 수 없습니다.');
  }
  if (it) {
    const back = lg.type === 'in' ? it.stock - lg.qty : it.stock + lg.qty;
    const sh = sheet('품목');
    sh.getRange(it.row, 8).setValue(Math.max(0, back));
    sh.getRange(it.row, 10).setValue(fmtTime());
  }
  sheet('입출고').deleteRow(lg.row);
  if (el) sheet('직원재고').deleteRow(el.row);
}

/* ---------- 직원 ---------- */
function saveEmp(e) {
  const sh = sheet('직원');
  const name = clean(e.name, 20), phone = clean(e.phone, 20), memo = clean(e.memo, 60);
  if (!name) throw new Error('직원 이름을 입력해 주세요.');
  const all = readEmps();
  if (all.some(x => x.name === name && x.id !== e.id)) throw new Error('같은 이름의 직원이 이미 있습니다.');
  const now = fmtTime();
  if (e.id) {
    const cur = all.find(x => x.id === e.id);
    if (!cur) throw new Error('직원을 찾지 못했습니다. 다른 기기에서 삭제했을 수 있습니다.');
    sh.getRange(cur.row, 2, 1, 3).setValues([[name, phone, memo]]);
    sh.getRange(cur.row, 6).setValue(now);
    return;
  }
  sh.appendRow([newId('P'), name, phone, memo, now, now]);
}

function deleteEmp(id) {
  const cur = readEmps().find(x => x.id === id);
  if (!cur) return;
  const left = empBalances(readEmpLogs().filter(l => l.empId === id)).filter(b => b.bal > 0);
  if (left.length) throw new Error(cur.name + '님이 아직 자재를 갖고 있습니다 (' + left.map(b => b.itemName + ' ' + b.bal).join(', ') + '). 사용 또는 반납 처리 후 삭제해 주세요.');
  sheet('직원').deleteRow(cur.row);
}

/** 직원 기록: use(사용) / return(반납 → 본사 재고로 입고) / own(본사 출고 없이 이미 갖고 있던 수량 등록) */
function addEmpLog(l, device) {
  const emp = readEmps().find(x => x.id === l.empId);
  if (!emp) throw new Error('직원을 찾지 못했습니다. 화면을 새로고침해 주세요.');
  const it = readItems().find(x => x.id === l.itemId);
  if (!it) throw new Error('품목을 찾지 못했습니다. 화면을 새로고침해 주세요.');
  const qty = Math.floor(num(l.qty));
  if (!(qty > 0)) throw new Error('수량을 1 이상으로 입력해 주세요.');
  const type = l.type === 'return' ? 'return' : l.type === 'own' ? 'own' : 'use';
  const bal = empBal(emp.id, it.id);
  if (type !== 'own' && qty > bal) throw new Error(emp.name + '님의 ' + itemLabel(it) + ' 재고가 ' + bal + it.unit + '라서 ' + qty + ' ' + (type === 'use' ? '사용' : '반납') + '할 수 없습니다.');
  const day = dayOf(l.date), now = fmtTime(), memo = clean(l.memo, 80);
  let link = '';
  if (type === 'return') {
    link = newId('L');
    sheet('입출고').appendRow([link, day, '입고', it.id, itemLabel(it), qty, clean('[직원 반납] ' + emp.name + (memo ? ' · ' + memo : ''), 80), now, clean(device, 40)]);
    const sh = sheet('품목');
    sh.getRange(it.row, 8).setValue(it.stock + qty);
    sh.getRange(it.row, 10).setValue(now);
  }
  const ko = type === 'own' ? '입고' : ETYPE_KO[type];
  sheet('직원재고').appendRow([newId('E'), day, ko, emp.id, emp.name, it.id, itemLabel(it), qty, memo || (type === 'own' ? '기존 보유분 등록' : ''), link, now, clean(device, 40)]);
  const left = empBal(emp.id, it.id);
  const what = type === 'use' ? '사용' : type === 'return' ? '본사로 반납' : '보유 등록';
  return emp.name + '님 ' + itemLabel(it) + ' ' + qty + it.unit + ' ' + what + ' 기록했습니다. 남은 재고 ' + left + it.unit;
}

function cancelEmpLog(id) {
  const el = readEmpLogs().find(x => x.id === id);
  if (!el) return;
  if (el.link) { cancelLog(el.link); if (readEmpLogs().some(x => x.id === id)) sheet('직원재고').deleteRow(readEmpLogs().find(x => x.id === id).row); return; }
  if (el.type === 'in') {
    const bal = empBal(el.empId, el.itemId);
    if (bal < el.qty) throw new Error(el.empName + '님이 이미 일부를 사용·반납해서 취소할 수 없습니다. 사용 기록부터 취소해 주세요. (남은 ' + bal + ')');
  }
  sheet('직원재고').deleteRow(el.row);
}

/* ---------- 자동 백업 ---------- */
function ensureTrigger() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'dailyBackup');
  if (!has) ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(3).inTimezone(TZ).create();
}

function dailyBackup() {
  const ss = ensureStore();
  const bf = DriveApp.getFolderById(P.getProperty('BACKUP_ID'));
  const name = APP_NAME + ' 백업 ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HHmm');
  DriveApp.getFileById(ss.getId()).makeCopy(name, bf);
  const files = [];
  const it = bf.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(KEEP_BACKUPS).forEach(f => f.setTrashed(true));
  P.setProperty('LAST_BACKUP', fmtTime());
}

/** 설치 확인용: 스크립트 편집기에서 한 번 실행하면 권한을 승인하고 폴더·시트·자동 백업을 미리 만듭니다. */
function firstRun() {
  ensureStore();
  ensureTrigger();
  Logger.log('준비 완료. 시트: https://docs.google.com/spreadsheets/d/' + P.getProperty('SHEET_ID'));
}
