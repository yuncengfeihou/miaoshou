/**
 * 变异测试：把已知 bug 注入脚本源码**副本**（绝不碰交付物），确认沙箱能抓到。
 *
 * 依据 AGENTS.md §8.1 第 3 条：「测试全绿 ≠ 断言有效。必须做变异测试」。
 * 若某个变异后测试仍然全绿，说明那条用例是摆设。
 *
 * 运行：node .playwright-mcp/mutate-coverage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '..');
const SRC_PATH = path.join(WS, '妙手采集箱助手.user.js');
const orig = fs.readFileSync(SRC_PATH, 'utf8');

const TITLE = [
  {
    name: 'M1 覆盖断言失效（got < expected → false）',
    from: 'if (expected > 0 && got < expected) {',
    to: 'if (false && expected > 0 && got < expected) {',
    expectFail: /只滚到 30%/,
  },
  {
    name: 'M2 编辑前基准取错（cells[2] → cells[1]）',
    from: "orig: (cells[2].innerText || '').trim(),",
    to: "orig: (cells[1].innerText || '').trim(),",
    expectFail: /item-info/,
  },
  {
    name: 'M3 空原文断言失效',
    from: 'if (blank > 0) {',
    to: 'if (false && blank > 0) {',
    expectFail: /编辑前」为空/,
  },
  {
    name: 'M4 未勾选断言失效',
    from: 'if (unsel > 0) {',
    to: 'if (false && unsel > 0) {',
    expectFail: /未勾选/,
  },
  {
    name: 'M5 幂等短路被移除',
    from: "if ((r.ta.value || '').trim() === final) continue;   // 已是目标值，不重复写",
    to: '/* mutated */',
    expectFail: /幂等/,
  },
  {
    name: 'M6 停放副本不再排除',
    from: "if (t.includes('-9999')) continue;                 // 停放副本，不代表当前位置",
    to: '/* mutated */',
    expectFail: /20 条正常|100 条/,
  },
];

function runSuite(suiteFile, target) {
  const r = spawnSync(process.execPath, [path.join(HERE, suiteFile)], {
    env: { ...process.env, MSXB_TARGET: target, MSXB_WS: WS },
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const mutantPath = path.join(HERE, '_mutant.user.js');
let bad = 0;

for (const m of TITLE) {
  if (!orig.includes(m.from)) {
    console.log(`SKIP  ${m.name}\n      锚点不存在，变异未生效（不算通过）`);
    bad++;
    continue;
  }
  fs.writeFileSync(mutantPath, orig.replace(m.from, m.to));
  const { code, out } = runSuite('test-title-coverage.mjs', mutantPath);
  const failLines = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const hit = failLines.some((l) => m.expectFail.test(l));
  const ok = code !== 0 && hit;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${m.name}`);
  console.log(`      exit=${code} · 变红：${failLines.map((l) => l.replace(/^FAIL\s+/, '').slice(0, 26)).join(' | ') || '(无)'}`);
  if (!ok) bad++;
}

// 颜色图：模拟「把切不过去的页显形为失败」这一修复方向，看 KNOWN 是否转为 FIXED
{
  const from = "warn('颜色图第 ' + pg + ' 页切不过去，跳过（共 ' + pages + ' 页）');";
  const to = "warn('颜色图第 ' + pg + ' 页切不过去'); unreachablePages.push(pg);";
  const okAnchor = orig.includes(from);
  if (okAnchor) {
    // unreachablePages 必须在使用前声明，故挂在 isTarget 定义处（它在 goPage 循环之前）
    const mutated = orig
      .replace(from, to)
      .replace(
        "    const isTarget = (i) => (i.value || '').trim() === colorName;",
        "    const unreachablePages = [];\n    const isTarget = (i) => (i.value || '').trim() === colorName;"
      )
      .replace('      stillWrong: wrongRows.size,', '      stillWrong: wrongRows.size + unreachablePages.length,');
    fs.writeFileSync(mutantPath, mutated);
    const { out } = runSuite('test-color-coverage.mjs', mutantPath);
    const ok = /FIXED/.test(out);
    console.log(`${ok ? 'PASS' : 'FAIL'}  C1 把「切不过去的页」显形为失败 → 期望 KNOWN 转 FIXED`);
    console.log(`      含 FIXED：${ok}`);
    if (!ok) bad++;
  } else {
    console.log('SKIP  C1 锚点不存在');
    bad++;
  }
}

try { fs.unlinkSync(mutantPath); } catch (_) { /* ignore */ }

const total = TITLE.length + 1;
console.log(`\n变异 ${total} 个：被测试抓到 ${total - bad} · 漏检/失效 ${bad}`);
process.exit(bad ? 1 : 0);
