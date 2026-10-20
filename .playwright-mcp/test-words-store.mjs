/**
 * 词库版本库回归（v1.17.0）：20 例 + 3 个变异
 *
 * 覆盖：
 *   · diffWords —— 按词集合比较、大小写敏感、仅有顺序变化要报 orderOnly
 *   · push/ prune —— 单调 id、只留最近 10 版、空词库不入历史
 *   · load —— 首次种子 / 已对齐不重复记 / 与现值不一致要补记 / 坏 JSON 不炸 / 超量裁剪
 *   · save —— 配额失败时丢最旧一版再写
 *   · commitWords —— 同值不写、空库拒绝、写后「最新版 === settings.deleteWords」
 *
 * 最后跑 3 个变异（把 bug 注回去），**必须变红**，否则说明断言恒真。
 *
 * 运行：node .playwright-mcp/test-words-store.mjs
 */
import fs from 'node:fs';

const SRC = new URL('../妙手采集箱助手.user.js', import.meta.url);
// src 必须在这里声明：下面的 matchBrace / extractFunction / CFG 提取都在模块初始化时就用到它
let src = fs.readFileSync(SRC, 'utf8');

function matchBrace(from) {
  let i = src.indexOf('{', from);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('brace not balanced');
}
function extractFunction(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  return src.slice(start, matchBrace(start));
}

const CFG = (() => {
  const start = src.indexOf('const CFG = {');
  if (start < 0) throw new Error('missing CFG');
  return new Function('return (' + src.slice(src.indexOf('{', start), matchBrace(start)) + ')')();
})();
const STORE_KEY = (src.match(/const WORDS_STORE_KEY = '([^']+)'/) || [])[1];
if (!STORE_KEY) throw new Error('找不到 WORDS_STORE_KEY');
const MAX_VERSIONS = Number((src.match(/const WORDS_MAX_VERSIONS = (\d+)/) || [])[1]);
if (!MAX_VERSIONS) throw new Error('找不到 WORDS_MAX_VERSIONS');

const FUNCS = [
  'parseWords', 'sameWords', 'findWordVersion', 'activeWordVersion',
  'loadWordStore', 'saveWordStore', 'pruneWordVersions', 'pushWordVersion',
  'syncActiveWordVersion', 'diffWords', 'commitWords'
];

/** 造一个沙箱：localStorage / warn / toast 都由测试控制 */
function makeSandbox(opts) {
  const o = opts || {};
  const store = new Map(Object.entries(o.seed || {}));
  const warns = [];
  const toasts = [];
  const state = { saveSettings: 0, quotaLeft: typeof o.quotaFails === 'number' ? o.quotaFails : 0 };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (k === STORE_KEY && state.quotaLeft > 0) {
        state.quotaLeft -= 1;
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      store.set(k, String(v));
    }
  };
  const warn = (...a) => warns.push(a.map((x) => String(x)).join(' '));
  const toast = (ok, title, sub) => toasts.push({ ok, title, sub: sub || '' });
  const settings = { deleteWords: [...(o.words || CFG.deleteWords)] };
  const wordsStore = { seq: 0, list: [] };
  const saveSettings = () => { state.saveSettings += 1; return o.saveSettingsOk !== false; };
  const refreshWordsBtn = () => {};
  const renderWordsModal = () => {};

  const decls = FUNCS.map(extractFunction).join('\n\n');
  const consts = 'const WORDS_STORE_KEY = ' + JSON.stringify(STORE_KEY) + ';\n'
    + 'const WORDS_MAX_VERSIONS = ' + MAX_VERSIONS + ';\n';
  const factory = new Function(
    'settings', 'wordsStore', 'localStorage', 'warn', 'toast', 'saveSettings',
    'refreshWordsBtn', 'renderWordsModal',
    consts + decls + '\nreturn { ' + FUNCS.join(', ') + ' };'
  );
  const api = factory(settings, wordsStore, localStorage, warn, toast, saveSettings,
    refreshWordsBtn, renderWordsModal);
  return { api, settings, wordsStore, store, warns, toasts, state };
}


