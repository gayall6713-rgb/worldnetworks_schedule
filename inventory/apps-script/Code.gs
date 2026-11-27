/**
 * 월드네트웍스 자재 재고 — 구글 시트·드라이브 저장 서버 (Google Apps Script)
 *
 * 하는 일
 *  - 재고 화면(inventory/index.html)이 보내는 요청을 받아 구글 시트에 저장합니다.
 *  - 처음 설정할 때 내 구글 드라이브에 "월드네트웍스 재고관리" 폴더와 시트를 자동으로 만듭니다.
 *  - 매일 새벽 3~4시에 시트 사본을 "백업" 폴더에 자동 저장합니다 (최근 60개 보관).
 *  - 직원별 재고: 본사가 직원에게 출고하면 그 직원 재고에 입고로 잡히고, 직원이 사용·반납하면 차감됩니다.
 *    ("직원", "직원재고" 시트는 처음 쓸 때 자동으로 만들어지며 기존 "품목", "입출고" 시트는 그대로입니다.)
 *  - 사람별 로그인과 권한: 직원마다 이름 + 개인 비밀번호로 들어오고, 권한(관리자/직원)에 따라 할 수 있는 일이 다릅니다.
 *    예전 공용 비밀번호(본사·직원용)도 관리자가 끌 때까지 그대로 됩니다.
 *  - 재고 미달 알림: 본사 재고가 최소재고 이하로 떨어지면 정해 둔 이메일로 바로 알리고, 매일 아침 부족 목록을 보냅니다.
 *  - 변경 기록: 누가 언제 어느 기기에서 무엇을 바꿨는지 "변경기록" 시트에 한 줄씩 남습니다.
 *
 * 설치 방법은 같은 폴더의 설치안내.md 를 보세요.
 */

const APP_NAME = '월드네트웍스 재고관리';
const TZ = 'Asia/Seoul';
const ITEM_HEAD = ['ID', '구분', '품목명', '규격', '색상', '단위', '최소재고', '현재재고', '등록일시', '수정일시', '적정재고'];
const LOG_HEAD = ['ID', '날짜', '입출고', '품목ID', '품목명', '수량', '메모', '기록일시', '기록기기'];
const EMP_HEAD = ['ID', '이름', '연락처', '메모', '등록일시', '수정일시', '권한'];
const AUDIT_HEAD = ['일시', '이름', '권한', '기기', '작업', '내용'];
const ELOG_HEAD = ['ID', '날짜', '구분', '직원ID', '직원이름', '품목ID', '품목명', '수량', '메모', '본사기록ID', '기록일시', '기록기기'];
const HEADS = { '품목': ITEM_HEAD, '입출고': LOG_HEAD, '직원': EMP_HEAD, '직원재고': ELOG_HEAD, '변경기록': AUDIT_HEAD };
const MAX_AUDIT_SENT = 1000;
const KEEP_BACKUPS = 60;
const MAX_LOGS_SENT = 500;
const TOKEN_DAYS = 365;

const P = PropertiesService.getScriptProperties();
let ROLE = '';   // 'admin'(본사) 또는 'emp'(직원)
let USER = { uid: '', name: '', device: '' };   // 지금 요청한 사람 (개인 로그인이면 uid = 직원 ID)

/* ---------- 입구 ---------- */
function doGet() {
  return out({ ok: true, app: 'inventory', needsSetup: !P.getProperty('PW_HASH') });
}

