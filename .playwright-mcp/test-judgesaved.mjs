/**
 * judgeSaved 表驱动测试（v1.15.0 补做）
 *
 * 为什么要有这个文件：
 *   上一轮我把「复核」交付出去时，judgeSaved 里有 4 条 `return { ok: true }` 是**无条件通过**的
 *   （default 分支 / !before 分支 / 尺寸表解析失败分支 / 尺寸表裸返回）。
 *   也就是说「复核」自己会恒真通过 —— 和坑 62 批判的形态一模一样。
 *   当时没发现，是因为我只测了「数据对→通过」和「手搓3条→抓到3条」，
 *   **从没测过「输入异常时它是否会误报通过」**。
 *
 *   这个脚本就是补那一课：每个用例都必须断言「该失败的真的失败、该通过的真通过」。
 *
 * 运行： node .playwright-mcp/test-judgesaved.mjs
 */
import fs from 'node:fs';

const SRC = new URL('../妙手采集箱助手.user.js', import.meta.url);
const src = fs.readFileSync(SRC, 'utf8');

// 从源码里抠出被测函数（避免为了测试去改产品代码导出）
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  // 用大括号配平找函数结尾
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('函数 ' + name + ' 括号不配平');
}

const CFG = { titlePrefix: '[Print Design - No Texture]', colorName: '混合色', modelName: 'Jack', tryOnSize: 'M', tryOnFeel: '合适' };
const VERIFY_FIELDS = {
  title: (it) => it.title || '',
  enTitle: (it) => (it.multiLanguageTitleMap || {}).en || '',
  sizeChart: (it) => (it.sizeCharts || []).map((s) => s.sizeTemplateSource + ':' + s.sizeTemplateId).sort().join(','),
  model: (it) => Object.values(it.shopIdAndGoodsModelReqMap || {}).map((m) => [m.modelName, m.sizeSpecName, m.tryOnResult].join('/')).sort().join(','),
  colorNames: (it) => (((it.saleAttributes || []).find((a) => a.name === '颜色') || {}).values || []).map((v) => v.name).join(','),
  saleValues: (it) => (it.saleAttributes || []).map((a) => a.name + '=' + (a.values || []).map((v) => v.name).join('+')).join(';')
};

function tryOnFeelCode(label) { return ({ '合适': '1', '偏大': '2', '偏小': '3' })[label] || '1'; }

const fnSrc = extract('judgeSaved');
const judgeSaved = new Function('CFG', 'VERIFY_FIELDS', 'tryOnFeelCode', fnSrc + '\nreturn judgeSaved;')(CFG, VERIFY_FIELDS, tryOnFeelCode);

// ---- 测试夹具 ----
const buildTitle = (o) => {
  let v = o || '';
  ['短袖', '透气'].forEach((w) => { v = v.split(w).join(''); });
  v = v.replace(/[ \t]+/g, ' ').trim();
  return v ? CFG.titlePrefix + ' ' + v : CFG.titlePrefix;
};
const ctxOk = { buildTitle, sizeTemplateId: '401221', sizeTemplateName: '男士标码长袖T恤' };

const good = {
  title: buildTitle('男士短袖 透气 T恤'),
  multiLanguageTitleMap: { en: ' ' },
  sizeCharts: [{ sizeTemplateId: '401221', sizeTemplateSource: 'erp' }],
  shopIdAndGoodsModelReqMap: { 1: { modelName: 'Jack', sizeSpecName: 'M', tryOnResult: '1' } },
  saleAttributes: [{ name: '颜色', values: [{ name: '混合色' }] }]
};
const beforeItem = { title: '男士短袖 透气 T恤', saleAttributes: [{ name: '颜色', values: [{ name: '花色' }] }] };

let pass = 0, fail = 0;
const results = [];
function check(name, actual, expectOk) {
  const ok = actual.ok === expectOk;
  if (ok) pass++; else fail++;
  results.push({ name, expect: expectOk ? 'ok=true' : 'ok=false', got: actual.ok, ok, why: actual.why || actual.note || '' });
}

// ===== 必须通过的用例 =====
check('enTitle / 已是空格', judgeSaved('enTitle', null, good, ctxOk), true);
check('title / 内容正确', judgeSaved('title', beforeItem, good, ctxOk), true);
check('sizeChart / id 匹配', judgeSaved('sizeChart', null, good, ctxOk), true);
check('model / Jack+M+合适', judgeSaved('model', null, good, ctxOk), true);
check('colorImages / 全混合色', judgeSaved('colorImages', null, good, ctxOk), true);

// ===== 必须失败的用例（这是上一轮缺失的部分）=====
const bad = (patch) => ({ ...JSON.parse(JSON.stringify(good)), ...patch });

check('enTitle / 不是空格', judgeSaved('enTitle', null, bad({ multiLanguageTitleMap: { en: 'hello' } }), ctxOk), false);
check('title / 内容不符', judgeSaved('title', beforeItem, bad({ title: '没改' }), ctxOk), false);
check('title / 没有保存前快照', judgeSaved('title', null, good, ctxOk), false);
check('sizeChart / 模板 id 不符', judgeSaved('sizeChart', null, bad({ sizeCharts: [{ sizeTemplateId: '999' }] }), ctxOk), false);
check('sizeChart / 期望 id 解析失败', judgeSaved('sizeChart', null, good, { buildTitle, sizeTemplateId: '', sizeTemplateName: '某模板' }), false);
check('sizeChart / 完全没有尺码表', judgeSaved('sizeChart', null, bad({ sizeCharts: [] }), ctxOk), false);
check('model / 模特名不符', judgeSaved('model', null, bad({ shopIdAndGoodsModelReqMap: { 1: { modelName: 'Amy', sizeSpecName: 'M', tryOnResult: '1' } } }), ctxOk), false);
check('model / 试穿码不符', judgeSaved('model', null, bad({ shopIdAndGoodsModelReqMap: { 1: { modelName: 'Jack', sizeSpecName: 'L', tryOnResult: '1' } } }), ctxOk), false);
check('model / 没有模特', judgeSaved('model', null, bad({ shopIdAndGoodsModelReqMap: {} }), ctxOk), false);
check('colorImages / 仍是花色', judgeSaved('colorImages', null, bad({ saleAttributes: [{ name: '颜色', values: [{ name: '花色' }] }] }), ctxOk), false);
check('colorImages / 没有颜色属性', judgeSaved('colorImages', null, bad({ saleAttributes: [] }), ctxOk), false);
check('任意步骤 / 保存后查不到商品', judgeSaved('title', beforeItem, null, ctxOk), false);
check('未知 stepId / 没有判据', judgeSaved('不存在的步骤', null, good, ctxOk), false);

// 模板步骤：允许 ok=true，但必须显式标注「无可断言目标」，不能算作真通过
const tpl = judgeSaved('productTpl', null, good, ctxOk);
check('productTpl / 标注无可断言目标', { ok: tpl.ok && tpl.noAssertion === true }, true);
const tplNote = tpl.note || '';

// ===== 输出 =====
console.log('用例结果：');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} 期望 ${r.expect.padEnd(8)} 实得 ok=${r.got}${r.why ? '  ' + r.why : ''}`);
}
console.log('');
console.log(`合计 ${results.length} 例：通过 ${pass} · 失败 ${fail}`);
console.log(`模板步骤备注：${tplNote}`);
if (fail) {
  console.log('\n存在失败用例 —— 判据有问题，不要发布。');
  process.exit(1);
}
console.log('\n全部通过：每个「该失败」的分支都真的失败了。');
