/**
 * 颜色图 setAllColors 仿真沙箱：抽出真实源码，跑在模拟「虚拟滚动 + 分页 + 停放副本」的假 DOM 上。
 *
 * 要回答（审查报告 §4.10 的主张）：
 *   ① coveredRows 是否真的没有绝对下界？
 *   ② 「整段行从未渲染 / 翻页失败」时 stillWrong 是否仍为 0 → 保存 → 报成功？
 *
 * 运行：node test-color-coverage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const WS = process.env.MSXB_WS || 'C:\\Users\\lenovo\\Desktop\\妙手';
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

/* ------------------------------- 极简假 DOM ------------------------------- */
function mkNode(className = '', tag = 'DIV') {
  const n = {
    children: [], parent: null, style: {}, value: '', placeholder: '',
    innerText: '', textContent: '', tagName: tag, scrollTop: 0,
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
  if (p.startsWith('[')) {
    m = true;
  } else {
    const base = p.split('.')[0];
    const classes = p.split('.').slice(1).filter(Boolean);
    const tagOk = !base || base === '*' || (node.tagName || '').toLowerCase() === base.toLowerCase();
    const clsOk = classes.every((c) => node.__cls && node.__cls.has(c));
    m = tagOk && clsOk;
  }
  if (!m) return false;
  if (idx === 0) return true;
  let parent = node.parent;
  while (parent) {
    if (matchChain(parent, parts, idx - 1)) return true;
    parent = parent.parent;
  }
  return false;
}

function queryWithin(root, sel) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (matchesSel(c, sel)) out.push(c); walk(c); } };
  walk(root);
  return out;
}

/* --------------------------- 颜色图面板假 DOM --------------------------- */
const ROW_H = 270;

function makeColorPanel(spec) {
  const rowsPerItem = spec.rowsPerItem;
  const itemTotal = rowsPerItem.length;
  const flat = [];
  rowsPerItem.forEach((c, itemIdx) => {
    for (let k = 0; k < c; k++) flat.push({ itemIdx, name: `颜色${itemIdx + 1}-${k + 1}` });
  });

  const root = mkNode('fake-root');
  const editor = mkNode('sku-image-batch-editor');
  root.appendChild(editor);

  const itemList = mkNode('sku-image-batch-editor__item-list');
  editor.appendChild(itemList);

  const pagerWrap = mkNode('jx-pro-pagination');
  editor.appendChild(pagerWrap);
  const pagEl = mkNode('el-pagination');
  pagerWrap.appendChild(pagEl);
  const totalEl = mkNode('el-pagination__total');
  totalEl.innerText = `${itemTotal}条`;
  pagEl.appendChild(totalEl);

  const pageSize = spec.pageSize;
  const pageCount = Math.max(1, Math.ceil(itemTotal / pageSize));
  const pagerUl = mkNode('el-pager');
  pagEl.appendChild(pagerUl);

  let curPage = 1;
  function renderPager() {
    pagerUl.children = [];
    for (let i = 1; i <= pageCount; i++) {
      const li = mkNode('el-pager__item number' + (i === curPage ? ' active' : ''), 'LI');
      li.innerText = String(i);
      li.click = () => { if (spec.goPageWorks !== false) { curPage = i; reflow(); } };
      pagerUl.appendChild(li);
    }
  }

  const stateByName = new Map(flat.map((r) => [r.name, r.name]));

  function pageRows() {
    const from = (curPage - 1) * pageSize;
    return flat.slice(from, from + pageSize);
  }

  function reflow() {
    renderPager();
    const rows = pageRows();
    const contentH = Math.max(rows.length * ROW_H, 1);
    itemList.scrollHeight = contentH;
    itemList.clientHeight = Math.min(spec.clientH || 470, contentH);
    const cap = spec.windowRows || (Math.ceil(itemList.clientHeight / ROW_H) + 4);
    const first = Math.max(0, Math.min(Math.floor((itemList.scrollTop || 0) / ROW_H), Math.max(0, rows.length - 1)));
    const count = Math.max(0, Math.min(cap, rows.length - first));

    itemList.children = [];
    const paint = (idx, park) => {
      const view = mkNode('vue-recycle-scroller__item-view');
      view.style = { transform: park ? 'translateY(-9999px)' : `translateY(${idx * ROW_H}px)` };
      const div = mkNode('pro-divider');
      const inp = mkNode('el-input__inner', 'INPUT');
      Object.defineProperty(inp, 'value', {
        get: () => stateByName.get(rows[idx].name),
        set: (v) => { stateByName.set(rows[idx].name, v); },
        configurable: true,
      });
      div.appendChild(inp);
      view.appendChild(div);
      return view;
    };
    for (let k = 0; k < count; k++) itemList.appendChild(paint(first + k, false));
    for (let p = 0; p < (spec.parkCopies ?? 2); p++) itemList.appendChild(paint(0, true));
  }

  Object.defineProperty(itemList, 'scrollTop', {
    get: () => itemList._st || 0,
    set: (v) => {
      const maxT = Math.max(0, (itemList.scrollHeight || 0) - (itemList.clientHeight || 0));
      itemList._st = Math.max(0, Math.min(v, maxT));
      reflow();
    },
    configurable: true,
  });

  reflow();
  return { root, itemList, state: stateByName, flat, itemTotal, getPage: () => curPage };
}