function doPost(e) {
  let req;
  ROLE = ''; USER = { uid: '', name: '', device: '' };
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
  const t = checkToken(req.token);
  if (!t) return { ok: false, error: 'AUTH' };
  ROLE = t.role;
  USER = { uid: t.uid || '', name: t.name || (ROLE === 'emp' ? '직원 공용' : '본사 공용'), device: clean(req.device, 40) };
  // 개인 로그인이면 지금 직원 목록에서 이름·권한을 다시 확인 (삭제됐거나 권한이 바뀌었을 수 있음)
  if (USER.uid) {
    const me = readEmps().find(x => x.id === USER.uid);
    if (!me) { dropToken(req.token); return { ok: false, error: 'AUTH' }; }
    USER.name = me.name;
    ROLE = me.role === '관리자' ? 'admin' : 'emp';
  }
  // 직원 권한은 직원 재고 일만 할 수 있음
  if (ROLE === 'emp') {
    const EMP_OK = { logout: 1, list: 1, saveEmp: 1, addEmpLog: 1, cancelEmpLog: 1, myPassword: 1 };
    if (!EMP_OK[a]) return { ok: false, error: '직원 권한으로는 할 수 없는 일입니다. 관리자에게 부탁해 주세요.' };
    if (a === 'saveEmp' && (USER.uid || (req.emp && req.emp.id))) return { ok: false, error: '직원 정보 수정은 관리자만 할 수 있습니다.' };
    if (a === 'addEmpLog' && USER.uid && req.log && req.log.empId !== USER.uid) return { ok: false, error: '내 자재만 기록할 수 있습니다.' };
    if (a === 'cancelEmpLog') {
      const el = readEmpLogs().find(x => x.id === req.id);
      if (el && el.link) return { ok: false, error: '본사 출고·반납과 이어진 기록은 관리자만 취소할 수 있습니다.' };
      if (el && USER.uid && el.empId !== USER.uid) return { ok: false, error: '내 기록만 취소할 수 있습니다.' };
    }
  }
  if (a === 'myPassword' && !USER.uid) return { ok: false, error: '공용 비밀번호로 들어온 기기는 내 비밀번호를 바꿀 수 없습니다. 이름과 개인 비밀번호로 로그인해 주세요.' };
  const d = req.device;
  let m;
  switch (a) {
    case 'logout': audit('로그아웃', ''); dropToken(req.token); return { ok: true };
    case 'list': return listAll();
    case 'audit': return readAudit();
    case 'saveItem': audit(req.item && req.item.id ? '품목 수정' : '품목 추가', saveItem(req.item || {}, d)); return listAll('품목을 저장했습니다.');
    case 'deleteItem': audit('품목 삭제', deleteItem(req.id)); return listAll('품목을 삭제했습니다.');
    case 'addLog': m = addLog(req.log || {}, d); audit(req.log && req.log.type === 'out' ? '출고' : '입고', m); return listAll(m);
    case 'cancelLog': audit('입출고 취소', cancelLog(req.id)); return listAll('기록을 취소하고 재고를 되돌렸습니다.');
    case 'saveEmp': audit(req.emp && req.emp.id ? '직원 수정' : '직원 추가', saveEmp(req.emp || {})); return listAll('직원을 저장했습니다.');
    case 'deleteEmp': audit('직원 삭제', deleteEmp(req.id)); return listAll('직원을 삭제했습니다.');
    case 'addEmpLog': m = addEmpLog(req.log || {}, d); audit('직원 ' + ({ own: '입고', 'return': '반납' }[req.log && req.log.type] || '사용'), m); return listAll(m);
    case 'cancelEmpLog': audit('직원 기록 취소', cancelEmpLog(req.id)); return listAll('직원 기록을 취소하고 재고를 되돌렸습니다.');
    case 'backupNow': dailyBackup(); audit('백업', '지금 백업'); return listAll('지금 상태를 드라이브에 백업했습니다.');
    case 'changePassword': return changePassword(req);
    case 'setEmpPassword': return setEmpPassword(req);
    case 'setUserLogin': m = setUserLogin(req); audit('로그인 설정', m); return listAll(m);
    case 'myPassword': return myPassword(req);
    case 'setAlert': m = setAlert(req); audit('알림 설정', m); return listAll(m);
    case 'testAlert': m = sendLowMail('테스트'); audit('알림 테스트', m); return listAll(m);
    case 'assignOut': m = assignOut(req.id, req.empId, d); audit('직원 지정', m); return listAll(m);
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
  return { ok: true, role: 'admin', token: newToken(req.device, 'admin') };
}

function login(req) {
  const salt = P.getProperty('PW_SALT');
  if (!salt) return { ok: false, error: '아직 처음 설정이 안 되어 있습니다.' };
  ensureStore();
  const pw = String(req.password || '');
  const name = clean(req.name, 20);
  USER = { uid: '', name: name, device: clean(req.device, 40) };
  if (name) {   // 이름 + 개인 비밀번호
    const emps = readEmps();
    const key = s => String(s || '').replace(/\s+/g, '');
    let hit = emps.filter(x => key(x.name) === key(name));
    if (!hit.length) hit = emps.filter(x => key(x.name).indexOf(key(name)) === 0);
    const pws = userPws();
    const emp = hit.length === 1 ? hit[0] : null;
    const rec = emp && pws[emp.id];
    if (!emp || !rec || hash(pw, rec.s) !== rec.h) {
      Utilities.sleep(800);
      ROLE = '';
      audit('로그인 실패', '입력한 이름: ' + name);
      if (emp && !rec) return { ok: false, error: emp.name + '님은 아직 개인 비밀번호가 없습니다. 관리자에게 비밀번호를 받아 주세요.' };
      return { ok: false, error: '이름 또는 비밀번호가 맞지 않습니다.' };
    }
    ROLE = emp.role === '관리자' ? 'admin' : 'emp';
    USER = { uid: emp.id, name: emp.name, device: clean(req.device, 40) };
    audit('로그인', '');
    return { ok: true, role: ROLE, token: newToken(req.device, ROLE, emp) };
  }
  let role = '';
  if (hash(pw, salt) === P.getProperty('PW_HASH')) role = 'admin';
  else if (P.getProperty('EMP_PW_HASH') && hash(pw, P.getProperty('EMP_PW_SALT')) === P.getProperty('EMP_PW_HASH')) role = 'emp';
  if (!role) {
    Utilities.sleep(800);
    USER.name = '(이름 없음)';
    audit('로그인 실패', '공용 비밀번호 틀림');
    return { ok: false, error: '비밀번호가 맞지 않습니다. 개인 비밀번호를 받았다면 이름도 함께 넣어 주세요.' };
  }
  ROLE = role;
  USER.name = role === 'emp' ? '직원 공용' : '본사 공용';
  audit('로그인', '공용 비밀번호');
  return { ok: true, role, token: newToken(req.device, role) };
}

/* ---------- 사람별 로그인 ---------- */
function userPws() { try { return JSON.parse(P.getProperty('USER_PW') || '{}'); } catch (e) { return {}; } }
function saveUserPws(m) { P.setProperty('USER_PW', JSON.stringify(m)); }
function dropUserTokens(uid) {
  const t = tokens();
  Object.keys(t).forEach(k => { if (t[k].uid === uid) delete t[k]; });
  P.setProperty('TOKENS', JSON.stringify(t));
}

/** 관리자가 한 사람의 권한과 로그인 비밀번호를 정함. password 빈 값이면 비밀번호는 그대로, off면 로그인 끔 */
function setUserLogin(req) {
  const emp = readEmps().find(x => x.id === req.empId);
  if (!emp) throw new Error('직원을 찾지 못했습니다. 화면을 새로고침해 주세요.');
  const role = req.role === '관리자' ? '관리자' : '직원';
  const out = [];
  if (role !== emp.role) {
    if (emp.id === USER.uid && role !== '관리자') throw new Error('내 관리자 권한은 내가 직접 뺄 수 없습니다. 다른 관리자나 본사 공용 비밀번호로 바꿔 주세요.');
    sheet('직원').getRange(emp.row, 7).setValue(role);
    out.push('권한 ' + emp.role + ' → ' + role);
  }
  const pws = userPws();
  if (req.off) {
    if (pws[emp.id]) { delete pws[emp.id]; saveUserPws(pws); dropUserTokens(emp.id); out.push('개인 로그인 끔'); }
  } else if (req.password) {
    const pw = String(req.password);
    if (pw.length < 4) throw new Error('비밀번호는 4자 이상으로 정해 주세요.');
    const s = Utilities.getUuid();
    pws[emp.id] = { s: s, h: hash(pw, s) };
    saveUserPws(pws);
    if (emp.id !== USER.uid) dropUserTokens(emp.id);
    out.push('비밀번호 새로 정함');
  }
  if (!out.length) return emp.name + ': 바뀐 것이 없습니다.';
  return emp.name + ': ' + out.join(', ');
}

/** 개인 로그인한 사람이 자기 비밀번호를 바꿈 */
function myPassword(req) {
  const pws = userPws();
  const rec = pws[USER.uid];
  if (!rec || hash(String(req.oldPassword || ''), rec.s) !== rec.h) return { ok: false, error: '지금 비밀번호가 맞지 않습니다.' };
  const pw = String(req.newPassword || '');
  if (pw.length < 4) return { ok: false, error: '새 비밀번호는 4자 이상으로 정해 주세요.' };
  const s = Utilities.getUuid();
  pws[USER.uid] = { s: s, h: hash(pw, s) };
  saveUserPws(pws);
  dropUserTokens(USER.uid);
  audit('내 비밀번호 변경', '');
  const emp = readEmps().find(x => x.id === USER.uid);
  return { ok: true, role: ROLE, token: newToken(req.device, ROLE, emp) };
}

/** 본사에서 직원용 비밀번호를 정하거나 바꿈 (빈 값이면 직원 로그인 끔). 바꾸면 직원 기기는 다시 로그인 */
function setEmpPassword(req) {
  const pw = String(req.password || '');
  if (pw && pw.length < 4) return { ok: false, error: '직원용 비밀번호는 4자 이상으로 정해 주세요.' };
  if (pw && hash(pw, P.getProperty('PW_SALT')) === P.getProperty('PW_HASH')) return { ok: false, error: '본사 비밀번호와 다르게 정해 주세요.' };
  const t = tokens();
  Object.keys(t).forEach(k => { if (t[k].role === 'emp' && !t[k].uid) delete t[k]; });   // 공용 비밀번호 직원 기기만
  P.setProperty('TOKENS', JSON.stringify(t));
  if (!pw) { P.deleteProperty('EMP_PW_HASH'); P.deleteProperty('EMP_PW_SALT'); audit('직원 공용 비밀번호', '끔'); return listAll('직원용 비밀번호를 껐습니다.'); }
  const salt = Utilities.getUuid();
  P.setProperty('EMP_PW_SALT', salt);
  P.setProperty('EMP_PW_HASH', hash(pw, salt));
  audit('직원 공용 비밀번호', '새로 정함');
  return listAll('직원용 비밀번호를 정했습니다. 직원들은 이 비밀번호로 들어오면 직원 화면만 보입니다.');
}

function changePassword(req) {
  const salt = P.getProperty('PW_SALT');
  if (hash(String(req.oldPassword || ''), salt) !== P.getProperty('PW_HASH')) return { ok: false, error: '지금 비밀번호가 맞지 않습니다.' };
  const pw = String(req.newPassword || '');
  if (pw.length < 4) return { ok: false, error: '새 비밀번호는 4자 이상으로 정해 주세요.' };
  const ns = Utilities.getUuid();
  P.setProperty('PW_SALT', ns);
  P.setProperty('PW_HASH', hash(pw, ns));
  // 공용 비밀번호로 들어온 다른 기기는 모두 로그아웃 (개인 로그인은 그대로)
  const t = tokens();
  Object.keys(t).forEach(k => { if (!t[k].uid) delete t[k]; });
  P.setProperty('TOKENS', JSON.stringify(t));
  audit('본사 공용 비밀번호 변경', '');
  return { ok: true, role: 'admin', token: newToken(req.device, 'admin', USER.uid ? readEmps().find(x => x.id === USER.uid) : null) };
}

function tokens() { try { return JSON.parse(P.getProperty('TOKENS') || '{}'); } catch (e) { return {}; } }
function newToken(device, role, emp) {
  const t = tokens();
  const now = Date.now();
  Object.keys(t).forEach(k => { if (now - t[k].at > TOKEN_DAYS * 864e5) delete t[k]; });
  const keys = Object.keys(t).sort((x, y) => t[x].at - t[y].at);
  while (keys.length >= 60) delete t[keys.shift()];
  const tok = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  t[tok] = { at: now, device: String(device || '').slice(0, 40), role: role === 'emp' ? 'emp' : 'admin' };
  if (emp) t[tok].uid = emp.id;
  P.setProperty('TOKENS', JSON.stringify(t));
  return tok;
}
function checkToken(tok) {
  if (!tok) return null;
  const t = tokens()[tok];
  if (!t || (Date.now() - t.at) >= TOKEN_DAYS * 864e5) return null;
  return { role: t.role === 'emp' ? 'emp' : 'admin', uid: t.uid || '' };   // 예전 기기(역할 없음)는 본사
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
  const sh = sheet('품목');
  if (sh.getRange(1, 11).getValue() !== '적정재고') sh.getRange(1, 11).setValue('적정재고').setFontWeight('bold').setBackground('#e2edf5');
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    const x = v[r];
    if (!x[0]) continue;
    out.push({ id: String(x[0]), category: String(x[1] || '기타'), name: String(x[2] || ''), spec: String(x[3] || ''), color: String(x[4] || ''),
      unit: String(x[5] || '개'), minStock: num(x[6]), stock: num(x[7]), target: num(x[10]), row: r + 1 });
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
  const sh = sheet('직원');
  if (sh.getRange(1, 7).getValue() !== '권한') sh.getRange(1, 7).setValue('권한').setFontWeight('bold').setBackground('#e2edf5');
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    const x = v[r];
    if (!x[0]) continue;
    out.push({ id: String(x[0]), name: String(x[1] || ''), phone: String(x[2] || ''), memo: String(x[3] || ''), role: x[6] === '관리자' ? '관리자' : '직원', row: r + 1 });
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

/** 입출고·직원재고 시트 "기록기기" 칸: 누가 + 어느 기기 */
function who(device) { return clean([USER.name, clean(device, 40)].filter(String).join(' · '), 60); }

/* ---------- 변경 기록 ---------- */
function audit(action, detail) {
  try {
    sheet('변경기록').appendRow([fmtTime(), USER.name || '', ROLE === 'emp' ? '직원' : ROLE === 'admin' ? '관리자' : '', USER.device || '', action, clean(detail, 300)]);
  } catch (e) {}
}
function readAudit() {
  const sh = sheet('변경기록');
  const n = sh.getLastRow() - 1;
  if (n < 1) return { ok: true, audit: [], auditTotal: 0 };
  const k = Math.min(n, MAX_AUDIT_SENT);
  const v = sh.getRange(sh.getLastRow() - k + 1, 1, k, 6).getValues();
  const rows = v.reverse().map(x => ({ at: x[0] instanceof Date ? fmtTime(x[0]) : String(x[0] || ''), name: String(x[1] || ''), role: String(x[2] || ''), device: String(x[3] || ''), action: String(x[4] || ''), detail: String(x[5] || '') }));
  return { ok: true, audit: rows, auditTotal: n };
}

function itemLabel(it) { return [it.name, it.spec, it.color].filter(String).join(' · '); }

/* ---------- 읽기 ---------- */
function listAll(message) {
  const items = readItems().map(i => { delete i.row; return i; });
  const logs = readLogs();
  logs.sort((a, b) => b.row - a.row);   // 시트 아래쪽(나중에 쓴 것)이 먼저
  const sent = logs.slice(0, MAX_LOGS_SENT).map(l => { delete l.row; return l; });
  const pws = userPws();
  const emps = readEmps().map(e => { delete e.row; e.hasPw = !!pws[e.id]; return e; });
  let elogs = readEmpLogs();
  if (ROLE === 'emp' && USER.uid) elogs = elogs.filter(l => l.empId === USER.uid);   // 개인 로그인 직원은 내 것만
  const empStock = empBalances(elogs);
  elogs.sort((a, b) => b.row - a.row);
  const esent = elogs.slice(0, MAX_LOGS_SENT * 2).map(l => { delete l.row; return l; });
  const me = { uid: USER.uid, name: USER.name, personal: !!USER.uid };
  if (ROLE === 'emp') {
    return { ok: true, role: 'emp', me, message: message || '', items: items.map(i => ({ id: i.id, category: i.category, name: i.name, spec: i.spec, color: i.color, unit: i.unit })),
      logs: [], logTotal: 0, employees: emps.map(e => ({ id: e.id, name: e.name })), empLogs: esent, empLogTotal: elogs.length, empStock, serverTime: fmtTime() };
  }
  return {
    ok: true, role: 'admin', me, empPwSet: !!P.getProperty('EMP_PW_HASH'), message: message || '', items, logs: sent, logTotal: logs.length,
    employees: emps, empLogs: esent, empLogTotal: elogs.length, empStock,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + P.getProperty('SHEET_ID'),
    folderUrl: 'https://drive.google.com/drive/folders/' + P.getProperty('FOLDER_ID'),
    lastBackup: P.getProperty('LAST_BACKUP') || '', alert: alertSettings(), serverTime: fmtTime()
  };
}

/* ---------- 쓰기 ---------- */
function saveItem(it, device) {
  const sh = sheet('품목');
  const data = {
    category: clean(it.category, 10) || '기타', name: clean(it.name, 40), spec: clean(it.spec, 40), color: clean(it.color, 20),
    unit: clean(it.unit, 6) || '개', minStock: Math.max(0, Math.floor(num(it.minStock))), target: Math.max(0, Math.floor(num(it.target)))
  };
  if (!data.name) throw new Error('품목명을 입력해 주세요.');
  const now = fmtTime();
  if (it.id) {
    const cur = readItems().find(x => x.id === it.id);
    if (!cur) throw new Error('품목을 찾지 못했습니다. 다른 기기에서 삭제했을 수 있습니다.');
    sh.getRange(cur.row, 2, 1, 6).setValues([[data.category, data.name, data.spec, data.color, data.unit, data.minStock]]);
    sh.getRange(cur.row, 10, 1, 2).setValues([[now, data.target || '']]);
    const KO = { category: '구분', name: '품목명', spec: '규격', color: '색상', unit: '단위', minStock: '최소재고', target: '적정재고' };
    const ch = Object.keys(KO).filter(k => String(cur[k]) !== String(data[k])).map(k => KO[k] + ' ' + (cur[k] === '' ? '(빈칸)' : cur[k]) + ' → ' + (data[k] === '' ? '(빈칸)' : data[k]));
    return itemLabel(cur) + (ch.length ? ': ' + ch.join(', ') : ': 바뀐 것 없음');
  }
  const init = Math.max(0, Math.floor(num(it.initStock)));
  const id = newId('I');
  sh.appendRow([id, data.category, data.name, data.spec, data.color, data.unit, data.minStock, init, now, now, data.target || '']);
  if (init > 0) {
    sheet('입출고').appendRow([newId('L'), Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), '입고', id, itemLabel(data), init, '처음 등록 (기초 재고)', now, who(device)]);
  }
  return '[' + data.category + '] ' + itemLabel(data) + ' · 최소재고 ' + data.minStock + (init ? ' · 기초 재고 ' + init + data.unit : '');
}

function deleteItem(id) {
  const cur = readItems().find(x => x.id === id);
  if (!cur) return '';
  sheet('품목').deleteRow(cur.row);
  return '[' + cur.category + '] ' + itemLabel(cur) + ' (삭제 때 재고 ' + cur.stock + cur.unit + ')';
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
  sheet('입출고').appendRow([lid, day, type === 'in' ? '입고' : '출고', it.id, itemLabel(it), qty, emp ? clean('[직원 출고] ' + emp.name + (memo ? ' · ' + memo : ''), 80) : memo, now, who(device)]);
  const sh = sheet('품목');
  sh.getRange(it.row, 8).setValue(next);
  sh.getRange(it.row, 10).setValue(now);
  if (type === 'out' && it.minStock > 0 && it.stock > it.minStock && next <= it.minStock) instantAlert(it, next);
  if (emp) {
    sheet('직원재고').appendRow([newId('E'), day, '입고', emp.id, emp.name, it.id, itemLabel(it), qty, memo || '본사 출고', lid, now, who(device)]);
    return itemLabel(it) + ' ' + qty + it.unit + ' ' + emp.name + '님에게 출고했습니다. 본사 재고 ' + next + it.unit + ', ' + emp.name + '님 재고 ' + empBal(emp.id, it.id) + it.unit;
  }
  return itemLabel(it) + ' ' + qty + it.unit + ' ' + (type === 'in' ? '입고' : '출고') + ' 기록했습니다. 현재 ' + next + it.unit;
}

function dayOf(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

function cancelLog(id) {
  const lg = readLogs().find(x => x.id === id);
  if (!lg) return '';
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
  return lg.date + ' ' + (lg.type === 'in' ? '입고' : '출고') + ' ' + lg.itemName + ' ' + lg.qty + (lg.memo ? ' (' + lg.memo + ')' : '') + (el ? ' · ' + el.empName + '님 직원 기록도 함께' : '');
}

/** 예전에 직원 지정 없이 기록한 본사 출고를 직원에게 준 것으로 바꿈 → 그 직원 재고에 입고로 잡힘 (본사 재고는 그대로) */
function assignOut(id, empId, device) {
  const lg = readLogs().find(x => x.id === id);
  if (!lg || lg.type !== 'out') throw new Error('본사 출고 기록을 찾지 못했습니다.');
  if (readEmpLogs().some(x => x.link === id)) throw new Error('이미 직원에게 연결된 출고입니다.');
  const emp = readEmps().find(x => x.id === empId);
  if (!emp) throw new Error('직원을 찾지 못했습니다.');
  const now = fmtTime();
  sheet('직원재고').appendRow([newId('E'), lg.date, '입고', emp.id, emp.name, lg.itemId, lg.itemName, lg.qty, clean(lg.memo, 80) || '본사 출고', id, now, who(device)]);
  if (!/^\[직원 출고\]/.test(lg.memo)) sheet('입출고').getRange(lg.row, 7).setValue(clean('[직원 출고] ' + emp.name + (lg.memo ? ' · ' + lg.memo : ''), 80));
  return lg.itemName + ' ' + lg.qty + ' 출고를 ' + emp.name + '님 재고로 옮겼습니다. 남은 재고 ' + empBal(emp.id, lg.itemId);
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
    return cur.name + (cur.name !== name ? ' → ' + name : '') + (phone ? ' · ' + phone : '') + (memo ? ' · ' + memo : '');
  }
  sh.appendRow([newId('P'), name, phone, memo, now, now, '직원']);
  return name + (phone ? ' · ' + phone : '');
}

function deleteEmp(id) {
  const cur = readEmps().find(x => x.id === id);
  if (!cur) return '';
  if (cur.id === USER.uid) throw new Error('지금 로그인한 나 자신은 삭제할 수 없습니다.');
  const left = empBalances(readEmpLogs().filter(l => l.empId === id)).filter(b => b.bal > 0);
  if (left.length) throw new Error(cur.name + '님이 아직 자재를 갖고 있습니다 (' + left.map(b => b.itemName + ' ' + b.bal).join(', ') + '). 사용 또는 반납 처리 후 삭제해 주세요.');
  sheet('직원').deleteRow(cur.row);
  const pws = userPws();
  if (pws[cur.id]) { delete pws[cur.id]; saveUserPws(pws); }
  dropUserTokens(cur.id);
  return cur.name;
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
    sheet('입출고').appendRow([link, day, '입고', it.id, itemLabel(it), qty, clean('[직원 반납] ' + emp.name + (memo ? ' · ' + memo : ''), 80), now, who(device)]);
    const sh = sheet('품목');
    sh.getRange(it.row, 8).setValue(it.stock + qty);
    sh.getRange(it.row, 10).setValue(now);
  }
  const ko = type === 'own' ? '입고' : ETYPE_KO[type];
  sheet('직원재고').appendRow([newId('E'), day, ko, emp.id, emp.name, it.id, itemLabel(it), qty, memo || (type === 'own' ? '직접 입고' : ''), link, now, who(device)]);
  const left = empBal(emp.id, it.id);
  const what = type === 'use' ? '사용' : type === 'return' ? '본사로 반납' : '입고';
  return emp.name + '님 ' + itemLabel(it) + ' ' + qty + it.unit + ' ' + what + ' 기록했습니다. 남은 재고 ' + left + it.unit;
}

