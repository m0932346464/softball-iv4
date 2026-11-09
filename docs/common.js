/* 慢壘賽事紀錄系統 — 後台資訊中控與後台共用程式 */
'use strict';

/* ---------- Firebase ---------- */
const FB = (() => {
  const cfg = window.FIREBASE_CONFIG || {};
  const ready = !!(cfg.apiKey && cfg.projectId);
  if (!ready) return { ready: false };
  const app = firebase.initializeApp(cfg);
  const db = firebase.firestore();
  const auth = firebase.auth();
  // 本機測試：網址加 ?emu=1 時連到 Firebase Emulator
  if (/[?&]emu=1/.test(location.search)) {
    db.useEmulator('127.0.0.1', 8080);
    auth.useEmulator('http://127.0.0.1:9099');
  } else {
    // 場邊網路不穩時，寫入先存在裝置上，恢復連線後自動上傳
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  }
  const TS = () => firebase.firestore.FieldValue.serverTimestamp();
  return { ready: true, app, db, auth, TS };
})();

/* 只給紀錄員看的連結（data-scorer）：沒登入或不是紀錄員／管理員就隱藏，例如公開頁面上的「打擊落點紀錄」 */
function gateScorerLinks() {
  const els = () => document.querySelectorAll('[data-scorer]'), set = on => els().forEach(e => e.hidden = !on);
  set(false); if (!FB.ready) return;
  FB.auth.onAuthStateChanged(async u => { if (!u) { set(false); return; }
    try { const d = await FB.db.collection('users').doc(u.uid).get(); set(d.exists && ['admin', 'scorer'].includes(d.data().role)); } catch (_) { set(false); } });
}
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', gateScorerLinks);
/* 打席先後：伺服器時間（含奈秒）→ 同一秒內再用裝置時間排序 */
const tsv = b => b.createdAt ? b.createdAt.seconds * 1e9 + (b.createdAt.nanoseconds || 0) : 9e18;
const byTime = (a, b) => (tsv(a) - tsv(b)) || ((a.at || 0) - (b.at || 0));
const T = tid => FB.db.collection('tournaments').doc(tid);
const col = (tid, name) => T(tid).collection(name);

/* 登入後確保有 users 文件；回傳角色 */
async function ensureUser(user) {
  const ref = FB.db.collection('users').doc(user.uid);
  let snap = await ref.get();
  if (!snap.exists) {
    let nm = ''; try { nm = sessionStorage.getItem('sb-signup-name') || ''; sessionStorage.removeItem('sb-signup-name'); } catch (_) {}
    await ref.set({ email: user.email || '', name: nm || user.displayName || '', role: 'pending', createdAt: FB.TS() });
    snap = await ref.get();
  }
  FB.me = Object.assign({ uid: user.uid }, snap.data());
  return FB.me.role || 'pending';
}
/* 記錄員顯示用姓名（沒填姓名時用 Email） */
const myName = () => (FB.me && FB.me.name) || (FB.me && FB.me.email) || '';
async function saveMyName(name) {
  await FB.db.collection('users').doc(FB.me.uid).update({ name });
  FB.me.name = name;
}

/* ---------- 常數 ---------- */
// ab：是否計入打數；loc：是否需要點球場落點
const RESULTS = [
  { k: '1B', label: '一安', c: '--r1', hit: 1, tb: 1, ab: 1, loc: 1 },
  { k: '2B', label: '二安', c: '--r2', hit: 1, tb: 2, ab: 1, loc: 1 },
  { k: '3B', label: '三安', c: '--r3', hit: 1, tb: 3, ab: 1, loc: 1 },
  { k: 'HR', label: '全壘打', c: '--hr', hit: 1, tb: 4, ab: 1, loc: 1 },
  { k: 'OUT', label: '出局', c: '--out', hit: 0, tb: 0, ab: 1, loc: 1 },
  { k: 'E', label: '失誤', c: '--err', hit: 0, tb: 0, ab: 1, loc: 1 },
  { k: 'FC', label: '野選', c: '--fc', hit: 0, tb: 0, ab: 1, loc: 1 },
  { k: 'DP', label: '雙殺', c: '--dp', hit: 0, tb: 0, ab: 1, loc: 1, outs: 2 },
  { k: 'SF', label: '高犧', c: '--sf', hit: 0, tb: 0, ab: 0, loc: 1 },
  { k: 'GS', label: '滾犧', c: '--gs', hit: 0, tb: 0, ab: 0, loc: 1 },
  { k: 'K', label: '三振', c: '--k', hit: 0, tb: 0, ab: 1, loc: 0 },
  { k: 'BB', label: '四壞', c: '--bb', hit: 0, tb: 0, ab: 0, loc: 0 }
];
// 本賽制：10 人守備（下列前 10 個守位）＋ 1 名 EP 指定打擊 ＝ 11 人打擊；無盜壘
const POS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'LCF', 'RCF', 'RF', 'EP'];
const FIELD_POS = POS.slice(0, 10), BATTERS = 11;
const POSL = { P: '投手', C: '捕手', '1B': '一壘', '2B': '二壘', '3B': '三壘', SS: '游擊', LF: '左外', LCF: '左中', RCF: '右中', RF: '右外', EP: '指定打擊' };
const hasLoc = b => !b.noLoc && (RES[b.result] || {}).loc !== 0;
const TYPES = [{ k: 'G', label: '滾地' }, { k: 'L', label: '平飛' }, { k: 'F', label: '高飛' }, { k: 'P', label: '小飛球' }];
const RES = Object.fromEntries(RESULTS.map(r => [r.k, r]));
/* 出局數：出局、三振、高犧、滾犧各 1，雙殺 2 */
const OUT_N = { OUT: 1, K: 1, SF: 1, GS: 1, DP: 2 };
/* 紙本紀錄代號：1B 2B 3B HR BB FC E F(高飛接殺) G(滾地封殺) L(平飛接殺) SF GS K DP */
function paperCode(b) {
  if (b.result === 'OUT') return b.type === 'G' ? 'G' : b.type === 'L' ? 'L' : 'F';
  return b.result === 'E' ? 'E' : b.result;
}
/* 小球場（紙本打擊落點格式）：藍點內野、紅點外野 */
function miniFieldSVG(dims, balls, opt = {}) {
  const FD = makeField(dims), f = FD.f, SC = Math.min(268 / f.L, 322 / f.C), VH = Math.round(f.C * SC + 30), HX = 200, HY = VH - 14;
  const toV = (x, y) => [HX + x * SC, HY - y * SC];
  const ptV = (a, d) => { const q = a * Math.PI / 180, [x, y] = toV(d * Math.sin(q), d * Math.cos(q)); return x.toFixed(1) + ',' + y.toFixed(1); };
  const fp = []; for (let a = -45; a <= 45; a += 3) fp.push(ptV(a, FD.fenceAt(a)));
  const inf = []; for (let a = -45; a <= 45; a += 3) inf.push(ptV(a, FD.RZ[3]));
  const B = f.B, h = B * Math.SQRT1_2, b1 = toV(h, h), b2 = toV(0, B * Math.SQRT2), b3 = toV(-h, h);
  const dots = balls.filter(hasLoc).map(b => {
    const [x, y] = toV(b.x, b.y), out = FD.zoneOf(b) === 'out', cur = opt.curGame && b.gameId === opt.curGame;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${cur ? 11 : 9}" style="fill:${out ? 'var(--r1)' : 'var(--bb)'};stroke:${cur ? 'var(--ink)' : 'var(--surface)'};stroke-width:${cur ? 3 : 2}"><title>${esc(b.batterName || '')}｜${(RES[b.result] || {}).label || ''}｜${FD.zoneCode(b)}</title></circle>`;
  }).join('');
  return `<svg viewBox="0 0 400 ${VH}" class="mini-field" role="img" aria-label="打擊落點">
    <path d="M${HX},${HY} L${fp.join(' L')} Z" style="fill:var(--surface);stroke:var(--line);stroke-width:3"/>
    <path d="M${inf.join(' L')}" style="fill:none;stroke:var(--line);stroke-width:2;stroke-opacity:.6"/>
    <path d="M${HX},${HY} L${b1} L${b2} L${b3}Z" style="fill:none;stroke:var(--line);stroke-width:2.5"/>
    <line x1="${HX}" y1="${HY}" x2="${HX}" y2="${HY - f.C * SC}" style="stroke:var(--line);stroke-width:1.5;stroke-dasharray:6 8;stroke-opacity:.5"/>
    ${dots}</svg>`;
}
const TYP = Object.fromEntries(TYPES.map(t => [t.k, t]));
const PRESETS = { m: { L: 300, C: 300, B: 65, P: 50 }, w: { L: 275, C: 275, B: 65, P: 50 } };
const STATUS = { scheduled: '未開賽', live: '比賽中', final: '已結束' };
const HAND = { R: '右打', L: '左打', S: '左右開弓' };
const SEX = { M: '男', F: '女' };
const sexOf = v => /女|^F$|^f$/.test(String(v || '')) ? 'F' : /男|^M$|^m$/.test(String(v || '')) ? 'M' : '';
/* 例外標示（第四版）：只標少數資訊——女生在背號旁標「女」、左打／左右開弓在姓名後標「左」／「左右」，都用紅色；名單未填性別標灰色「?」；男生、右打不標 */
const SEXL = { M: '男', F: '女' };
const isF = p => sexOf(p && p.sex) === 'F';
const HANDX = { L: '左', S: '左右' };
const noSex = p => p && !sexOf(p.sex);   // 名單沒填性別：灰色「?」提醒補上
const femTag = p => isF(p) ? '<span class="xt" title="女生">女</span>' : noSex(p) ? '<span class="xt xu" title="名單未填性別，請到賽務管理後台補上">?</span>' : '';
const handTag = p => p && HANDX[p.bats] ? `<span class="xt" title="${HAND[p.bats]}">${HANDX[p.bats]}</span>` : '';
const sexTag = p => femTag(p) + handTag(p);
const pLab = p => p ? `#${esc(p.no || '—')}${femTag(p)} ${esc(p.name)}${handTag(p)}` : '—';
const sexTxt = p => [isF(p) ? '女' : noSex(p) ? '性別未填' : '', p && HANDX[p.bats] ? HAND[p.bats] : ''].filter(Boolean).join('・');
const sexOpt = p => { const t = sexTxt(p); return t ? `（${t}）` : ''; };
const DIRL = { pull: '拉打', center: '中間', oppo: '推打', foul: '界外' };

