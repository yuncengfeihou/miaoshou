/**
 * 生成「测试版注入体」：与 inject-body.js 相同，但把 SCRIPT_VERSION 改成一个不同值。
 *
 * 为什么需要：Tampermonkey 里若已装同版本脚本，其 boot() 见到
 * `host.dataset.msxbVersion === SCRIPT_VERSION` 就会「沿用现有 DOM」，
 * 于是注入的新代码永远不生效（表现为「改了脚本但面板还是旧的」）。
 * 换成不同版本号后，boot() 会走「顶掉旧面板 → 重建」的分支。
 *
 * 注意：这**只影响版本标记字段**，不改任何业务逻辑。
 */
import fs from 'node:fs';

const SRC = new URL('../妙手采集箱助手.user.js', import.meta.url);
const OUT = new URL('./inject-test.js', import.meta.url);

const src = fs.readFileSync(SRC, 'utf8');
const body = src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==[ \t]*\r?\n/, '');
if (body.startsWith('// ==UserScript==')) throw new Error('UserScript 头没剥掉');

const TAG = '1.15.0-audit';
const out = body.replace(/const SCRIPT_VERSION = '[^']*';/, `const SCRIPT_VERSION = '${TAG}';`);
if (out === body) throw new Error('SCRIPT_VERSION 替换失败');
if (!out.includes(`const SCRIPT_VERSION = '${TAG}';`)) throw new Error('替换结果不符合预期');

fs.writeFileSync(OUT, out);
console.log('wrote inject-test.js · SCRIPT_VERSION ->', TAG, '· chars', out.length);
