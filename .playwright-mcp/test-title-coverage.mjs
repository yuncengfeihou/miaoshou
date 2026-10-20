/**
 * 虚拟滚动仿真沙箱：把真实 stepTitle 的**源码原文**抽出来，跑在忠实模拟
 * 「虚拟滚动 + 停放副本 + 值持久化」的假 DOM 上。
 *
 * 目的：负向用例 —— 故意让滚动只走一部分，看脚本自己的覆盖断言会不会失败。
 * 若负向用例也"成功"，说明覆盖断言是摆设，正是「步骤漏了还报成功」的形态。
 *
 * 运行：node test-title-coverage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
const WS = process.env.MSXB_WS || 'C:\\Users\\lenovo\\Desktop\\妙手';
const SCRATCH = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const SRC = fs.readFileSync(process.env.MSXB_TARGET || path.join(WS, '妙手采集箱助手.user.js'), 'utf8');
function extractFn(name) {
  const a = SRC.indexOf('async function ' + name + '(');
  const start = a >= 0 ? a : SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('括号不配平: ' + name);
}

/* --------------------------------------------------- 极简假 DOM */
function mkNode(className = '', tag = 'DIV') {
  const n = {
    children: [], parent: null, style: {}, value: '',
    innerText: '', textContent: '', tagName: tag,
    __cls: new Set(className ? className.split(/\s+/) : []),
    hasClass(c) { return this.__cls.has(c); },
    getClientRects() { return [1]; },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return queryWithin(this, sel); },
    closest(sel) { let p = this; while (p) { if (matchesSel(p, sel)) return p; p = p.parent; } return null; },
  };
  n.classList = {
    add: (...a) => a.forEach((x) => n.__cls.add(x)),
    contains: (c) => n.__cls.has(c),
    remove: (c) => n.__cls.delete(c),
  };
  Object.defineProperty(n, 'className', {
    get: () => [...n.__cls].join(' '),
    set: (v) => { n.__cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  return n;
}
function matchesSel(node, sel) {
  return sel.split(',').some((one) => {
    const parts = one.trim().split(/\s+/).filter(Boolean);
    return matchChain(node, parts, parts.length - 1);
  });
}
function matchChain(node, parts, idx) {
  const p = parts[idx];
  let m;
  if (p.startsWith('[')) m = true;
  else if (p.startsWith('.')) m = p.split('.').filter(Boolean).every((c) => node.__cls && node.__cls.has(c));
  else m = (node.tagName || '').toLowerCase() === p.toLowerCase();
  if (!m) return false;
  if (idx === 0) return true;
  let parent = node.parent;
  while (parent) { if (matchChain(parent, parts, idx - 1)) return true; parent = parent.parent; }
  return false;
}
function queryWithin(root, sel) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (matchesSel(c, sel)) out.push(c); walk(c); } };
  walk(root);
  return out;
}

/* ------------------------------------------------------------ 假预览表 */
const ROW_H = 31;