function cancelEmpLog(id) {
  const el = readEmpLogs().find(x => x.id === id);
  if (!el) return '';
  const desc = el.date + ' ' + el.empName + ' ' + ETYPE_KO[el.type] + ' ' + el.itemName + ' ' + el.qty + (el.memo ? ' (' + el.memo + ')' : '');
  if (el.link) { cancelLog(el.link); if (readEmpLogs().some(x => x.id === id)) sheet('직원재고').deleteRow(readEmpLogs().find(x => x.id === id).row); return desc + ' · 본사 기록도 함께'; }
  if (el.type === 'in') {
    const bal = empBal(el.empId, el.itemId);
    if (bal < el.qty) throw new Error(el.empName + '님이 이미 일부를 사용·반납해서 취소할 수 없습니다. 사용 기록부터 취소해 주세요. (남은 ' + bal + ')');
  }
  sheet('직원재고').deleteRow(el.row);
  return desc;
}

/* ---------- 재고 미달 알림 ---------- */
function alertSettings() {
  return { email: P.getProperty('ALERT_EMAIL') || '', daily: P.getProperty('ALERT_DAILY') === '1', instant: P.getProperty('ALERT_INSTANT') === '1', last: P.getProperty('ALERT_LAST') || '' };
}
function setAlert(req) {
  const emails = String(req.email || '').split(/[,\s;]+/).map(x => x.trim()).filter(Boolean);
  if (emails.some(x => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) throw new Error('이메일 주소 모양이 맞지 않습니다.');
  if (emails.length > 5) throw new Error('이메일은 5개까지 넣을 수 있습니다.');
  if ((req.daily || req.instant) && !emails.length) throw new Error('알림 받을 이메일을 넣어 주세요.');
  P.setProperty('ALERT_EMAIL', emails.join(', '));
  P.setProperty('ALERT_DAILY', req.daily ? '1' : '0');
  P.setProperty('ALERT_INSTANT', req.instant ? '1' : '0');
  ensureAlertTrigger();
  return '알림 설정을 저장했습니다' + (emails.length ? ' (' + emails.join(', ') + (req.daily ? ', 매일 아침 8시 요약' : '') + (req.instant ? ', 부족 즉시 알림' : '') + ')' : ' (알림 끔)');
}
function ensureAlertTrigger() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'dailyAlert');
  if (!has) ScriptApp.newTrigger('dailyAlert').timeBased().everyDays(1).atHour(8).inTimezone(TZ).create();
}
function lowItems() {
  return readItems().filter(it => it.minStock > 0 && it.stock <= it.minStock)
    .map(it => ({ it: it, need: Math.max(0, (it.target > it.minStock ? it.target : it.minStock * 2) - it.stock) }));
}
function appUrl() { return 'https://gayall6713-rgb.github.io/worldnetworks_schedule/inventory/'; }
function lowTable(list) {
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const td = 'style="border:1px solid #ccc;padding:4px 8px"';
  return '<table style="border-collapse:collapse;font-size:14px"><tr><th ' + td + '>구분</th><th ' + td + '>품목</th><th ' + td + '>현재</th><th ' + td + '>최소</th><th ' + td + '>발주 추천</th></tr>' +
    list.map(x => '<tr><td ' + td + '>' + esc(x.it.category) + '</td><td ' + td + '>' + esc(itemLabel(x.it)) + '</td><td ' + td + ' align="right"><b>' + x.it.stock + '</b></td><td ' + td + ' align="right">' + x.it.minStock + '</td><td ' + td + ' align="right">' + x.need + ' ' + esc(x.it.unit) + '</td></tr>').join('') + '</table>';
}
/** 부족 목록 메일. why: '매일' / '테스트' */
function sendLowMail(why) {
  const to = P.getProperty('ALERT_EMAIL');
  if (!to) throw new Error('먼저 알림 받을 이메일을 저장해 주세요.');
  const list = lowItems();
  if (why === '매일' && !list.length) return '부족 품목 없음';
  const subject = '[자재 재고] ' + (list.length ? '최소재고 이하 ' + list.length + '개 품목' : '부족 품목 없음') + (why === '테스트' ? ' (테스트)' : '');
  const html = '<p>' + fmtTime() + ' 기준 ' + (list.length ? '최소재고 이하인 품목입니다. 발주 추천 = 적정재고(없으면 최소재고의 2배) − 현재 재고.' : '최소재고 이하인 품목이 없습니다.') + '</p>' +
    (list.length ? lowTable(list) : '') + '<p><a href="' + appUrl() + '">재고 앱 열기</a></p>';
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: APP_NAME });
  P.setProperty('ALERT_LAST', fmtTime());
  return to + '로 ' + (why === '테스트' ? '테스트 메일을' : '알림을') + ' 보냈습니다 (부족 ' + list.length + '개)';
}
function instantAlert(it, next) {
  if (P.getProperty('ALERT_INSTANT') !== '1' || !P.getProperty('ALERT_EMAIL')) return;
  try {
    const x = { it: Object.assign({}, it, { stock: next }), need: 0 };
    x.need = Math.max(0, (it.target > it.minStock ? it.target : it.minStock * 2) - next);
    MailApp.sendEmail({ to: P.getProperty('ALERT_EMAIL'), name: APP_NAME,
      subject: '[자재 재고] ' + itemLabel(it) + ' 최소재고 이하 (' + next + it.unit + ')',
      htmlBody: '<p>' + (USER.name || '') + '님이 출고해서 아래 품목이 최소재고 이하로 떨어졌습니다.</p>' + lowTable([x]) + '<p><a href="' + appUrl() + '">재고 앱 열기</a></p>' });
    P.setProperty('ALERT_LAST', fmtTime());
  } catch (e) {}
}
/** 배포 후 편집기에서 한 번 실행: 메일 보내기 권한 승인 + 아침 알림 트리거 만들기 */
function authorizeMail() {
  ensureAlertTrigger();
  Logger.log('메일 권한 확인됨. 오늘 남은 메일 수: ' + MailApp.getRemainingDailyQuota());
}

/** 매일 아침 8시 트리거 */
function dailyAlert() {
  if (P.getProperty('ALERT_DAILY') !== '1') return;
  sendLowMail('매일');
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
  ensureAlertTrigger();
  Logger.log('준비 완료. 시트: https://docs.google.com/spreadsheets/d/' + P.getProperty('SHEET_ID'));
}