let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra === undefined ? '' : extra); }
}

function runSuite() {
  /* ---------- diffWords ---------- */
  {
    const { api } = makeSandbox();
    const d = api.diffWords(['x', 'y', 'z'], ['x', 'z', 'w']);
    check('diff: 新增/删除/未变计数', d.added.length === 1 && d.added[0] === 'w'
      && d.removed.length === 1 && d.removed[0] === 'y' && d.kept === 2 && d.orderOnly === false, JSON.stringify(d));
  }
  {
    const { api } = makeSandbox();
    const d = api.diffWords(['a', 'b'], ['a', 'b']);
    check('diff: 完全相同 → 全 0 且不报 orderOnly',
      !d.added.length && !d.removed.length && d.kept === 2 && d.orderOnly === false, JSON.stringify(d));
  }
  {
    const { api } = makeSandbox();
    const d = api.diffWords(['a', 'b'], ['b', 'a']);
    check('diff: 只有顺序不同 → orderOnly', d.orderOnly === true
      && !d.added.length && !d.removed.length, JSON.stringify(d));
  }
  {
    const { api } = makeSandbox();
    const d = api.diffWords(['3D'], ['3d']);
    check('diff: 大小写敏感（3D ≠ 3d）',
      d.added[0] === '3d' && d.removed[0] === '3D', JSON.stringify(d));
  }
  {
    const { api } = makeSandbox();
    const d = api.diffWords([], ['a', 'b']);
    check('diff: 基准为空 → 全部新增', d.added.length === 2 && !d.removed.length && d.kept === 0);
  }

  /* ---------- sameWords ---------- */
  {
    const { api } = makeSandbox();
    check('sameWords: 顺序不同 → false', api.sameWords(['a', 'b'], ['b', 'a']) === false);
    check('sameWords: 完全一致 → true', api.sameWords(['a', 'b'], ['a', 'b']) === true);
  }

  /* ---------- prune / push ---------- */
  {
    const { api, wordsStore } = makeSandbox();
    for (let i = 1; i <= MAX_VERSIONS + 4; i++) {
      wordsStore.list.unshift({ id: i, at: i, words: ['w' + i], reason: 'manual', note: '' });
    }
    const dropped = api.pruneWordVersions();
    check('prune: 只留最近 10 版', wordsStore.list.length === MAX_VERSIONS && dropped === 4,
      wordsStore.list.length + ' / dropped=' + dropped);
    check('prune: 保留的是最新的那 10 条', wordsStore.list[0].id === MAX_VERSIONS + 4
      && wordsStore.list[wordsStore.list.length - 1].id === 5);
  }
  {
    const { api, wordsStore, store } = makeSandbox();
    const a = api.pushWordVersion(['x', 'y'], 'manual', '第一个');
    const b = api.pushWordVersion(['x', 'y', 'z'], 'manual', '');
    check('push: id 单调递增且前插', a.id === 1 && b.id === 2 && wordsStore.list[0].id === 2);
    check('push: 落盘（key 正确）', !!store.get(STORE_KEY) && JSON.parse(store.get(STORE_KEY)).list.length === 2);
    check('push: 词条经 parseWords 归一（去重/去空）',
      JSON.stringify(api.pushWordVersion(['x', 'x', ' ', 'y'], 'manual', '').words) === JSON.stringify(['x', 'y']));
  }
  {
    const { api, wordsStore } = makeSandbox();
    const ver = api.pushWordVersion([], 'manual', '');
    check('push: 空词库不入历史', ver === null && wordsStore.list.length === 0);
  }

  /* ---------- load ---------- */
  {
    const { api, wordsStore, settings } = makeSandbox();
    api.loadWordStore();
    check('load: 首次 → 用当前词库生成 seed 版',
      wordsStore.list.length === 1 && wordsStore.list[0].reason === 'seed'
      && JSON.stringify(wordsStore.list[0].words) === JSON.stringify(settings.deleteWords));
  }
  {
    const list = [{ id: 7, at: 1000, words: [...CFG.deleteWords], reason: 'manual', note: '' }];
    const { api, wordsStore, settings } = makeSandbox({ seed: { [STORE_KEY]: JSON.stringify({ v: 1, seq: 7, list }) } });
    api.loadWordStore();
    check('load: 已与现值对齐 → 不重复记版本',
      wordsStore.list.length === 1 && JSON.stringify(wordsStore.list[0].words) === JSON.stringify(settings.deleteWords),
      wordsStore.list.length);
  }
  {
    const stale = [{ id: 7, at: 1000, words: ['旧词'], reason: 'manual', note: '' }];
    const { api, wordsStore, settings } = makeSandbox({ seed: { [STORE_KEY]: JSON.stringify({ v: 1, seq: 7, list: stale }) } });
    api.loadWordStore();
    check('load: 与现值不一致 → 补记一条，且最新版 === settings.deleteWords',
      wordsStore.list.length === 2
      && JSON.stringify(wordsStore.list[0].words) === JSON.stringify(settings.deleteWords)
      && wordsStore.list[0].id > 7,
      wordsStore.list.map((v) => v.id + ':' + v.words.length).join(','));
  }
  {
    const { api, wordsStore, settings, warns } = makeSandbox({ seed: { [STORE_KEY]: '{ 这不是 JSON' } });
    api.loadWordStore();
    check('load: 坏 JSON 不抛错，按当前词库重建',
      wordsStore.list.length === 1
      && JSON.stringify(wordsStore.list[0].words) === JSON.stringify(settings.deleteWords)
      && warns.length === 1, warns.join(' | '));
  }
  {
    const many = [];
    for (let i = 1; i <= 15; i++) many.push({ id: i, at: 1000 + i, words: ['w' + i], reason: 'manual', note: '' });
    many.sort((a, b) => b.id - a.id);
    const { api, wordsStore, settings } = makeSandbox({ seed: { [STORE_KEY]: JSON.stringify({ v: 1, seq: 15, list: many }) } });
    api.loadWordStore();
    check('load: 超量历史自动裁到 10 版', wordsStore.list.length === MAX_VERSIONS,
      String(wordsStore.list.length));
    check('load: 裁剪后仍然对齐（补记的版本在最前）',
      JSON.stringify(wordsStore.list[0].words) === JSON.stringify(settings.deleteWords));
  }

  /* ---------- save 配额 ---------- */
  {
    const list = [];
    for (let i = 1; i <= 3; i++) list.push({ id: i, at: 1000 + i, words: ['w' + i], reason: 'manual', note: '' });
    list.sort((a, b) => b.id - a.id);
    const { api, wordsStore, store, state, warns } = makeSandbox({
      seed: { [STORE_KEY]: JSON.stringify({ v: 1, seq: 3, list }) }
    });
    api.loadWordStore();                     // 这里会补记一条「与执行词库对齐」→ 共 4 版
    const before = wordsStore.list.length;
    state.quotaLeft = 1;                     // 只让**这一次**写入挨配额错误（load 阶段不挨）
    wordsStore.list.unshift({ id: before + 1, at: 2000, words: ['w4'], reason: 'manual', note: '' });
    const ok = api.saveWordStore();
    const after = JSON.parse(store.get(STORE_KEY)).list;
    check('save: 配额失败 → 丢最旧一版后写入成功',
      ok === true && after.length === before && after[0].id === before + 1,
      'ok=' + ok + ' len=' + after.length + ' before=' + before);
    check('save: 丢弃行为有 warn 留痕',
      warns.some((w) => /丢弃最旧版本/.test(w)), warns.join(' | '));
  }

  /* ---------- commitWords ---------- */
  {
    const { api, settings, wordsStore, toasts, state } = makeSandbox();
    api.loadWordStore();
    const before = wordsStore.list.length;
    const ok = api.commitWords(settings.deleteWords.slice(), 'manual', '');
    check('commit: 与现值相同 → 不写、不产生版本',
      ok === false && wordsStore.list.length === before && state.saveSettings === 0,
      'ok=' + ok + ' ver=' + wordsStore.list.length);
    check('commit: 同值提示「词库未变」', toasts.length === 1 && toasts[0].title === '词库未变');
  }
  {
    const { api, settings, wordsStore } = makeSandbox({ words: ['a', 'b'] });
    api.loadWordStore();
    const ok = api.commitWords(['b', 'c'], 'manual', '弹窗编辑');
    check('commit: 新值 → settings 更新 + 新版本在最前',
      ok === true && wordsStore.list[0].id === 2 && wordsStore.list[0].reason === 'manual'
      && JSON.stringify(settings.deleteWords) === JSON.stringify(['b', 'c']));
    check('commit: 不变量成立（最新版 === 执行词库）',
      JSON.stringify(wordsStore.list[0].words) === JSON.stringify(settings.deleteWords));
  }
  {
    const { api, settings, wordsStore, state } = makeSandbox({ words: ['a'] });
    api.loadWordStore();
    const ok = api.commitWords([], 'manual', '');
    check('commit: 空词库被拒绝（清空输入框 ≠ 清空词库）',
      ok === false && wordsStore.list.length === 1
      && JSON.stringify(settings.deleteWords) === JSON.stringify(['a']) && state.saveSettings === 0);
  }
  {
    const { api, wordsStore } = makeSandbox({ words: ['a'] });
    api.loadWordStore();
    api.commitWords(['a', 'b'], 'manual', '');
    const d = api.diffWords(wordsStore.list[1].words, wordsStore.list[0].words);
    check('commit: 相邻两版差异正确（+b）',
      d.added.length === 1 && d.added[0] === 'b' && !d.removed.length);
  }
}