/* ---------- 球場幾何與落點分格（Project Scoresheet 格位） ---------- */
function makeField(f) {   // 格位與「打擊落點紀錄」表相同（公尺為單位的扇形格，8 欄 × 內外野各 3–4 圈）
  f = Object.assign({}, PRESETS.m, f || {});
  const M = 3.2808, m = v => v * M;
  const RZ = [8.5, 16, 26, 46, 46].map(m);   // RZ[3]＝內外野分界（46 公尺）
  const fenceAt = a => f.L + (f.C - f.L) * Math.cos(2 * a * Math.PI / 180);
  const A = v => ({ abs: v }), F = v => ({ frac: v });
  const rAt = (s, a) => s.abs != null ? s.abs : Math.max(s.frac * fenceAt(a), m(78) + 1);
  const OUT = ['7', '78', '8', '810', '108', '10', '109', '9'], IN = ['5', '56', '6', '64', '46', '4', '34', '3'];
  const c8 = i => [-45 + i * 11.25, -45 + (i + 1) * 11.25];
  const cells = [];
  const add = (code, a0, a1, r0, r1, ring) => cells.push({ code, a0, a1, r0, r1, ring });
  [['25', -45, -15], ['1S', -15, 15], ['23', 15, 45]].forEach(([c, a0, a1]) => add(c, a0, a1, A(m(1.2)), A(m(8.5)), 'home'));
  [['16', -45, -10], ['1', -10, 10], ['13', 10, 45]].forEach(([c, a0, a1]) => add(c, a0, a1, A(m(8.5)), A(m(16)), 'home'));
  IN.forEach((c, i) => { add(c + 'S', ...c8(i), A(m(16)), A(m(26)), 'in'); add(c, ...c8(i), A(m(26)), A(m(36)), 'in'); add(c + 'D', ...c8(i), A(m(36)), A(m(46)), 'in'); });
  OUT.forEach((c, i) => { add(c + 'S', ...c8(i), A(m(46)), A(m(56)), 'out'); add(c, ...c8(i), A(m(56)), A(m(67)), 'out'); add(c + 'D', ...c8(i), A(m(67)), A(m(78)), 'out'); add(c + 'XD', ...c8(i), A(m(78)), F(1), 'out'); });
  const FOUL = [[8.5, '25F', '23F'], [36, '5F', '3F'], [46, '5DF', '3DF'], [56, '75F', '95F'], [67, '7F', '9F'], [1e9, '7DF', '9DF']];
  const angle = b => Math.atan2(b.x, b.y) * 180 / Math.PI;
  const dist = b => Math.hypot(b.x, b.y);
  function zoneCode(b) {
    if (b.x == null || b.y == null) return b.zone || '';
    const a = angle(b), dm = dist(b) / M;
    if (b.y < 0 || dm < 1.2) return Math.abs(a) > 135 || dm < 1.2 ? '2' : (b.x < 0 ? '25F' : '23F');
    if (Math.abs(a) > 45) { const r = FOUL.find(x => dm < x[0]); return a < 0 ? r[1] : r[2]; }
    for (const c of cells) if (a >= c.a0 && a <= c.a1 && dist(b) >= rAt(c.r0, a) && dist(b) < rAt(c.r1, a)) return c.code;
    return OUT[Math.min(7, Math.max(0, Math.floor((a + 45) / 11.25)))] + 'XD';
  }
  function side(b) { const a = angle(b); if (Math.abs(a) > 45) return 'foul'; return a < -15 ? 'L' : a > 15 ? 'R' : 'C'; }
  function dirOf(b) {
    const s = side(b); if (s === 'foul') return 'foul'; if (s === 'C') return 'center';
    return (s === 'L') === ((b.side || 'R') === 'R') ? 'pull' : 'oppo';
  }
  const zoneOf = b => dist(b) < RZ[3] ? 'in' : 'out';
  return { f, RZ, fenceAt, rAt, cells, angle, dist, zoneCode, side, dirOf, zoneOf };
}
/* 落點格位：一律依座標換算成打擊落點紀錄表的格位（舊資料的舊代號也統一） */
const zoneOfB = (b, FD) => FD.zoneCode(b);

