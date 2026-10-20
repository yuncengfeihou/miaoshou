/**
 * attachVerify 归并顺序测试（v1.15.0 补做）
 *
 * 背景：我第一次写这个函数时，注释写着「先看失败，再看不可用」，
 * 条件里却写了 `!vr.unavailable` —— 注释和代码自相矛盾。
 * 后果：当「范围不完整」和「发现了失败」同时成立时，真实的失败会被吞掉，
 * 步骤显示成「复核不可用」而不是「复核未通过」。这是我自己引入的 bug，
 * 是靠手写对拍表才发现的（不是靠跑真实数据）。
 *
 * v1.15.1 补充：noAssertion（模板两步）必须走「未核对」，日志里不允许出现「通过」字样；
 * 并且失败优先级仍高于 noAssertion。
 *
 * 运行： node .playwright-mcp/test-attachverify.mjs
 */
import fs from 'node:fs';

// 默认测产品脚本；MSXB_SRC 可指向变异副本，用于证明用例真的能抓住回归
const SRC = process.env.MSXB_SRC
  ? new URL(process.env.MSXB_SRC, import.meta.url)
  : new URL('../妙手采集箱助手.user.js', import.meta.url);
const src = fs.readFileSync(SRC, 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('函数 ' + name + ' 括号不配平');
}

const logs = [];
const warn = (...a) => logs.push(['warn', a.join(' ')]);
const log = (...a) => logs.push(['log', a.join(' ')]);
const attachVerify = new Function('warn', 'log', extract('attachVerify') + '\nreturn attachVerify;')(warn, log);

let pass = 0, fail = 0;
const rows = [];
function check(name, actual, expectKind, expectContains, forbid) {
  const kindOk = actual.kind === expectKind;
  // 期望文本既可能出现在 verifyFail 里，也可能只出现在日志里（noAssertion 就是后者）
  const hay = [actual.text, actual.allLogs].filter(Boolean).join(' | ');
  const textOk = expectContains ? hay.includes(expectContains) : true;
  const forbidOk = forbid ? !hay.includes(forbid) : true;
  const ok = kindOk && textOk && forbidOk;
  ok ? pass++ : fail++;
  rows.push({
    name,
    expect: expectKind + (expectContains ? ` 含"${expectContains}"` : '') + (forbid ? ` 不含"${forbid}"` : ''),
    got: actual.kind,
    text: actual.text || '',
    ok
  });
}

function run(vr) {
  logs.length = 0;
  const out = attachVerify({ total: 1, success: 1 }, vr, '测试步骤');
  // 归并类别只看产品代码自己产出的 verifyFail；
  // 「不可用 / 未执行」由 verify 字段体现（vr 为 null 时 verify 也是 null）。
  // noAssertion 必须同时满足：verify 上带标记 + 日志里真的说了「未核对」，
  // 否则「标记在、日志却报通过」这种回归会漏掉。
  const sawUnchecked = logs.some((l) => l[1].includes('未核对'));
  const kind = out.verifyFail ? 'verifyFail'
    : (out.verify && out.verify.noAssertion && sawUnchecked) ? 'noAssertion'
      : (!out.verify || out.verify.unavailable) ? 'unavailable'
        : 'pass';
  return {
    kind,
    text: out.verifyFail || '',
    out,
    warned: logs.some((l) => l[0] === 'warn'),
    allLogs: logs.map((l) => l[1]).join(' | ')
  };
}

// 1) 有失败 + 有 unavailable → 必须报 verifyFail（失败不能被吞），且带上范围提示
check('失败+不可用 → 失败优先',
  run({ checked: 5, failed: [{ id: '1', why: '颜色名仍是 花色' }], unavailable: '只复核了 5 条' }),
  'verifyFail', '颜色名仍是 花色');

// 2) 有失败 + 无 unavailable → verifyFail
check('失败（无范围问题）',
  run({ checked: 5, failed: [{ id: '2', why: '标题不对' }] }),
  'verifyFail', '标题不对');

// 3) 无失败 + 有 unavailable → unavailable
check('无失败但有范围问题',
  run({ checked: 3, failed: [], unavailable: '只复核了 3 条' }),
  'unavailable');

// 4) 无失败 + 无 unavailable → pass
check('完全通过',
  run({ checked: 217, failed: [], notes: [] }),
  'pass');

// 5) null → unavailable
check('vr 为 null',
  run(null),
  'unavailable');

// 6) 失败数量多于 3 时要截断并带省略号
check('失败过多截断',
  run({ checked: 9, failed: Array.from({ length: 5 }, (_, i) => ({ id: String(i), why: 'x' })) }),
  'verifyFail', '…');

// 7) noAssertion：只能是「未核对」，且日志里绝不能出现「通过」二字
check('noAssertion → 未核对（不报通过）',
  run({ checked: 217, failed: [], notes: ['1: 该步骤无可断言的落库目标'], noAssertion: true }),
  'noAssertion', '未核对', '通过');

// 8) noAssertion + 有失败：失败优先级不变，不能被 noAssertion 吞掉
check('noAssertion + 失败 → 失败优先',
  run({ checked: 5, failed: [{ id: '3', why: '保存后接口查不到这条商品' }], notes: [], noAssertion: true }),
  'verifyFail', '保存后接口查不到这条商品');

console.log('用例结果：');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(26)} 期望 ${r.expect.padEnd(22)} 实得 ${r.got}`);
console.log('');
console.log(`合计 ${rows.length} 例：通过 ${pass} · 失败 ${fail}`);
if (fail) { console.log('\n存在失败用例 —— 归并逻辑有问题，不要发布。'); process.exit(1); }
console.log('\n全部通过。');
