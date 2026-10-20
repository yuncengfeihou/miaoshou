/**
 * 生成可直接 addScriptTag 注入的脚本体（去掉 UserScript 头）。
 * 注意：AGENTS.md §4 给的示例正则末尾写成了 `// ==UserScript==`，
 * 而真实的头尾标记是 `// ==/UserScript==` —— 照抄那条正则**什么都剥不掉**（实测）。
 * 这里用真实结束标记。
 */
import fs from 'node:fs';

const SRC = new URL('../妙手采集箱助手.user.js', import.meta.url);
const OUT = new URL('./inject-body.js', import.meta.url);
const src = fs.readFileSync(SRC, 'utf8');
const body = src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==[ \t]*\r?\n/, '');
if (body.startsWith('// ==UserScript==')) throw new Error('UserScript 头没剥掉');
fs.writeFileSync(OUT, body);
console.log('wrote', OUT.pathname, 'chars', body.length);