/* 格位代號 → 口語位置（拖曳時即時顯示） */
function zoneName(code) {
  const c = String(code || ''), foul = /F$/.test(c), b = c.replace(/F$/, '');
  const base = b.replace(/(XD|D|S|M|L)$/, '').replace(/(XD|D|S)$/, '');
  const N = { '1': '投手前', '2': '捕手前', '15': '投手三壘側', '13': '投手一壘側', '25': '三壘線前', '23': '一壘線前', '5': '三壘', '56': '三游間', '6': '游擊', '4': '二壘', '34': '一二壘間', '3': '一壘',
    '7': '左外野', '78': '左中間', '8': '中外野', '89': '右中間', '9': '右外野',
    '10': '自由手', '810': '中外野右側', '108': '自由手左側', '109': '右中間', '16': '投手三壘側', '64': '游擊二壘間', '46': '二壘游擊間', '75': '左外野線', '95': '右外野線' };
  let nm = N[base] || '';
  if (/^6M|^4M/.test(b)) nm = '二壘附近';
  if (/L(S|D)?$/.test(b.replace(/F$/, '')) && /^[79]L/.test(b)) nm = (b[0] === '7' ? '左外野' : '右外野') + '邊線';
  const deep = /XD$/.test(b) ? '深遠' : /D$/.test(b) ? '深' : /S$/.test(b) ? '淺' : '';
  return (foul ? '界外・' : '') + nm + deep;
}