/* ============================ 变异测试 ============================ */

const MUTANTS = [
  {
    name: 'M1 diff 改成大小写不敏感（基准侧先小写）',
    apply: (s) => s.replace(
      'const setA = new Set(a);',
      'const setA = new Set(a.map((w) => String(w).toLowerCase()));'
    )
  },
  {
    name: 'M2 裁剪上限写死成 99（等于不裁）',
    apply: (s) => s.replace(
      'while (wordsStore.list.length > WORDS_MAX_VERSIONS) {',
      'while (wordsStore.list.length > 99) {'
    )
  },
  {
    name: 'M3 对账永远返回 false（历史不再跟着实际值）',
    apply: (s) => s.replace(
      '  function syncActiveWordVersion(reason) {\n    const latest = activeWordVersion();',
      '  function syncActiveWordVersion(reason) {\n    return false;\n    const latest = activeWordVersion();'
    )
  }
];

runSuite();
const baselinePass = pass;
const baselineFail = fail;

console.log('\n基线：PASS ' + baselinePass + ' / FAIL ' + baselineFail);

let mutated = 0;
for (const mut of MUTANTS) {
  const next = mut.apply(src);
  if (next === src) {
    console.log('SKIP 变异未命中源码：' + mut.name);
    continue;
  }
  src = next;
  pass = 0;
  fail = 0;
  try {
    runSuite();
  } catch (e) {
    fail = 1;
    console.log('   （变异导致抛错，也算变红）：' + (e && e.message));
  }
  const red = fail > 0;
  mutated += red ? 1 : 0;
  console.log((red ? 'RED  ' : 'GREEN(无效变异) ') + mut.name + ' → FAIL ' + fail);
}

console.log('\n结果：基线 ' + baselinePass + ' 通过 / ' + baselineFail + ' 失败；'
  + mutated + '/' + MUTANTS.length + ' 个变异被测试抓住');

if (baselineFail > 0 || mutated !== MUTANTS.length) {
  console.log('FAILED');
  process.exit(1);
}
console.log('ALL GREEN');