function makeTable({ items, stopAtFraction = 1, windowRows = null, clientH = 400, parkCopies = 2, hideTotal = false }) {
  const total = items.length;
  const root = mkNode('fake-root');
  const table = mkNode('jx-pro-virtual-table');
  const body = mkNode('jx-pro-virtual-table__body');
  const scroller = mkNode('vue-recycle-scroller jx-pro-virtual-table__body');
  table.appendChild(body);
  body.appendChild(scroller);
  root.appendChild(table);

  if (!hideTotal) {
    const totalEl = mkNode('el-pagination__total');
    totalEl.innerText = `已选 ${total} / ${total}条`;
    root.appendChild(totalEl);
  }

  // 行状态的**持久**副本：模拟 Vue 的 data 层（DOM 行随滚动重建，值不丢）
  const state = items.map((it) => ({ orig: it.orig, ta: it.ta, unchecked: !!it._unchecked }));

  const contentH = Math.max(total * ROW_H, 1);
  scroller.scrollHeight = contentH;
  scroller.clientHeight = Math.min(clientH, contentH);
  const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const limitTop = Math.floor(maxScroll() * stopAtFraction);
  const cap = windowRows == null ? Math.ceil(scroller.clientHeight / ROW_H) + 4 : windowRows;

  function paintRow(idx) {
    const st = state[idx];
    const row = mkNode('jx-pro-virtual-table__row');
    row.appendChild(Object.assign(mkNode('jx-pro-virtual-table__row-cell'), { innerText: '' }));
    row.appendChild(Object.assign(mkNode('jx-pro-virtual-table__row-cell'), { innerText: items[idx].itemInfo || '' }));
    row.appendChild(Object.assign(mkNode('jx-pro-virtual-table__row-cell'), { innerText: st.orig }));   // 编辑前
    const c3 = mkNode('jx-pro-virtual-table__row-cell');
    const ta = mkNode('', 'TEXTAREA');
    Object.defineProperty(ta, 'value', { get: () => st.ta, set: (v) => { st.ta = v; }, configurable: true });
    c3.appendChild(ta);
    row.appendChild(c3);
    row.appendChild(mkNode('el-checkbox' + (st.unchecked ? '' : ' is-checked')));
    return row;
  }

  let top = 0;
  function reflow() {
    const first = Math.max(0, Math.min(Math.floor(top / ROW_H), Math.max(0, total - 1)));
    const count = Math.max(0, Math.min(cap, total - first));
    const next = [];
    for (let k = 0; k < count; k++) {
      const idx = first + k;
      const view = mkNode('vue-recycle-scroller__item-view');
      view.style = { transform: `translateY(${idx * ROW_H}px)` };
      view.appendChild(paintRow(idx));
      next.push(view);
    }
    for (let k = 0; k < parkCopies; k++) {
      const pv = mkNode('vue-recycle-scroller__item-view');
      pv.style = { transform: 'translateY(-9999px)' };
      pv.appendChild(paintRow(0));
      next.push(pv);
    }
    scroller.children = next;
    next.forEach((v) => { v.parent = scroller; });
  }

  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v) => {
      const want = Math.max(0, Math.min(v, maxScroll()));
      top = Math.min(want, limitTop);       // stopAtFraction < 1：模拟「滚不过去」
      reflow();
    },
    configurable: true,
  });
  reflow();
  return { root, scroller, state, total };
}

/* ------------------------------------------------------------ 沙箱环境 */
function buildEnv({ table, words, prefix }) {
  const logLines = [], warnLines = [], writes = [];
  const env = {
    settings: { deleteWords: words },
    log: (...a) => logLines.push(a.map(String).join(' ')),
    warn: (...a) => warnLines.push(a.map(String).join(' ')),
    sleep: () => Promise.resolve(),
    textOf: (el) => ((el && (el.innerText || el.textContent)) || '').trim(),
    setNativeValue: (el, v) => { el.value = v; writes.push(v); },
    assertPageVisible: () => {},
    // v1.17.0：stepTitle 开头会调 syncActiveWordVersion() 对账词库版本（方向只有
    // settings → 版本库）。这里用桩函数：对账逻辑本身在 test-words-store.mjs 里单独覆盖，
    // 本文件只关心「覆盖断言 + 写入」。
    syncActiveWordVersion: () => false,
    openBatchEdit: async () => table.root,
    ensureRuleMode: async () => {},
    setPreviewPageSize: async () => '500条/页',
    clickPreview: async () => {},
    previewPageCount: () => 1,
    clickSave: async () => ({ total: 1, success: 1, fail: 0 }),
    safeVerify: async () => ({ checked: 0, failed: [], notes: [] }),
    attachVerify: (r) => r,
    makeTitleBuilder: (w) => (orig) => {
      let v = orig || '';
      w.forEach((x) => { v = v.split(x).join(''); });
      v = v.replace(/[ \t]+/g, ' ')
        .replace(/([,，、])\s*(?=[,，、])/g, '')
        .replace(/^[\s,，、\-–—]+/, '')
        .replace(/[\s,，、\-–—]+$/, '')
        .replace(/\s+([,，、])/g, '$1')
        .trim();
      return v ? prefix + ' ' + v : prefix;
    },
  };
  return { env, logLines, warnLines, writes };
}

async function runStepTitle(opts) {
  const table = makeTable(opts);
  const { env, logLines, warnLines, writes } = buildEnv({ table, words: opts.words, prefix: opts.prefix });
  const body = extractFn('stepTitle');
  const stepTitle = new Function('env', `with (env) {\n${body}\nreturn stepTitle;\n}`)(env);
  let error = null;
  try { await stepTitle(); } catch (e) { error = e.message; }
  return { logLines, warnLines, writes, error, state: table.state };
}

/* ------------------------------------------------------------------ 用例 */
const WORDS = ['短袖', '透气', '面料'];
const PREFIX = '[Print Design - No Texture]';
const mkItems = (n) => Array.from({ length: n }, (_, i) => ({
  orig: `男士短袖透气面料T恤 第${i + 1}号`,
  ta: `男士短袖透气面料T恤 第${i + 1}号`,
  itemInfo: `店铺${i % 3} 未分组`,
}));