/* ---------- 球場繪圖（SVG + 熱區 canvas） ---------- */
function makeFieldView({ bg, pts, heat, wrap, onTap }) {
  let FD = makeField(), SC = 1, HX = 200, HY = 340, VH = 360, view = 'grid', balls = [], ghost = [], curGame = '', lastId = null, colors = {}, labels = false;
  const toV = (x, y) => [HX + x * SC, HY - y * SC];
  const ptV = (a, d) => { const q = a * Math.PI / 180, [x, y] = toV(d * Math.sin(q), d * Math.cos(q)); return x.toFixed(1) + ',' + y.toFixed(1); };
  function cellPath(c) {
    const st = Math.max(1, Math.ceil((c.a1 - c.a0) / 2)), o = [], n = [];
    for (let i = 0; i <= st; i++) { const a = c.a0 + (c.a1 - c.a0) * i / st; o.push(ptV(a, FD.rAt(c.r1, a))); n.push(ptV(a, FD.rAt(c.r0, a))); }
    return 'M' + o.join(' L') + ' L' + n.reverse().join(' L') + 'Z';
  }
  function cellCenter(c) { const a = (c.a0 + c.a1) / 2; return ptV(a, c.code === '2' ? FD.RZ[0] * .57 : (FD.rAt(c.r0, a) + FD.rAt(c.r1, a)) / 2).split(','); }

  function setField(dims) {
    FD = makeField(dims); const f = FD.f;
    SC = Math.min(268 / f.L, 322 / f.C); VH = Math.round(f.C * SC + 62); HY = VH - 26;
    [bg, pts].forEach(s => s.setAttribute('viewBox', `0 0 400 ${VH}`));
    wrap.style.aspectRatio = `400 / ${VH}`;
    const fp = []; for (let a = -45; a <= 45; a += 1.5) fp.push(ptV(a, FD.fenceAt(a)));
    const B = f.B, h = B * Math.SQRT1_2, b1 = toV(h, h), b2 = toV(0, B * Math.SQRT2), b3 = toV(-h, h), pp = toV(0, f.P);
    const marks = [-45, -22.5, 0, 22.5, 45].map(a0 => {
      const a = Math.abs(a0) === 45 ? Math.sign(a0) * 41 : a0, [x, y] = ptV(a, FD.fenceAt(a) + 14).split(',');
      return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" style="font:600 11px var(--display);fill:var(--muted)">${Math.round(FD.fenceAt(a0))}</text>`;
    }).join('');
    const top = HY - f.C * SC + 14;
    bg.innerHTML = `
      <path d="M${HX},${HY} L${fp.join(' L')} Z" style="fill:var(--grass);stroke:var(--line);stroke-width:1.5"/>
      <path d="M${HX},${HY} L${b1} L${b2} L${b3}Z" style="fill:var(--dirt)"/>
      <g class="zone-cells"></g>
      <path d="M${HX},${HY} L${b1} L${b2} L${b3}Z" style="fill:none;stroke:var(--line);stroke-width:1.5"/>
      <rect x="${pp[0] - 5}" y="${pp[1] - 1.5}" width="10" height="3" style="fill:var(--line)"/>
      ${[b1, b2, b3].map(([x, y]) => `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" transform="rotate(45 ${x} ${y})" style="fill:var(--line)"/>`).join('')}
      <path d="M${HX - 6} ${HY - 4} H${HX + 6} V${HY} L${HX} ${HY + 3} L${HX - 6} ${HY} Z" style="fill:#fff;stroke:var(--line);stroke-width:1.2"/>
      <path d="M${HX - 5.8} ${HY} L${HX} ${HY + 3} L${HX + 5.8} ${HY} V${HY + 17} H${HX - 5.8} Z" style="fill:#2b2f36"/>
      <!-- 打擊區（左：右打者、右：左打者）；跑者踩好球板或右打者打擊區黑色板得分 -->
      <rect x="${HX - 21}" y="${HY - 7}" width="11" height="22" rx="1" style="fill:#fff;stroke:var(--line);stroke-width:.8"><title>打擊區（右打者）</title></rect>
      <rect x="${HX + 10}" y="${HY - 7}" width="11" height="22" rx="1" style="fill:#fff;stroke:var(--line);stroke-width:.8"><title>打擊區（左打者）</title></rect>
      <!-- 4.5 公尺安全壘線（三壘邊線上，示意位置） -->
      ${(() => { const d = 34, cx = HX - d * Math.SQRT1_2, cy = HY - d * Math.SQRT1_2, u = 7; return `<path d="M${cx - u * Math.SQRT1_2} ${cy + u * Math.SQRT1_2} L${cx + u * Math.SQRT1_2} ${cy - u * Math.SQRT1_2}" style="stroke:#e0403a;stroke-width:2.2"><title>4.5 公尺安全壘線：跑者踩到或越過即成封殺狀態</title></path><text x="${cx - 32}" y="${cy - 4}" style="font:700 8px var(--body);fill:#e0403a">4.5m 線</text>`; })()}
      <text x="${HX + 24}" y="${HY + 14}" style="font:600 8px var(--body);fill:var(--muted)">好球板</text>
      ${marks}
      <text x="58" y="${HY - 48}" style="font:700 22px var(--display);fill:var(--line);letter-spacing:1px">FOUL</text>
      <text x="300" y="${HY - 48}" style="font:700 22px var(--display);fill:var(--line);letter-spacing:1px">FOUL</text>
      <text x="16" y="${top}" style="font:700 18px var(--display);fill:var(--muted)">HR</text>
      <text x="356" y="${top}" style="font:700 18px var(--display);fill:var(--muted)">HR</text>`;
    render();
  }
  function renderZones() {
    const grid = view === 'grid', cnt = {};
    balls.forEach(b => { const z = FD.zoneCode(b); cnt[z] = (cnt[z] || 0) + 1; });
    const max = Math.max(1, ...Object.values(cnt));
    bg.querySelector('.zone-cells').innerHTML = FD.cells.map(c => {
      const n = cnt[c.code] || 0, a = n / max;
      const fill = grid && n ? `color-mix(in srgb,var(--accent) ${Math.round(18 + a * 62)}%,transparent)` : 'transparent';
      let lab = '';
      if (grid) {   // 分格：和打擊落點紀錄表一樣每格都標代號，有落點的格子加上球數
        const [x, y] = cellCenter(c), fs = c.ring === 'out' ? 7.4 : c.ring === 'in' ? 5.4 : 6, col = a > .6 ? '#fff' : 'var(--ink)';
        lab = `<text x="${x}" y="${n ? y - fs * .45 : y}" text-anchor="middle" dominant-baseline="middle" style="font:${n ? 700 : 600} ${fs}px var(--display);fill:${n ? col : 'var(--muted)'};pointer-events:none">${c.code}${n ? `<tspan x="${x}" dy="${fs + 1}" style="font-weight:800">${n}</tspan>` : ''}</text>`;
      }
      return `<path d="${cellPath(c)}" style="fill:${fill};stroke:var(--line);stroke-opacity:${grid ? .6 : .3};stroke-width:${grid ? .7 : .6}"><title>${c.code}：${n} 球</title></path>${lab}`;
    }).join('') + (grid ? (() => {   // 界外格位與距離標示（同打擊落點紀錄表）
      const M = 3.2808, fl = [[1.2, 8.5, '25F', '23F'], [8.5, 36, '5F', '3F'], [36, 46, '5DF', '3DF'], [46, 56, '75F', '95F'], [56, 67, '7F', '9F'], [67, 84, '7DF', '9DF']];
      const t = (a, d, txt, st) => { const [x, y] = ptV(a, d).split(','); return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" style="${st}">${txt}</text>`; };
      const fs = 'font:600 5.6px var(--display);fill:var(--muted);pointer-events:none', ms = 'font:600 5px var(--display);fill:var(--muted);opacity:.8;pointer-events:none';
      return fl.map(([r0, r1, L, R]) => { const d = Math.min((r0 + r1) / 2, 84) * M; return t(-52, d, L, fs) + t(52, d, R, fs); }).join('')
        + [20, 40, 60, 80].map(mm => t(-47.5, mm * M, mm + 'm', ms) + t(47.5, mm * M, mm + 'm', ms)).join('');
    })() : '') + (grid && !balls.length ? `<text x="${HX}" y="${HY - FD.f.C * SC * .55}" text-anchor="middle" style="font:500 13px var(--body);fill:var(--muted)">此範圍還沒有落點</text>` : '');
  }
  function renderPoints() {
    /* 點位模式顯示大點；分格、熱區模式也疊上小點，落點不會消失 */
    const big = view === 'pts', rr = big ? 6 : 4.2, op = big ? 1 : .9;
    /* 淡色背景點：本場同隊其他打者；剛記錄的那一球保持亮色並閃爍 */
    const gh = ghost.map(b => {
      const [x, y] = toV(b.x, b.y), r = RES[b.result] || RES.OUT, last = b.id === lastId;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${last ? 6 : 4}" class="${last ? 'flash' : ''}" style="fill:var(${r.c});fill-opacity:${last ? 1 : .32};stroke:var(--surface);stroke-width:1.2"><title>${esc(b.batterName || '')}｜${r.label}${last ? '｜剛記錄' : ''}</title></circle>` +
        (last && b.batterNo ? `<text x="${(x + 7).toFixed(1)}" y="${(y - 5).toFixed(1)}" style="font:700 9px var(--display);fill:var(--ink);paint-order:stroke;stroke:var(--surface);stroke-width:2.5px;pointer-events:none">#${esc(b.batterNo)}</text>` : '');
    }).join('');
    /* 歷屆（非本場）淡色、畫在下層；本場深色加深框、畫在上層 */
    const isPast = b => curGame && b.gameId !== curGame;
    /* 分格模式：只留剛記錄的那一球，其餘以格子數字呈現，不和點位混在一起 */
    const shown = view === 'grid' ? balls.filter(b => b.id === lastId) : balls;
    const sorted = [...shown].sort((a, b) => isPast(b) - isPast(a));
    pts.innerHTML = gh + (sorted.length ? sorted.map(b => {
      const [x, y] = toV(b.x, b.y), r = RES[b.result] || RES.OUT, past = isPast(b);
      const st = past ? `fill:var(${r.c});fill-opacity:${big ? .35 : .3};stroke:var(--surface);stroke-width:1` : `fill:var(${r.c});fill-opacity:${op};stroke:var(--ink);stroke-width:${big ? 1.8 : 1.2}`;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${past ? rr - 1 : rr}" class="${b.id === lastId ? 'flash' : ''}" style="${st}"><title>${esc(b.batterName || '')}｜${r.label}｜${FD.zoneCode(b)}${past ? '｜歷屆' : '｜本場'}</title></circle>` +
        (labels && big && b.batterNo ? `<text x="${(x + 7).toFixed(1)}" y="${(y - 5).toFixed(1)}" style="font:700 9px var(--display);fill:var(--ink);fill-opacity:${past ? .45 : 1};paint-order:stroke;stroke:var(--surface);stroke-width:2.5px;pointer-events:none">${esc(b.batterNo)}</text>` : '');
    }).join('') : '');
  }
  const RAMP = [[0, [70, 110, 205, 0]], [.12, [70, 110, 205, .75]], [.3, [150, 175, 230, .75]], [.48, [235, 240, 252, .7]], [.68, [245, 150, 140, .85]], [1, [220, 35, 40, .95]]];
  function ramp(t) { for (let i = 1; i < RAMP.length; i++) if (t <= RAMP[i][0]) { const [a, c1] = RAMP[i - 1], [b, c2] = RAMP[i], q = (t - a) / (b - a); return c1.map((v, j) => v + (c2[j] - v) * q); } return RAMP[RAMP.length - 1][1]; }
  function renderHeat() {
    const w = heat.clientWidth, h = heat.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!w) return; heat.width = Math.round(w * dpr); heat.height = Math.round(h * dpr);
    const ctx = heat.getContext('2d'); ctx.clearRect(0, 0, heat.width, heat.height);
    if (view !== 'heat' || !balls.length) return;
    const k = heat.width / 400, R = 26 * k;
    for (const b of balls) {
      const [x, y] = toV(b.x, b.y), cx = x * k, cy = y * k, g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, 'rgba(0,0,0,.5)'); g.addColorStop(.55, 'rgba(0,0,0,.28)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    const img = ctx.getImageData(0, 0, heat.width, heat.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; if (a < .02) { d[i + 3] = 0; continue; } const c = ramp(Math.min(1, a / .9)); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3] * 255; }
    ctx.putImageData(img, 0, 0);
  }
  function render() { renderZones(); renderPoints(); renderHeat(); }
  /* 按住可拖曳微調：游標跟著手指移動並即時顯示格位，放開才記錄 */
  const toPt = e => { const p = pts.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; const q = p.matrixTransform(pts.getScreenCTM().inverse()); return { vx: q.x, vy: q.y, x: +((q.x - HX) / SC).toFixed(1), y: +((HY - q.y) / SC).toFixed(1) }; };
  const cur = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cur.setAttribute('class', 'field-cur'); cur.setAttribute('aria-hidden', 'true'); wrap.appendChild(cur);
  let drag = null, pend = null;
  function drawCur(q, live) {
    cur.setAttribute('viewBox', pts.getAttribute('viewBox'));
    if (!q) { cur.innerHTML = ''; return; }
    const code = FD.zoneCode(q), nm = zoneName(code), lw = Math.max(46, code.length * 7 + nm.length * 12 + 26), ly = q.vy - 26 < 14 ? q.vy + 22 : q.vy - 22;
    cur.innerHTML = `<circle cx="${q.vx}" cy="${q.vy}" r="${live ? 13 : 9}" style="fill:color-mix(in srgb,var(--accent) 18%,transparent);stroke:var(--accent);stroke-width:2"/>
      <circle cx="${q.vx}" cy="${q.vy}" r="3" style="fill:var(--ink)"/>
      ${live ? `<path d="M${q.vx - 20} ${q.vy}H${q.vx - 14}M${q.vx + 14} ${q.vy}H${q.vx + 20}M${q.vx} ${q.vy - 20}V${q.vy - 14}M${q.vx} ${q.vy + 14}V${q.vy + 20}" style="stroke:var(--accent);stroke-width:2"/>` : ''}
      <g transform="translate(${Math.min(400 - lw / 2 - 2, Math.max(lw / 2 + 2, q.vx))} ${ly})"><rect x="${-lw / 2}" y="-10" width="${lw}" height="20" rx="6" style="fill:var(--ink)"/><text text-anchor="middle" dominant-baseline="central" style="font:700 11px var(--body);fill:var(--surface)">${code}・${nm}</text></g>`;
  }
  pts.style.touchAction = 'none';
  pts.addEventListener('pointerdown', e => {
    if (!onTap || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); try { pts.setPointerCapture(e.pointerId); } catch (_) {}
    drag = { id: e.pointerId }; drawCur(toPt(e), true);
  });
  pts.addEventListener('pointermove', e => { if (drag && drag.id === e.pointerId) drawCur(toPt(e), true); });
  pts.addEventListener('pointerup', e => {
    if (!drag || drag.id !== e.pointerId) return; drag = null;
    const q = toPt(e); drawCur(pend || null, false);
    const r = wrap.getBoundingClientRect();
    onTap({ x: q.x, y: q.y }, { left: e.clientX - r.left, top: e.clientY - r.top, w: r.width, h: r.height });
  });
  pts.addEventListener('pointercancel', () => { drag = null; drawCur(pend, false); });
  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(renderHeat, 60); }).observe(heat);
  setField();
  return {
    setField, get field() { return FD; },
    setView(v) { view = v; render(); }, get view() { return view; },
    setLabels(v) { if (labels !== !!v) { labels = !!v; render(); } },
    setGhost(list) { ghost = (list || []).filter(hasLoc); },
    setCurGame(g) { curGame = g || ''; },
    setBalls(list, last) { balls = list.filter(hasLoc); lastId = last || null; render(); },
    /* 等待選結果時，保留落點標記 */
    setPending(p) { pend = p ? Object.assign({}, p, { vx: HX + p.x * SC, vy: HY - p.y * SC }) : null; drawCur(pend, false); }
  };
}