/* ------------------------------ 沙箱环境 ------------------------------ */
function buildEnv(panel, colorName) {
  const logs = [], warns = [];
  const env = {
    log: (...a) => logs.push(a.map(String).join(' ')),
    warn: (...a) => warns.push(a.map(String).join(' ')),
    sleep: () => Promise.resolve(),
    textOf: (el) => ((el && (el.innerText || el.textContent)) || '').trim(),
    isVisible: () => true,
    clickEl: async (el) => { if (el && el.click) el.click(); },
    setNativeValue: (el, v) => { el.value = v; },
    setPreviewPageSize: async () => '500条/页',
    __dlg: panel.root,
  };
  return { env, logs, warns };
}

async function runSetAllColors(spec) {
  const panel = makeColorPanel(spec);
  const colorName = '混合色';
  const { env, logs, warns } = buildEnv(panel, colorName);
  const helpers = [extractFn('colorNameInputs'), extractFn('colorRowTotal')].join('\n');
  const body = extractFn('setAllColors');
  const fn = new Function('env', `
    with (env) {
      ${helpers}
      ${body}
      return setAllColors;
    }
  `)(env);
  let error = null, res = null;
  try { res = await fn(panel.root, colorName); } catch (e) { error = e.message; }
  return { res, error, logs, warns, panel, state: panel.state };
}

/* -------------------------------- 用例 -------------------------------- */
const results = [];
function check(name, r, pred) {
  const ok = pred(r);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (r.res) {
    console.log(`      changed=${r.res.changed} stillWrong=${r.res.stillWrong} coveredRows=${r.res.coveredRows} selectedItemCount=${r.res.selectedItemCount} pages=${r.res.pages}`);
  }
  console.log(`      错误=${r.error || '(无)'}`);
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
  { // 1 单页 6 商品各 1 规格
    const r = await runSetAllColors({ rowsPerItem: Array(6).fill(1), pageSize: 20, windowRows: 7, clientH: 470 });
    results.push(check('6 商品各 1 行：全部改成混合色', r,
      (x) => !x.error && x.res && x.res.stillWrong === 0 && [...x.state.values()].every((v) => v === '混合色')));
  }
  { // 2 25 商品 / 默认 20 条每页（真实坑：第 21 条起滚不到）
    const r = await runSetAllColors({ rowsPerItem: Array(25).fill(1), pageSize: 20, windowRows: 8, clientH: 470 });
    results.push(check('25 商品 / 每页 20：应翻页扫完 25 行', r,
      (x) => !x.error && x.res && x.res.stillWrong === 0 && [...x.state.values()].every((v) => v === '混合色')));
  }
  { // 5 【验证报告建议】coveredRows >= selectedItemCount 这条下界够不够
    //   20 个商品、每个 2 个规格 = 40 行；每页 10 个商品 → 第 2 页永远进不去
    const r5 = await runSetAllColors({ rowsPerItem: Array(20).fill(2), pageSize: 10, windowRows: 8, clientH: 470, goPageWorks: false });
    const unmixed5 = [...r5.state.values()].filter((v) => v !== '混合色').length;
    const boundPasses = r5.res && r5.res.coveredRows >= r5.res.selectedItemCount;
    console.log(`      （${unmixed5} 行没改；报告建议的下界 coveredRows>=selectedItemCount → ${boundPasses ? '成立(放行!)' : '不成立(能拦住)'}）`);
    KNOWN_DEFECT('报告建议的下界也拦不住「整页漏改」', r5, (x) => !x.error && x.res && x.res.stillWrong > 0);
  }
  { // 3 多规格 1/2/3/1/2/4 = 13 行
    const r = await runSetAllColors({ rowsPerItem: [1, 2, 3, 1, 2, 4], pageSize: 20, windowRows: 7, clientH: 700 });
    results.push(check('多规格共 13 行：全部改成混合色', r,
      (x) => !x.error && x.res && x.res.stillWrong === 0 && [...x.state.values()].every((v) => v === '混合色')));
  }
  { // 4 【关键负向】翻页失效：第 2 页永远进不去
    const r = await runSetAllColors({ rowsPerItem: Array(30).fill(1), pageSize: 20, windowRows: 8, clientH: 470, goPageWorks: false });
    const unmixed = [...r.state.values()].filter((v) => v !== '混合色').length;
    console.log(`      （实际仍有 ${unmixed} 行没改成混合色）`);
    KNOWN_DEFECT('翻页失效、10 行没改：stillWrong=0，静默放行（脚本缺陷）', r, (x) => !x.error && x.res && x.res.stillWrong > 0);
  }

  if (known.length) console.log(`\n⚠ 下面这些缺陷看起来已被修复，请转成正式用例：\n  - ` + known.join('\n  - '));
  const pass = results.filter(Boolean).length;
  console.log(`\n合计 ${results.length} 例：通过 ${pass} · 失败 ${results.length - pass}`);
  process.exit(pass === results.length ? 0 : 1);
}

main();