const results = [];
function check(name, r, pred) {
  const cov = r.logLines.find((l) => l.includes('覆盖')) || '(无覆盖日志)';
  const ok = pred(r);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${cov}`);
  console.log(`      错误=${r.error || '(无)'} · 写入=${r.writes.length}`);
  return ok;
}

const known = [];
function KNOWN_DEFECT(name, r, pred) {
  // 已确认的脚本缺陷：期望行为是"应当失败"，当前实现却放行。
  // 记为 known，不判红；一旦脚本修好（pred 成立）会反过来提示把它转成正式用例。
  const ok = pred(r);
  console.log(`${ok ? 'FIXED?' : 'KNOWN'}  ${name}`);
  if (r.res) console.log(`      changed=${r.res.changed} stillWrong=${r.res.stillWrong} coveredRows=${r.res.coveredRows} selectedItemCount=${r.res.selectedItemCount} pages=${r.res.pages}`);
  console.log(`      错误=${r.error || '(无)'}`);
  if (ok) known.push(name);
  return true;
}

async function main() {
  { // 1 正常小批量
    const r = await runStepTitle({ items: mkItems(20), words: WORDS, prefix: PREFIX });
    results.push(check('20 条正常：覆盖 20/20、不抛错、每行只写一次', r,
      (x) => !x.error && /覆盖 20 \/ 20/.test(x.logLines.join('\n')) && x.writes.length === 20));
  }
  { // 2 滚不到底（负向：必须失败）
    const r = await runStepTitle({ items: mkItems(40), words: WORDS, prefix: PREFIX, stopAtFraction: 0.3 });
    results.push(check('40 条只滚到 30%：必须抛「只覆盖到 X/40 行」', r,
      (x) => !!x.error && /只覆盖到 \d+\/40 行/.test(x.error)));
  }
  { // 3 大批量 + 窄渲染窗（7 行刚好铺满 155px 视口）
    const r = await runStepTitle({ items: mkItems(100), words: WORDS, prefix: PREFIX, windowRows: 7, clientH: 155 });
    results.push(check('100 条、一次只渲染 7 行：应覆盖 100/100', r,
      (x) => !x.error && /覆盖 100 \/ 100/.test(x.logLines.join('\n'))));
  }
  { // 4 空原文（负向）
    const items = mkItems(10); items[4].orig = '';
    const r = await runStepTitle({ items, words: WORDS, prefix: PREFIX });
    results.push(check('有 1 行「编辑前」为空：必须抛错', r,
      (x) => !!x.error && /编辑前/.test(x.error)));
  }
  { // 5 item-info 污染
    const r = await runStepTitle({ items: mkItems(10), words: WORDS, prefix: PREFIX });
    results.push(check('item-info 有内容：写入不得含「店铺」', r,
      (x) => !x.error && !x.writes.some((w) => w.includes('店铺'))));
  }
  { // 6 未勾选（负向）
    const items = mkItems(10); items[3]._unchecked = true;
    const r = await runStepTitle({ items, words: WORDS, prefix: PREFIX });
    results.push(check('有 1 行预览未勾选：必须抛错', r,
      (x) => !!x.error && /没勾选/.test(x.error)));
  }
  { // 7 幂等：已改成目标值的行不应再写
    const items = mkItems(5).map((it) => ({ ...it, ta: PREFIX + ' ' + it.orig.replace(/短袖|透气|面料/g, '') }));
    const r = await runStepTitle({ items, words: WORDS, prefix: PREFIX });
    results.push(check('5 条已是目标值：不应重复写入（幂等）', r,
      (x) => !x.error && x.writes.length === 0));
  }
  { // 8 expected 读不到（=0）：覆盖断言不能整段跳过 —— 必须抛错（审查报告.md §三 T1）
    const r = await runStepTitle({ items: mkItems(40), words: WORDS, prefix: PREFIX, stopAtFraction: 0.3, hideTotal: true });
    results.push(check('expected 读不到 + 只滚 30%：必须抛「读不到预览区总条数」', r,
      (x) => !!x.error && /读不到预览区总条数/.test(x.error)));
  }

  if (known.length) console.log(`\n⚠ 下面这些缺陷看起来已被修复，请转成正式用例：\n  - ` + known.join('\n  - '));
  const pass = results.filter(Boolean).length;
  console.log(`\n合计 ${results.length} 例：通过 ${pass} · 失败 ${results.length - pass}`);
  process.exit(pass === results.length ? 0 : 1);
}

main();