/* ---------- 紙本紀錄表（落點紀錄表第三版格位）→ 系統打席 ----------
   紀錄表上傳的 payload：{ innings:[逐局得分], lineup:[{slot,sub,no,from}], pas:[{slot,sub,no,round,inn,zone,res,rbi,pr,scorers:[背號]}] }
   格位依紙本：外野 7・78・8・810・108・10・109・9（S/一般/D/XD）、內野 5・56・6・64・46・4・34・3（S/一般/D）、本壘前 25・1S・23、投手前 16・1・13、捕手 2、界外 …F */
const SHEET_OUT = ['7', '78', '8', '810', '108', '10', '109', '9'], SHEET_IN = ['5', '56', '6', '64', '46', '4', '34', '3'];
function sheetZoneXY(code) {
  const c = String(code || ''), M = 3.2808, col = i => -45 + 11.25 * (i + .5);
  let a = 0, d = 0, m;
  if (!c) return null;
  if (c === '2') { a = 180; d = 1.5; }
  else if ((m = c.match(/^(25|23|5|3|5D|3D|75|95|7|9|7D|9D)F$/))) {
    const k = m[1], left = /^(25|5|5D|75|7|7D)$/.test(k);
    d = { 25: 5, 23: 5, 5: 22, 3: 22, '5D': 41, '3D': 41, 75: 51, 95: 51, 7: 61.5, 9: 61.5, '7D': 75, '9D': 75 }[k]; a = left ? -50 : 50;
  }
  else if ((m = c.match(/^(25|1S|23)$/))) { a = { 25: -30, '1S': 0, 23: 30 }[m[1]]; d = 5; }
  else if ((m = c.match(/^(16|1|13)$/))) { a = { 16: -27.5, 1: 0, 13: 27.5 }[m[1]]; d = 12; }
  else if ((m = c.match(/^(5|56|6|64|46|4|34|3)(S|D)?$/))) { a = col(SHEET_IN.indexOf(m[1])); d = { S: 21, D: 41 }[m[2]] || 31; }
  else if ((m = c.match(/^(7|78|8|810|108|10|109|9)(S|D|XD)?$/))) { a = col(SHEET_OUT.indexOf(m[1])); d = { S: 51, D: 72.5, XD: 83 }[m[2]] || 61.5; }
  else return null;
  const q = a * Math.PI / 180;
  return { x: +(d * M * Math.sin(q)).toFixed(1), y: +(d * M * Math.cos(q)).toFixed(1), m: d };
}
/* 紙本結果代號 → 系統結果與擊球型態 */
const SHEET_RES = { F: 'OUT', G: 'OUT', RE: 'OUT', FS: 'SF', GS: 'GS', K: 'K', BB: 'BB', DP: 'DP', FC: 'FC', E: 'E', '1B': '1B', '2B': '2B', '3B': '3B', HR: 'HR' };
function sheetType(res, pos) {
  if (res === 'F' || res === 'FS' || res === 'HR') return 'F';
  if (res === 'G' || res === 'GS' || res === 'DP' || res === 'FC') return 'G';
  const inf = pos && pos.m < 46;
  if (['1B', '2B', '3B'].includes(res)) return inf ? 'G' : 'L';
  return inf ? 'G' : 'F';
}
/* ctx：{ gameId, teamId, side, idOf(背號) → 球員 id 或 ''、player(id) → 球員、uid、uploadId } */
function sheetToBalls(P, ctx) {
  const base = Date.now();
  return (P.pas || []).map((pa, i) => {
    const res = SHEET_RES[pa.res] || 'OUT', pos = sheetZoneXY(pa.zone), noLoc = !RES[res].loc || !pos;
    const id = ctx.idOf(pa.no), p = id ? ctx.player(id) : null;
    const outN = { OUT: 1, K: 1, SF: 1, GS: 1, DP: 2 }[res] || 0;
    const scored = (pa.scorers || []).map(no => ctx.idOf(no) || '#' + no);
    const run = { pre: [null, null, null], post: [null, null, null], scored, outs: res === 'DP' ? ['?'] : res === 'FC' ? ['?'] : [], bOut: outN > 0, rbi: pa.rbi || 0, voided: 0 };
    return {
      gameId: ctx.gameId, teamId: ctx.teamId, batterId: id || '#' + pa.no, batterNo: String(pa.no || ''), batterName: p ? p.name : '（未對應）',
      side: p && p.bats && p.bats !== 'S' ? p.bats : 'R', inning: pa.inn || 1, half: ctx.side === 'away' ? 'top' : 'bottom',
      result: res, type: sheetType(pa.res, pos), x: noLoc ? 0 : pos.x, y: noLoc ? 0 : pos.y, zone: noLoc ? '' : pa.zone, noLoc,
      slot: pa.slot || null, paper: { res: pa.res, zone: pa.zone || '', round: pa.round, pr: pa.pr || null },
      source: 'sheet', uploadId: ctx.uploadId || '', createdBy: ctx.uid, at: base + i, run
    };
  });
}
/* 由 payload 建立打序（{pos, players:[{id, from}]}；from 用該員第一個打席的局數） */
function sheetLineup(P, idOf) {
  const slots = {};
  (P.lineup || []).forEach(l => { const id = idOf(l.no); if (!id) return; const first = (P.pas || []).find(pa => pa.slot === l.slot && pa.sub === l.sub);
    (slots[l.slot] = slots[l.slot] || []).push({ id, from: l.sub ? (first ? first.inn : 99) : 1, sub: l.sub }); });
  return Object.keys(slots).map(Number).sort((a, b) => a - b).map(k => ({ pos: '', players: slots[k].sort((a, b) => a.sub - b.sub).map(({ id, from }) => ({ id, from })) }));
}

