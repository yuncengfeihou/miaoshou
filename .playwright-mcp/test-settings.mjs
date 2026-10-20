/**
 * knownTemplates 迁移回归（7 例）
 *
 * 背景：v1 的 knownTemplates 曾被无条件写回 v2；下次加载又把 v2 里的它当 v1 数据，
 * 重新并入 tplOptions —— 用户点过「读取模板列表」整体替换后，旧模板名仍会回灌。
 *
 * 运行：node .playwright-mcp/test-settings.mjs
 */
import fs from 'node:fs';

const SRC = new URL('../妙手采集箱助手.user.js', import.meta.url);
const src = fs.readFileSync(SRC, 'utf8');

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
function extractConstObject(name) {
  const start = src.indexOf('const ' + name + ' = {');
  if (start < 0) throw new Error('missing const ' + name);
  const end = matchBrace(start);
  return src.slice(src.indexOf('{', start), end);
}

const CFG = new Function('return (' + extractConstObject('CFG') + ')')();
const TPL_KEYS = [
  { key: 'product', label: '产品模板' },
  { key: 'sku', label: 'SKU 模板' },
  { key: 'sizeChart', label: '尺码表模板' }
];
const storeKeyMatch = src.match(/const STORE_KEY = '([^']+)'/);
if (!storeKeyMatch) throw new Error('找不到 STORE_KEY');
const STORE_KEY = storeKeyMatch[1];
const parseWordsSrc = extractFunction('parseWords');
const loadSrc = extractFunction('loadSettings');
const saveSrc = extractFunction('saveSettings');

function makeEnv(seed) {
  const store = new Map(Object.entries(seed || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v))
  };
  // loadSettings/saveSettings 只在异常时 warn；测试里把它变成硬失败，避免“带着警告通过”
  const warn = (...a) => { throw new Error('unexpected warning: ' + a.join(' ')); };
  const parseWords = new Function(parseWordsSrc + '\nreturn parseWords;')();
  const settings = {
    deleteWords: [...CFG.deleteWords],
    tpl: { product: CFG.productTemplate, sku: CFG.skuTemplate, sizeChart: CFG.sizeChartTemplate },
    tplOptions: {
      product: [CFG.productTemplate],
      sku: [CFG.skuTemplate],
      sizeChart: [CFG.sizeChartTemplate]
    }
  };
  const loadSettings = new Function(
    'settings', 'STORE_KEY', 'TPL_KEYS', 'parseWords', 'warn', 'localStorage',
    loadSrc + '\nreturn loadSettings;'
  )(settings, STORE_KEY, TPL_KEYS, parseWords, warn, localStorage);
  const saveSettings = new Function(
    'settings', 'STORE_KEY', 'warn', 'localStorage',
    saveSrc + '\nreturn saveSettings;'
  )(settings, STORE_KEY, warn, localStorage);
  return { store, settings, loadSettings, saveSettings };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

// 1) v1 -> v2：迁移一次；v2 不再带 knownTemplates；替换后不会回灌
{
  const env = makeEnv({
    'msxb-settings-v1': JSON.stringify({
      deleteWords: [], tplPreset: true, productTemplate: '', skuTemplate: '',
      knownTemplates: ['旧模板']
    })
  });
  env.loadSettings();
  check('v1 迁移：旧模板进入候选', env.settings.tplOptions.product.includes('旧模板'), JSON.stringify(env.settings.tplOptions.product));
  env.saveSettings();
  const v2 = JSON.parse(env.store.get(STORE_KEY));
  check('写入 v2 时不再保存 knownTemplates', !Object.prototype.hasOwnProperty.call(v2, 'knownTemplates'), JSON.stringify(Object.keys(v2)));
  // 模拟用户之后点「读取模板列表」整体替换
  v2.tplOptions.product = ['新模板'];
  env.store.set(STORE_KEY, JSON.stringify(v2));
  env.loadSettings();
  check('v2 加载不再回灌旧模板', JSON.stringify(env.settings.tplOptions.product) === JSON.stringify(['新模板']), JSON.stringify(env.settings.tplOptions.product));
}

// 2) 旧 v2 里已经有 knownTemplates：忽略并让下一次保存移除
{
  const env = makeEnv({
    [STORE_KEY]: JSON.stringify({
      deleteWords: [], tpl: {},
      tplOptions: { product: ['新模板'], sku: ['新模板'], sizeChart: ['新模板'] },
      knownTemplates: ['旧模板']
    })
  });
  env.loadSettings();
  check('旧 v2 的 knownTemplates 被忽略', JSON.stringify(env.settings.tplOptions.product) === JSON.stringify(['新模板']), JSON.stringify(env.settings.tplOptions.product));
  env.saveSettings();
  const v2 = JSON.parse(env.store.get(STORE_KEY));
  check('下次保存移除旧键', !Object.prototype.hasOwnProperty.call(v2, 'knownTemplates'), JSON.stringify(Object.keys(v2)));
}

// 3) 没有 v1 的新装用户：行为不变
{
  const env = makeEnv({});
  env.loadSettings();
  check('新装用户仍用内置默认值', env.settings.tplOptions.product[0] === CFG.productTemplate, JSON.stringify(env.settings.tplOptions.product));
  env.saveSettings();
  const v2 = JSON.parse(env.store.get(STORE_KEY));
  check('新装保存不带 knownTemplates', !Object.prototype.hasOwnProperty.call(v2, 'knownTemplates'), JSON.stringify(Object.keys(v2)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