/* ---------- 成績統計 ----------
   打席 PA、打數 AB（不含四壞、高犧）、打擊率 AVG＝安打÷打數、上壘率 OBP＝(安打＋四壞)÷(打數＋四壞＋高犧)、
   長打率 SLG＝壘打數÷打數、整體攻擊指數 OPS＝OBP＋SLG */
function rateStats(r) {
  const den = r.ab + r.BB + r.SF;
  r.avg = r.ab ? r.h / r.ab : 0; r.obp = den ? (r.h + r.BB) / den : 0; r.slg = r.ab ? r.tb / r.ab : 0; r.ops = r.obp + r.slg;
  r.pullPct = r.fair ? r.pull / r.fair : 0; return r;
}
function emptyLine(extra) { return Object.assign({ pa: 0, ab: 0, h: 0, '1B': 0, '2B': 0, '3B': 0, HR: 0, OUT: 0, E: 0, FC: 0, DP: 0, SF: 0, GS: 0, K: 0, BB: 0, tb: 0, pull: 0, center: 0, oppo: 0, fair: 0, games: new Set() }, extra); }
function addBall(r, b, FD) {
  const res = RES[b.result]; if (!res) return;
  r.pa++; r[b.result]++; r.h += res.hit; r.tb += res.tb; r.ab += res.ab; if (b.gameId) r.games.add(b.gameId);
  if (hasLoc(b)) { const d = FD.dirOf(b); if (d !== 'foul') { r[d]++; r.fair++; } }
}
function battingTable(balls, FD) {
  const by = new Map();
  for (const b of balls) {
    if (!by.has(b.batterId)) by.set(b.batterId, emptyLine({ batterId: b.batterId, teamId: b.teamId, no: b.batterNo || '', name: b.batterName || '' }));
    addBall(by.get(b.batterId), b, FD);
  }
  return [...by.values()].map(r => rateStats(Object.assign(r, { g: r.games.size, bip: r.pa })));
}
function teamBatting(balls, FD) {
  const by = new Map();
  for (const b of balls) { if (!by.has(b.teamId)) by.set(b.teamId, emptyLine({ teamId: b.teamId })); addBall(by.get(b.teamId), b, FD); }
  return [...by.values()].map(r => rateStats(Object.assign(r, { g: r.games.size })));
}
/* 先後攻互換（賽程只公布對戰組合，先後攻現場決定）：比分、逐局、打序一起對調 */
function canSwapSides(g) { const inn = g.innings || {}; return (g.status || 'scheduled') !== 'final' && ![...(inn.away || []), ...(inn.home || [])].some(v => v != null && v !== ''); }
function swapPatch(g) {
  const inn = g.innings || {}, lu = g.lineups || {};
  return { awayId: g.homeId, homeId: g.awayId, awayScore: g.homeScore ?? null, homeScore: g.awayScore ?? null,
    innings: { away: inn.home || [], home: inn.away || [] }, lineups: { away: lu.home || [], home: lu.away || [] }, outsAdj: {} };
}
/* 半局順序：1 上、1 下、2 上、2 下…（先攻隊打完該局上半，後攻隊才能打下半）
   halfOrd：把（局, 攻擊方）換成序號；nextHalf：第一個還沒登錄得分的半局＝現在該打的半局 */
const halfOrd = (inn, side) => (inn - 1) * 2 + (side === 'home' ? 1 : 0);
const halfOf = k => ({ inn: (k >> 1) + 1, side: k % 2 ? 'home' : 'away' });
const halfName = k => { const h = halfOf(k); return `第 ${h.inn} 局${h.side === 'away' ? '上' : '下'}`; };
function nextHalf(g) {
  const inn = (g && g.innings) || {}, blank = v => v == null || v === '';
  for (let k = 0; k < 60; k++) { const h = halfOf(k); if (blank((inn[h.side] || [])[h.inn - 1])) return k; }
  return 60;
}
/* ---------- 壘上跑者推進（秩序冊：不得盜壘、離壘；跑者踩好球板得分） ----------
   pre：[一壘, 二壘, 三壘] 的球員 id（null＝無人）
   pick：野選＝出局跑者的壘位（-1＝沒人出局）；雙殺＝Set（'B'＝打者、0/1/2＝壘位）；高犧＝[一壘到, 二壘到, 三壘到]（3＝得分）
   female：女性打者安打（秩序冊十四：打者上一壘、跑者被擠到才推進） */
function runAdvance(res, batter, pre, pick, female) {
  const b = [...pre], nb = [null, null, null], scored = [], outs = [];
  const put = (who, to) => { if (!who) return; if (to >= 3) scored.push(who); else nb[to] = who; };
  const chain = () => { let n = 0; while (n < 3 && b[n]) n++; return n; };
  let bOut = false;
  const r = female && ['1B', '2B', '3B'].includes(res) ? 'BB' : res;
  switch (r) {
    case '1B': case 'E': put(b[2], 3); put(b[1], 2); put(b[0], 1); put(batter, 0); break;
    case '2B': put(b[2], 3); put(b[1], 3); put(b[0], 2); put(batter, 1); break;
    case '3B': b.forEach(x => put(x, 3)); put(batter, 2); break;
    case 'HR': b.forEach(x => put(x, 3)); put(batter, 3); break;
    case 'BB': { const n = chain(); for (let i = 2; i >= 0; i--) if (b[i]) put(b[i], i < n ? i + 1 : i); put(batter, 0); break; }
    case 'FC': case 'DP': {
      const n = chain(), P = pick instanceof Set ? pick : new Set(Array.isArray(pick) ? pick : [pick]);
      for (let i = 2; i >= 0; i--) if (b[i]) { if (P.has(i)) outs.push(b[i]); else put(b[i], i < n ? i + 1 : i); }
      if (r === 'DP' && P.has('B')) bOut = true; else put(batter, 0);
      break;
    }
    case 'SF': { const to = Array.isArray(pick) ? pick : [0, 1, 3]; for (let i = 2; i >= 0; i--) if (b[i]) put(b[i], to[i]); bOut = true; break; }
    case 'GS': put(b[2], 3); put(b[1], 2); put(b[0], 1); bOut = true; break;
    default: b.forEach((x, i) => put(x, i)); bOut = true;   // 出局、三振：跑者不動
  }
  return { post: nb, scored, outs, bOut };
}
/* 一筆打席造成的出局數：有跑者資料時以實際（打者＋跑者）為準 */
const ballOuts = b => b.run ? (b.run.bOut ? 1 : 0) + (b.run.outs || []).length : (OUT_N[b.result] || 0);
/* 打點：得分者人數（失誤、雙殺不給打點） */
const rbiOf = (res, scored) => ['E', 'DP'].includes(res) ? 0 : scored.length;

/* 寫入某半局得分（逐局比分紀錄與後台資訊中控共用）：回傳要更新的欄位 */
function inningPatch(g, side, idx, v) {
  const inn = { away: [...((g.innings || {}).away || [])], home: [...((g.innings || {}).home || [])] };
  while (inn[side].length <= idx) inn[side].push(null);
  inn[side][idx] = v;
  ['away', 'home'].forEach(s => { while (inn[s].length && inn[s][inn[s].length - 1] == null) inn[s].pop(); });
  const t = lineTotals({ innings: inn });
  const patch = { innings: inn, awayScore: t.innings ? t.away : null, homeScore: t.innings ? t.home : null };
  if ((g.status || 'scheduled') === 'scheduled') patch.status = 'live';
  return patch;
}
const fmt3 = n => n.toFixed(3).replace(/^0/, '');
/* 逐局比分：innings = { away: [..], home: [..] }，空白為 null */
function lineTotals(g) {
  const inn = g.innings || {}, sum = a => (a || []).reduce((s, v) => s + (+v || 0), 0);
  const n = Math.max((inn.away || []).length, (inn.home || []).length);
  let played = 0;
  for (let i = 0; i < n; i++) if ((inn.away || [])[i] != null || (inn.home || [])[i] != null) played = i + 1;
  return { away: sum(inn.away), home: sum(inn.home), innings: played };
}
/* 分組積分（依第 14 屆秩序冊「五、積分與晉級制」）
   勝 3 分、和 1 分、敗 0 分。勝和敗與積分在比賽結束後計入；
   live:true（現況排名）時，進行中場次的得分、失分、防守局數隨每局即時累計。
   積分相同依序比較：1.勝負關係（同分隊伍間的對戰積分）2.總失分（少者優先）3.總得分（多者優先）
   4.總防守局數（多者優先）5.抽籤。 */
function standings(teams, games, { live = false } = {}) {
  const t = new Map(teams.map(x => [x.id, { id: x.id, name: x.name, group: x.group || '', g: 0, w: 0, l: 0, d: 0, pts: 0, rs: 0, ra: 0, def: 0, live: 0, basis: '' }]));
  const res = [];   // 已結束場次：{ a, h, as, hs }
  const filled = arr => (arr || []).filter(v => v != null && v !== '').length;
  for (const g of games) {
    if (!/預賽/.test(g.round || '預賽')) continue;
    const h = t.get(g.homeId), a = t.get(g.awayId); if (!h || !a) continue;
    if (g.status === 'live') { h.live++; a.live++; }
    const fin = g.status === 'final';
    if (!(fin || (live && g.status === 'live')) || g.homeScore == null || g.awayScore == null) continue;
    const inn = g.innings || {}, n = lineTotals(g).innings;
    // 防守局數：對手進攻了幾個半局（主隊守客隊的上半局、客隊守主隊的下半局）
    h.def += filled(inn.away) || n; a.def += filled(inn.home) || n;
    h.rs += g.homeScore; h.ra += g.awayScore; a.rs += g.awayScore; a.ra += g.homeScore;
    if (!fin) continue;
    h.g++; a.g++;
    if (g.homeScore > g.awayScore) { h.w++; a.l++; } else if (g.homeScore < g.awayScore) { a.w++; h.l++; } else { h.d++; a.d++; }
    res.push({ a: a.id, h: h.id, as: g.awayScore, hs: g.homeScore });
  }
  const rows = [...t.values()].map(r => Object.assign(r, { pts: r.w * 3 + r.d, diff: r.rs - r.ra }));
  // 同分隊伍之間的對戰積分
  const mini = block => { const ids = new Set(block.map(r => r.id)), m = new Map(block.map(r => [r.id, 0]));
    res.forEach(x => { if (ids.has(x.a) && ids.has(x.h)) { if (x.as > x.hs) m.set(x.a, m.get(x.a) + 3); else if (x.as < x.hs) m.set(x.h, m.get(x.h) + 3); else { m.set(x.a, m.get(x.a) + 1); m.set(x.h, m.get(x.h) + 1); } } });
    return m; };
  const split = (block, key, label) => {   // 依 key 分群（大者在前），單獨一隊的標上依據
    const gs = new Map(); block.forEach(r => { const k = key(r); gs.has(k) || gs.set(k, []); gs.get(k).push(r); });
    const out = [...gs.entries()].sort((x, y) => y[0] - x[0]).map(e => e[1]);
    if (out.length > 1) out.forEach(sub => { if (sub.length === 1) sub[0].basis = sub[0].basis || label; });
    return out;
  };
  function order(block, useH2H) {
    if (block.length <= 1) return block;
    if (useH2H) {
      const m = mini(block), parts = split(block, r => m.get(r.id), '勝負關係');
      if (parts.length > 1) return parts.flatMap(p => order(p, true));
    }
    let parts = [block];
    for (const [key, label] of [[r => -r.ra, '總失分'], [r => r.rs, '總得分'], [r => r.def, '防守局數']])
      parts = parts.flatMap(p => p.length > 1 ? split(p, key, label) : [p]);
    parts.forEach(p => { if (p.length > 1) p.forEach(r => r.basis = r.g ? '需抽籤' : ''); });
    return parts.flat();
  }
  const byG = {};
  rows.forEach(r => (byG[r.group] = byG[r.group] || []).push(r));
  Object.values(byG).forEach(list => {
    const ordered = split(list, r => r.pts, '積分').flatMap(p => order(p, true));
    ordered.forEach((r, i) => { r.rank = i + 1; if (r.basis === '積分' || !r.g) r.basis = ''; });
  });
  return rows.sort((a, b) => a.group.localeCompare(b.group) || a.rank - b.rank);
}

/* ---------- 名單解析：每行「背號 姓名 左右打」 ---------- */
function parseRoster(txt) {
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const t = line.split(/[,\t，、;；]+|\s+/).map(x => x.trim()).filter(Boolean); if (!t.length) continue;
    const ni = t.findIndex(x => /^#?\d{1,3}$/.test(x)); if (ni < 0) continue;
    let hand = 'R'; const no = t[ni].replace('#', ''), rest = t.filter((_, i) => i !== ni);
    const hi = rest.findIndex(x => /^(左|右|左打|右打|左右|左右開弓|兩打|L|R|S|l|r|s)$/.test(x));
    if (hi >= 0) { const h = rest[hi]; hand = /左右|兩|S|s/.test(h) ? 'S' : /左|L|l/.test(h) ? 'L' : 'R'; rest.splice(hi, 1); }
    let sex = ''; const si = rest.findIndex(x => /^(男|女|男性|女性)$/.test(x));
    if (si >= 0) { sex = sexOf(rest[si]); rest.splice(si, 1); }
    const name = rest.join(' '); if (name) out.push(Object.assign({ no, name, bats: hand }, sex ? { sex } : {}));
  }
  return out;
}

/* ---------- 小工具 ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (n, d = 1) => (n * 100).toFixed(d) + '%';
const avg3 = n => n.toFixed(3).replace(/^0/, '');
let _tt;
function toast(m) { const t = $('toast'); if (!t) return; t.textContent = m; t.classList.add('on'); clearTimeout(_tt); _tt = setTimeout(() => t.classList.remove('on'), 2200); }
/* 時間一律以台灣時間顯示與解析，不受裝置時區影響 */
function tpe(v) {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : new Date(v); if (isNaN(d)) return null;
  const t = new Date(d.getTime() + 8 * 3600e3);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: String(t.getUTCHours()).padStart(2, '0'), mm: String(t.getUTCMinutes()).padStart(2, '0') };
}
function parseTPE(s) {   // '2026/10/17 07:00'、'2026-10-17T07:00'
  const m = String(s || '').trim().match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5])) : new Date(NaN);
}
function nowTPEInput() { const t = tpe(new Date()); return `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}T${t.hh}:00`; }
function fmtDT(v) { const t = tpe(v); return t ? `${t.m}/${t.d} ${t.hh}:${t.mm}` : ''; }
function toCSV(rows) { return rows.map(r => r.map(v => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? '')).join(',')).join('\n'); }
function copyText(t, fallbackEl, okMsg) {
  const fb = () => { if (fallbackEl) { fallbackEl.hidden = false; fallbackEl.value = t; fallbackEl.focus(); fallbackEl.select(); } toast('已選取文字，請手動複製'); };
  try { navigator.clipboard.writeText(t).then(() => toast(okMsg || '已複製'), fb); } catch (_) { fb(); }
}
function friendlyError(e) {
  const c = e && e.code || '';
  if (c.includes('permission-denied')) return '沒有權限：請確認帳號已被管理員設為紀錄員';
  if (c.includes('wrong-password') || c.includes('invalid-credential') || c.includes('user-not-found')) return '帳號或密碼錯誤';
  if (c.includes('too-many-requests')) return '嘗試次數過多，請稍後再試';
  if (c.includes('email-already-in-use')) return '這個 Email 已註冊，請直接登入';
  if (c.includes('weak-password')) return '密碼至少需要 6 個字元';
  if (c.includes('unavailable')) return '目前離線，資料會在恢復連線後同步';
  return (e && e.message) || '發生錯誤';
}

/* ---------- 以場次為準的連結：打擊落點紀錄連結了某場後，各頁之間的連結自動帶到那一場（12 小時內有效） ---------- */
function focusGame() { try { const f = JSON.parse(localStorage.getItem('sb-focus') || 'null'); if (f && f.g && Date.now() - f.at < 12 * 3600e3) return f; } catch (_) {} return null; }
function focusHref(h) { const f = focusGame(); if (!f || !/^(admin|score|scorer|index|standings|sheet)\.html(\?|#|$)/.test(h) || /[?&]g=/.test(h)) return h;
  const [p, hash] = h.split('#'); return p.split('?')[0] + '?t=' + encodeURIComponent(f.t) + '&g=' + encodeURIComponent(f.g) + (hash ? '#' + hash : ''); }
document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a[href]'); if (!a) return; const h = a.getAttribute('href'), n = focusHref(h); if (n !== h) a.setAttribute('href', n); }, true);
