// ==UserScript==
// @name         1.15.0妙手ERP · TEMU全托管采集箱 批量处理助手
// @namespace    https://erp.91miaoshou.com/
// @version      1.15.0
// @description  iOS 风格浮动面板（自绘 Apple 风格下拉，非原生 select，圆角触发框 + 毛玻璃浮层菜单）：自动完成「产品 → TEMU全托管 → 采集箱」导航，再执行分步流程（模板引用、标题清理、尺码表、模特信息、颜色图填充+混合色）。设置区：三类模板选中即生效（无开关）；「读取模板列表」走直连接口（产品、SKU、尺码表三处各自独立直连，失败自动回落开弹窗），词条**只在点「立即更新」时**才整体替换。主按钮「一键编辑」，运行中变为「停止编辑」并在按钮内计时，可随时中断当前步骤。面板位置 / 折叠 / 视图跨刷新保持。**只在「未发布」列表工作，全程不发布产品。**
// @author       -
// @match        https://erp.91miaoshou.com/pddkj/collect_box/items*
// @match        https://erp.91miaoshou.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * ============================================================================
 *  ⛔ 三条硬红线（改本脚本前必读；违反任何一条都算事故）
 * ============================================================================
 *
 *  红线 1｜禁止发布
 *      本脚本**没有任何发布入口**。只允许「保存修改 / 应用至选中 / 应用 / 使用」。
 *      绝不点「批量发布 / 发布 / 保存并发布」。改动后必须自查：
 *          Select-String -Path "妙手采集箱助手.user.js" -Pattern "发布"
 *      结果只应命中注释与 UI 文案（「不发布」胶囊、toast 文本等）。
 *
 *  红线 2｜只操作「未发布」，绝不碰「全部 / 已发布」
 *      · 已发布是**线上在售数据**，任何触碰都可能触发平台侧同步。
 *      · **测试、调试、验证、复现问题，一律只准用「未发布」。** 只勾 1 条也不行，
 *        「只看一眼」「只调只读接口」也不行。
 *      · 「未发布」为空时必须停下来说明，**不得借用「全部 / 已发布」**。
 *      · 代码里由 assertUnpublishedOnly() 做运行时兜底（见下方「未发布守卫」）。
 *
 *  红线 3｜审查 / 调试时禁止任何实际写入
 *      · 「允许保存修改」是**脚本运行时的业务权限**，不是**调试者的权限**。
 *      · 审查/复现只准只读或只改前端预览，关闭弹窗必须走「取消」+「确定（放弃修改）」。
 *      · **连"写入一个与现值相同、业务上等于无变化的值"也不行** —— 那仍会刷新
 *        saveDetailTs，让系统认为该商品被修改过（可能进入下一轮同步）。
 *      · 要验证「保存 → 落库复核」正向链，**必须先拿到用户明确同意**，或直接标注「未验证」。
 * ============================================================================
 */

(function () {
  'use strict';

  /** 脚本版本：用于识别/接管 Tampermonkey 里可能残留的旧版面板 */
  const SCRIPT_VERSION = '1.15.0';
  const SEL_RADIO = '.el-radio, .jx-radio';
  const SEL_CHECKBOX = '.el-checkbox, .jx-checkbox';

  /** 取元素可视文本 */
  const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();

  /** 组件是否处于选中态 */
  const isChecked = (el) =>
    !!el && ((el.className && String(el.className).includes('is-checked')) ||
      el.getAttribute('aria-checked') === 'true');

  /* ============================ 配置 ============================ */

  const CFG = {
    pageSize: '500条/页',
    productTemplate: '男士标码长袖T恤',
    skuTemplate: '男士标码长袖T恤',
    sizeChartTemplate: '男士标码长袖T恤',
    modelName: 'Jack',
    tryOnSize: 'M',
    tryOnFeel: '合适',
    titlePrefix: '[Print Design - No Texture]',

    // 标题需删除的词表（顺序无关，内部会按长度降序处理）
    deleteWords: [
      '两件', '与叠穿', '做工扎实', '短袖', '速干', '多种尺码可选', '涤纶',
      '[Printed Design – Not Textured]', '3D', '3d', '衬衫', '[印花设计-无纹理]',
      '标码', '柔软透气', '[Print Design - No Texture]', '数码', '面料', '耐用',
      '材质', '耐用材质', '材质耐用', '轻便', '轻便透气', '透气轻便',
      '亲肤弹力', '弹力亲肤', '亲肤', '弹力', '透气', '大胆', '网眼', '微修身',
      '聚酯纤维', '定制', '机甲', '100%棉'
    ],

    // 颜色图：插入位置 -> 网络图片直链
    colorImages: [
      { pos: 3, url: 'https://i.ibb.co/Ndjpt3tD/1.png' },
      { pos: 4, url: 'https://i.ibb.co/Gb3pYgz/2.png' },
      { pos: 5, url: 'https://i.ibb.co/bj4RgpZT/3.png' }
    ],
    colorName: '混合色'
  };

  /* ============================ 用户设置（持久化） ============================ */

  const STORE_KEY = 'msxb-settings-v2';

  /** 三类模板：各自独立记忆选中的模板名（默认＝页面下拉里的第一个选项） */
  const TPL_KEYS = [
    { key: 'product', label: '产品模板' },
    { key: 'sku', label: 'SKU 模板' },
    { key: 'sizeChart', label: '尺码表模板' }
  ];

  /**
   * 可在面板里手动修改的设置。
   * 必须落 localStorage：刷新页面会重新执行脚本、模块级变量归零，
   * 只存内存的话用户改完词库 / 模板，一刷新就回到默认值，等于白改。
   * （面板被页面冲掉时会重建，但重建不丢模块级状态，真正会丢的是刷新。）
   */
  const settings = {
    // 过滤词词库：面板里只读展示，「立即更新」按中英文逗号解析后整体替换
    deleteWords: [...CFG.deleteWords],
    // 三类模板的目标值＝面板下拉里选中的模板名；空串＝跟随页面下拉的第一个选项。
    // v1.8.0 起没有「模板预设」开关：设置里是什么就用什么（选中即保存，无防抖）
    tpl: { product: CFG.productTemplate, sku: CFG.skuTemplate, sizeChart: CFG.sizeChartTemplate },
    tplOptions: {
      product: [CFG.productTemplate],
      sku: [CFG.skuTemplate],
      sizeChart: [CFG.sizeChartTemplate]
    },                                               // 页面读到的完整选项（保持页面顺序）
  };

  /**
   * 标题改写纯函数：删词 + 规整标点 + 唯一前缀。
   *
   * 提到模块级（v1.15.0）是为了让**两个地方用同一份实现**：
   *   ① 第 6 步在预览 textarea 里算「应该改成什么」；
   *   ② `verifySaved()` 在保存后用接口返回的 title 复算一次做落库复核。
   * 若两边各写一份，任何一处漏改都会让复核「自己认证自己」，等于没复核。
   *
   * 实测（217 条真实数据）：本函数**幂等** —— f(f(x)) === f(x) 全部成立，
   * 所以复核拿「保存后的 title」再跑一次也能稳定比对，不会因重复执行而漂移。
   */
  function makeTitleBuilder(words) {
    return (orig) => {
      let v = orig || '';
      words.forEach((w) => { v = v.split(w).join(''); });
      v = v
        .replace(/[ \t]+/g, ' ')
        .replace(/([,，、])\s*(?=[,，、])/g, '')
        .replace(/^[\s,，、\-–—]+/, '')
        .replace(/[\s,，、\-–—]+$/, '')
        .replace(/\s+([,，、])/g, '$1')
        .trim();
      return v ? CFG.titlePrefix + ' ' + v : CFG.titlePrefix;
    };
  }

  /** 用当前词库设置构造标题改写器（第 6 步与落库复核共用） */
  function currentTitleBuilder() {
    const words = [...settings.deleteWords].filter(Boolean).sort((a, b) => b.length - a.length);
    return makeTitleBuilder(words);
  }

  /**
   * 词库文本 → 词数组：按**中英文逗号**解析（顺带容忍换行/顿号，方便直接粘表格列）。
   * 绝不按空格切分 —— 会毁掉 `[Print Design - No Texture]` 这类含空格的词。
   */
  function parseWords(text) {
    const out = [];
    const seen = new Set();
    String(text || '')
      .split(/[,，\r\n、]+/)
      .map((w) => w.trim())
      .filter((w) => w && !/^[（(]?空[)）]?$/.test(w))
      .forEach((w) => {
        if (seen.has(w)) return;
        seen.add(w);
        out.push(w);
      });
    return out;
  }

  /**
   * 当前生效的模板目标名：'' 表示「跟随页面下拉的第一个选项」。
   * v1.8.0 起没有「模板预设」开关，设置里选中的模板名直接生效。
   */
  function tplTarget(kind) {
    return settings.tpl[kind] || '';
  }

  /**
   * 读设置。v1（只有 productTemplate / skuTemplate 两个扁平字段）会自动迁移到 v2。
   */
  function loadSettings() {
    try {
      // v1 的键名是 msxb-settings-v1，读不到 v2 就回落到它做一次迁移
      const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem('msxb-settings-v1');
      if (!raw) return;
      const o = JSON.parse(raw);
      if (Array.isArray(o.deleteWords)) {
        settings.deleteWords = parseWords(o.deleteWords.join(','));
      }

      TPL_KEYS.forEach(({ key }) => {
        const flat = { product: 'productTemplate', sku: 'skuTemplate', sizeChart: 'sizeChartTemplate' }[key];
        const fromTpl = o.tpl && typeof o.tpl[key] === 'string' ? o.tpl[key] : '';
        const fromOld = typeof o[flat] === 'string' ? o[flat] : '';
        settings.tpl[key] = fromTpl || fromOld;
      });

      if (o.tplOptions && typeof o.tplOptions === 'object') {
        TPL_KEYS.forEach(({ key }) => {
          const arr = o.tplOptions[key];
          // 空数组是「用户还没读到过」的合法状态：保留内置名做占位
          if (Array.isArray(arr) && arr.length) {
            settings.tplOptions[key] = parseWords(arr.join(','));
          }
        });
      }
      // v1 的 knownTemplates 是「见过的模板名」，并入产品/SKU 的候选项
      if (Array.isArray(o.knownTemplates)) {
        const extra = o.knownTemplates.filter((s) => typeof s === 'string' && s);
        settings.knownTemplates = extra;
        ['product', 'sku'].forEach((k) => {
          settings.tplOptions[k] = parseWords([...settings.tplOptions[k], ...extra].join(','));
        });
      }
    } catch (e) {
      warn('读取设置失败，使用默认值:', e.message || e);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        deleteWords: settings.deleteWords,
        tpl: settings.tpl,
        tplOptions: settings.tplOptions,
        knownTemplates: settings.knownTemplates
      }));
      return true;
    } catch (e) {
      warn('保存设置失败:', e.message || e);
      return false;
    }
  }

  /**
   * 记下页面下拉里的模板名，供设置里直接显示/选择**真实名字**。
   * replace=true（「读取模板列表」）＝用页面当前读到的顺序整体替换；
   * replace=false（执行步骤时顺带读到）＝页面顺序优先，旧条目保留在后面
   * （尺码表下拉是双 Tab，只读到一个 Tab 时不能把另一个 Tab 的选项丢掉）。
   */
  function rememberTemplates(kind, names, replace) {
    const list = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
    if (!list.length || !settings.tplOptions[kind]) return;
    const before = settings.tplOptions[kind];
    const merged = parseWords([...list, ...(replace ? [] : before)].join(','));
    if (merged.length === before.length && merged.every((n, i) => n === before[i])) return;
    settings.tplOptions[kind] = merged;
    saveSettings();
    renderSettingsOptions();
  }

  /**
   * 读取「引用模板」弹窗里下拉的完整选项列表。
   * 只读：只点开下拉看选项，**不点应用、不保存**，读完后收起弹窗（取消/关闭）。
   */
  async function probeTemplateOptions(kind, menuText, dlgText, label) {
    await pickTemplateMenu(menuText);
    const dlg = await waitFor(() => dialogByText(dlgText), { desc: dlgText + '弹窗', timeout: 12000 })
      .catch((e) => {
        if (e instanceof StopError) throw e;   // 停止编辑：别当成「没开弹窗」
        // 没选中商品时妙手只弹「请选择要操作的产品」，不会开弹窗
        const msg = [...document.querySelectorAll('.el-message, .jx-message')]
          .map(textOf).filter(Boolean).join(' ');
        throw new Error(msg || ('未打开' + dlgText + '弹窗（先在采集箱勾选产品）'));
      });
    const selectEl = dlg.querySelector('.jx-select.pro-select, .jx-select') || dlg.querySelector('.el-select');
    if (!selectEl) throw new Error('未找到' + label + '选择框');

    const inp = selectEl.querySelector('input');
    await clickEl(inp || selectEl, { wait: 900 });
    const nodes = await waitFor(
      () => { const n = templateOptionNodes(); return n.length ? n : null; },
      { desc: label + '下拉选项', timeout: 12000 }
    );
    const names = nodes
      .filter((l) => !l.classList.contains('is-disabled'))
      .map(textOf)
      .filter((t) => t && !/暂未创建|请先创建|无数据/.test(t));

    // 收起下拉，再关掉弹窗（绝不点「应用至选中」）
    closeDropdown(dlg);
    await sleep(300);
    const cancel = [...dlg.querySelectorAll('button')]
      .find((b) => isVisible(b) && /^(取消|关闭)$/.test(textOf(b)));
    if (cancel) await clickEl(cancel, { wait: 800 });
    else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(500);

    rememberTemplates(kind, names, true);
    return names;
  }


  /* ============================ 基础工具 ============================ */

  /**
   * 「停止编辑」用的协作式取消：sleep / waitFor / clickEl 里的等待都会抛这个错，
   * 于是任何步骤都能被立刻打断，不必为每步单独写取消逻辑。
   */
  class StopError extends Error {
    constructor() { super('已停止编辑'); this.name = 'StopError'; }
  }
  let stopRequested = false;
  /** 正在挂起的 sleep 的打断函数（点「停止编辑」时全部立刻触发） */
  const pendingSleepAborts = new Set();

  /** 可被打断的 sleep：等待期间点「停止编辑」，立刻以 StopError 结束 */
  const sleep = (ms) => new Promise((resolve, reject) => {
    let done = false;
    let timer = 0;
    const abort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingSleepAborts.delete(abort);
      reject(new StopError());
    };
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      pendingSleepAborts.delete(abort);
      resolve();
    }, ms);
    pendingSleepAborts.add(abort);
  });
  const log = (...a) => console.log('%c[妙手助手]', 'color:#0aa', ...a);
  const warn = (...a) => console.warn('[妙手助手]', ...a);

  /* ============================ 自动检测更新 ============================ */

  /**
   * GreasyFork 发布页（脚本主页）与版本查询接口。
   *
   * 为什么用 `/scripts/600852.json`：实测该接口带 `Access-Control-Allow-Origin: *`，
   * 妙手页面里直接 `fetch` 就能读到版本（`update.greasyfork.org/.../script.meta.js` 虽然也有版本，
   * 但**没有 CORS 头**，浏览器里读不到 —— 那个地址只有 Tampermonkey 自身能访问）。
   *
   * 注意：脚本是 `@grant none`（页面上下文），这里纯使用 `fetch`，不引入任何油猴 API，
   * 因此不需要改 @grant，也不改变现有运行环境。
   */
  const GF_PAGE_URL = 'https://greasyfork.org/zh-CN/scripts/600852';
  const GF_JSON_URL = 'https://greasyfork.org/scripts/600852.json';
  const UPD_CACHE_KEY = 'msxb-upd-check-v1';
  const UPD_RETRY_GAP = 60 * 1000;    // 请求失败后 60s 内不重试（成功则每次加载都重新校验）

  /** 更新检测结果：{ at, remote, error }；remote 为远端版本号，读不到则为空 */
  let updState = { at: 0, remote: '', error: '' };
  let updBtn = null;        // 头部「更新」标记
  let updBusy = false;

  /**
   * 版本号比较：返回 1（a 更新）/ 0（相同）/ -1（a 更旧）。
   * 规则：按 . - + 分段，两侧都是数字就按数值比（1.10 > 1.9）；
   * 任一侧缺失按 0 补（1.10 == 1.10.0）；数字段 > 非数字段（1.10.0 > 1.10.0-beta）。
   * 空串直接返回 0，绝不产生「未知版本比本地新」的误判。
   */
  function cmpVersion(a, b) {
    const sa = String(a || '').trim();
    const sb = String(b || '').trim();
    if (!sa || !sb) return 0;
    const pa = sa.split(/[.\-+]/).filter((x) => x !== '');
    const pb = sb.split(/[.\-+]/).filter((x) => x !== '');
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || '0';
      const y = pb[i] || '0';
      const nx = /^\d+$/.test(x);
      const ny = /^\d+$/.test(y);
      if (nx && ny) {
        const d = Number(x) - Number(y);
        if (d) return d > 0 ? 1 : -1;
      } else if (nx !== ny) {
        return nx ? 1 : -1;      // 数字段视为更高（正式版 > beta）
      } else if (x !== y) {
        return x > y ? 1 : -1;
      }
    }
    return 0;
  }

  /** 是否需要提示更新：**只要远端与本地版本不一致就提示**（含「线上比本地旧」＝本地还没上传） */
  function needsUpdate() {
    return !!updState.remote && cmpVersion(updState.remote, SCRIPT_VERSION) !== 0;
  }

  /** 把检测结果画到头部「更新」标记上（面板还没建时静默跳过，建完会再调一次） */
  function renderUpdateBadge() {
    if (!updBtn) return;
    const show = needsUpdate();
    updBtn.hidden = !show;
    if (!show) return;
    const cmp = cmpVersion(updState.remote, SCRIPT_VERSION);
    updBtn.title = cmp > 0
      ? `GreasyFork 有新版 ${updState.remote}（当前 ${SCRIPT_VERSION}）· 点此打开脚本主页`
      : `GreasyFork 上是 ${updState.remote}，比本机 ${SCRIPT_VERSION} 旧（新版还没上传）· 点此打开脚本主页`;
  }

  /**
   * 读缓存：存的是「上一次检测的结论」，用于面板首帧立即显形（不阻塞、不等网络）。
   * 缓存不是「有效期」—— 每次加载仍会发一次真实请求复核。
   */
  function loadUpdCache() {
    try {
      const raw = localStorage.getItem(UPD_CACHE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      return {
        at: Number(o.at) || 0,
        remote: typeof o.remote === 'string' ? o.remote : '',
        error: typeof o.error === 'string' ? o.error : ''
      };
    } catch (_) { return null; }
  }

  /** 写缓存：只在读写 localStorage 失败（隐私模式 / 配额）时静默忽略，绝不影响主流程 */
  function saveUpdCache() {
    try { localStorage.setItem(UPD_CACHE_KEY, JSON.stringify(updState)); } catch (_) { /* ignore */ }
  }

  /**
   * 检测 GreasyFork 上的最新版本。
   *
   * 策略（需求：**每次刷新网页都自动检测**）：
   *   · 先用缓存把「上一次的结果」立刻画出来 → 面板首帧就有正确状态，不用等网络；
   *   · 然后无论缓存新旧都再发一次请求做真实校验 → 刷新即校验，不会停留在过期结论。
   *   · 唯一例外：上次请求**失败**且距今不足 60s，则这一轮跳过，避免网络不通时每刷新一次就打接口。
   *
   * @param {boolean} force 点「更新」标记时用：忽略失败冷却，立刻重查
   */

  async function checkUpdate(force) {
    if (updBusy) return;

    // ① 先把上一次的结论画出来（面板首帧就有状态，不必等网络）
    const cached = loadUpdCache();
    if (cached) {
      updState = cached;
      renderUpdateBadge();
    }

    // ② 失败冷却：上次请求失败且距今不足 UPD_RETRY_GAP，这一轮跳过（网络不通时别反复打接口）
    if (!force && cached && cached.error && Date.now() - cached.at < UPD_RETRY_GAP) return;

    // ③ 真实校验：成功过就每次都做 —— 「刷新即校验」，不会停在过期结论上
    updBusy = true;
    try {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : 0;
      let res;
      try {
        res = await fetch(GF_JSON_URL, {
          credentials: 'omit',                       // 不必带任何 cookie
          cache: 'no-store',
          signal: ctl ? ctl.signal : undefined
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const remote = String((data && data.version) || '').trim();
      if (!remote) throw new Error('响应里没有 version 字段');
      updState = { at: Date.now(), remote, error: '' };
      saveUpdCache();
      renderUpdateBadge();
      log('版本检测：远端 ' + remote + ' / 本地 ' + SCRIPT_VERSION);
    } catch (e) {
      // 拉不到就保持「不提示」，绝不误报新版本；失败也落缓存（含 error），供下一轮 60s 冷却判断
      updState = { at: Date.now(), remote: '', error: String((e && e.message) || e) };
      saveUpdCache();
      renderUpdateBadge();
      warn('版本检测失败（不影响任何功能）:', e);
    } finally {
      updBusy = false;
    }
  }

  /**
   * 元素是否真的渲染可见。
   * 见 步骤.md §二 E（接口与数据）：Element Plus 的下拉/浮层用 <teleport> 传送到
   * body 末尾且 position:fixed；这类元素 offsetParent === null，用 `offsetParent`
   * 做可见性判断会永远判为不可见（颜色图「选中全部」菜单就因此永远找不到，
   * 等待 20s 后超时卡死）。
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    if (el.offsetParent !== null) return true;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  }

  /** 轮询等待条件成立 */
  async function waitFor(fn, { timeout = 20000, interval = 200, desc = '' } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (stopRequested) throw new StopError();
      let v;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      await sleep(interval);
    }
    throw new Error('等待超时: ' + (desc || fn.toString().slice(0, 60)));
  }

  /** 按可见文本找按钮/元素 */
  function findByText(selector, text, { exact = false, root = document } = {}) {
    return [...root.querySelectorAll(selector)].find((n) => {
      if (!isVisible(n)) return false;
      const t = textOf(n);
      return exact ? t === text : t.includes(text);
    });
  }

  /** 已渲染可见的弹窗列表 */
  function visibleDialogs() {
    return [...document.querySelectorAll('.el-dialog, .jx-dialog')].filter(isVisible);
  }

  /* =====================================================================
   *  !! 强制守卫：只允许操作「未发布」的产品 !!
   * =====================================================================
   *
   * 【规矩，任何情况都不许破】
   *   1. 只允许处理**未发布**的产品。
   *   2. **「全部」和「已发布」两个 Tab 绝对不许碰 —— 调试、测试、取样、验证也不许。**
   *      挨一下「已发布」就等于把线上的东西暴露给本脚本，一步走错就是线上事故。
   *   3. 不许对任何产品执行"实际修改 / 保存 / 应用"以外的写操作；写操作也只在
   *      「保存修改」这一个入口，绝无「发布」「批量发布」「保存并发布」。
   *
   * 【为什么要写成会抛错的代码，而不是只写注释】
   *   审查过程中真出过一次教训：为了验证复核链路，对着**未发布**列表的一条商品点了
   *   「保存修改」（虽然写入值与原值相同），这是典型的"为了测试而越界"。
   *   只写在文档里的规矩，到了"我就试一下"的时候挡不住人；所以这里做成**运行时强制**：
   *   一旦当前筛选不是「未发布」，任何步骤都会在第一步被拦下。
   *
   * 【怎么判断"现在是未发布"】
   *   不能只看 URL（同一路由四种筛选）。真正的依据是筛选条里那个
   *   `label.jx-radio-button` 的 `is-active` / `input.checked`：
   *     全部 / 定时发布 / 已发布  → 直接拒绝
   *     未发布                    → 放行
   *     读不到筛选条              → **拒绝**（拿不到证据就不许通过，见 步骤.md §二 C）
   */

  /** 采集箱的状态筛选 Tab（全部 / 未发布 / 定时发布 / 已发布） */
  function collectStatusTabs() {
    return [...document.querySelectorAll(
      '.pro-radio-group label.jx-radio-button, .pro-radio-group label.el-radio-button, ' +
      'label.jx-radio-button, label.el-radio-button'
    )].filter((l) => isVisible(l) && /^(全部|未发布|定时发布|已发布)/.test(textOf(l)));
  }

  /**
   * 状态 Tab 的值 → 中文名。
   * 优先用 `input.value`（实测稳定：`notPublished` / `published` / `timingPublish`），
   * 读不到再退回文本前缀。**不用文本做唯一依据** —— 文本里带 `(217)` 这种会变的计数。
   */
  const TAB_VALUE_MAP = {
    notPublished: '未发布',
    published: '已发布',
    timingPublish: '定时发布',
    '': '全部'
  };

  /** 该 Tab 对应的筛选名（拿不到返回 ''） */
  function filterNameOfTab(label) {
    if (!label) return '';
    const inp = label.querySelector('input');
    const v = inp ? String(inp.value || '').trim() : '';
    if (Object.prototype.hasOwnProperty.call(TAB_VALUE_MAP, v)) return TAB_VALUE_MAP[v];
    const t = textOf(label);
    if (/^未发布/.test(t)) return '未发布';
    if (/^已发布/.test(t)) return '已发布';
    if (/^定时发布/.test(t)) return '定时发布';
    if (/^全部/.test(t)) return '全部';
    return '';
  }

  /** 当前生效的状态筛选名（读不到返回 ''） */
  function currentCollectFilter() {
    const tabs = collectStatusTabs();
    if (!tabs.length) return '';
    const on = tabs.find((l) =>
      l.classList.contains('is-active') ||
      !!((l.querySelector('input') || {}).checked)
    );
    return filterNameOfTab(on);
  }

  /** 找「未发布」那个 Tab */
  function unpublishedTab() {
    return collectStatusTabs().find((l) => filterNameOfTab(l) === '未发布') || null;
  }

  /**
   * **检测并切换到「未发布」**（幂等：已在「未发布」则原样返回，不做任何点击）。
   *
   * 为什么要自动切而不是直接报错：
   *   用户经常停在「全部」或刚处理完看着「已发布」，一键编辑时不该逼他手工先切 Tab。
   *   自动切到「未发布」既满足红线 2（绝不操作系统其它两类），又不打断流程。
   *
   * 切完必须**验证真的切过去了**（重读 `currentCollectFilter`），
   * 切不过去就抛错 —— 绝不"点了一下就当成功"。
   *
   * @returns {Promise<{from:string, to:string, switched:boolean}>}
   */
  async function ensureUnpublishedFilter(stepName) {
    const before = currentCollectFilter();
    if (before === '未发布') return { from: before, to: before, switched: false };

    const tab = unpublishedTab();
    if (!tab) {
      throw new Error(
        (stepName ? '【' + stepName + '】' : '') +
        '未能自动切换：页面上找不到「未发布」筛选 Tab' +
        (before ? '（当前是「' + before + '」）' : '（读不到当前筛选）') +
        '。请确认已登录并停留在采集箱列表页，或手工切到「未发布」后重跑。'
      );
    }

    log('筛选不是「未发布」（当前：' + (before || '未知') + '），正在自动切换…');
    // 点内部 span：label 被 input 覆盖时点 label 本体可能只聚焦不触发
    const hit = tab.querySelector('.jx-radio-button__inner, .el-radio-button__inner') || tab;
    await clickEl(hit, { wait: 600 });

    // 等它真的切过去（30s 上限：列表要重新拉数据）
    await waitFor(
      () => (currentCollectFilter() === '未发布' ? true : null),
      { desc: '切换到「未发布」筛选', timeout: 30000, interval: 200 }
    );
    log('已切换到「未发布」筛选');
    return { from: before || '未知', to: '未发布', switched: true };
  }

  /**
   * 断言「当前只处理未发布」。**不满足就抛错中止——不许吞、不许降级。**
   *
   * 注意分工：本函数只做**校验**，不做切换（切换是 `ensureUnpublishedFilter` 的职责，
   * 由「步骤 1」在流程最开始统一做一次）。
   * 写入入口挂这道断言是**第二道防线**：万一有人绕过第 1 步直接点某一步，
   * 或流程中途被人手工切了 Tab，也会在下笔前被拦下。
   *
   * @param {string} where 调用点说明（用于报错文案）
   */
  function assertUnpublishedOnly(where) {
    const cur = currentCollectFilter();
    if (cur === '未发布') return '未发布';
    const hint =
      cur
        ? '当前筛选是「' + cur + '」'
        : '读不到状态筛选（可能不在采集箱列表页，或页面结构已变）';
    throw new Error(
      (where ? '【' + where + '】' : '') +
      '已中止：本脚本只允许操作「未发布」的产品，绝不触碰「全部 / 定时发布 / 已发布」。' +
      hint + '。请先跑「检测并切换到未发布」这一步，或手工切回「未发布」再重跑。'
    );
  }

  function dialogByText(text) {
    return visibleDialogs().find((d) => (d.innerText || '').includes(text));
  }

  /** 批量编辑弹窗识别：颜色图面板不含「批量编辑方式」，需按特征判断 */
  function batchEditDialog() {
    const ds = visibleDialogs();
    return ds.find((d) => (d.innerText || '').includes('批量编辑方式')) ||
      ds.find((d) => d.querySelector('.sku-image-batch-editor')) ||
      null;
  }

  /** 点击元素（滚动到视野；fixed 传送层元素不滚动，否则会把页面顶飞） */
  async function clickEl(el, { wait = 500 } = {}) {
    if (!el) throw new Error('clickEl: 元素不存在');
    try {
      if (getComputedStyle(el).position !== 'fixed' && el.offsetParent !== null) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    } catch (_) { /* ignore */ }
    await sleep(120);
    el.click();
    await sleep(wait);
  }
  /**
   * 原生 setter 写入 input/textarea 并派发事件（绕过 Vue 受控组件）。
   *
   * `keepFocus: true` —— 不调 `el.focus()`。
   * 颜色图面板里有些行被虚拟滚动挪到 `translateY(-9999px)`，对它们 `focus()` 会让浏览器
   * 把所有可滚动祖先滚过去"露出"它，表现为弹窗/页面突然顶飞（同 clickEl 里规避的坑）。
   * 写成「直接赋值 + 派发 input/change/blur」本来就不依赖焦点，所以这里可以安全跳过。
   */
  function setNativeValue(el, value, { keepFocus = false } = {}) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (!keepFocus) el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /** 读取「保存修改」结果弹窗并关闭；返回 {total, success, fail} */
  async function readAndCloseResultDialog() {
    const dlg = await waitFor(() => dialogByText('总计'), { desc: '保存结果弹窗' });
    // 等待进度到 100%
    await waitFor(
      () => {
        const t = dlg.innerText || '';
        const m = t.match(/未完成[：:]\s*(\d+)/);
        return m && Number(m[1]) === 0 ? true : null;
      },
      { timeout: 180000, interval: 500, desc: '任务完成' }
    ).catch((e) => { if (e instanceof StopError) throw e; });
    await sleep(500);
    const text = dlg.innerText || '';
    const num = (label) => {
      const m = text.match(new RegExp(label + '[：:]\\s*(\\d+)'));
      return m ? Number(m[1]) : -1;
    };
    const res = { total: num('总计'), success: num('成功'), fail: num('失败') };
    const closeBtn = [...dlg.querySelectorAll('button')].find(
      (b) => textOf(b) === '关闭'
    );
    if (closeBtn) {
      await clickEl(closeBtn, { wait: 800 });
    } else {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(500);
    }
    return res;
  }

  /* ==================== 落库复核（v1.15.0，verifySaved） ==================== */

  /**
   * 为什么要有这一层（答「保存后没有接口级复核」）：
   *
   * 脚本原有断言**全部发生在点「保存修改」之前** —— 校验的是「预览里改成什么样」。
   * 但「预览改对了」≠「真的存进了数据库」：v1.12.0 实测就出现过面板报「成功 20/20」、
   * 接口复核发现其中 1 条标题根本没改（带着原文参加了保存）。
   * 所以这里补一环：**保存后用 `getCollectItemInfoList` 把落库结果拉回来比对**。
   *
   * 设计要点（均为实测结论，勿凭直觉改）：
   *
   * ① **范围必须来自页面自己发出的请求**，不能用 `selectedDetailIds()`。
   *    实测：勾选 217 条时 `selectedDetailIds()` 只返回 **6~8** 条（它只读已渲染的虚拟滚动行），
   *    靠滚动兜底最多也只能凑到 **176/217**。用它会「只复核了那几条，却以为复核了 217 条」。
   *    而页面打开批量编辑时会**自己发一次** `getCollectItemInfoList`，body 里带**全部 217 个**
   *    `detailIds[i]` —— 这就是权威且零额外请求的选中集来源（见 installSelectionWatcher）。
   *
   * ② **接口按 `fields[]` 裁剪返回**。实测只传 `fields[0]=title` 时，`sizeCharts` /
   *    `shopIdAndGoodsModelReqMap` / `saleAttributes` 全部**不返回**。所以复核必须**不传 fields[]**
   *    自己完整取一次，否则会读到 undefined 并误判成「没改」。
   *
   * ③ **判据是「算出来的期望值」，不是「值有没有变」**。
   *    实测反例：34 条标题**本来就已经是目标值**，183 条才会变；颜色也有商品本来就叫「花色」。
   *    若用「前后不同即通过」，这些商品会被误判成失败。所以每个步骤都给一个**绝对判据**。
   *
   * ④ **模板类步骤（产品/SKU 模板）没有可断言的目标**。
   *    实测：`saleAttributes[].templatePid` 是 1755426/1755427 这类平台属性 id，
   *    与 `itemTemplateId`（1062367）和 `skuPropTemplateId`（575646）**都不在一个号段**，
   *    接口也不返回当前用了哪个模板。所以这两步的判据只标注 `noAssertion`，
   *    不做 before/after 比对 —— 不要把它当成「已核对」。
   *
   * ⑤ 复核失败**不改流程成功与否的结论**，只补一条明确的错误 —— 因为此时数据已经落库了，
   *    报「步骤失败」会误导人去重跑（重跑会二次改标题）。所以用 `verifyFail` 单独标记。
   */
  const VERIFY_MAX_IDS_PER_CALL = 200;   // 实测 217 条一次也行（~1.5s），分批只为缩短单请求

  /**
   * 复核总开关。默认开；万一某天接口变动导致复核恒失败、挡住正常使用，
   * 可以在面板控制台执行 `__msxb.verifyEnabled = false` 关掉，不必改脚本。
   * 复核**只读且只旁听**，关掉它不影响任何业务流程。
   */
  let verifyEnabled = true;
  try {
    window.__msxb = {
      get verifyEnabled() { return verifyEnabled; },
      set verifyEnabled(v) { verifyEnabled = !!v; },
      /** 只读调试快照：能看到「选中集旁听器」抓到了多少条、保存前快照是否就绪 */
      get selection() {
        return {
          ids: selectionWatch.ids.length,
          beforeSnapshot: selectionWatch.before.size,
          captures: selectionWatch.seen
        };
      },
      /**
       * 仅供人工/自动化验证用的复核入口（不参与业务流程）：
       * 不点保存、不写任何数据，只按当前选中集跑一次判据。
       * 例：await __msxb.verify('title')  →  { checked, failed:[...], notes:[...] }
       */
      verify(stepId, extra) {
        return verifySaved(stepId, extra || {});
      }
    };
  } catch (_) {}

  /** 复核要看哪些字段（从接口 item 上取的纯函数，便于单测） */
  const VERIFY_FIELDS = {
    title: (it) => it.title || '',
    enTitle: (it) => (it.multiLanguageTitleMap || {}).en || '',
    sizeChart: (it) => (it.sizeCharts || [])
      .map((s) => s.sizeTemplateSource + ':' + s.sizeTemplateId).sort().join(','),
    model: (it) => Object.values(it.shopIdAndGoodsModelReqMap || {})
      .map((m) => [m.modelName, m.sizeSpecName, m.tryOnResult].join('/')).sort().join(','),
    colorNames: (it) => ((it.saleAttributes || []).find((a) => a.name === '颜色') || {}).values
      ? ((it.saleAttributes || []).find((a) => a.name === '颜色').values || []).map((v) => v.name).join(',') : '',
    saleValues: (it) => (it.saleAttributes || [])
      .map((a) => a.name + '=' + (a.values || []).map((v) => v.name).join('+')).join(';')
  };

  /** 试穿感受：面板上是中文，接口里是数字码（实测 合适=1） */
  function tryOnFeelCode(label) {
    return ({ '合适': '1', '偏大': '2', '偏小': '3' })[label] || '1';
  }

  /** 一次批量拉取（自动分批）；返回 Map<detailId, item> */
  async function fetchItemInfoMap(ids) {
    const map = new Map();
    for (let i = 0; i < ids.length; i += VERIFY_MAX_IDS_PER_CALL) {
      const chunk = ids.slice(i, i + VERIFY_MAX_IDS_PER_CALL);
      // ⚠ 不传 fields[]：传了会把 sizeCharts / 模特 / 颜色整段裁掉（见 ② ）
      const json = await apiPost(
        API_COLLECT_BOX + '/getCollectItemInfoList',
        chunk.map((id, k) => ['detailIds[' + k + ']', id]).concat([['sites[0]', 'PDDKJ']])
      );
      (json.collectItemInfoList || []).forEach((it) => {
        if (it && it.detailId != null) map.set(String(it.detailId), it);
      });
    }
    return map;
  }

  /**
   * 监听页面自己发出的 `getCollectItemInfoList`（XHR）以取得**权威选中集**。
   * 同时把「保存前」的字段快照顺手存下来，供需要前值的判据（标题）使用。
   *
   * 实测：页面用的是 **XHR 而不是 fetch**（只包 fetch 抓不到任何东西）。
   * 包法对调用方完全透明：不改写返回值、不消费 responseText，只旁听。
   */
  const selectionWatch = { ids: [], before: new Map(), seen: 0 };

  function installSelectionWatcher() {
    if (selectionWatch.installed) return;
    selectionWatch.installed = true;
    try {
      const OX = XMLHttpRequest.prototype.open;
      const OS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__msxbUrl = String(url || '');
        return OX.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        const isTarget = this.__msxbUrl && this.__msxbUrl.indexOf('getCollectItemInfoList') >= 0;
        if (isTarget && body) {
          const ids = [];
          String(body).split('&').forEach((kv) => {
            const m = kv.match(/^detailIds%5B\d+%5D=(.+)$/);
            if (m) ids.push(decodeURIComponent(m[1]));
          });
          if (ids.length) {
            selectionWatch.ids = ids;
            selectionWatch.seen++;
            this.addEventListener('load', () => {
              try {
                const json = JSON.parse(this.responseText);
                const map = new Map();
                (json.collectItemInfoList || []).forEach((it) => {
                  if (it && it.detailId != null) map.set(String(it.detailId), it);
                });
                // 只在「还没保存」时记快照：第一次抓到的就是保存前状态
                if (!selectionWatch.before.size) selectionWatch.before = map;
              } catch (_) { /* 旁听失败不影响页面 */ }
            });
          }
        }
        return OS.apply(this, arguments);
      };
    } catch (e) {
      warn('选中集监听安装失败（复核会退回 DOM 兜底）:', e.message || e);
    }
  }

  /**
   * 取本次要复核的 id 集。返回 { ids, complete }。
   *
   * `complete=false` 表示**这个范围不可信**：没能旁听到页面自己的请求，只能退回
   * 「DOM 里已渲染的那几行」。实测勾 217 条时 DOM 只有 6~8 行，滚动兜底最多 176 条 ——
   * 拿这种残缺范围去复核，然后因为「这部分都对了」就报「复核通过」，
   * 等于自己骗自己（这正是 v1.15.0 自查出来的缺陷，上一版就是这么写的）。
   * 所以完整性必须一路传到 verifySaved，由它把这种事标成「无法判定」。
   */
  function verifyScopeIds(dlg) {
    if (selectionWatch.ids.length) return { ids: selectionWatch.ids.slice(), complete: true };
    const domIds = selectedDetailIds();
    if (domIds.length) {
      warn('没能捕获页面请求里的选中集，复核范围退回 DOM 已渲染的 ' + domIds.length + ' 条（范围不完整）');
    }
    return { ids: domIds, complete: false };
  }

  /**
   * 每个步骤的**落库判据**：输入「保存前 item / 保存后 item」，返回 {ok, why}
   * 返回 ok=false 就会进 verify 失败列表。
   */
  function judgeSaved(stepId, before, after, ctx) {
    // 拿不到「保存后」数据 = 无法证明落库成功，绝不能当通过
    if (!after) return { ok: false, why: '保存后接口查不到这条商品' };
    const V = VERIFY_FIELDS;
    switch (stepId) {
      case 'enTitle': {
        const v = V.enTitle(after);
        return v === ' ' ? { ok: true } : { ok: false, why: '英语标题是 ' + JSON.stringify(v) };
      }
      case 'title': {
        // 没有「保存前」基准就无法核对，只能报无法判定（不能报通过）
        if (!before) return { ok: false, why: '没有保存前快照，无法核对标题' };
        const want = ctx.buildTitle(before.title);
        if (after.title === want) return { ok: true };
        return {
          ok: false,
          why: '应为「' + String(want).slice(0, 40) + '…」，实际「' + String(after.title || '').slice(0, 40) + '…」'
        };
      }
      case 'sizeChart': {
        const ids = (after.sizeCharts || []).map((s) => String(s.sizeTemplateId));
        if (!ids.length) return { ok: false, why: '保存后没有尺码表' };
        // ⚠ 解析不出期望 id 时**不能**降级成「有尺码表就算过」—— 那正是恒真断言。
        // 只能报「无法判定」，让它显形，而不是伪装成功。
        if (!ctx.sizeTemplateId) {
          return {
            ok: false,
            why: '无法判定：模板「' + (ctx.sizeTemplateName || '(未提供)') + '」没能解析成 id' +
              '（当前尺码表 ' + ids.join('/') + '）'
          };
        }
        return ids.includes(String(ctx.sizeTemplateId))
          ? { ok: true }
          : { ok: false, why: '尺码表模板是 ' + ids.join('/') + '，期望「' + (ctx.sizeTemplateName || '') + '」(' + ctx.sizeTemplateId + ')' };
      }
      case 'model': {
        const vals = Object.values(after.shopIdAndGoodsModelReqMap || {});
        if (!vals.length) return { ok: false, why: '保存后没有模特信息' };
        const bad = vals.filter((m) => m.modelName !== CFG.modelName ||
          m.sizeSpecName !== CFG.tryOnSize ||
          String(m.tryOnResult) !== tryOnFeelCode(CFG.tryOnFeel));
        if (!bad.length) return { ok: true };
        return {
          ok: false,
          why: '模特是 ' + bad.map((m) => [m.modelName, m.sizeSpecName, m.tryOnResult].join('/')).join('、')
        };
      }
      case 'colorImages': {
        const vals = ((after.saleAttributes || []).find((a) => a.name === '颜色') || {}).values || [];
        if (!vals.length) return { ok: false, why: '保存后没有「颜色」属性' };
        const bad = vals.filter((v) => v.name !== CFG.colorName).map((v) => v.name);
        if (!bad.length) return { ok: true };
        return { ok: false, why: '颜色名仍是 ' + bad.join('、') };
      }
      case 'productTpl':
      case 'skuTpl': {
        // 接口不暴露「用了哪个模板」（templatePid 与 itemTemplateId / skuPropTemplateId 不同号段），
        // 这两步**没有**可断言的目标值：返回 ok 只为不阻断流程，同时带 noAssertion 标明「未核对」。
        return { ok: true, note: '该步骤无可断言的落库目标（接口不暴露模板 id）', noAssertion: true };
      }
      default:
        // 未知步骤 = 没有判据。绝不能默认通过（见 步骤.md §二 C · 「复核」自己也会恒真通过）。
        return { ok: false, why: '没有为步骤「' + stepId + '」定义落库判据' };
    }
  }

  /**
   * 尺码表模板名 → 该类目下的 sizeTemplateId。
   * 接口 `getCategorySizeTemplateList` 给的是 `{sizeTemplateId, name, sizeTemplateSource}`，
   * 而保存后 `sizeCharts[].sizeTemplateId` 也是同一套 id —— 所以可以按名字对齐。
   * 解析不到就返回 ''；判据**不会**降级成「有尺码表就算过」，而是报「无法判定」（见 judgeSaved）。
   */
  async function resolveSizeTemplateId(templateName, ids) {
    if (!templateName) return '';
    try {
      const sample = (ids && ids.length ? ids : selectedDetailIds()).slice(0, VERIFY_MAX_IDS_PER_CALL);
      const info = await fetchItemInfoMap(sample);
      const cids = [];
      info.forEach((it) => {
        const cid = it && it.cid ? String(it.cid) : '';
        if (cid && cids.indexOf(cid) < 0) cids.push(cid);
      });
      if (!cids.length) return '';
      const json = await apiPost(
        API_COLLECT_BOX + '/getCategorySizeTemplateList',
        cids.map((cid, i) => ['cids[' + i + ']', cid])
      );
      let hit = '';
      (json.categorySizeTemplateList || []).forEach((g) => {
        (g.sizeTemplateList || []).forEach((s) => {
          if (!hit && String(s.name || '').trim() === templateName) hit = String(s.sizeTemplateId || '');
        });
      });
      return hit;
    } catch (e) {
      warn('尺码表模板名→id 解析失败（复核会报「无法判定」，不会放行）:', e.message || e);
      return '';
    }
  }

  /**
   * 保存后复核入口。
   * @param {string} stepId STEPS 里的 id
   * @param {object} opts   { dlg, sizeTemplateId, buildTitle }
   * @returns {Promise<{checked:number, failed:Array, notes:string[], unavailable?:string}>}
   *          永远 resolve（复核本身不该把一次已成功的保存变成抛错）；
   *          结果由调用方决定怎么显示。
   */
  async function verifySaved(stepId, opts) {
    const o = opts || {};
    if (!verifyEnabled) return { checked: 0, failed: [], notes: [], unavailable: '复核已关闭' };
    const scope = verifyScopeIds(o.dlg);
    const ids = scope.ids;
    if (!ids.length) {
      return { checked: 0, failed: [], notes: [], unavailable: '没能确定本次保存的商品范围' };
    }
    /*
     * 范围不完整时不报「通过」。
     * 只看得到 6/217 条却宣称「复核通过」，比不复核更糟 —— 它会给一个假的安心。
     * 但也不判失败（会诱导重跑），而是标成 unavailable 让人知道「这次没验全」。
     */
    const partial = !scope.complete
      ? '只复核了 ' + ids.length + ' 条（未能捕获完整选中集，范围不完整）'
      : '';
    const ctx = {
      sizeTemplateId: o.sizeTemplateId || '',
      sizeTemplateName: o.sizeTemplateName || '',
      buildTitle: o.buildTitle || currentTitleBuilder()
    };
    // 只给了名字没给 id 时，先解析一次（需要类目 cid，故放在这里而不是调用方）
    if (ctx.sizeTemplateName && !ctx.sizeTemplateId) {
      ctx.sizeTemplateId = await resolveSizeTemplateId(ctx.sizeTemplateName, ids);
    }
    const after = await fetchItemInfoMap(ids);
    const failed = [];
    const notes = [];
    ids.forEach((id) => {
      const b = selectionWatch.before.get(String(id)) || null;
      const a = after.get(String(id)) || null;
      // 「保存后接口没返回这条商品」由 judgeSaved 的 `!after` 分支负责记一条，
      // 这里不要再补一次 —— 否则同一商品会在错误列表里出现两次，数字虚高。
      const r = judgeSaved(stepId, b, a, ctx);
      if (r.note) notes.push(id + ': ' + r.note);
      if (!r.ok) failed.push({ id, why: r.why });
    });
    return { checked: ids.length, failed, notes, unavailable: partial || undefined };
  }

  /**
   * 把复核结果贴到步骤结果上。
   * 失败**不把步骤判成 error**（数据已落库，报失败会诱导重跑 → 二次改标题），
   * 而是挂一个 `verifyFail` 标记，由 runSequence 显示成「已保存 · 落库复核未通过 N/M 条」。
   */
  function attachVerify(result, vr, stepName) {
    const base = (result && typeof result === 'object') ? result : {};
    /*
     * 顺序很重要：**先看失败，再看「不可用」**。
     * 「范围不完整(unavailable)」和「发现了失败(failed)」可以同时成立 ——
     * 此时失败是硬信息，必须报出来；先判 unavailable 就 return 会把它吞掉。
     * （这一点上一版写错过：注释说「失败优先」，条件里却写了 `!vr.unavailable`，自相矛盾。）
     * 两个都成立时，把「范围不完整」附在失败消息尾部，让两件事都可见。
     */
    if (vr && vr.failed && vr.failed.length) {
      warn(stepName + ' 落库复核未通过：', vr.failed);
      return {
        ...base,
        verify: vr,
        verifyFail: '落库复核未通过 ' + vr.failed.length + '/' + vr.checked + ' 条：' +
          vr.failed.slice(0, 3).map((f) => f.id + ' ' + f.why).join('；') +
          (vr.failed.length > 3 ? ' …' : '') +
          (vr.unavailable ? '（另注：' + vr.unavailable + '）' : '')
      };
    }
    if (!vr || vr.unavailable) {
      // vr 缺失（理论上不该发生）也不能静默放过 —— 那等于「没复核」却毫无痕迹。
      if (!vr) warn(stepName + ' 落库复核没有返回结果（未执行），本步未做落库校验');
      else warn(stepName + ' 落库复核不可用：' + vr.unavailable);
      return { ...base, verify: vr || null };
    }
    log(stepName + ' 落库复核通过：' + vr.checked + ' 条');
    if (vr.notes.length) log(stepName + ' 复核备注：', vr.notes.slice(0, 5));
    return { ...base, verify: vr };
  }

  /**
   * `attachVerify(await clickSave(dlg), await safeVerify(...), name)` 里两个 await 是**从左到右顺序求值**的
   * （先保存、后复核，顺序正确）；但 `verifySaved` 一旦抛错（网络抖动 / 接口改版），异常会从参数位置冒出，
   * 让整个步骤掉进 catch 被记成「步骤失败」—— 可保存其实已经成功了，这会把人骗去重跑。
   * 所以复核一律用这个包一层：出错只 warn、返回「不可用」，绝不影响保存结论。
   */
  async function safeVerify(stepId, opts, stepName) {
    try {
      return await verifySaved(stepId, opts);
    } catch (e) {
      if (e instanceof StopError) throw e;      // 用户主动停止：照常向上传播
      warn((stepName || stepId) + ' 落库复核出错（不影响已完成的保存）:', e.message || e);
      return { checked: 0, failed: [], notes: [], unavailable: '复核出错：' + (e.message || e) };
    }
  }

  /* ============================ 步骤实现 ============================ */

  /**
   * 1. 检测并切换到「未发布」
   *
   * 为什么要有这一步：用户经常停在「全部」或刚处理完停在「已发布」，
   * 一键编辑时不该逼他手工先切 Tab。这里自动切到「未发布」再往下走。
   *
   * 红线 2 的落地方式：
   *   · 本步只**切换筛选**，不勾选、不打开任何面板、不写任何数据；
   *   · 切完立刻重读 `currentCollectFilter()` 验证，切不过去就抛错；
   *   · 后续每个写入入口仍有 `assertUnpublishedOnly()` 兜底。
   *
   * 幂等：已在「未发布」时不做任何点击，直接返回。
   */
  async function stepEnsureUnpublished() {
    const r = await ensureUnpublishedFilter('第 1 步 · 检测并切换到未发布');
    if (!r.switched) {
      log('筛选已是「未发布」，无需切换');
      return '已是未发布';
    }
    return '已从「' + r.from + '」切到未发布';
  }

  /** 2. 分页改 500 + 全选 */
  async function stepSelectAll() {
    // 红线 2 第二道闸：万一有人跳过第 1 步直接点本步，也不能在非「未发布」下勾选
    assertUnpublishedOnly('第 2 步 · 分页 500 + 全选');
    // 分页下拉
    const combo = document.querySelector(
      '.pro-pagination .jx-select__input, .pro-pagination .el-input__inner, .pro-pagination input[readonly]'
    );
    const pagWrap = document.querySelector('.pro-pagination');
    const already500 = pagWrap && (pagWrap.innerText || '').includes('500条/页');
    if (combo && !already500) {
      // 展开下拉：点其外层，不要点 input 本体（jx 组件的 input 是只读的）
      await clickEl(combo.parentElement || combo, { wait: 1200 });
      const opt = await waitFor(
        () => [...document.querySelectorAll(
          '.jx-select-dropdown__item, .el-select-dropdown__item, .el-option, .jx-option, li'
        )].find((o) => isVisible(o) && textOf(o) === CFG.pageSize),
        { desc: '500条/页 选项' }
      );
      await clickEl(opt, { wait: 2500 });
    }
    // 全选。
    // 见 步骤.md §二 A（交互定位）：「全选」按钮是**切换型**（没有 is-checked 态可判断），
    // 已全部选中时再点一次会全部取消，
    // 因此必须先读分页区的「已选 N /M条」判断，已全选则跳过。
    const pagLeft = () =>
      ((document.querySelector('.pro-pagination__left')?.innerText) || '').replace(/\s+/g, ' ');
    const allSelected = () => {
      const m = pagLeft().match(/已选\s*(\d+)\s*\/\s*(\d+)/);
      return !!m && Number(m[1]) > 0 && Number(m[1]) === Number(m[2]);
    };

    const all = findByText('button', '全选', { exact: true });
    if (!all) throw new Error('未找到「全选」按钮');

    if (!allSelected()) {
      await clickEl(all, { wait: 1800 });
      // 兜底：万一确实被整组取消（已选区消失），再点一次恢复
      if (!/已选/.test(pagLeft())) {
        warn('「全选」把选中清空了，重新点一次');
        await clickEl(all, { wait: 1800 });
      }
    }

    const selText = await waitFor(
      () => {
        const t = pagLeft();
        return /已选\s*\d+/.test(t) ? t : null;
      },
      { desc: '选中数量（当前分页区: ' + pagLeft() + '）' }
    );
    const m = selText.match(/已选\s*(\d+)\s*\/\s*(\d+)/);
    return m ? `已选 ${m[1]}/${m[2]}` : '已全选';
  }

  /**
   * 打开「引用模板」下拉并选择菜单项。
   * 注意：左侧导航也有同名的「产品模板」，必须限定在 .jx-dropdown-menu 内匹配，
   * 否则会误点导航导致页面跳走并丢失选中态。
   */
  async function pickTemplateMenu(menuText) {
    const btn = findByText('button', '引用模板');
    if (!btn) throw new Error('未找到「引用模板」按钮');
    btn.scrollIntoView({ block: 'center' });
    await sleep(150);
    // 实测：该下拉由 mouseenter + mouseover 触发（click 无效）
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(1200);

    const item = await waitFor(
      () => {
        const menus = [...document.querySelectorAll('.jx-dropdown-menu, .el-dropdown-menu')].filter(isVisible);
        for (const m of menus) {
          const hit = [...m.querySelectorAll('li, .jx-dropdown-menu__item, .el-dropdown-menu__item, span')]
            .find((e) => textOf(e) === menuText);
          if (hit) return hit;
        }
        return null;
      },
      { desc: '下拉菜单项: ' + menuText }
    );
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    item.click();
    await sleep(2200);
  }

  /**
   * 读 jx-select 当前选中的文本。
   * 见 步骤.md §二 E（接口与数据）：该组件的 input.value 恒为空，选中值只体现在 `.jx-select__placeholder` 里，
   * 所以「当前值是否等于目标模板」必须读 DOM 文本，不能读 input.value
   * （原实现读 value，永远读不到，只会在控制台刷一段无害但误导的 warn）。
   */
  function readSelectText(selectEl) {
    if (!selectEl) return '';
    const ph = selectEl.querySelector('.jx-select__placeholder, .el-select__placeholder');
    const shown = ph ? textOf(ph) : '';
    if (shown) return shown;
    const items = [...selectEl.querySelectorAll('.jx-select__selected-item')]
      .filter((n) => !n.classList.contains('jx-select__input-wrapper'))
      .map(textOf)
      .filter(Boolean);
    if (items.length) return items[items.length - 1];
    const inp = selectEl.querySelector('input');
    return (inp && inp.value || '').trim();
  }

  /** 下拉里当前可见的模板选项 li（只取一层，避免 .jx-popper 与其内层 .jx-select-dropdown 重复计入） */
  function templateOptionNodes() {
    const boxes = [
      '.jx-popper.jx-select__popper li',
      '.jx-select-dropdown li',
      '.el-select-dropdown li'
    ];
    for (const sel of boxes) {
      const nodes = [...document.querySelectorAll(sel)].filter(isVisible);
      if (nodes.length) return nodes;
    }
    return [];
  }

  /**
   * 在「引用模板」弹窗里选中目标模板。
   * targetName 为空 = 跟随页面默认（此时按下拉顺序取第一个选项，并把真实名字回报给面板）。
   * 返回实际应用的模板名。
   */
  async function chooseTemplateInDialog(dlg, targetName, label, kind) {
    const selectEl = dlg.querySelector('.jx-select.pro-select, .jx-select') ||
      dlg.querySelector('.el-select');
    if (!selectEl) throw new Error('未找到' + label + '选择框');

    const openList = async () => {
      const inp = selectEl.querySelector('input');
      await clickEl(inp || selectEl, { wait: 900 });
      const nodes = await waitFor(
        () => { const n = templateOptionNodes(); return n.length ? n : null; },
        { desc: label + '下拉选项', timeout: 12000 }
      );
      return nodes;
    };

    let nodes = [];
    const current = readSelectText(selectEl);

    // 指定了名字时先比对当前值，已一致就不动下拉（少一次误触风险）
    if (targetName && current === targetName) {
      if (kind) rememberTemplates(kind, [current]);
      return current;
    }

    nodes = await openList();
    const names = nodes
      .filter((n) => !n.classList.contains('is-disabled'))
      .map(textOf)
      .filter(Boolean);
    if (kind) rememberTemplates(kind, names);

    const wanted = targetName || names[0];
    if (!wanted) throw new Error(label + '下拉无可用选项');

    if (current === wanted) {
      closeDropdown(dlg);
      return current;
    }

    const hit = nodes.find((n) => textOf(n) === wanted);
    if (!hit) throw new Error(label + '未找到模板「' + wanted + '」（可选：' + names.join(' / ') + '）');
    await clickEl(hit, { wait: 1200 });
    log(label, '已选模板:', wanted, targetName ? '' : '(跟随页面第一个选项)');
    return wanted;
  }

  /**
   * 收起当前展开的下拉。
   * 不用 Escape：Esc 会把「引用模板」主弹窗一起关掉，后续点「应用至选中」就找不到按钮，
   * 表现为「未找到应用至选中」这种莫名其妙的中途失败。改为点弹窗标题这类中性区域。
   */
  function closeDropdown(dlg) {
    const neutral = (dlg && (dlg.querySelector('.jx-dialog__header, .el-dialog__header') ||
      dlg.querySelector('.jx-dialog__title, .el-dialog__title'))) || null;
    if (neutral) {
      neutral.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      neutral.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      neutral.click();
    }
  }

  /** 3. 产品模板 */
  async function stepProductTemplate() {
    await pickTemplateMenu('产品模板');

    const dlg = await waitFor(() => dialogByText('批量引用模板'), { desc: '产品模板弹窗' });
    // 设置里选中的模板名直接生效；空值＝跟随页面下拉的第一个选项
    const wanted = tplTarget('product');
    const applied = await chooseTemplateInDialog(dlg, wanted, '产品模板', 'product');

    const apply = [...dlg.querySelectorAll('button')].find((b) => textOf(b) === '应用至选中');
    if (!apply) throw new Error('未找到「应用至选中」');
    assertUnpublishedOnly('产品模板 · 应用至选中');   // 写入口第二道闸（见文件头红线 2）
    await clickEl(apply, { wait: 1500 });
    const res = await readAndCloseResultDialog();
    // 落库复核：接口不暴露「用了哪个模板」，本步只标 noAssertion、不做比对（见 verifySaved ④）
    return attachVerify(
      { ...res, template: applied },
      await safeVerify('productTpl', { dlg }),
      '产品模板'
    );
  }

  /**
   * SKU 弹窗里的「引用方式」单选。
   *
   * 实测（2026-10-19，真实页面）：三个选项的 `<input type=radio>` 值分别是
   *   `append`       = 增补模板内容      ← **页面默认勾选**（老脚本一直沿用它，是错的）
   *   `cover`        = 直接以模板内容覆盖  ← 本流程要选的
   *   `partReplace`  = 部分替换
   * 文案在 `.jx-radio__label` 里，`li/span` 那种按文本找节点的写法在这里命中不到，
   * 所以按 `引用方式` 那一行 `.jx-form-item` 内的 radio 定位，并同时用 value 兜底。
   */
  const SKU_COVER_TEXT = '直接以模板内容覆盖';

  function skuModeRadios(dlg) {
    // 「引用方式」那一行：label 文本是「引用方式」，其 content 里是 pro-radio-group
    const items = [...dlg.querySelectorAll('.jx-form-item, .pro-form-item')];
    const row = items.find((it) => /引用方式/.test(textOf(it.querySelector('.jx-form-item__label') || it)));
    const scope = row || dlg;
    return [...scope.querySelectorAll('.jx-radio, .el-radio')].filter((r) => isVisible(r));
  }

  /** 让「引用方式」= 直接以模板内容覆盖；返回是否确认已选中 */
  async function ensureSkuCoverMode(dlg) {
    const labelOf = (r) => {
      const l = r.querySelector('.jx-radio__label, .el-radio__label');
      return textOf(l || r);
    };
    const inputOf = (r) => r.querySelector('input[type=radio]');
    const isOn = (r) => {
      const inp = inputOf(r);
      return !!(inp && inp.checked) || r.className.includes('is-checked');
    };

    let radios = skuModeRadios(dlg);
    if (!radios.length) throw new Error('未找到「引用方式」选项');
    let cover = radios.find((r) => labelOf(r) === SKU_COVER_TEXT) ||
      radios.find((r) => (inputOf(r) || {}).value === 'cover');
    if (!cover) {
      throw new Error('未找到「' + SKU_COVER_TEXT + '」选项（可选：' +
        radios.map(labelOf).filter(Boolean).join(' / ') + '）');
    }

    if (isOn(cover)) {
      log('SKU 引用方式：已是「' + SKU_COVER_TEXT + '」，不重复点');
      return true;
    }

    // 点 label 文本节点（点外层 label / 直接 click() 在 jx-radio 上不一定触发 Vue 的 v-model）
    const hit = cover.querySelector('.jx-radio__label, .el-radio__label') || cover;
    await clickEl(hit, { wait: 300 });

    // 等它真的变成选中态：单选按钮的选中是页面状态，不能假设点完就生效
    try {
      await waitFor(
        () => {
          const now = skuModeRadios(dlg);
          const c = now.find((r) => labelOf(r) === SKU_COVER_TEXT) ||
            now.find((r) => (inputOf(r) || {}).value === 'cover');
          return c && isOn(c) ? true : null;
        },
        { desc: '「' + SKU_COVER_TEXT + '」被选中', timeout: 6000, interval: 100 }
      );
    } catch (e) {
      if (e instanceof StopError) throw e;
      throw new Error('「引用方式」没能切到「' + SKU_COVER_TEXT + '」，已中止（避免按增补方式覆盖）');
    }
    const now = skuModeRadios(dlg);
    const stillOn = now.find((r) => labelOf(r) === SKU_COVER_TEXT || (inputOf(r) || {}).value === 'cover');
    if (!stillOn || !isOn(stillOn)) {
      throw new Error('「引用方式」没能切到「' + SKU_COVER_TEXT + '」，已中止（避免按增补方式覆盖）');
    }
    log('SKU 引用方式：已切到「' + SKU_COVER_TEXT + '」');
    return true;
  }

  /** 4. SKU 模板（**直接以模板内容覆盖**，不是默认的「增补模板内容」） */
  async function stepSkuTemplate() {
    await pickTemplateMenu('SKU模板');

    const dlg = await waitFor(() => dialogByText('批量引用SKU模板'), { desc: 'SKU模板弹窗' });
    const wanted = tplTarget('sku');
    const applied = await chooseTemplateInDialog(dlg, wanted, 'SKU模板', 'sku');

    // 引用方式：必须显式改成「直接以模板内容覆盖」。
    // 页面默认是「增补模板内容」（input value=append），沿用它就会变成"往原 SKU 上再加一套"，
    // 与流程要求的"整段覆盖"相反 —— 老版本正是把它当默认值保留了。
    await ensureSkuCoverMode(dlg);

    // 弹窗底部有 4 个按钮（取消 / 应用至无类目 / 应用至相同类目 / 应用至选中），
    // 只有 1 个文本严格等于「应用至选中」，用最右那个兜底
    const apply = [...dlg.querySelectorAll('button')]
      .filter((b) => textOf(b) === '应用至选中')
      .pop();
    if (!apply) throw new Error('未找到「应用至选中」');
    assertUnpublishedOnly('SKU 模板 · 应用至选中');   // 写入口第二道闸（见文件头红线 2）
    await clickEl(apply, { wait: 1500 });
    const res = await readAndCloseResultDialog();
    // 落库复核：同上，只标 noAssertion、不做比对（接口不暴露 skuPropTemplateId）
    return attachVerify(
      { ...res, template: applied },
      await safeVerify('skuTpl', { dlg }),
      'SKU 模板'
    );
  }

  /**
   * 打开批量编辑并切到某字段。
   * 实测：点「批量编辑」先弹出的是字段选择浮层（.jx-tooltip.jx-popover，
   * 内含 SPAN: 标题/英语标题/尺码表/模特信息/颜色图…），点字段后才打开编辑弹窗。
   */
  async function openBatchEdit(fieldName) {
    /**
     * 左侧字段 li 是否已切到 fieldName **并且该面板的编辑区已可交互**。
     * 该 li 带 `menu-item active`，但实测切字段瞬间 active 就已经变过去，
     * 而新面板还是空骨架（textarea / 字段浮层都还没出来），
     * 所以必须同时要求「编辑区已就绪」，否则会拿上一个字段的 DOM 继续跑。
     */
    const panelReady = (d) => {
      if (!d) return false;
      const act = [...d.querySelectorAll('li.menu-item.active, li.active')]
        .find((l) => isVisible(l) && textOf(l) === fieldName);
      if (!act) return false;
      // 颜色图面板没有通用编辑区，用它自己的编辑器判断
      if (fieldName === '颜色图') return !!d.querySelector('.sku-image-batch-editor input.el-input__inner');
      return !!(d.querySelector('textarea') ||
                d.querySelector('.jx-pro-input input.el-input__inner') ||
                d.querySelector('.jx-pro-virtual-table__row textarea'));
    };

    // 弹窗已打开：先点左侧字段切换（同一个弹窗内切换，不重新打开）
    let dlg = batchEditDialog();
    if (dlg) {
      const sideItem = [...dlg.querySelectorAll('li')].find(
        (l) => textOf(l) === fieldName && isVisible(l)
      );
      if (sideItem) {
        // 见 步骤.md §二 B（虚拟滚动与分页）：实测切字段只要 ~125ms，这里不再盲等 2000ms，
        // 改成「等该字段 active + 编辑区就绪」——快则立刻过，慢则自动等（上限 20s）
        if (!panelReady(dlg)) {
          await clickEl(sideItem, { wait: 80 });
          await waitFor(() => panelReady(dlg) || null,
            { desc: '字段面板切换: ' + fieldName, timeout: 20000, interval: 100 })
            .catch((e) => { if (e instanceof StopError) throw e; });
        }
        return dlg;
      }
    }

    if (!dlg) {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => isVisible(b) && textOf(b).startsWith('批量编辑')
      );
      if (!btn) throw new Error('未找到「批量编辑」按钮');

      // 该按钮是 jx-tooltip 触发器，用 hover 事件展开
      btn.scrollIntoView({ block: 'center' });
      await sleep(150);
      btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // 同上（§二 B）：hover 后不再盲等 1200ms，直接等「字段浮层里出现目标字段」

      // 在字段浮层里精确点字段（SPAN 叶子节点）
      const field = await waitFor(
        () => {
          const pops = [...document.querySelectorAll('.jx-popper, .el-popper, .jx-tooltip')]
            .filter((p) => isVisible(p) && (p.innerText || '').includes(fieldName));
          for (const p of pops) {
            const hit = [...p.querySelectorAll('span, div, li')].find(
              (e) => e.children.length === 0 && textOf(e) === fieldName
            );
            if (hit) return hit;
          }
          return null;
        },
        { desc: '批量编辑字段: ' + fieldName }
      );
      await clickEl(field, { wait: 150 });
      dlg = await waitFor(() => batchEditDialog(), { desc: '批量编辑弹窗' });
    }
    return dlg;
  }

  /** 确保「按指定规则修改」被选中 */
  async function ensureRuleMode(dlg) {
    const radio = [...dlg.querySelectorAll('.el-radio')].find(
      (r) => (r.innerText || '').includes('按指定规则修改')
    );
    if (radio && !radio.className.includes('is-checked')) await clickEl(radio, { wait: 800 });
  }

  /**
   * 前置自检：**页面必须在可见的前台标签页**。
   *
   * 为什么会漏改（v1.13.1 实测）：预览表 / 颜色图列表都是 DynamicScroller 虚拟滚动，
   * 只渲染可视区那几行，且**靠 requestAnimationFrame 驱动重绘**。
   * 标签页切到后台 / 窗口最小化 / 被完全遮挡时，浏览器冻结 rAF（实测 前台 61 次/秒 → 后台 0 次/秒），
   * 于是 `scroller.scrollTop` 照常变化、代码以为在滚，但**表格一行都不重绘**，
   * 脚本读到的永远是开头那几行 → 表现为「覆盖 7/50」或第 9 步「漏改但报成功」。
   * 这不是脚本能绕过的（是浏览器省电策略），只能提前拦下来说清楚原因。
   */
  function assertPageVisible(stepName) {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      throw new Error(
        (stepName || '本步') + '中止：妙手这个标签页当前不在前台（已切走 / 最小化 / 被遮挡）。' +
        '虚拟滚动的表格在后台不会重绘，会导致漏改。请把它切到最前面再重跑本步。'
      );
    }
  }

  /**
   * 把「预览表」的分页条数设成指定值（默认 500 条/页）。
   *
   * 见 步骤.md §二 B（虚拟滚动与分页）：预览表的分页器是 **el- 系**（`.el-pagination__sizes .el-select`），
   * 与列表页那个 **jx- 系**（`.pro-pagination .jx-select`）是两套完全不同的组件树，
   * 所以第 2 步设的「500 条/页」**不会**带进预览区 —— 必须单独设一次。
   *
   * 关键实测（2026-10-19）：
   *  · 点「预览」之前，这个条数下拉**就已经在 DOM 里**（默认 20 条/页），
   *    所以可以「先设条数 → 再点预览」，不必预览两次；
   *  · 设成 500 后，50 条商品从 3 页并成 **1 页**，一趟滚到底实测覆盖 50/50；
   *  · 500 是硬上限：选中超过 500 条时仍会分页，调用方需自行校验（见 previewPageCount）。
   *
   * @returns {Promise<string>} 实际生效的条数文本（读不到返回 ''）
   */
  async function setPreviewPageSize(root, want = '500条/页') {
    // root 传弹窗（标题面板）或面板容器（颜色图用 .sku-image-batch-editor），
    // 避免同时存在多个分页器时抓错那一个。
    const sel = root.querySelector('.el-pagination__sizes .el-select');
    if (!sel) return '';                       // 没有分页器（如结果为空）→ 交给调用方判断

    const input = sel.querySelector('input.el-input__inner');
    const cur = (input && input.value) || '';
    if (cur === want) return cur;              // 已是目标值，不重复点

    // 展开下拉：点 .el-input 外壳（点 input 本体在 el-select 上常常只聚焦不展开）
    await clickEl(sel.querySelector('.el-input') || input || sel, { wait: 700 });

    let hit = null;
    try {
      hit = await waitFor(
        () => [...document.querySelectorAll('.el-select-dropdown__item')]
          .find((li) => isVisible(li) && textOf(li) === want),
        { desc: '预览区每页条数选项 ' + want, timeout: 8000, interval: 100 }
      );
    } catch (e) {
      if (e instanceof StopError) throw e;
      // 展开失败（下拉已开但没找到选项 / 组件没响应）→ 收回并如实报告，不硬撑
      closeDropdown(root);
      warn('预览区条数下拉没展开，保持原值:', cur || '(未知)');
      return cur;
    }

    await clickEl(hit, { wait: 1200 });
    // 等值真的变了（el-select 选中后会重渲染，input 节点可能被替换 → 重新查）
    try {
      await waitFor(
        () => (root.querySelector('.el-pagination__sizes input') || {}).value === want,
        { desc: '预览区条数生效', timeout: 6000, interval: 100 }
      );
    } catch (e) {
      if (e instanceof StopError) throw e;
    }
    return (root.querySelector('.el-pagination__sizes input') || {}).value || '';
  }

  /**
   * 预览表当前的分页页数（1 起）。用于判断「是否还残留分页」。
   * 优先读 `.el-pager li` 里最大的页码（el-pagination 折叠时会显示 `1 2 3 4 … 11`，最大号仍在）；
   * 读不到再按「总数 / 每页条数」估算。
   */
  function previewPageCount(root) {
    const pager = root.querySelector('.el-pagination');
    if (!pager) return 1;
    const nums = [...pager.querySelectorAll('.el-pager li')]
      .map((li) => Number(textOf(li)))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length) return Math.max(...nums);
    const total = Number((textOf(pager.querySelector('.el-pagination__total')).match(/(\d+)\s*条/) || [])[1]);
    const per = Number((pager.querySelector('.el-pagination__sizes input') || {}).value.replace(/\D/g, '')) || 20;
    return total > 0 ? Math.max(1, Math.ceil(total / per)) : 1;
  }
  /**
   * 点「预览」并等预览行真的渲染出来（条件等待，不再盲等 1500ms）。
   * 见 步骤.md §二 B（虚拟滚动与分页）：实测点「预览」→ 预览行出现只要 **约 53ms**，
   * 老实现 clickEl(1500) + sleep(800) 白等 2.25s，各步累计就是十几秒的黏滞感。
   *
   * ⚠ 判据必须是「**带 textarea 的**预览行」：实测在同一弹窗里切字段时，
   * 新字段会先渲染出一排**空骨架行**（`.jx-pro-virtual-table__row` 已在、textarea 还没有，
   * 持续约 1s 以上）。若只判断 row 存在，就会立刻拿旧字段的骨架继续往下走。
   */
  async function clickPreview(dlg) {
    const btn = [...dlg.querySelectorAll('button')].find((b) => textOf(b) === '预览');
    if (!btn) throw new Error('未找到「预览」按钮');
    await clickEl(btn, { wait: 80 });
    // 等预览真的渲染出可编辑行（首屏；后续翻页/滚动由各步骤自行处理）
    await waitFor(
      () => dlg.querySelector('.jx-pro-virtual-table__row textarea') ||
            (!dlg.querySelector('.jx-pro-virtual-table__row') && dlg.querySelector('textarea')),
      { desc: '预览结果', timeout: 20000, interval: 120 }
    ).catch((e) => { if (e instanceof StopError) throw e; });
  }

  /**
   * 点「保存修改」——**全脚本唯一的落库出口**。
   *
   * 这里有意再加一道 `assertUnpublishedOnly()`：前面每个 step 已经断言过，但这一步是
   * 真正把数据写进数据库的地方，**防线要设两道**。万一将来有人新增了一条步骤、
   * 又忘了加断言，也不会从这条路把"已发布"的数据写出去。
   */
  async function clickSave(dlg) {
    assertUnpublishedOnly('保存修改');          // ← 最后一道闸：非「未发布」一律不落库
    const btn = [...dlg.querySelectorAll('button')].find((b) => textOf(b) === '保存修改');
    if (!btn) throw new Error('未找到「保存修改」按钮');
    // 同上（§二 B）：点完不再盲等 2000ms 再去找结果弹窗 —— 结果弹窗本身由
    // readAndCloseResultDialog 的 waitFor 兜着（默认 20s），这里只留点击节流
    await clickEl(btn, { wait: 120 });
    return await readAndCloseResultDialog();
  }

  /** 5. 英语标题 → 一个空格 */
  async function stepEnglishTitle() {
    const dlg = await openBatchEdit('英语标题');
    await ensureRuleMode(dlg);
    const box = dlg.querySelector('.jx-pro-input input.el-input__inner');
    if (!box) throw new Error('未找到「使用新英语标题」输入框');
    await clickEl(box, { wait: 200 });
    setNativeValue(box, ' ');
    await sleep(400);
    await clickPreview(dlg);
    const res = await clickSave(dlg);
    // 落库复核：接口里 multiLanguageTitleMap.en 必须是单个空格
    return attachVerify(res, await safeVerify('enTitle', { dlg }, '英语标题'), '英语标题');
  }

  /** 6. 标题 → 删词 + 唯一前缀（在预览内手工改写） */
  async function stepTitle() {
    assertPageVisible('「标题」');
    const dlg = await openBatchEdit('标题');
    await ensureRuleMode(dlg);

    // 见 步骤.md §二 B（虚拟滚动与分页）：预览表自带「每页条数」下拉（el- 系，与列表页 jx- 系无关），
    // 默认 20 条/页。若不拉满，选中 >20 条时预览就会分页，而下面的滚动只扫当前页 →
    // 覆盖断言虽能拦住（不会写坏），但这一步等于跑不完。先把条数设成 500 再预览。
    const sizeSet = await setPreviewPageSize(dlg, '500条/页');
    if (sizeSet && sizeSet !== '500条/页') warn('预览区条数未设成 500条/页（当前：' + sizeSet + '），多页时可能覆盖不全');
    // 必须清空「删除标题中」——该框有 BUG，不可使用
    const delBox = dlg.querySelector('input[placeholder*="请输入要删除的关键词"]');
    if (delBox && (delBox.value || '').trim()) {
      warn('检测到「删除标题中」有内容，已清空（该功能有 BUG）');
      setNativeValue(delBox, '');
      await sleep(300);
    }

    await clickPreview(dlg);

    // 词表来自面板设置（可手动增删），为空时只加前缀不删词
    const words = [...settings.deleteWords].filter(Boolean).sort((a, b) => b.length - a.length);
    if (!words.length) warn('删除词表为空，本步只加前缀，不删任何词');

    /*
     * 见 步骤.md §二 B（虚拟滚动与分页）：预览表是 **虚拟滚动**（`.jx-pro-virtual-table__body` 是 DynamicScroller，
     * maxHeight 400px），一次只渲染可视区 + 缓冲那几行。老实现用一次
     * `dlg.querySelectorAll('.jx-pro-virtual-table__row')` 快照，只改到「当前渲染出来的行」：
     * 实测 30 条商品时只有 **7 行**在 DOM 里，于是 23 条原封不动，
     * 而 `count` 非零 → 不报错 → 面板仍显示「成功 30/30」。
     * 对策：**边滚边改**。scrollTop 从 0 按 clientHeight*0.7 步进到底，
     * 每一步把当前渲染的所有行改写掉；一遍扫完再复扫，直到「整趟零改动」。
     * 已改过的行不会重复处理（改写结果以「编辑前」原文为基准，天然幂等）。
     */
    const scroller = dlg.querySelector('.vue-recycle-scroller.jx-pro-virtual-table__body') ||
      dlg.querySelector('.jx-pro-virtual-table .vue-recycle-scroller') ||
      dlg.querySelector('.jx-pro-virtual-table__body');

    /* ---------------- 覆盖追踪（§二 C：不许再出现「保存 20/20，实际只改 19 条」） ---------------- */

    /**
     * 「应改总数」：预览区分页区的 `已选 N / M条` 里的 M，就是本次预览的行数。
     * 实测该值在点「预览」之前就已经是 N（`已选 20 / 20条`），所以读不到也不算阻塞。
     */
    const readExpectedCount = () => {
      const t = textOf(dlg.querySelector('.el-pagination__total'));
      const m = t.match(/(\d+)\s*条/);
      const v = m ? Number(m[1]) : 0;
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    const expected = readExpectedCount();

    /*
     * 见 步骤.md §二 B（虚拟滚动与分页）：预览区条数已拉到 500 上限，但**选中超过 500 条时仍会分页**。
     * 这一步只滚当前页，跨页的行永远渲染不到 → 必须在动手前就把它识别出来，
     * 否则会走到最后才被 "只覆盖到 X/Y 行（虚拟滚动没扫全）" 拦下，报错原因还指向歧路。
     */
    const previewPages = previewPageCount(dlg);
    if (previewPages > 1) {
      throw new Error(
        '预览区仍有 ' + previewPages + ' 页（每页最多 500 条），说明本批选中数 ' +
        (expected || '>500') + ' 条超过了预览的 500 条上限。本步只能单页整表扫描，' +
        '请减少勾选数量（≤500 条）后重跑，已中止保存。'
      );
    }

    /**
     * 行的稳定去重键 = 该 item-view 的 `translateY(...)` 位移（虚拟滚动按位置摆放行，
     * 每条商品一个唯一位移）。实测 20 条数据 → 20 个互不相同的位移；
     * `translateY(-9999px)` 是停放中的缓冲副本，跳过。
     * 没有 item-view（表格未虚拟化）时退回「行内序号」，那种情况下所有行本来都在 DOM 里。
     */
    const renderedRows = () => {
      const views = [...dlg.querySelectorAll('.vue-recycle-scroller__item-view')];
      const list = [];
      if (views.length) {
        for (const v of views) {
          const t = (v.style && v.style.transform) || '';
          if (t.includes('-9999')) continue;                 // 停放副本，不代表当前位置
          const row = v.querySelector('.jx-pro-virtual-table__row');
          if (row) list.push({ row, key: t || ('view#' + list.length) });
        }
        if (list.length) return list;
      }
      return [...dlg.querySelectorAll('.jx-pro-virtual-table__row')]
        .map((row, i) => ({ row, key: 'row#' + i }));
    };

    const covered = new Set();        // 读到原文并已处理的行（位置键）
    const emptyOrig = new Set();      // 有行但「编辑前」为空的（这类必须显形，不能静默跳过）
    const stillWrong = new Set();     // 复核发现内容仍不对的行
    const unchecked = new Set();      // 预览行没勾选 → 保存不会带上（左上角「不勾选则不保存」）

    /** 删词 + 规整标点 + 唯一前缀 —— 与 `verifySaved()` 共用同一份实现（见 makeTitleBuilder） */
    const buildTitle = makeTitleBuilder(words);

    /**
     * 取一行里的 { textarea, 编辑前原文, 是否勾选 }；拿不到返回 null。
     * 「是否勾选」很关键：预览表左上角写着「产品信息（不勾选则不保存）」——
     * 行没勾选时，即使我们把 textarea 改对了，保存也不会带上它（实测默认全勾选，但绝不能假设）。
     */
    const readRow = (row) => {
      const cells = [...row.querySelectorAll('.jx-pro-virtual-table__row-cell')];
      const ta = row.querySelector('textarea');
      if (!ta || cells.length < 3) return null;
      // 见 步骤.md §二 C（断言与复核）：基准列必须是 cells[2]（`.old-title` 的「编辑前」列），
      // 不能用 cells[1]（整块商品信息，item-info 有内容时会污染标题）
      return {
        ta,
        orig: (cells[2].innerText || '').trim(),
        checked: !!row.querySelector('.el-checkbox.is-checked, .jx-checkbox.is-checked')
      };
    };

    /** 改写当前 DOM 里所有预览行；返回本次实际写入的行数 */
    const rewriteRendered = () => {
      let n = 0;
      for (const { row, key } of renderedRows()) {
        const r = readRow(row);
        if (!r) continue;
        if (!r.orig) { emptyOrig.add(key); continue; }
        if (!r.checked) { unchecked.add(key); continue; }   // 未勾选 → 改也白改，记下来报错
        emptyOrig.delete(key);
        unchecked.delete(key);
        covered.add(key);
        const final = buildTitle(r.orig);
        if ((r.ta.value || '').trim() === final) continue;   // 已是目标值，不重复写
        setNativeValue(r.ta, final);
        n++;
      }
      return n;
    };

    /** 复核当前 DOM：内容仍不等于目标的记入 stillWrong；同时补齐 covered / unchecked（只读，不写） */
    const verifyRendered = () => {
      for (const { row, key } of renderedRows()) {
        const r = readRow(row);
        if (!r) continue;
        if (!r.orig) { emptyOrig.add(key); continue; }
        if (!r.checked) { unchecked.add(key); continue; }   // 未勾选 = 保存不会带上
        emptyOrig.delete(key);
        unchecked.delete(key);
        covered.add(key);
        if ((r.ta.value || '').trim() !== buildTitle(r.orig)) stillWrong.add(key);
        else stillWrong.delete(key);
      }
    };

    const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const stepPx = () => Math.max(80, Math.round(scroller.clientHeight * 0.7));
    const maxSteps = () => Math.ceil(maxScroll() / stepPx()) + 2;

    /** 从顶滚到底扫描一趟（只写），返回本趟写入行数 */
    const sweepRows = async () => {
      scroller.scrollTop = 0;
      await sleep(250);
      let wrote = 0;
      for (let guard = 0; guard <= maxSteps(); guard++) {
        wrote += rewriteRendered();
        await sleep(180);
        const cur = scroller.scrollTop;
        if (cur >= maxScroll() - 1) {
          // `scrollHeight` 会随着新行渲染而增长（实测 1485 → 1885），
          // 因此「到底」必须再确认一次：等一拍后重新看内容高度，变高了就继续滚。
          await sleep(260);
          if (cur >= maxScroll() - 1) break;
        }
        const next = Math.min(maxScroll(), cur + stepPx());
        if (next <= cur) break;                    // 确实滚不动了
        scroller.scrollTop = next;
        await sleep(240);
        if (Math.abs(scroller.scrollTop - cur) < 1) break;
      }
      wrote += rewriteRendered();   // 到底后再补一遍
      await sleep(220);
      return wrote;
    };

    /** 从顶滚到底复核一趟（只读 + 兜底补写），统计覆盖/残留 */
    const verifySweep = async () => {
      scroller.scrollTop = 0;
      await sleep(240);
      for (let guard = 0; guard <= maxSteps(); guard++) {
        // 复核前先补一次写入：个别行可能上一趟读到的是空骨架，这里兜住
        rewriteRendered();
        verifyRendered();
        const cur = scroller.scrollTop;
        if (cur >= maxScroll() - 1) {
          await sleep(260);
          if (cur >= maxScroll() - 1) break;
        }
        const next = Math.min(maxScroll(), cur + stepPx());
        if (next <= cur) break;
        scroller.scrollTop = next;
        await sleep(220);
        if (Math.abs(scroller.scrollTop - cur) < 1) break;
      }
      rewriteRendered();
      verifyRendered();
    };
    const canScroll = scroller && scroller.scrollHeight > scroller.clientHeight + 4;
    let count = 0;
    let passes = 0;
    if (!canScroll) {
      count = rewriteRendered();
      if (!covered.size && !dlg.querySelector('.jx-pro-virtual-table__row textarea')) {
        throw new Error('预览表为空');
      }
      passes = 1;
    } else {
      // 反复扫，直到「一整趟下来零改动」（最多 6 趟，防页面异常时死循环）
      for (; passes < 6; passes++) {
        const wrote = await sweepRows();
        count += wrote;
        if (wrote === 0) break;
      }
    }

    if (!count && !covered.size && !dlg.querySelector('.jx-pro-virtual-table__row textarea')) {
      throw new Error('未取到任何标题行');
    }

    /*
     * 见 步骤.md §二 C（断言与复核）：**覆盖断言** —— 别再把「本趟没有可写的行」当成「全都改完了」。
     * 2026-10-19 实测踩到过：勾 20 条跑完面板显示「成功 20/20」，
     * 但接口复核发现其中 1 条标题根本没改（带着原文参加了保存）。
     * 原因就是收敛判据只看「有没有可写行」，分辨不出「这一行还没渲染出来 / 编辑前是空的」。
     * 现在改成三角核对，任一条对不上就**不保存**、直接抛错，让问题显形：
     *   ① covered（读到原文并已处理的位置数）必须 == expected（预览区 `已选 N / M条` 的 M）
     *   ② emptyOrig（有行但「编辑前」为空）必须为 0
     *   ③ stillWrong（复核后内容仍不等于目标）必须为 0
     */
    if (canScroll) await verifySweep();
    else verifyRendered();

    scroller && (scroller.scrollTop = 0);   // 收起时回到顶部，别让用户眼前停在中段
    await sleep(200);

    const got = covered.size;
    const wrong = stillWrong.size;
    const blank = emptyOrig.size;
    const unsel = unchecked.size;
    log('标题已改写', count, '行 · 扫描', passes + 1, '趟 · 覆盖', got, '/', expected || '?',
        '· 残留', wrong, '· 空原文', blank, '· 未勾选', unsel);

    if (blank > 0) {
      throw new Error(
        '有 ' + blank + ' 行的「编辑前」标题是空的，已中止保存（避免带着原文落库）'
      );
    }
    if (unsel > 0) {
      throw new Error(
        '有 ' + unsel + ' 行预览没勾选（左上角写着「不勾选则不保存」），保存会漏掉它们，已中止'
      );
    }
    if (wrong > 0) {
      throw new Error(
        '复核发现 ' + wrong + ' 行标题没改成本步要求的内容，已中止保存'
      );
    }
    if (expected > 0 && got < expected) {
      throw new Error(
        '只覆盖到 ' + got + '/' + expected + ' 行（虚拟滚动没扫全），已中止保存，请重跑本步'
      );
    }
    if (expected === 0) {
      warn('读不到预览总条数，无法做覆盖断言（已写入 ' + count + ' 行，覆盖 ' + got + ' 行）');
    }

    // 落库复核：按「编辑前原文」算出的期望值逐条比对接口里的 title。
    // 这里必须把 buildTitle 传下去 —— 只有这样复核才知道「应该是什么」，
    // 而不是只知道「变没变」（实测有 34 条本来就已是目标值）。
    return attachVerify(
      await clickSave(dlg),
      await safeVerify('title', { dlg, buildTitle }),
      '标题'
    );
  }

  /**
   * 7. 尺码表
   * 实测（2026-10-18）：模板下拉带固定类名 `.size-template-select`，
   * 比原来「取最后一个 placeholder=请选择 的输入框」稳得多
   * （那个写法依赖「弹窗里只有分页 + 模板两个 select」这个偶然事实）。
   * 见 步骤.md §二 E（接口与数据）：该下拉的选中值同样不在 input.value，必须读 `.jx-select__placeholder`。
   * 见 步骤.md §二 A（交互定位）：下拉里可能只有「暂未创建模板，请创建模板后再引用」这类提示 li，不能当成模板名。
   */
  async function stepSizeChart() {
    const dlg = await openBatchEdit('尺码表');

    const selectEl = dlg.querySelector('.size-template-select') ||
      dlg.querySelector('.el-select.jx-pro-select');
    if (!selectEl) throw new Error('未找到尺码表模板选择框');

    // 设置里选中的尺码表模板直接生效（空＝跟随下拉第一个选项；没有开关，也不回落 CFG）
    const current = readSelectText(selectEl);
    const inp = selectEl.querySelector('input');
    await clickEl(inp || selectEl, { wait: 900 });

    // 该下拉是「妙手模板 / 后台模板」双 Tab 面板，选项 li 与提示文案混在一起
    const opts = await waitFor(
      () => {
        const nodes = [...document.querySelectorAll(
          '.size-template-select-popper li.el-select-dropdown__item'
        )].filter(isVisible);
        return nodes.length ? nodes : null;
      },
      { desc: '尺码表模板下拉', timeout: 15000 }
    );
    const names = opts.map(textOf).filter((t) => t && !/暂未创建|请先创建|无数据/.test(t));
    if (!names.length) {
      throw new Error('尺码表模板下拉里没有可用模板（后台模板 Tab 为空？）');
    }
    rememberTemplates('sizeChart', names);

    const wanted = tplTarget('sizeChart') || names[0];

    if (current && current === wanted) {
      closeDropdown(dlg);   // 读选项时下拉是打开的，点「预览」前必须先收起
      await sleep(400);
      log('尺码表模板已是目标值，直接预览保存:', current);
    } else {
      const hit = opts.find((o) => textOf(o) === wanted);
      if (!hit) {
        closeDropdown(dlg);
        throw new Error(
          '尺码表模板里没有「' + wanted + '」，当前可选：' + names.join(' / ')
        );
      }
      await clickEl(hit, { wait: 1200 });
      log('尺码表模板已选:', wanted);
    }

    await clickPreview(dlg);
    // 落库复核：sizeCharts[].sizeTemplateId 必须等于「wanted」解析出的 id
    return attachVerify(
      await clickSave(dlg),
      await safeVerify('sizeChart', { dlg, sizeTemplateName: wanted }),
      '尺码表'
    );
  }

  /**
   * 找一个「子弹窗」：排除批量编辑主弹窗。
   * 见 步骤.md §二 A（交互定位）：原实现用 dialogByText('试穿尺码') 找模特信息子弹窗，但主弹窗的
   * 预览区「编辑前」列本身就含有「试穿尺码：M」（产品已设置过模特时），
   * dialogByText 按可见弹窗顺序返回**第一个**匹配 → 命中主弹窗 →
   * 在主弹窗里找不到 M/合适 radio，直接抛「未找到试穿尺码/感受选项」。
   */
  function subDialogByText(text) {
    return visibleDialogs().find(
      (d) => (d.innerText || '').includes(text) &&
        !(d.innerText || '').includes('批量编辑方式')
    ) || null;
  }

  /**
   * 读「模特信息」编辑表里成衣模特列当前显示的文本。
   * 见 步骤.md §二 A（交互定位）：原实现用 dlg.innerText 判断「已应用」，但这个文本除了编辑表单，
   * 还包含预览区「编辑前」列（历史状态）。商品早就设置过 Jack 时，
   * 即使本次表单是空的也会判成「已应用」而整步跳过，新选中且没设置的商品就被漏处理。
   * 正确依据是 `.goods-model-table` 的成衣模特单元格：未设置时它是「添加模特」按钮文本。
   */
  function readModelCellText(dlg) {
    const table = dlg.querySelector('.goods-model-table');
    if (!table) return '';
    const row = table.querySelector('.jx-pro-virtual-table__row');
    if (!row) return '';
    const cells = [...row.querySelectorAll('.jx-pro-virtual-table__row-cell')];
    // cells[0] = 店铺，cells[1] = 成衣模特
    return cells.length > 1 ? textOf(cells[1]) : '';
  }

  /** 8. 模特信息 → Jack / 试穿 M / 合适 */
  async function stepModelInfo() {
    const dlg = await openBatchEdit('模特信息');

    // 等编辑表渲染（该面板比其它面板慢）
    await waitFor(() => dlg.querySelector('.goods-model-table'), { desc: '模特信息编辑表' });
    const cellText = readModelCellText(dlg);
    const applied = !!cellText && cellText.includes(CFG.modelName);
    if (applied) {
      log('成衣模特已是 ' + CFG.modelName + '，直接预览保存');
      await clickPreview(dlg);
      return attachVerify(
        await clickSave(dlg),
        await safeVerify('model', { dlg }),
        '模特信息'
      );
    }

    // 「添加模特」在成衣模特 / 鞋类模特两列各有一个，取第一个（成衣模特）
    const addBtn = [...dlg.querySelectorAll('button')]
      .find((b) => isVisible(b) && textOf(b) === '添加模特');
    if (!addBtn) throw new Error('未找到「添加模特」按钮');
    await clickEl(addBtn, { wait: 1500 });

    const picker = await waitFor(() => subDialogByText('选择模特'), { desc: '选择模特弹窗' });
    const useBtn = await waitFor(
      () => [...picker.querySelectorAll('button')].find((b) => isVisible(b) && textOf(b) === '使用'),
      { desc: '使用按钮' }
    );
    await clickEl(useBtn, { wait: 1500 });

    // 试穿子弹窗：用「温馨提示」定位（该文案只出现在这个子弹窗里），
    // 不要再用「试穿尺码」——主弹窗预览区也含这段文字
    const infoDlg = await waitFor(
      () => subDialogByText('温馨提示') || subDialogByText('试穿感受'),
      { desc: '模特信息（试穿）弹窗' }
    );
    const radiosOf = (name) => [...infoDlg.querySelectorAll('.el-radio, .jx-radio')]
      .filter((r) => isVisible(r) && textOf(r) === name);

    const sizeRadio = radiosOf(CFG.tryOnSize)[0];
    if (!sizeRadio) {
      const all = [...infoDlg.querySelectorAll('.el-radio, .jx-radio')].map(textOf).join(' / ');
      throw new Error('试穿尺码里没有「' + CFG.tryOnSize + '」，可选：' + all);
    }
    const feelRadio = radiosOf(CFG.tryOnFeel)[0];
    if (!feelRadio) {
      const all = [...infoDlg.querySelectorAll('.el-radio, .jx-radio')].map(textOf).join(' / ');
      throw new Error('试穿感受里没有「' + CFG.tryOnFeel + '」，可选：' + all);
    }
    if (!sizeRadio.className.includes('is-checked')) await clickEl(sizeRadio, { wait: 400 });
    if (!feelRadio.className.includes('is-checked')) await clickEl(feelRadio, { wait: 400 });

    const saveBtn = [...infoDlg.querySelectorAll('button')].find((b) => textOf(b) === '保存');
    if (!saveBtn) throw new Error('未找到「保存」');
    await clickEl(saveBtn, { wait: 1800 });

    // 确认子弹窗已关、编辑表里出现模特名
    await waitFor(() => !subDialogByText('温馨提示'), { desc: '试穿弹窗关闭', timeout: 10000 })
      .catch((e) => { if (e instanceof StopError) throw e; });
    const after = readModelCellText(dlg);
    if (!after.includes(CFG.modelName)) {
      throw new Error('模特信息未写入编辑表（当前显示：' + (after || '空') + '）');
    }

    await clickPreview(dlg);
    // 落库复核：shopIdAndGoodsModelReqMap 里每个店铺都必须是 Jack / M / 合适(=1)
    return attachVerify(
      await clickSave(dlg),
      await safeVerify('model', { dlg }),
      '模特信息'
    );
  }

  /* ---------- 颜色图（第 9 步） ---------- */

  /**
   * 顶部「选择 ▾ → 选中全部」。
   * 见 步骤.md §二 E（接口与数据）：菜单 <ul> 被 teleport 到 body 末尾、position:fixed，offsetParent 为 null，
   * 必须用 isVisible 判断；且该菜单由 **click** 展开（hover 不展开）。
   */
  async function selectAllSkus(scope) {
    const findItem = () => {
      const menus = [...document.querySelectorAll('ul.el-dropdown-menu, ul.jx-dropdown-menu')].filter(isVisible);
      for (const ul of menus) {
        const hit = [...ul.querySelectorAll('li')].find((li) => textOf(li) === '选中全部' && isVisible(li));
        if (hit) return hit;
      }
      return null;
    };

    if (!findItem()) {
      const trigger = scope.querySelector('.sku-image-batch-editor__editor-title label.el-checkbox') ||
        scope.querySelector('.sku-image-batch-editor__editor-title .el-dropdown');
      if (!trigger) throw new Error('未找到颜色图「选择 ▾」控件');
      await clickEl(trigger, { wait: 900 });
      if (!findItem()) {
        trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await sleep(800);
      }
    }

    const item = await waitFor(findItem, { desc: '「选中全部」菜单项', timeout: 12000 });
    await clickEl(item, { wait: 3000 });
    return (scope.querySelector('.sku-image-batch-editor__editor-title')?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 打开（或复用）「图片填充」面板。面板已展开时不要再点按钮，否则会被切掉。 */
  async function ensureFillPanel(dlg) {
    const open = () => [...dlg.querySelectorAll('.extra-area__fillImage')].find(isVisible);
    const cur = open();
    if (cur) return cur;

    const btn = [...dlg.querySelectorAll('button')].find((b) => isVisible(b) && textOf(b) === '图片填充');
    if (!btn) throw new Error('未找到「图片填充」按钮');
    await clickEl(btn, { wait: 1200 });
    return await waitFor(open, { desc: '图片填充面板', timeout: 25000 });
  }

  /**
   * 颜色图面板里的颜色名输入框。
   * 注意：① 列表是虚拟滚动，只会渲染当前可见的几行；② placeholder 是「该规格当前色名」，
   * 也可能是空串（见 步骤.md §四 元素定位速查表的「颜色名输入框」）—— 所以**不能**要求 placeholder 非空，只排除已知的其它输入框。
   */
  function colorNameInputs(dlg) {
    return [...dlg.querySelectorAll('.pro-divider input.el-input__inner')]
      .filter((i) => !/^(请选择|是否标记|请输入颜色)/.test(i.placeholder || ''));
  }
  /**
   * 颜色图面板分页区的「N条」。
   *
   * ⚠ **语义是「勾选商品数」，不是「规格行数」**（见 步骤.md §二 C「那个覆盖数 warn 本身也没意义」）：
   * 勾 6 个商品 → 这里显示 `6条`；而列表里每一行是**一个规格**（颜色名输入框按规格排），
   * 当前可视区渲染 4 行、全表可能有十几行。两个数维度不同，**不能相互比较**。
   *
   * v1.13.1：分页器不一定嵌在 `__item-list` 里（实测它在 `.sku-image-batch-editor` 层），
   * 所以两级都查一遍。
   */
  function colorRowTotal(dlg) {
    const ed = dlg.querySelector('.sku-image-batch-editor') || dlg;
    const totalEl = ed.querySelector('.sku-image-batch-editor__item-list .el-pagination__total') ||
      ed.querySelector('.el-pagination__total');
    // 见 步骤.md §二 C（断言与复核）：这里原本是 `/(\\d+)\\s*条/` —— 正则**字面量**里的 `\\d` 表示
    // 「一个反斜杠 + 字母 d」，永远匹配不到数字，函数恒走 fallback（返回已渲染 view 数，实测 4）。
    // 这直接导致依赖它的那条覆盖数 warn 恒不成立、且错误弹窗里印出误导数字（「共 4 条，实际扫到 37 行」）。
    // 正则字面量里只能用单反斜杠。注意：`new RegExp('...\\d...')` 那种**字符串**写法里双反斜杠才是对的。
    const m = textOf(totalEl).match(/(\d+)\s*条/);
    if (m) return Number(m[1]);
    return ed.querySelectorAll('.vue-recycle-scroller__item-view').length;
  }
  /**
   * 颜色名统一改成「混合色」。
   *
   * 见 步骤.md §二 B（虚拟滚动与分页）—— 用户实测「没把所有商品改成混合色」：
   * 颜色图列表是 **虚拟滚动**（`RecycleScroller`）：只有落进可视区的那几行会真正渲染，
   * 其余行要么还没 DOM、要么被挪到 `translateY(-9999px)`。旧实现 `dlg.querySelectorAll(...)`
   * 只对「调用瞬间已渲染的那几行」动手，所以 6 个商品里往往只改到前 2–3 个就收工
   * （历史日志 `颜色已改为「混合色」: 2 / 4` 同一成因，当时误判成 placeholder 问题）。
   * 对策：**按可视区扫一遍 + 边扫边滚**，6–20 条已实测可全覆盖。
   *
   * 同一节的后半段（§二 B，严格审查发现）：**光滚还不够** —— 这个面板 **有分页**，
   * 默认 `pageSize = 20`。实测 25 个商品时 `displayDetailList` 有 25 条，
   * 但列表 `scrollHeight` 只覆盖当前页 20 条 → 第 21 条起**根本滚不到、永远不渲染**，
   * 而且「复核」也只看当前页，于是 `stillWrong = 0` → 不 warn → 面板报成功。
   * 实测：30 条商品跑完 `changed = 20 / stillWrong = 0`，索引 20–29 一个都没改。
   * 对策：**先翻遍所有分页，每页各扫一遍**；复核同样按「遍历所有页」的口径统计。
   */
  async function setAllColors(dlg, colorName) {
    // 同上（§二 B）：颜色图面板同样是 **el- 系分页器**，默认 20 条/页。
    // 先把条数拉满（500），让「逐页遍历」退化成单页直通；
    // 超过 500 条时仍会分页，下面的逐页逻辑继续兜底。
    /* 颜色图列表容器（也是唯一的滚动容器） */
    const edRoot = dlg.querySelector('.sku-image-batch-editor') || dlg;
    const sizeSet = await setPreviewPageSize(edRoot, '500条/页');
    if (sizeSet) log('颜色图每页条数:', sizeSet);
    await sleep(600);   // 条数变更会触发列表重渲染，等一拍再取输入框

    const scroller = edRoot.querySelector('.sku-image-batch-editor__item-list') ||
      [...edRoot.querySelectorAll('.vue-recycle-scroller')].find(isVisible) || null;
    const isTarget = (i) => (i.value || '').trim() === colorName;

    /** 把当前 DOM 里所有颜色名输入框改成目标色；返回本次实际改动数 */
    const fixRendered = () => {
      let n = 0;
      for (const inp of colorNameInputs(dlg)) {
        if (isTarget(inp)) continue;
        setNativeValue(inp, colorName, { keepFocus: true });
        n++;
      }
      return n;
    };

    if (!colorNameInputs(dlg).length) throw new Error('未找到颜色名输入框');

    /* ---------- 分页翻页（§二 B） ---------- */

    /** 该面板的分页器（页面用 jx-pro-pagination 包 el-pagination） */
    const pager = () =>
      dlg.querySelector('.sku-image-batch-editor .jx-pro-pagination .el-pagination') ||
      dlg.querySelector('.sku-image-batch-editor .el-pagination') || null;
    /** 分页总页数：优先读页码按钮最大号，读不到就按「N条 / 每页数」算 */
    const pageCount = () => {
      const p = pager();
      if (!p) return 1;
      const nums = [...p.querySelectorAll('.el-pager li.number, .el-pager li')]
        .map((li) => Number(textOf(li)))
        .filter((x) => Number.isFinite(x) && x > 0);
      if (nums.length) return Math.max(...nums);
      const m = textOf(p.querySelector('.el-pagination__total')).match(/(\d+)\s*条/);
      const per = Number((p.querySelector('.el-pagination__editor input, .el-input__inner') || {}).value) || 20;
      return m ? Math.max(1, Math.ceil(Number(m[1]) / per)) : 1;
    };
    /** 当前页码（1 起）：页码按钮里带 .active 的那个 */
    const currentPage = () => {
      const p = pager();
      const active = p && p.querySelector('.el-pager li.number.active, .el-pager li.active');
      return active ? Number(textOf(active)) || 1 : 1;
    };
    /** 跳到第 n 页；返回是否确实切过去了（防死等） */
    const goPage = async (n) => {
      const p = pager();
      if (!p) return false;
      if (currentPage() === n) return true;
      const li = [...p.querySelectorAll('.el-pager li.number, .el-pager li')]
        .find((x) => Number(textOf(x)) === n);
      if (!li) return false;
      const before = currentPage();
      await clickEl(li, { wait: 900 });
      // 等页码真的切过去（最多 ~5s），切不动就别耗着
      for (let i = 0; i < 25; i++) {
        if (currentPage() === n) return true;
        await sleep(200);
      }
      return currentPage() === n && currentPage() !== before;
    };

    /* ---------- 单页内边扫边滚 ---------- */
    const canScroll = () => scroller && scroller.scrollHeight > scroller.clientHeight + 4;
    const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const stepPx = () => Math.max(80, Math.round(scroller.clientHeight * 0.7));
    const maxSteps = () => Math.ceil(maxScroll() / stepPx()) + 2;

    /**
     * 在当前页从顶滚到底扫一趟，返回本趟改动数。
     * 防死等：若赋值 scrollTop 后位置没变（容器不可滚动 / 被别的滚动层接管），直接结束本趟。
     */
    const sweep = async () => {
      if (!canScroll()) {           // 本页内容没超出可视区 → 一次改完
        const n = fixRendered();
        await sleep(300);
        return n;
      }
      scroller.scrollTop = 0;
      await sleep(250);
      let fixed = 0;
      for (let guard = 0; guard <= maxSteps(); guard++) {
        fixed += fixRendered();
        await sleep(180);
        const cur = scroller.scrollTop;
        if (cur >= maxScroll() - 1) break;
        scroller.scrollTop = Math.min(maxScroll(), cur + stepPx());
        await sleep(240);
        if (Math.abs(scroller.scrollTop - cur) < 1) break;   // 滚不动了，别再空转
      }
      fixed += fixRendered();   // 到底后再补一遍
      await sleep(220);
      return fixed;
    };

    const pages = pageCount();
    let changed = 0;
    let passes = 0;

    // 逐页扫：每页反复扫到「一整趟零改动」（最多 4 趟/页，防页面异常时死循环）
    for (let pg = 1; pg <= pages; pg++) {
      if (!(await goPage(pg))) {
        warn('颜色图第 ' + pg + ' 页切不过去，跳过（共 ' + pages + ' 页）');
        continue;
      }
      for (let k = 0; k < 4; k++) {
        const fixed = await sweep();
        changed += fixed;
        passes++;
        if (fixed === 0) break;
      }
    }

    /* ---------- 复核：遍历所有页，按「商品行」统计，而不是按「输入框」 ---------- */
    /*
     * 见 步骤.md §二 B（虚拟滚动与分页）：老实现把待复核项收集成 **输入框 DOM 节点**（Set<input>）。
     * 但虚拟滚动会复用节点 —— 同一个 <input> 元素先后承载不同商品行，
     * 于是 wrongNodes.size 既可能少算（后一行改对了就把前一行的那条覆盖掉），
     * 也可能多算（同一行在不同滚动位置重复计入）—— 它压根不代表"有几个商品没改对"。
     *
     * 现在的行身份 = **页码 + 该行在内容中的绝对位置**（item-view 的 translateY）。
     * 实测：虚拟滚动的 item-view 是按"行在内容中的位置"摆放的，同一行的位移固定
     * （270px 一行），view 元素本身复用但位移跟着行走，所以「页码+位移」是行的稳定身份。
     * 比拿标题文本做键可靠：实测确实存在**标题完全相同的两个商品**，用文本会并成一行，
     * 导致覆盖数少算、覆盖断言假报警。
     */
    const rowKeyOf = (inp, pageNo) => {
      const view = inp.closest('.vue-recycle-scroller__item-view');
      if (view) {
        const tf = (view.style && view.style.transform) || '';
        if (tf && !tf.includes('-9999')) return 'p' + pageNo + ':' + tf;
      }
      // 退路：没有虚拟滚动（行全在 DOM 里）时，用「第几个输入框」即可
      const idx = colorNameInputs(dlg).indexOf(inp);
      return 'p' + pageNo + ':i' + (idx >= 0 ? idx : '?');
    };
    const wrongRows = new Set();
    const coveredRows = new Set();
    const scanPageForWrong = (pageNo) => {
      for (const inp of colorNameInputs(dlg)) {
        const k = rowKeyOf(inp, pageNo);
        if (!k) continue;
        coveredRows.add(k);
        if (!isTarget(inp)) wrongRows.add(k);
        else wrongRows.delete(k);          // 同一行后续被改对 → 撤销
      }
    };
    /*
     * 复核要多趟扫：实测单趟从顶滚到底会漏掉个别行（滚动过快时虚拟滚动来不及摆好某些行，
     * 50 行只认到 42 行）。所以「重复扫，直到这次没有新增覆盖行」最多 4 趟 ——
     * 这与第 6 步 sweepRows 的收敛思路一致，比「扫一趟就断言」稳。
     */
    for (let pg = 1; pg <= pages; pg++) {
      if (!(await goPage(pg))) continue;
      if (!canScroll()) { scanPageForWrong(pg); continue; }
      for (let round = 0; round < 4; round++) {
        const before = coveredRows.size;
        scroller.scrollTop = 0;
        await sleep(240);
        for (let guard = 0; guard <= maxSteps(); guard++) {
          scanPageForWrong(pg);
          const cur = scroller.scrollTop;
          if (cur >= maxScroll() - 1) break;
          scroller.scrollTop = Math.min(maxScroll(), cur + stepPx());
          await sleep(200);
          if (Math.abs(scroller.scrollTop - cur) < 1) break;
        }
        scanPageForWrong(pg);
        if (coveredRows.size === before) break;   // 这一趟没发现新行 → 收敛
      }
    }

    // 回到第 1 页顶部，别让用户眼前停在中段
    await goPage(1);
    if (scroller) { scroller.scrollTop = 0; await sleep(200); }

    return {
      // 同理（§二 C）：命名上就把语义钉死 —— 这是**勾选商品数**，不是规格行数。
      // 老名字 `total` 太含糊，下一个人一定会再拿它去跟 coveredRows 比。
      selectedItemCount: colorRowTotal(dlg),
      changed,
      stillWrong: wrongRows.size,
      coveredRows: coveredRows.size,
      passes,
      pages
    };
  }

  /** 9. 颜色图：选中全部 → 三次插入 → 混合色 */
  async function stepColorImages() {
    assertPageVisible('「颜色图」');
    const dlg = await openBatchEdit('颜色图');
    const editor = await waitFor(
      () => dlg.querySelector('.sku-image-batch-editor'),
      { desc: '颜色图面板', timeout: 25000 }
    );

    /*
     * 见 步骤.md §二 B（虚拟滚动与分页）：先把颜色图列表的每页条数拉满（默认 20 条/页 → 500），
     * 再执行「选中全部」。这样即使「选中全部」是按当前渲染/当前页生效的，
     * 也不会只选到第一页那 20 条。（setAllColors 里还会再设一次，已是目标值时直接跳过。）
     */
    const earlySize = await setPreviewPageSize(editor, '500条/页');
    if (earlySize) log('颜色图每页条数:', earlySize);
    await sleep(500);

    // 9.1 范围必须是「全部规格」，否则只会改到当前勾选的规格
    const range = await selectAllSkus(editor);
    log('选择范围:', range);

    // 9.2 逐张插入
    for (const img of CFG.colorImages) {
      await insertOneImage(dlg, img.pos, img.url);
      await sleep(1200);
    }

    // 9.3 颜色名 → 混合色（§二 B：虚拟滚动 + 分页 + 条数拉满）
    const res = await setAllColors(dlg, CFG.colorName);
    log(
      '颜色已改为「' + CFG.colorName + '」:',
      res.changed, '处改动 · 勾选商品', res.selectedItemCount, '个 ·',
      res.pages, '页 · 扫描', res.passes, '趟 · 覆盖规格行', res.coveredRows
    );
    /*
     * 见 步骤.md §二 C（断言与复核）：这里以前只 warn 就照样「保存修改」，等于把「改了一半」当成功落库。
     * 现在 **有行没改对就中止**（与第 6 步同一条取舍）：宁可显式失败、重跑一次。
     *
     * 见 步骤.md §二 C「那个覆盖数 warn 本身也没意义」：**删掉了「覆盖数 < 总数」那条 warn**，两个数维度不同、不可比：
     *   分页区 `N条` = **勾选商品数**（实测勾 6 个 → `6条`）
     *   coveredRows = **规格行数**（每个商品可能有多个颜色规格；实测同一时刻可视区 4 行、
     *                 全表十几行）
     * 拿它们比大小没有意义。老代码还因为正则写坏让 total 恒为 4，于是：
     *   ① 这条 warn 恒不成立（说了等于没说）；
     *   ② 万一别的断言失败，错误文案里会印出「共 4 条 / 1 页，实际扫到 37 行」这种误导数字。
     * 所以直接删掉，不再制造假信息。**真正的覆盖保障是下面 stillWrong === 0 这条硬中止**
     * —— 它按「规格行」逐行核对颜色名，比拿商品数比行数可靠得多。
     */
    if (res.stillWrong > 0) {
      throw new Error(
        '仍有 ' + res.stillWrong + ' 个颜色名没改成「' + CFG.colorName + '」' +
        '（勾选商品 ' + res.selectedItemCount + ' 个 / ' + res.pages + ' 页，已扫 ' +
        res.coveredRows + ' 个规格行），已中止保存'
      );
    }

    // 9.4 保存
    // 落库复核：saleAttributes[颜色].values[].name 必须全是「混合色」
    return attachVerify(
      await clickSave(dlg),
      await safeVerify('colorImages', { dlg }),
      '颜色图'
    );
  }

  /** 颜色图：单次插入。顺序严格为 radio → 序号 → 上传 → 应用 */
  async function insertOneImage(dlg, pos, url) {
    const panel = await ensureFillPanel(dlg);

    // 修改范围：确保「选中的规格」（配合顶部「选中全部」= 全部规格）
    const scopeRadio = [...panel.querySelectorAll('label.el-radio, .el-radio')]
      .find((r) => isVisible(r) && textOf(r).includes('选中的规格'));
    if (scopeRadio && !scopeRadio.className.includes('is-checked')) {
      await clickEl(scopeRadio, { wait: 700 });
    }

    // 添加方式：图片添加到第 N 张
    const addRow = await waitFor(
      () => [...panel.querySelectorAll('label.el-radio, .el-radio')]
        .find((r) => isVisible(r) && textOf(r).includes('图片添加到第')),
      { desc: '「图片添加到第 N 张」选项', timeout: 20000 }
    );
    if (!addRow.className.includes('is-checked')) await clickEl(addRow, { wait: 1000 });

    // 勾选「插入原图片列表」
    const insChk = [...addRow.querySelectorAll('label.el-checkbox, .el-checkbox')]
      .find((c) => textOf(c).includes('插入原图片列表'));
    if (insChk && !insChk.className.includes('is-checked')) {
      await clickEl(insChk, { wait: 600 });
    }

    // 序号（未上传图片时 disabled，先移除属性再原生赋值）
    const numInput = addRow.querySelector('input.el-input__inner');
    if (!numInput) throw new Error('未找到「图片添加到第 N 张」输入框');
    numInput.removeAttribute('disabled');
    numInput.removeAttribute('readonly');
    setNativeValue(numInput, String(pos));
    await sleep(400);
    if ((numInput.value || '').trim() !== String(pos)) warn('序号写入异常:', numInput.value);

    // 上传网络图片（入口在填充面板内，页面共有多个 .add-image-box，必须限定作用域）
    const addBox = panel.querySelector('.add-image-box') ||
      [...dlg.querySelectorAll('.add-image-box')].find(isVisible);
    if (!addBox) throw new Error('未找到「添加图片」入口');
    await clickEl(addBox, { wait: 900 });

    const netItem = await waitFor(
      () => {
        const boxes = [...document.querySelectorAll('.dropdown-btns-container')].filter(isVisible);
        for (const b of boxes) {
          const hit = [...b.querySelectorAll('.dropdown-btns-item, div, span')]
            .find((e) => e.children.length === 0 && textOf(e) === '使用网络图片');
          if (hit) return hit;
        }
        return null;
      },
      { desc: '「使用网络图片」菜单', timeout: 15000 }
    );
    await clickEl(netItem, { wait: 1500 });

    const urlDlg = await waitFor(() => dialogByText('使用网络图片'), { desc: '网络图片弹窗' });
    const ta = urlDlg.querySelector('textarea');
    if (!ta) throw new Error('未找到图片链接输入框');
    setNativeValue(ta, url);
    await sleep(400);
    const ok = [...urlDlg.querySelectorAll('button')].find((b) => textOf(b) === '确定');
    if (!ok) throw new Error('未找到「确定」');
    await clickEl(ok, { wait: 5000 });

    // 应用（操作栏底部唯一的「应用」）
    const apply = await waitFor(
      () => [...dlg.querySelectorAll('button')].find((b) => isVisible(b) && textOf(b) === '应用'),
      { desc: '「应用」按钮', timeout: 20000 }
    );
    assertUnpublishedOnly('颜色图 · 图片填充应用');   // 写入口第二道闸（见文件头红线 2）
    await clickEl(apply, { wait: 6000 });
    log('已插入第', pos, '张:', url);
  }

  /* ============ 导航：首页 → 产品 → TEMU全托管 → 采集箱 ============ */

  /** 当前是否已在采集箱页 */
  const isCollectPage = () => /\/pddkj\/collect_box\//.test(location.pathname);

  /** 用真实鼠标事件触发 Vue 浮层（页面用 mouseenter 打开二级菜单） */
  function hoverEl(el) {
    ['mouseenter', 'mouseover', 'mousemove'].forEach((t) =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
    );
  }

  /** 「产品」菜单里 TEMU全托管 那一行：该行只有平台 logo 无文字，靠采集箱链接反查 */
  function findPddkjPlatformRow() {
    return (
      [...document.querySelectorAll('.platform-list-content .popover-menu-product-content')]
        .find((c) => c.querySelector('.J_navBarPddkjCollectBoxItems')) || null
    );
  }

  /** 0. 首页 → 产品 → TEMU全托管 → 采集箱（SPA 内部跳转，不整页刷新） */
  async function stepGotoCollectBox() {
    if (isCollectPage()) return '已在采集箱页';
    try {
      // 1) 悬停顶部「产品」
      const navGoods = await waitFor(
        () => document.querySelector('.nav-item-goods .nav-item-text'),
        { desc: '顶部「产品」导航' }
      );
      hoverEl(navGoods);
      await sleep(600);

      // 2) 悬停 TEMU全托管 平台行
      const row = await waitFor(findPddkjPlatformRow, { desc: '产品菜单渲染' });
      const logo = row.querySelector('.platform-logo') || row.querySelector('.popover-slide-menu');
      hoverEl(logo || row);
      await sleep(800);

      // 3) 点「采集箱」
      const link = await waitFor(
        () => {
          const span = document.querySelector('.J_navBarPddkjCollectBoxItems');
          const a = span && span.closest('a.link-item');
          return a && a.getClientRects().length > 0 ? a : null;
        },
        { desc: '「采集箱」菜单项' }
      );
      await clickEl(link, { wait: 1500 });

      // 4) 等路由切换 + 列表首屏渲染
      await waitFor(isCollectPage, { timeout: 20000, interval: 300, desc: '进入采集箱页' });
      await sleep(2500);
      return '已进入采集箱页';
    } catch (e) {
      // 「停止编辑」不是导航失败：原样抛出，否则会被这里吞掉并触发整页跳转
      if (e instanceof StopError) throw e;
      // 兜底：菜单结构变了就走直达链接（会整页刷新）
      warn('菜单导航失败，改用直达链接:', e.message || e);
      location.href = '/pddkj/collect_box/items';
      return '已通过直达链接跳转';
    }
  }

  /* ============================ UI ============================ */

  const STEPS = [
    { id: 'nav', name: '进入采集箱', hint: '产品 → TEMU全托管 → 采集箱', fn: stepGotoCollectBox },
    { id: 'filter', name: '切到未发布', hint: '非「未发布」则自动切换', fn: stepEnsureUnpublished },
    { id: 'selectAll', name: '分页 500 + 全选', hint: '勾选本次要处理的产品', fn: stepSelectAll },
    { id: 'productTpl', name: '产品模板', hint: '引用模板 · 应用至选中', fn: stepProductTemplate },
    { id: 'skuTpl', name: 'SKU 模板', hint: '直接以模板内容覆盖', fn: stepSkuTemplate },
    { id: 'enTitle', name: '英语标题', hint: '改为一个空格', fn: stepEnglishTitle },
    { id: 'title', name: '标题', hint: '删词 + 唯一前缀', fn: stepTitle },
    { id: 'sizeChart', name: '尺码表', hint: '应用尺码表模板', fn: stepSizeChart },
    { id: 'model', name: '模特信息', hint: 'Jack / 试穿 M / 合适', fn: stepModelInfo },
    { id: 'colorImages', name: '颜色图', hint: '第 3/4/5 张 + 混合色', fn: stepColorImages }
  ];

  /** 跨面板重建保留的运行期 UI 状态（位置 / 折叠 / 视图另由 localStorage 持久化） */
  const uiState = {
    running: false,
    view: 'settings',        // 默认显示设置页；'run'＝执行页（步骤 + 一键编辑）
    mode: '',
    currentStep: null,
    steps: new Map()
  };

  /** 用户拖动后的面板左上角坐标（重建面板时还原，避免跳回默认右上角） */
  let dragPos = null;

  /**
   * 面板外观状态持久化（**刷新页面后也要保持**）。
   *
   * 存三样：位置 `pos`、折叠 `collapsed`、视图 `view`。
   * - `pos` 用**左上角坐标**（left/top），不用 right —— 面板 CSS 默认是 `right:16px`，
   *   一旦用户拖过就得改成 left 定位，只存 right 会在窗口宽度变化时漂移。
   * - 位置在**拖动结束（mouseup）时**才落盘，不在 mousemove 里写：拖动每帧写 localStorage
   *   是同步 IO，会明显拖慢拖动。折叠/切视图是低频动作，直接写。
   * - 读回时按当前视口夹一下（窗口变小后重建，面板不该跑到屏幕外找不回来）。
   */
  const UI_STORE_KEY = 'msxb-ui-v1';

  /** 页面加载时读一次的持久化外观状态（位置 / 折叠）；运行期由 saveUiState 回写 */
  const persistedUi = loadUiState() || {};
  /** 视图也沿用上次的选择（这里只读，不写回；写回只发生在 toggleView） */
  if (persistedUi.view) uiState.view = persistedUi.view;

  function loadUiState() {
    try {
      const raw = localStorage.getItem(UI_STORE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      const out = {};
      const p = o.pos;
      if (p && Number.isFinite(Number(p.left)) && Number.isFinite(Number(p.top))) {
        out.pos = { left: Number(p.left), top: Number(p.top) };
      }
      if (typeof o.collapsed === 'boolean') out.collapsed = o.collapsed;
      if (o.view === 'settings' || o.view === 'run') out.view = o.view;
      return out;
    } catch (_) { return null; }
  }

  function saveUiState(patch) {
    try {
      // 以**内存副本**为准回写，而不是每次重新读盘：
      // 拖动结束只写 pos、折叠只写 collapsed，分开写的时候读盘再合并也没问题，
      // 但如果同一帧内两次写（例如切视图时顺手展开），读盘合并会读到刚写的旧值。
      Object.assign(persistedUi, patch);
      const out = {};
      if (persistedUi.pos) out.pos = persistedUi.pos;
      if (typeof persistedUi.collapsed === 'boolean') out.collapsed = persistedUi.collapsed;
      if (persistedUi.view === 'settings' || persistedUi.view === 'run') out.view = persistedUi.view;
      localStorage.setItem(UI_STORE_KEY, JSON.stringify(out));
      return true;
    } catch (e) {
      warn('保存面板状态失败:', e.message || e);
      return false;
    }
  }
  /** 面板当前是否折叠（DOM 为准；DOM 不在时回落到持久化值） */
  function isPanelCollapsed() {
    if (refs.panel) return refs.panel.classList.contains('is-collapsed');
    return !!persistedUi.collapsed;
  }

  /** 展开/折叠面板，并同步持久化（主按钮/齿轮/折叠按钮都走这里，别再各自 toggle） */
  function setCollapsed(collapsed) {
    const on = !!collapsed;
    if (refs.panel) refs.panel.classList.toggle('is-collapsed', on);
    if (refs.fold) {
      refs.fold.textContent = on ? '+' : '−';
      refs.fold.classList.toggle('is-open', on);
      refs.fold.title = on ? '展开面板' : '折叠面板';
    }
    if (on) closeSelectMenu();     // 面板收起了，浮层不该还留在屏幕上
    persistedUi.collapsed = on;    // 同步内存副本（重建时读它来还原本体）
    saveUiState({ collapsed: on });
  }

  /**
   * 「停止编辑」按钮里的计时。
   *
   * 需求：**开始执行时在按钮内计时显示花费的秒数**。
   * 实现：`uiState.startedAt` 是权威起点，`tickTimer` 每 250ms 只改按钮里的
   * `.main-btn-time` 文本节点 —— 不去调 `render()`（那会重排 10 个步骤行，白费）。
   * 停止/结束/异常时都要 `stopTimer()`，否则重建面板后旧 interval 会继续改已脱离文档的节点。
   */
  let tickTimer = 0;

  function fmtElapsed(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? m + ':' + String(s).padStart(2, '0') : s + 's';
  }

  function paintTimer() {
    if (!refs.mainBtn) return;
    const node = refs.mainBtn.querySelector('.main-btn-time');
    if (!node) return;
    if (!uiState.running) { node.textContent = ''; return; }
    node.textContent = fmtElapsed(Date.now() - (uiState.startedAt || Date.now()));
  }

  function startTimer() {
    stopTimer();
    paintTimer();
    tickTimer = setInterval(paintTimer, 250);
  }

  function stopTimer() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
  }

  function stepState(id) {
    if (!uiState.steps.has(id)) uiState.steps.set(id, { status: 'idle', detail: '' });
    return uiState.steps.get(id);
  }

  /* 拖拽状态：监听只挂一次（见 步骤.md §二 D 面板生命周期），指向"当前这块面板" */
  let drag = null;
  let dragRef = null;
  let dragBound = false;

  let shadow = null;
  const refs = { rows: {} };

  const CSS = `
    /* ============================================================================
       视觉系统（Apple HIG 取向）—— 纯中性底 + 系统蓝强调
       · **面板主体回到中性白/灰阶**：设置抽屉、词标签、徽标一律不再铺彩色底
       · 彩色只出现在**点级**：悬停/选中的蓝块、主按钮、状态色
       · 强调色＝iOS 系统蓝 #0A84FF（深色文字用 #0B6BCB 保证对比度）
       · 圆角五级 16 / 12 / 10 / 8 / 6；投影三级 --sh-1..3；曲线一条 --ease
       · 主按钮＝浅蓝底 + 蓝字（运行中＝浅红底 + 深红字），无边框、不发光
       · .panel.is-collapsed 必须有对应规则：JS 一直在 toggle 这个类，
         没有规则时点「−」只有符号变、面板收不起来
       ============================================================================ */
    :host { all: initial; }
    :host, .panel {
      /* 文字三级 */
      --ink: #1C1C1E;
      --ink-2: rgba(60, 60, 67, 0.60);
      --ink-3: rgba(60, 60, 67, 0.38);
      /* 分隔线两级 */
      --line: rgba(60, 60, 67, 0.14);
      --line-soft: rgba(60, 60, 67, 0.08);
      /* 中性底：面板内的"浅灰"只作填充分层，不作高亮 */
      --fill-1: rgba(120, 120, 128, 0.06);   /* 输入框/标签的极浅底 */
      --fill-2: rgba(120, 120, 128, 0.10);   /* 悬停 */
      --fill-3: rgba(120, 120, 128, 0.16);   /* 按压 */
      --hover: rgba(120, 120, 128, 0.12);    /* 图标按钮悬停 */
      /* 强调色：系统蓝 */
      --accent: #0A84FF;
      --accent-deep: #0B6BCB;
      --accent-tint: rgba(10, 132, 255, 0.12);   /* 选中/悬停的蓝块 */
      --accent-tint-strong: rgba(10, 132, 255, 0.20);
      --accent-line: rgba(10, 132, 255, 0.32);
      --r-lg: 16px; --r-md: 12px; --r-sm: 10px; --r-xs: 8px; --r-2xs: 6px;
      --sh-1: 0 1px 2px rgba(16, 24, 40, 0.06);
      --sh-2: 0 2px 6px rgba(16, 24, 40, 0.09);
      --sh-3: 0 12px 30px rgba(16, 24, 40, 0.14), 0 0 0 0.5px rgba(16, 24, 40, 0.06);
      --ease: cubic-bezier(0.32, 0.72, 0, 1);
      --t-fast: 0.16s;
      --t-base: 0.22s;
    }
    .panel, .panel *, .menu-layer, .menu-layer * {
      box-sizing: border-box;
      /* 中文环境优先：拉丁走 Segoe UI Variable / Segoe UI，中文回落 鸿蒙 / MiSans / 苹方 / 雅黑 UI */
      font-family: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont,
        "HarmonyOS Sans SC", "MiSans", "PingFang SC", "Hiragino Sans GB",
        "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue",
        system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      font-variant-numeric: tabular-nums;
      line-height: 1.35;
    }
    .panel {
      position: fixed;
      top: 84px;
      right: 16px;
      width: 252px;
      z-index: 2147483000;
      border-radius: var(--r-lg);
      background: rgba(255, 255, 255, 0.86);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      backdrop-filter: blur(24px) saturate(180%);
      box-shadow: var(--sh-3);
      color: var(--ink);
      overflow: hidden;
      animation: msxb-in 0.28s var(--ease);
      user-select: none;
    }
    @keyframes msxb-in {
      from { opacity: 0; transform: translateY(-6px) scale(0.985); }
      to { opacity: 1; transform: none; }
    }
    /* 见 步骤.md §二 D（面板生命周期）：面板被页面冲掉后自愈重建时，若每次都播 msxb-in，
       用户看到的就是"切页闪一下"。首次挂载才播入场动画；重建走 .no-anim 直接出成品。 */
    .panel.no-anim { animation: none; }

    /* ---------- 头：单行承载标题 / 红线标记 / 更新标记 / 状态 ---------- */
    .head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 8px 7px 10px;
      cursor: move;
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #2FC46E;
      flex: none;
    }
    .panel.is-busy .dot { background: var(--accent); animation: msxb-pulse 1.3s ease-in-out infinite; }
    .panel.is-fail .dot { background: #E5302A; }
    @keyframes msxb-pulse {
      0%, 100% { opacity: 0.35; }
      50% { opacity: 1; }
    }
    .title {
      font-size: 12px;
      font-weight: 650;
      letter-spacing: -0.1px;
      flex: none;
    }
    .pill {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: -0.1px;
      color: #A34A00;
      background: rgba(255, 149, 0, 0.16);
      border-radius: var(--r-2xs);
      padding: 1px 5px;
      flex: none;
    }
    /* 「更新」标记：紧贴「不发布」右侧，浅红底 + 红字，可点开 GreasyFork */
    .upd {
      flex: none;
      border: none;
      padding: 1px 5px;
      border-radius: var(--r-2xs);
      background: rgba(255, 59, 48, 0.14);
      color: #D70015;
      font-family: inherit;
      font-size: 9.5px;
      font-weight: 650;
      letter-spacing: -0.1px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      transition: background-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
      animation: msxb-upd-in 0.4s var(--ease);
    }
    .upd:hover { background: rgba(255, 59, 48, 0.24); }
    .upd:active { transform: scale(0.94); }
    .upd[hidden] { display: none; }
    @keyframes msxb-upd-in {
      from { opacity: 0; transform: scale(0.8); }
      to { opacity: 1; transform: none; }
    }
    .status {
      margin-left: auto;
      font-size: 10px;
      font-weight: 500;
      color: var(--ink-3);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status.is-running { color: var(--accent); }
    .status.is-ok { color: #1C8C4A; }
    .status.is-fail { color: #D70015; }
    .status.is-stopped { color: #A34A00; }
    /* 头部的两个图标按钮（齿轮 / 折叠）：**无底衬的纯图标**。
       旧版给它们套了实心圆底，折叠按钮看着就是个灰圆点。现在默认完全透明、
       只用中性灰图标；悬停才浮出一层极淡的中性底，激活态用系统蓝。两钮同源同观感。 */
    .gear,
    .fold {
      width: 18px; height: 18px; flex: none;
      border: none;
      border-radius: 6px;
      padding: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; line-height: 1;
      font-family: inherit;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      background: transparent;
      color: var(--ink-2);
      box-shadow: none;
      transition: background-color var(--t-fast) var(--ease),
        color var(--t-fast) var(--ease),
        transform var(--t-base) var(--ease);
    }
    .gear:hover,
    .fold:hover {
      background-color: var(--hover);
      color: var(--ink);
      transform: none;
    }
    .gear:active { transform: rotate(60deg) scale(0.9); }
    .fold:active { transform: scale(0.9); }
    /* 齿轮展开设置页 / 面板折叠中：系统蓝（不加底色，只变色，避免又出现一块彩色） */
    .gear.is-open,
    .fold.is-open { background-color: transparent; color: var(--accent); }
    .gear.is-open:hover,
    .fold.is-open:hover { background-color: var(--accent-tint); color: var(--accent); }
    .row {
      display: flex;
      align-items: center;
      gap: 7px;
      width: 100%;
      height: 26px;
      padding: 0 9px;
      border: none;
      border-radius: var(--r-xs);      /* 方案 A：步骤行 8px（--r-xs） */
      background: transparent;
      text-align: left;
      cursor: pointer;
      position: relative;
      font-family: inherit;
      -webkit-tap-highlight-color: transparent;
      box-shadow: 0 0 0 rgba(0, 0, 0, 0);
      transition: background-color var(--t-fast) var(--ease),
        box-shadow var(--t-base) var(--ease),
        transform var(--t-fast) var(--ease);
    }
    /* 悬停/按压（v1.14.0）：**浅蓝底**（用户要求：执行步骤列表的选中/激活项背景
       从浅灰改为浅蓝）。'--accent-tint' = 12% 系统蓝，比原来的中性灰更有指向性，
       但仍是"浅"的，不会像 v1.10.0 那样铺满整片彩色。 */
    .row:hover {
      background-color: var(--accent-tint);
    }
    .row:active { background-color: var(--accent-tint-strong); }
    .row:not(:disabled):active { transform: translateY(0.5px) scale(0.99); }
    .row:disabled { cursor: default; }
    .row:disabled:hover { background-color: transparent; box-shadow: none; transform: none; }
    /* 进度线（同时充当分隔线）：容器必须有高度，否则 .bar-fill 的 height:100% 会算成 0 */
    .bar {
      height: 2px;
      background: var(--line-soft);
      overflow: hidden;
    }
    .bar-fill {
      height: 100%; width: 0%;
      background: var(--accent);
      transition: width 0.45s var(--ease);
    }
    .bar.is-busy .bar-fill {
      width: 35% !important;
      animation: msxb-slide 1.15s ease-in-out infinite;
    }
    @keyframes msxb-slide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(320%); }
    }


    /* 徽标：中性灰底 + 灰字（流水号不需要抢眼），只有状态变化时才上色 */
    .badge {
      width: 16px; height: 16px; flex: none;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 650;
      color: var(--ink-2);
      background: var(--fill-2);
    }
    .name {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 12px;
      font-weight: 550;
      letter-spacing: -0.1px;
      color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .detail {
      flex: none;
      max-width: 100px;
      font-size: 10px;
      font-weight: 500;
      color: var(--ink-3);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .detail:empty { display: none; }

    /* 方案 A（v1.13.0）：运行时行 = 10% 蓝底（原 12%）+ 实心蓝徽标；蓝底更浅一点，
       让「标题/明细」的蓝字对比更清楚，同时避免整行像一块彩色贴纸。 */
    .row.is-running { background: rgba(10, 132, 255, 0.10); }
    .row.is-running .badge { background: var(--accent); color: #fff; }
    .row.is-running .badge span {
      width: 8px; height: 8px;
      border-radius: 50%;
      border: 1.4px solid rgba(255, 255, 255, 0.45);
      border-top-color: #fff;
      animation: msxb-spin 0.7s linear infinite;
    }
    .row.is-running .name { color: var(--accent-deep); font-weight: 650; }
    .row.is-running .detail { color: rgba(10, 132, 255, 0.8); }
    @keyframes msxb-spin { to { transform: rotate(360deg); } }

    .row.is-done .badge { background: #2FC46E; color: #fff; }
    .row.is-done .name { color: var(--ink-2); }
    .row.is-done .detail { color: rgba(28, 140, 74, 0.9); }

    .row.is-error .badge { background: #E5302A; color: #fff; }
    .row.is-error .name { color: #D70015; font-weight: 650; }
    .row.is-error .detail { color: rgba(215, 0, 21, 0.85); }

    .row.is-stopped .badge { background: #F59300; color: #fff; }
    .row.is-stopped .name { color: #A34A00; font-weight: 650; }
    .row.is-stopped .detail { color: rgba(163, 74, 0, 0.9); }

    /* ---------- 底部 ---------- */
    .foot { padding: 6px 9px 9px; }
    /* 主按钮「一键编辑」：**浅蓝底 + 蓝字**（v1.14.0 按用户要求改回浅色）。
       用户原话：背景改为浅蓝色/浅红色，要看起来很舒服、很简约，并且去掉灰黑边框。
       —— 旧版是实色蓝/红渐变 + 白字（很重），且**从未写 'border: none'**，
       吃的是 <button> 的 UA 默认 '1.6px outset rgb(0,0,0)'，所以边缘一直有一圈黑边。
       现在：无边框 + 无外投影（只留极淡内高光），浅色底 + 同色系深字。
       运行中＝「停止编辑」浅红配方，同样无边框；按钮文字右侧是计时（.main-btn-time）。 */
    .main-btn {
      position: relative;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      width: 100%; height: 32px;
      padding: 0 12px;
      border: none;
      -webkit-appearance: none; appearance: none;
      border-radius: var(--r-sm);
      background-color: rgba(10, 132, 255, 0.13);
      background-image: none;
      color: #0B6BCB;
      font-size: 12px; font-weight: 650;
      letter-spacing: -0.1px;
      font-family: inherit;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      text-shadow: none;
      box-shadow: inset 0 0 0 1px rgba(10, 132, 255, 0.16);
      transition: background-color var(--t-fast) var(--ease),
        color var(--t-fast) var(--ease),
        box-shadow var(--t-base) var(--ease),
        transform var(--t-fast) var(--ease);
    }
    .main-btn:hover {
      background-color: rgba(10, 132, 255, 0.19);
      box-shadow: inset 0 0 0 1px rgba(10, 132, 255, 0.24);
      transform: translateY(-0.5px);
    }
    .main-btn:active {
      transform: translateY(0.5px) scale(0.99);
      background-color: rgba(10, 132, 255, 0.26);
      box-shadow: inset 0 1px 2px rgba(10, 111, 224, 0.16);
    }
    /* 按钮内文案与计时：计时用等宽数字 + 中性色，不跟主文案抢注意力 */
    .main-btn-label { flex: none; }
    .main-btn-time {
      flex: none;
      min-width: 0;
      font-size: 11px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: rgba(10, 132, 255, 0.85);
      letter-spacing: 0.1px;
    }
    .main-btn-time:empty { display: none; }
    /* 运行中主按钮＝「停止编辑」：浅红底 + 深红字（同样无边框、不发光） */
    .main-btn.is-stop {
      background-color: rgba(255, 59, 48, 0.12);
      background-image: none;
      color: #D70015;
      text-shadow: none;
      box-shadow: inset 0 0 0 1px rgba(255, 59, 48, 0.18);
    }
    .main-btn.is-stop:hover {
      background-color: rgba(255, 59, 48, 0.18);
      box-shadow: inset 0 0 0 1px rgba(255, 59, 48, 0.26);
      transform: translateY(-0.5px);
    }
    .main-btn.is-stop:active {
      transform: translateY(0.5px) scale(0.99);
      background-color: rgba(255, 59, 48, 0.24);
      box-shadow: inset 0 1px 2px rgba(215, 0, 21, 0.16);
    }
    .main-btn.is-stop .main-btn-time { color: rgba(215, 0, 21, 0.82); }
    /* 禁用态＝中性（此处灰色是「不可用」语义，不是高亮） */
    .main-btn:disabled,
    .main-btn.is-stop:disabled,        /* 特异性对齐：不让 .main-btn.is-stop:hover 压过禁用态 */
    .main-btn.is-stop:disabled:hover,
    .main-btn.is-stop:disabled:active {
      background-color: #F4F5F7;
      background-image: none;
      color: rgba(60, 60, 67, 0.38);
      text-shadow: none;
      box-shadow: inset 0 0 0 1px var(--line);
      transform: none;
      cursor: default;
    }
    .main-btn:disabled .main-btn-time { color: rgba(60, 60, 67, 0.38); }

    /* ---------- 设置面板（抽屉式，展开在步骤列表之上） ---------- */
    .settings {
      display: none;
      padding: 8px 9px 4px;
      border-top: 0.5px solid var(--line-soft);
      /* 抽屉底＝极淡中性灰，不再铺彩色（这就是"全绿一片"的主要来源） */
      background: var(--fill-1);
    }
    .settings.is-open { display: block; }
    .settings.is-locked { opacity: 0.55; pointer-events: none; }

    .set-field { margin-bottom: 7px; }
    .set-label {
      font-size: 10px; font-weight: 600;
      color: var(--ink-3);
      letter-spacing: 0.2px;
      margin-bottom: 3px;
    }
    /* ---------- 自绘下拉（Apple 风格：圆角触发器 + 毛玻璃浮层菜单） ---------- */
    /* 原生 select 的弹出层由系统绘制，样式无法干预，故整套替换为自绘 */
    .asel { position: relative; }
    /* 方案 A（v1.13.0）：补上 border-radius —— 旧版这条规则里**完全没有圆角**，
       所以三个下拉框一直是直角方框。同时清掉 v1.10.0 残留的偏青渐变（#F4FAFB），
       统一成纯白 + 发丝边；高度 24 → 28px，点击命中更稳。
       v1.14.0：**必须显式 'border: none' + 'appearance: none'** ——
       <button> 的 UA 默认边框是 '1.6px outset rgb(0,0,0)'，而旧规则只写了 box-shadow
       画「发丝边」，于是每一帧都是「一圈黑边 + 一圈灰线」两层描边叠在一起，
       下拉和主按钮都显得脏。 */
    .asel-trigger {
      display: flex; align-items: center; gap: 5px;
      width: 100%; height: 28px;
      padding: 0 8px 0 10px;
      border: none;
      -webkit-appearance: none; appearance: none;
      border-radius: var(--r-sm);
      background-color: #FFFFFF;
      background-image: linear-gradient(180deg, #FFFFFF, #FCFCFD);
      box-shadow: inset 0 0 0 0.5px var(--line), var(--sh-1);
      color: var(--ink);
      font-size: 11px; font-weight: 550;
      text-align: left;
      font-family: inherit;
      cursor: pointer;
      transition: background-image var(--t-fast) var(--ease),
        box-shadow var(--t-fast) var(--ease),
        transform 0.12s var(--ease);
    }
    .asel-trigger:hover {
      background-image: linear-gradient(180deg, #FFFFFF, #F7F7F9);
      box-shadow: inset 0 0 0 1px var(--line), var(--sh-2);
      transform: translateY(-0.5px);
    }
    .asel-trigger:active {
      transform: translateY(0.5px) scale(0.99);
      background-image: linear-gradient(180deg, #F5F5F7, #FBFBFC);
      box-shadow: inset 0 1.5px 3px rgba(60, 60, 67, 0.14);
    }
    .asel-trigger:focus-visible { outline: none; box-shadow: inset 0 0 0 1.5px var(--accent-line), var(--sh-1); }
    .asel-trigger:disabled {
      cursor: default;
      color: var(--ink-3);
      background-image: linear-gradient(180deg, #F7F8F9, #F1F2F4);
      box-shadow: inset 0 0 0 0.5px var(--line-soft);
      transform: none;
    }
    .asel-trigger:disabled:hover { transform: none; box-shadow: inset 0 0 0 0.5px var(--line-soft); }
    .asel-trigger:disabled:active { transform: none; }
    /* 展开态（v1.14.0 重做）：**只留一圈浅蓝高亮边框**。
       旧版是「1.5px 蓝内描边 + 3px 蓝光晕」叠在原来的 0.5px 灰发丝边上 ——
       灰线与蓝色光晕同时存在，加上 UA 的黑边，一共三层描边，很脏。
       现在：去掉光晕（不发光）+ 彻底替换掉灰边（不是叠在它上面），
       描边用浅蓝 '--accent-line'，视觉上就是"这个框现在被选中了"。 */
    .asel.is-open .asel-trigger,
    .asel.is-open .asel-trigger:hover {
      background-image: linear-gradient(180deg, #FFFFFF, #FCFCFD);
      box-shadow: inset 0 0 0 1.5px var(--accent-line);
      transform: none;
    }
    .asel-value {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .asel-chevron {
      flex: none;
      display: flex; align-items: center; justify-content: center;
      color: var(--ink-3);
      transition: transform 0.24s var(--ease), color var(--t-fast) var(--ease);
    }
    .asel-chevron svg { display: block; width: 9px; height: 6px; }
    .asel.is-open .asel-chevron { transform: rotate(180deg); color: var(--accent); }

    /* 浮层容器：固定在视口，不被 .panel 的 overflow: hidden 裁切 */
    .menu-layer {
      position: fixed; inset: 0;
      z-index: 2147483002;
      pointer-events: none;
    }
    .asel-menu {
      position: absolute;
      padding: 4px;
      max-height: 208px;
      overflow-y: auto;
      border-radius: var(--r-md);
      background: rgba(255, 255, 255, 0.9);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      backdrop-filter: blur(24px) saturate(180%);
      box-shadow: var(--sh-3);
      pointer-events: auto;
      transform-origin: top center;
      animation: msxb-menu-in 0.18s var(--ease);
      /* v1.14.0：**彻底隐藏滚动条**（用户要求）。仍然可以滚：
         滚轮 / 键盘 ↑↓ / 拖选都能滚，只是不画那条灰杠。 */
      scrollbar-width: none;            /* Firefox */
      -ms-overflow-style: none;         /* 老 Edge/IE */
    }
    .asel-menu::-webkit-scrollbar { width: 0; height: 0; display: none; }
    .asel-menu.is-up { transform-origin: bottom center; }
    @keyframes msxb-menu-in {
      from { opacity: 0; transform: scale(0.96) translateY(-4px); }
      to { opacity: 1; transform: none; }
    }
    .asel-item {
      display: flex; align-items: center; gap: 6px;
      min-height: 28px;
      padding: 0 7px 0 10px;
      border-radius: var(--r-xs);
      font-size: 11px;
      color: var(--ink);
      cursor: pointer;
      transition: background-color 0.14s ease, color 0.14s ease,
        box-shadow 0.14s ease, transform 0.14s var(--ease);
    }
    .asel-item-label {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 悬停 / 键盘高亮（v1.14.0）：**浅蓝底**（用户要求：下拉列表与执行步骤列表的
       选中/激活项背景从浅灰改为浅蓝）。用 --accent-tint（12% 系统蓝），
       文字保持深色，不额外描边 —— 只靠底色区分，干净。
       v1.13.0 曾一度改成中性浅灰，本次按用户要求回到浅蓝。 */
    .asel-item:hover,
    .asel-item.is-active {
      background: var(--accent-tint);
      color: var(--ink);
    }
    /* 已选项：浅蓝底 + 蓝字 + 蓝勾。选中与悬停同色系但层次不同：
       选中靠**蓝字 + 勾号**辨认，悬停靠底色，两者叠加也不会糊。 */
    .asel-item.is-selected {
      color: var(--accent-deep);
      font-weight: 600;
      background: rgba(10, 132, 255, 0.08);
      box-shadow: none;
    }
    /* 已选中项被悬停/键盘高亮：底色加深一档，仍是浅蓝，不再出现"双层蓝块" */
    .asel-item.is-selected:hover,
    .asel-item.is-selected.is-active {
      background: var(--accent-tint);
      color: var(--accent-deep);
    }
    .asel-check { flex: none; display: flex; align-items: center; color: var(--accent); opacity: 0; }
    .asel-check svg { display: block; width: 11px; height: 9px; }
    .asel-item.is-selected .asel-check { opacity: 1; }
    .asel-empty { padding: 5px 9px; font-size: 10.5px; color: var(--ink-3); }
    .set-textarea {
      width: 100%; height: 96px;
      border: none;
      border-radius: var(--r-xs);
      background: #FFFFFF;
      box-shadow: inset 0 0 0 0.5px var(--line);
      color: var(--ink);
      font-size: 10.5px; line-height: 1.5;
      font-family: inherit;
      padding: 5px 6px;
      resize: vertical;
      user-select: text;
    }
    .set-textarea:focus { outline: none; box-shadow: inset 0 0 0 1.5px var(--accent-line); }
    /* 设置区按钮：白底 + 中性发丝边。文字用中性深灰而不是彩色 ——
       设置区按钮是「工具」不是「主操作」，不该整排泛蓝。 */
    .set-btn {
      flex: 1 1 auto; height: 26px;
      border: none;
      border-radius: var(--r-xs);
      font-size: 10.5px; font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      background-image: linear-gradient(180deg, #FFFFFF, #FAFAFB);
      color: var(--ink);
      box-shadow: inset 0 0 0 0.5px var(--line), var(--sh-1);
      transition: background-image var(--t-base) var(--ease),
        color var(--t-base) var(--ease),
        box-shadow var(--t-base) var(--ease),
        transform var(--t-fast) var(--ease);
    }
    .set-btn:hover {
      background-image: linear-gradient(180deg, #FFFFFF, #F2F2F4);
      box-shadow: inset 0 0 0 0.5px var(--line), var(--sh-2);
      transform: translateY(-0.5px);
    }
    .set-btn:active {
      background-image: linear-gradient(180deg, #EFEFF1, #F7F7F8);
      box-shadow: inset 0 1.5px 3px rgba(60, 60, 67, 0.16);
      transform: translateY(0.5px) scale(0.98);
    }
    /* is-plain：只是「不撑满整行」，观感与默认一致（旧版是把默认规则整段复制粘贴） */
    .set-btn.is-plain { flex: 0 0 auto; padding: 0 8px; }
    /* 读取模板列表按钮：缺选项时强化成实心 */
    .set-read-tpl { width: 100%; margin-bottom: 7px; }
    .set-btn.is-hint {
      background-image: linear-gradient(180deg, #2E93FF, #0A6FE0);
      color: #fff;
      text-shadow: 0 0.5px 0 rgba(0, 0, 0, 0.12);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 4px 10px rgba(10, 111, 224, 0.24);
    }
    .set-btn.is-hint:hover {
      background-image: linear-gradient(180deg, #4BA3FF, #0C7BF0);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.26), 0 6px 14px rgba(10, 111, 224, 0.3);
      transform: translateY(-0.5px);
    }
    .set-btn.is-hint:active {
      background-image: linear-gradient(180deg, #1F84F5, #0A64C8);
      box-shadow: inset 0 2px 5px rgba(6, 70, 150, 0.32);
      transform: translateY(0.5px) scale(0.98);
    }
    /* 展开态（如「收起词库」）：中性灰底 + 深灰字（不再泛彩） */
    .set-btn.is-on {
      background-image: linear-gradient(180deg, #F0F0F2, #E8E8EB);
      color: var(--ink);
      box-shadow: inset 0 0 0 0.5px var(--line);
    }
    .set-btn.is-on:hover {
      background-image: linear-gradient(180deg, #EAEAEC, #E1E1E4);
      box-shadow: inset 0 0 0 0.5px var(--line), var(--sh-1);
    }
    .set-btn.is-on:active {
      box-shadow: inset 0 1.5px 3px rgba(60, 60, 67, 0.18);
      transform: translateY(0.5px) scale(0.98);
    }
    /* 禁用态必须写成 :disabled（不是 :disabled:hover），否则鼠标没悬停时
       仍会从 .set-btn 基础规则拿到立体高光与投影，看起来"还是能按" */
    .set-btn:disabled {
      cursor: default;
      color: var(--ink-3);
      background-image: linear-gradient(180deg, #F7F8F9, #F1F2F4);
      box-shadow: inset 0 0 0 0.5px var(--line-soft);
      text-shadow: none;
      transform: none;
    }
    .set-btn:disabled:hover, .set-btn:disabled:active {
      background-image: linear-gradient(180deg, #F7F8F9, #F1F2F4);
      box-shadow: inset 0 0 0 0.5px var(--line-soft);
      transform: none;
    }

    /* 词库：只读标签。**中性灰胶囊**（浅灰底 + 深灰字）—— 36 个词原本铺满一屏彩色，
       这是"全绿一片"最刺眼的一块；改成中性后整块安静下来，只在悬停时微微加深。
       滚动条默认隐藏：滚动中淡显（.is-scrolling），悬停/按住变深；首尾倒三角按钮已去掉 */
    .word-chips {
      display: flex; flex-wrap: wrap; gap: 3px;
      max-height: 118px; overflow-y: auto;
      padding: 5px 5px;
      border-radius: var(--r-xs);
      background: #FFFFFF;
      box-shadow: inset 0 0 0 0.5px var(--line);
      user-select: text;
      scrollbar-width: thin;                     /* Firefox */
      scrollbar-color: transparent transparent;
    }
    .word-chips.is-scrolling { scrollbar-color: rgba(60, 60, 67, 0.28) transparent; }
    .word-chips:hover { scrollbar-color: rgba(60, 60, 67, 0.36) transparent; }
    /* WebKit/Blink：细滚动条 + 去掉首尾箭头按钮 */
    .word-chips::-webkit-scrollbar { width: 10px; }
    .word-chips::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
    .word-chips::-webkit-scrollbar-track { background: transparent; }
    .word-chips::-webkit-scrollbar-thumb {
      background-color: transparent;
      border: 3px solid transparent;             /* 留白：滑块视觉宽 4px */
      border-radius: 5px;
      background-clip: content-box;
      transition: background-color 0.18s ease;
    }
    .word-chips.is-scrolling::-webkit-scrollbar-thumb { background-color: rgba(60, 60, 67, 0.18); }
    .word-chips:hover::-webkit-scrollbar-thumb { background-color: rgba(60, 60, 67, 0.32); }
    .word-chips:active::-webkit-scrollbar-thumb { background-color: rgba(60, 60, 67, 0.46); }
    .word-chip {
      max-width: 100%;
      padding: 1px 6px;
      border-radius: var(--r-2xs);
      background: var(--fill-2);
      color: var(--ink-2);
      font-size: 10px; font-weight: 500; line-height: 1.45;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      box-shadow: none;
      transition: background-color 0.18s ease, color 0.18s ease;
    }
    .word-chip:hover { background: var(--fill-3); color: var(--ink); }
    .word-empty {
      font-size: 10px; line-height: 1.5;
      color: var(--ink-3);
    }
    /* 词库展开区（默认收起）：标签区 / 输入框 / 立即更新 —— 三块各自独立成盒 */
    .set-words-body { margin-top: 5px; }
    .set-words-body.is-hidden { display: none; }
    /* 标签框与输入框之间留出明显间隔（原来只有 0 间距、两块白盒直接贴在一起，
       看起来像一个被切成两半的盒子）。8px 足够把那两个"盒子"分开。 */
    .set-import-ta { height: 64px; margin-top: 8px; margin-bottom: 6px; }
    /* 词库两个按钮都占满整行、文字居中（和「读取模板列表」一致） */
    .set-words-toggle { width: 100%; margin-bottom: 7px; text-align: center; }
    .set-apply-words { width: 100%; margin-bottom: 3px; text-align: center; }
    .set-words-toggle { width: 100%; margin-bottom: 7px; text-align: center; }
    .set-apply-words { width: 100%; margin-bottom: 3px; text-align: center; }

    /* 打开设置时隐藏步骤列表与主按钮 */
    .list.is-hidden, .foot.is-hidden { display: none; }
    /* 折叠：只留头部一行（JS 早已在切 .is-collapsed，v1.10.0 前没有任何规则，所以点了没反应） */
    .panel.is-collapsed .bar,
    .panel.is-collapsed .body { display: none; }

    /* ---------- 完成提示 ---------- */
    .toasts {
      position: fixed;
      top: 16px; left: 50%;
      transform: translateX(-50%);
      z-index: 2147483001;
      display: flex; flex-direction: column; gap: 6px;
      align-items: center;
      pointer-events: none;
      width: 268px;
    }
    .toast {
      display: flex; align-items: center; gap: 8px;
      width: 100%;
      padding: 8px 11px;
      border-radius: var(--r-md);
      background: rgba(255, 255, 255, 0.92);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      backdrop-filter: blur(20px) saturate(180%);
      box-shadow: var(--sh-3);
      animation: msxb-toast-in 0.32s var(--ease);
    }
    .toast.is-out { animation: msxb-toast-out 0.28s ease forwards; }
    @keyframes msxb-toast-in {
      from { opacity: 0; transform: translateY(-14px) scale(0.96); }
      to { opacity: 1; transform: none; }
    }
    @keyframes msxb-toast-out {
      to { opacity: 0; transform: translateY(-10px) scale(0.98); }
    }
    .toast-icon {
      width: 16px; height: 16px; flex: none;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 9.5px; font-weight: 700; color: #fff;
      background: #2FC46E;
    }
    .toast.is-err .toast-icon { background: #E5302A; }
    .toast-body { min-width: 0; flex: 1; }
    .toast-title {
      font-size: 11.5px; font-weight: 650;
      letter-spacing: -0.1px;
      color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .toast-sub {
      font-size: 10px; font-weight: 500;
      color: var(--ink-2);
      margin-top: 1px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ---------- 键盘聚焦：统一系统蓝描边 ---------- */
    .gear:focus-visible, .fold:focus-visible, .row:focus-visible, .upd:focus-visible,
    .main-btn:focus-visible, .set-btn:focus-visible, .asel-item:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--accent-line), 0 2px 6px rgba(10, 132, 255, 0.18);
    }
    /* 无障碍：系统开了「减弱动态效果」就不做位移/缩放/滑动，只留颜色与阴影的淡变。
       写法是 transition-duration 压到 0.01ms；绝不能用 transition: none —— 那会把颜色过渡一起干掉。
       入场/弹出动画关掉后，面板与下拉必须显式停在「已就位」状态，否则会卡在动画首帧。 */
    @media (prefers-reduced-motion: reduce) {
      .panel, .asel-menu, .asel-chevron, .bar-fill, .toast, .upd,
      .gear, .fold, .row, .main-btn, .set-btn, .asel-trigger, .asel-item, .word-chip {
        animation: none !important;
        transition-duration: 0.01ms !important;
      }
      .panel, .asel-menu { opacity: 1 !important; }
      .gear:hover, .gear:active, .fold:hover, .fold:active, .row:hover, .row:active,
      .main-btn:hover, .main-btn:active, .set-btn:hover, .set-btn:active, .upd:hover, .upd:active,
      .asel-trigger:hover, .asel-trigger:active, .asel-item:hover, .word-chip:hover {
        transform: none !important;
      }
    }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function toast(ok, title, sub) {
    if (!refs.toasts) return;
    const t = el('div', 'toast' + (ok ? '' : ' is-err'));
    t.append(el('div', 'toast-icon', ok ? '✓' : '✕'));
    const body = el('div', 'toast-body');
    body.append(el('div', 'toast-title', title), el('div', 'toast-sub', sub || ''));
    t.appendChild(body);
    refs.toasts.appendChild(t);
    while (refs.toasts.children.length > 3) refs.toasts.firstElementChild.remove();
    setTimeout(() => {
      t.classList.add('is-out');
      setTimeout(() => t.remove(), 320);
    }, 2800);
  }

  /** 按 uiState 刷新面板视觉 */
  function render() {
    if (!shadow || !refs.panel) return;

    STEPS.forEach((s, i) => {
      const r = refs.rows[s.id];
      if (!r) return;
      const st = stepState(s.id);
      r.row.className = 'row is-' + st.status;
      if (st.status === 'running') {
        r.badge.textContent = '';
        r.badge.appendChild(el('span'));
      } else if (st.status === 'done') {
        r.badge.textContent = '✓';
      } else if (st.status === 'error') {
        r.badge.textContent = '✕';
      } else if (st.status === 'stopped') {
        r.badge.textContent = '■';
      } else {
        r.badge.textContent = String(i);
      }
      // 右侧小字只承载「结果」：空闲时不显示，保持单行干净（完整说明在 title 里）
      r.detail.textContent = st.detail || '';
      r.row.disabled = uiState.running;
    });

    const cur = uiState.currentStep
      ? STEPS.find((s) => s.id === uiState.currentStep)
      : null;

    refs.panel.classList.toggle('is-busy', !!cur);
    const done = STEPS.filter((s) => stepState(s.id).status === 'done').length;
    const failed = STEPS.find((s) => stepState(s.id).status === 'error');
    const stoppedStep = STEPS.find((s) => stepState(s.id).status === 'stopped');

    if (cur) {
      refs.status.textContent = cur.name;
      refs.status.className = 'status is-running';
      refs.bar.classList.add('is-busy');
      refs.barFill.style.width = '0%';
      refs.panel.classList.remove('is-fail');
    } else {
      refs.bar.classList.remove('is-busy');
      if (failed) {
        refs.status.textContent = '已中止';
        refs.status.className = 'status is-fail';
        refs.status.title = failed.name + '：' + failed.detail;
        refs.barFill.style.width = '0%';
        refs.panel.classList.add('is-fail');
      } else if (stoppedStep) {
        refs.status.textContent = '已停止';
        refs.status.className = 'status is-stopped';
        refs.status.title = stoppedStep.name + '：已停止';
        refs.barFill.style.width = (done / STEPS.length * 100) + '%';
        refs.panel.classList.remove('is-fail');
      } else if (done) {
        refs.status.textContent = done === STEPS.length
          ? `全部完成 ${done}/${STEPS.length}`
          : `完成 ${done}/${STEPS.length}`;
        refs.status.className = 'status is-ok';
        refs.status.title = refs.status.textContent;
        refs.barFill.style.width = (done / STEPS.length * 100) + '%';
        refs.panel.classList.remove('is-fail');
      } else {
        refs.status.textContent = '就绪';
        refs.status.className = 'status';
        refs.status.title = '';
        refs.barFill.style.width = '0%';
        refs.panel.classList.remove('is-fail');
      }
    }

    // 运行中主按钮＝「停止编辑」+ 已用时间（计时在按钮内部右侧，见 startTimer/paintTimer）
    refs.mainBtn.disabled = false;
    refs.mainBtn.classList.toggle('is-stop', uiState.running);
    const mainLabel = uiState.running ? '停止编辑' : '一键编辑';
    // 结构：<span class="main-btn-label">停止编辑</span><span class="main-btn-time">12s</span>
    // 只改文本，不重建节点（重建会打断 CSS transition，也会让计时节点引用失效）
    let label = refs.mainBtn.querySelector('.main-btn-label');
    let time = refs.mainBtn.querySelector('.main-btn-time');
    if (!label || !time) {
      refs.mainBtn.textContent = '';
      label = el('span', 'main-btn-label');
      time = el('span', 'main-btn-time');
      refs.mainBtn.append(label, time);
    }
    label.textContent = mainLabel;
    paintTimer();
    refs.mainBtn.title = uiState.running
      ? '停止当前编辑（当前步骤会被中断 · 不会发布产品）'
      : '一键编辑：依次执行全部 ' + STEPS.length + ' 步';
  }

  /**
   * 「停止编辑」：协作式取消。
   * 立刻打断所有挂起的等待（长 sleep / 轮询），当前步骤随即抛 StopError 退出。
   * 开跑后 350ms 内的停止请求直接忽略：主按钮为了能当停止键必须保持可点（旧版的
   * `disabled = running` 保护已去掉），双击「一键编辑」的第二下会立刻落在它身上。
   */
  function stopEditing() {
    if (!uiState.running) return;
    if (Date.now() - (uiState.startedAt || 0) < 350) return;
    stopRequested = true;
    [...pendingSleepAborts].forEach((fn) => { try { fn(); } catch (_) { /* ignore */ } });
    pendingSleepAborts.clear();
    toast(true, '已请求停止', '当前步骤会被中断 · 不会发布产品');
  }

  /**
   * 停止后的收尾：只关「总计」这类纯信息的结果弹窗（它会挡住整页）。
   * 保存类操作的结果弹窗是「点完之后才渲染」的（点击与弹窗之间隔着长等待），
   * 所以这里要**轮询一小段时间**，否则停止时弹窗还没出现就会被漏掉、留在页面上挡住后续操作。
   * 批量编辑弹窗**故意不关**：里面可能还有想手工核对/继续的内容，且此处绝不点保存/应用，更不发布。
   * 用户若立刻又开跑（uiState.running 变 true）则马上放手，避免误关新一轮的弹窗。
   */
  async function cleanupAfterStop() {
    try {
      for (let i = 0; i < 40; i++) {
        if (uiState.running) return;
        const dlg = visibleDialogs().find((d) => (d.innerText || '').includes('总计'));
        if (dlg) {
          const close = [...dlg.querySelectorAll('button')].find((b) => textOf(b) === '关闭');
          if (close) close.click();
          else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(400);
          return;
        }
        await sleep(250);
      }
    } catch (_) { /* 尽力而为 */ }
  }

  /** 依次执行步骤：单步传长度 1 的数组；运行中点主按钮＝停止编辑 */
  async function runSequence(steps) {
    if (uiState.running) return;
    closeSelectMenu();        // 开跑前收起可能展开的下拉浮层
    uiState.running = true;
    uiState.mode = steps.length > 1 ? 'all' : 'single';
    uiState.startedAt = Date.now();   // 「刚开跑就别停」的保护窗口用；同时也计时起点
    stopRequested = false;
    startTimer();                     // 按钮内开始显示已用秒数

    // 开跑前清掉上一次运行的失败/停止态（含单步失败后重试该步的场景）
    STEPS.forEach((x) => {
      const xs = stepState(x.id);
      if (xs.status === 'error' || xs.status === 'stopped') { xs.status = 'idle'; xs.detail = ''; }
    });

    let brokeEarly = false;           // 只有在步骤跑完之前跳出循环才算「被停止」
    for (const s of steps) {
      if (stopRequested) { brokeEarly = true; break; }   // 已请求停止：不再启动下一步

      const st = stepState(s.id);
      uiState.currentStep = s.id;
      st.status = 'running';
      st.detail = '';
      render();

      const t0 = Date.now();
      try {
        const r = await s.fn();
        const secs = Math.max(1, Math.round((Date.now() - t0) / 1000)) + 's';
        let ok = true;
        let detail = '';
        if (r && typeof r === 'object') {
          detail = `成功 ${r.success}/${r.total}`;
          ok = !r.fail;
          if (r.fail) detail += ` · 失败 ${r.fail}`;
          // 模板步骤带回实际选中的模板名，便于确认取到了哪个模板
          if (r.template) detail += ` · ${r.template}`;
        } else if (typeof r === 'string') {
          detail = r;
        }
        /*
         * 落库复核（v1.15.0）：`verifyFail` 表示「保存已成功、但接口里查到的结果不对」。
         * 这种情况**不能**把步骤判成 error —— 数据已经落库了，报失败会诱导用户重跑，
         * 而重跑会二次改写标题（前缀/删词都不是无损的）。所以：
         *   · 步骤仍记为 done（保存动作确实成功了）
         *   · 但状态行显式写出「复核未通过」，并用红色 toast，让人看见
         */
        if (r && r.verifyFail) {
          st.status = 'done';
          st.detail = '已保存 · ' + r.verifyFail + ' · ' + secs;
          uiState.currentStep = null;
          render();
          toast(false, s.name + ' 已保存但复核未通过', st.detail);
          log(s.name + ' 复核未通过', r.verifyFail, r.verify);
          continue;                    // 继续下一步：数据没坏，只是需要人工看一眼
        }
        st.status = ok ? 'done' : 'error';
        st.detail = (detail ? detail + ' · ' : '') + secs;
        uiState.currentStep = null;
        render();
        toast(ok, s.name + (ok ? ' 完成' : ' 有失败'), st.detail);
        log(s.name, ok ? '完成' : '有失败', r);
        if (!ok) {
          uiState.running = false;
          stopRequested = false;
          stopTimer();
          render();
          return;
        }
      } catch (e) {
        uiState.currentStep = null;
        uiState.running = false;
        stopRequested = false;
        stopTimer();
        if (e instanceof StopError) {
          // 用户点了「停止编辑」：不算失败，标成琥珀色「已停止」
          st.status = 'stopped';
          st.detail = '已停止';
          render();
          toast(true, s.name + ' 已停止', '当前步骤被中断');
          await cleanupAfterStop();
          return;
        }
        console.error('[妙手助手]', e);
        st.status = 'error';
        st.detail = (e && e.message ? e.message : String(e)).slice(0, 80);
        render();
        toast(false, s.name + ' 失败', st.detail);
        return;
      }
      // 步与步之间的间隙也可能收到停止请求：这里吞掉 StopError，交给循环开头统一收尾。
      // 见 步骤.md §二 B（虚拟滚动与分页）：这个间隔只是让面板有机会重绘；
      // 缩到 80ms，停止检测靠循环开头的 stopRequested，不依赖它
      await sleep(80).catch(() => {});
    }

    // 只有「真的提前跳出循环」才算被停止：最后一步跑完后的 80ms 等待里
    // 也可能收到停止请求，那不该把一次完整成功报成「已停止」。
    uiState.running = false;
    uiState.currentStep = null;
    stopRequested = false;
    stopTimer();
    render();
    if (brokeEarly) {
      toast(true, '已停止', '后续步骤不再执行');
      await cleanupAfterStop();
      return;
    }
    if (steps.length > 1) {
      toast(true, '全部完成', '全部 ' + STEPS.length + ' 步已执行 · 全程未发布产品');
    }
  }

  /* ---------- 自绘下拉：Apple 风格（圆角触发器 + 毛玻璃浮层菜单） ---------- */
  /*
   * 原生 <select> 的弹出列表由操作系统绘制，字体/圆角/高亮/毛玻璃全都无法用 CSS 控制，
   * 在面板里怎么看都像「别人的控件」。这里整套换成自绘下拉：
   *   触发器 = 圆角白底 + 值文本 + chevron（展开时旋转 180° 并变蓝）
   *   浮层   = 毛玻璃圆角菜单，选中项蓝字 + 勾，悬停浅蓝，键盘 ↑/↓ 可选
   * 浮层挂进 shadow 的 .menu-layer（position: fixed），因此不受 .panel overflow: hidden 影响。
   */
  const CHEVRON_SVG = '<svg viewBox="0 0 10 6" aria-hidden="true">' +
    '<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 12 10" aria-hidden="true">' +
    '<path d="M1 5.2l3.2 3.2L11 1.6" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** 当前展开的菜单（同一时刻只允许一个） */
  let openMenu = null;

  /** 收起当前展开的下拉浮层（面板重建 / 关设置 / 折叠 / 开跑前都要调） */
  function closeSelectMenu() {
    if (openMenu) openMenu.close();
  }

  /**
   * 造一个 Apple 风格下拉。onPick(name) 在用户真正选定某项后回调。
   * 对外 API：setOptions(list, { value, placeholder }) / setDisabled(bool) / close()
   */
  function createAppleSelect(onPick) {
    const wrap = el('div', 'asel');
    const trigger = el('button', 'asel-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const valueNode = el('span', 'asel-value', '');
    const chevron = el('span', 'asel-chevron');
    chevron.innerHTML = CHEVRON_SVG;
    trigger.append(valueNode, chevron);
    wrap.appendChild(trigger);

    let options = [];
    let value = '';
    let placeholder = '';
    let disabled = false;
    let menu = null;
    let items = [];
    let active = -1;

    function paint() {
      const text = value || options[0] || placeholder;
      valueNode.textContent = text;
      trigger.title = text;
      trigger.disabled = disabled;
    }

    /** 菜单位置：优先向下，下方不够且上方更宽裕时向上翻转，并夹在视口内 */
    function place() {
      if (!menu) return;
      const t = trigger.getBoundingClientRect();
      const width = Math.max(140, Math.round(t.width));
      const height = Math.min(menu.scrollHeight, 208);
      const below = window.innerHeight - t.bottom - 6;
      const up = t.top - 6;
      const flip = below < Math.min(height, 120) && up > below;
      menu.style.width = width + 'px';
      menu.style.left = Math.max(
        4, Math.min(window.innerWidth - width - 4, Math.round(t.left))
      ) + 'px';
      menu.style.top = (flip
        ? Math.max(4, Math.round(t.top - 3 - height))
        : Math.min(window.innerHeight - height - 4, Math.round(t.bottom + 3))) + 'px';
      menu.classList.toggle('is-up', flip);
    }

    /** 高亮第 i 项；scroll=true 时把高亮项滚进菜单可视区（只滚菜单自身） */
    function setActive(i, scroll) {
      active = i;
      items.forEach((n, k) => n.classList.toggle('is-active', k === i));
      const node = items[i];
      if (!node || !scroll || !menu) return;
      const top = node.offsetTop - menu.scrollTop;
      if (top < 0) menu.scrollTop += top - 4;
      else if (top + node.offsetHeight > menu.clientHeight) {
        menu.scrollTop += top + node.offsetHeight - menu.clientHeight + 4;
      }
    }

    function renderItems() {
      menu.textContent = '';
      items = [];
      if (!options.length) {
        menu.appendChild(el('div', 'asel-empty', placeholder || '暂无可选项'));
        return;
      }
      options.forEach((name, i) => {
        const item = el('div', 'asel-item' + (name === value ? ' is-selected' : ''));
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', name === value ? 'true' : 'false');
        item.title = name;
        const check = el('span', 'asel-check');
        check.innerHTML = CHECK_SVG;
        item.append(el('span', 'asel-item-label', name), check);
        item.addEventListener('mouseenter', () => setActive(i));
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          pick(i);
        });
        menu.appendChild(item);
        items.push(item);
      });
    }

    function pick(i) {
      const name = options[i];
      if (name == null || disabled) return;
      value = name;
      close();
      paint();
      onPick(name);
    }

    /** 点菜单和触发器以外的地方 = 收起（composedPath 才能穿透 shadow） */
    function onDocDown(e) {
      if (!menu) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(wrap) || path.includes(menu)) return;
      close();
    }

    function onKey(e) {
      if (!menu) return;
      // 只在事件确实来自本下拉时才接管按键。否则用户 Tab 到别的控件后，
      // Enter/Space/方向键会被这里吃掉（还会误改设置）—— 焦点已离开就收起浮层。
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(trigger) && !path.includes(menu)) { close(); return; }
      if (e.key === 'Tab') { close(); return; }   // Tab 正常移动焦点，浮层跟着收起
      const n = items.length;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        trigger.focus();
        return;
      }
      if (!n) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActive((active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n, true);
        return;
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        setActive(e.key === 'Home' ? 0 : n - 1, true);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (active >= 0) pick(active);
      }
    }

    function open() {
      if (disabled || menu || !refs.menuLayer) return;
      closeSelectMenu();                       // 只允许一个菜单展开
      menu = el('div', 'asel-menu');
      menu.setAttribute('role', 'listbox');
      renderItems();
      refs.menuLayer.appendChild(menu);
      place();
      setActive(Math.max(0, options.indexOf(value)), true);
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      openMenu = api;
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place, true);
    }

    function close() {
      if (openMenu === api) openMenu = null;
      if (!menu) return;
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place, true);
      menu.remove();
      menu = null;
      items = [];
      active = -1;
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (disabled) return;
      if (menu) close(); else open();
    });
    trigger.addEventListener('keydown', (e) => {
      if (disabled || menu) return;            // 已展开时交给菜单的全局键盘处理
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        open();
      }
    });

    const api = {
      wrap,
      setOptions(list, opts) {
        options = (list || []).slice();
        if (opts && 'value' in opts) value = opts.value || '';
        if (opts && opts.placeholder) placeholder = opts.placeholder;
        if (!options.includes(value)) value = options[0] || '';
        if (menu) { renderItems(); place(); }  // 菜单开着时同步刷新
        paint();
      },
      setDisabled(v) {
        disabled = !!v;
        if (disabled) close();
        paint();
      },
      close
    };
    paint();
    return api;
  }

  /* ---------- 设置抽屉（齿轮展开） ---------- */

  /**
   * 模板下拉：选项直接来自页面上的真实下拉列表（保持页面顺序），默认选中第一项。
   * 面板里显示的是**具体模板名**，不再是「第一个选项（默认）」这种含糊说法。
   */
  function buildTplField(kind, label) {
    const wrap = el('div', 'set-field');
    wrap.append(el('div', 'set-label', label));
    // 自绘下拉（Apple 风格浮层菜单），不再是浏览器原生 select 弹层
    const field = createAppleSelect((name) => {
      if (uiState.running) return;
      settings.tpl[kind] = name || '';
      saveSettings();
    });
    field.setOptions([], { placeholder: '未读取 · 点「读取模板列表」' });
    field.setDisabled(true);
    wrap.appendChild(field.wrap);
    return { wrap, sel: field };
  }

  /** 某类别是否已读到可用选项 */
  function tplHasOptions(kind) {
    return (settings.tplOptions[kind] || []).length > 0;
  }

  /**
   * 重绘三个模板下拉（选项来自 settings.tplOptions）。
   * 注意「显示 = 执行」：若用户之前选中的名字已经不在候选里（妙手后台改名 / 商品类目变了，
   * 换类目就会换尺码表候选），这里**顺手把选中值落到候选首项并落盘**，
   * 否则会出现「面板显示 A、第 3/4/7 步却按 B 去找 → 报『没有该模板』」的错位。
   */
  function renderSettingsOptions() {
    if (!refs.settings || !refs.tplSelects) return;
    let changed = false;
    TPL_KEYS.forEach(({ key }) => {
      const sel = refs.tplSelects[key];
      if (!sel) return;
      const opts = settings.tplOptions[key] || [];
      if (!opts.length) {
        sel.setOptions([], { placeholder: '未读取 · 点「读取模板列表」' });
        sel.setDisabled(true);
        return;
      }
      const keep = settings.tpl[key];
      const valid = !!keep && opts.includes(keep);
      if (keep && !valid) {
        settings.tpl[key] = opts[0];
        changed = true;
      }
      sel.setDisabled(false);
      sel.setOptions(opts, { value: valid ? keep : opts[0] });
    });
    if (changed) saveSettings();
    if (refs.setReadTpl) {
      const missing = TPL_KEYS.filter(({ key }) => !tplHasOptions(key)).map((x) => x.label);
      // 顺带把「前提」写进 tooltip：尺码表那份清单取决于所选商品的类目，
      // 只能在采集箱列表页读（选中集只存在于页面内存里，别处拿不到）
      const prereq = '｜尺码表模板需在采集箱列表页且已勾选商品（它按所选商品的类目取）';
      refs.setReadTpl.title = (missing.length
        ? '自动读取完整选项（优先直连接口，失败才开页面下拉；只读，不应用、不保存）：' + missing.join('、')
        : '重新读取三处模板的完整选项（优先直连接口，失败才开弹窗；只读，不应用、不保存）') + prereq;
      refs.setReadTpl.classList.toggle('is-hint', !!missing.length);
    }
  }

  /** 词库展示：只读标签，每词一个浅蓝底色 */
  function renderWordsChips() {
    const box = refs.setWordsChips;
    if (!box) return;
    box.textContent = '';
    const words = settings.deleteWords;
    if (!words.length) {
      box.appendChild(el('div', 'word-empty', '词库为空：第 6 步只加前缀，不删任何词'));
    } else {
      words.forEach((w) => {
        const c = el('span', 'word-chip', w);
        c.title = w;
        box.appendChild(c);
      });
    }
    if (refs.setWordsBtn) {
      const open = !!refs.setWordsBody && !refs.setWordsBody.classList.contains('is-hidden');
      refs.setWordsBtn.textContent = wordsBtnText(open);
    }
  }

  /** 词库按钮文案：「管理词库（N）」↔「收起词库（N）」，N 就是当前词条数 */
  function wordsBtnText(open) {
    return (open ? '收起词库' : '管理词库') + '（' + settings.deleteWords.length + '）';
  }

  /**
   * 词库展开区开/关：按钮文案在「管理词库（N） / 收起词库（N）」之间切换。
   * 展开时**不自动聚焦输入框**（避免抢走页面焦点、也别清空用户已输入的内容）。
   */
  function setWordsOpen(open) {
    if (!refs.setWordsBody) return;
    refs.setWordsBody.classList.toggle('is-hidden', !open);
    if (refs.setWordsBtn) {
      refs.setWordsBtn.textContent = wordsBtnText(open);
      refs.setWordsBtn.classList.toggle('is-on', !!open);
    }
  }

  /**
   * 更新词库：按中英文逗号解析 → 整体替换（词库本身不可直接编辑）。
   * v1.13.0 起**只在点「立即更新」时**才写词库 —— 输入框里打什么都不会自动落盘，
   * 想生效必须显式点按钮（避免边打字边被清词、也避免误触即改）。
   * 返回是否已生效。
   */
  function applyWordImport(text) {
    const words = parseWords(text);
    if (!words.length) {
      // 清空输入框 ≠ 清空词库：防止手滑把词库清空
      toast(false, '词库未更新', '没解析到词，请用中英文逗号分隔');
      return false;
    }
    const same = words.length === settings.deleteWords.length &&
      words.every((w, i) => w === settings.deleteWords[i]);
    if (same) {
      toast(true, '词库未变', words.length + ' 词 · 与当前词库一致');
      return true;
    }
    settings.deleteWords = words;
    saveSettings();
    renderWordsChips();
    toast(true, '词库已更新', words.length + ' 词 · 已整体替换');
    return true;
  }


  /* ---------- 直连接口读尺码表模板（v1.8.0）：省掉一次「批量编辑」弹窗 ----------
   * 链路：勾选行上的 collectboxdetailid → getCollectItemInfoList 换「类目 cid」→
   *       getCategorySizeTemplateList 拿「该类目的尺码表模板」。
   * 实测：同源 fetch + cookie 即可，页面那几个签名头（x-timestamp / x-app-zebra / X-Breadcrumb…）可以不带。
   * 任何一步不成立都抛错，调用方回落「开弹窗读下拉」。
   */
  const API_COLLECT_BOX = '/api/platform/pddkj/move/collect_box';

  /** 表单编码 POST（只读查询） */
  async function apiPost(path, fields) {
    const body = fields
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
      .join('&');
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json && json.result && json.result !== 'success') throw new Error('接口 result=' + json.result);
    return json;
  }

  /** 当前勾选的商品 id（采集箱列表行里带属性 collectboxdetailid） */
  function selectedDetailIds() {
    const ids = [];
    document.querySelectorAll('.pro-virtual-scroll__row.pro-virtual-table__row').forEach((row) => {
      const cb = row.querySelector('input[type=checkbox]');
      if (!cb || !cb.checked) return;
      const el = row.querySelector('[collectboxdetailid]');
      const id = el && el.getAttribute('collectboxdetailid');
      if (id) ids.push(id);
    });
    return ids;
  }

  /** 勾选商品 → 去重后的类目 cid 列表 */
  async function selectedCategoryIds() {
    const ids = selectedDetailIds();
    // 选中集只活在页面内存里（localStorage / 接口都拿不到），所以只能在采集箱列表页读勾选行
    if (!ids.length) throw new Error('没勾选商品');
    const json = await apiPost(
      API_COLLECT_BOX + '/getCollectItemInfoList',
      ids.map((id, i) => ['detailIds[' + i + ']', id])
    );
    const cids = [];
    (json.collectItemInfoList || []).forEach((x) => {
      const cid = x && x.cid ? String(x.cid) : '';
      if (cid && !cids.includes(cid)) cids.push(cid);
    });
    if (!cids.length) throw new Error('接口没返回类目 cid');
    return cids;
  }

  /** 直连读尺码表模板候选（按所选商品的类目；所选商品跨类目时取并集） */
  async function probeSizeChartOptionsByApi() {
    const cids = await selectedCategoryIds();
    const json = await apiPost(
      API_COLLECT_BOX + '/getCategorySizeTemplateList',
      cids.map((cid, i) => ['cids[' + i + ']', cid])
    );
    const names = [];
    (json.categorySizeTemplateList || []).forEach((g) => {
      (g.sizeTemplateList || []).forEach((s) => {
        const n = String((s && s.name) || '').trim();
        if (n && !names.includes(n)) names.push(n);
      });
    });
    if (!names.length) throw new Error('所选类目下没有尺码表模板');
    log('尺码表模板（直连接口）类目', cids.join('/'), '→', names.join(' / '));
    rememberTemplates('sizeChart', names, true);
    return names;
  }
  /** 【兜底】打开批量编辑面板读尺码表模板下拉（直连接口不成立时才走这里；只读，绝不保存） */
  async function probeSizeChartOptions() {
    const dlg = await openBatchEdit('尺码表');
    const selectEl = dlg.querySelector('.size-template-select') ||
      dlg.querySelector('.el-select.jx-pro-select');
    if (!selectEl) throw new Error('未找到尺码表模板选择框');

    const inp = selectEl.querySelector('input');
    await clickEl(inp || selectEl, { wait: 900 });
    const opts = await waitFor(
      () => {
        const nodes = [...document.querySelectorAll(
          '.size-template-select-popper li.el-select-dropdown__item'
        )].filter(isVisible);
        return nodes.length ? nodes : null;
      },
      { desc: '尺码表模板下拉', timeout: 15000 }
    );
    const names = opts.map(textOf).filter((t) => t && !/暂未创建|请先创建|无数据/.test(t));
    closeDropdown(dlg);
    await sleep(300);

    // 只关面板，绝不点保存
    const cancel = [...dlg.querySelectorAll('button')]
      .find((b) => isVisible(b) && /^(取消|关闭)$/.test(textOf(b)));
    if (cancel) await clickEl(cancel, { wait: 800 });
    else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(600);

    rememberTemplates('sizeChart', names, true);
    return names;
  }

  /**
   * 直连读「产品模板 / SKU 模板」候选（**两条独立链路**，不共用清单）。
   * GET item_template/getSiteTemplateMap?sites[]=PDDKJ → siteAndItemTemplateMap.PDDKJ[{ itemTemplateId, name, cid }]
   */
  const API_ITEM = '/api/platform/pddkj/item';

  /** 只读 GET（同样只需同源 cookie） */
  async function apiGet(path) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json && json.result && json.result !== 'success') throw new Error('接口 result=' + json.result);
    return json;
  }

  async function itemTemplateNames() {
    const json = await apiGet(API_ITEM + '/item_template/getSiteTemplateMap?sites%5B%5D=PDDKJ');
    const list = (json.siteAndItemTemplateMap || {}).PDDKJ || [];
    const names = [];
    list.forEach((x) => {
      const n = String((x && x.name) || '').trim();
      if (n && !names.includes(n)) names.push(n);
    });
    if (!names.length) throw new Error('接口没返回产品模板');
    return names;
  }

  /**
   * 直连读 **SKU 模板**候选。
   *
   * 见 步骤.md §二 E（接口与数据）：产品模板与 SKU 模板**不是同一份清单**，老实现让两者共用
   * `getSiteTemplateMap`，属于「看起来对」的巧合 —— 本账号两份恰好同名同序，
   * 一旦只在一边新建/改名，面板下拉就会显示出一份该弹窗里根本不存在的名字。
   * 实测（2026-10-19，DOM + 网络双证据）：打开「批量引用SKU模板」弹窗时页面发的是
   *   `GET /api/platform/pddkj/item/sku_prop_template/searchSkuPropTemplate?pageNo=1&pageSize=1000`
   * 响应 `skuPropTemplateList[].name` 与弹窗下拉 8 项逐字一致；
   * 同一时刻 `getSiteTemplateMap` 也返回 8 项（产品模板），两者是**两条独立链路**。
   */
  async function skuTemplateNames() {
    const json = await apiGet(
      API_ITEM + '/sku_prop_template/searchSkuPropTemplate?pageNo=1&pageSize=1000'
    );
    const list = json.skuPropTemplateList || [];
    const names = [];
    list.forEach((x) => {
      const n = String((x && x.name) || '').trim();
      if (n && !names.includes(n)) names.push(n);
    });
    if (!names.length) throw new Error('接口没返回 SKU 模板');
    return names;
  }

  /**
   * 不在采集箱列表页时自动跳过去（复用第 0 步的 SPA 导航），并等列表渲染出来。
   * 返回是否确实到了采集箱页。
   */
  async function ensureOnCollectBox() {
    if (isCollectPage()) return true;
    // 顶部导航不在（例如非妙手页面/测试环境）就别白等 20s，直接整页跳转兜底
    if (!document.querySelector('.nav-item-goods .nav-item-text')) {
      warn('没有顶部导航菜单，改用直达链接跳转采集箱');
      try { location.href = '/pddkj/collect_box/items'; } catch (_) { /* ignore */ }
      return false;
    }
    log('读取模板列表：不在采集箱页，自动跳转…');
    try {
      await stepGotoCollectBox();
    } catch (e) {
      warn('自动跳转采集箱页失败:', e.message || e);
      return false;
    }
    await waitFor(
      () => (document.querySelectorAll('.pro-virtual-scroll__row.pro-virtual-table__row').length ? true : null),
      { desc: '采集箱列表渲染', timeout: 20000 }
    ).catch(() => {});
    return isCollectPage();
  }

  /** 一个都没勾时点一次「全选」（已有勾选就沿用用户的选择，不覆盖） */
  async function ensureSomeSelection() {
    if (selectedDetailIds().length) return false;
    const all = findByText('button', '全选', { exact: true });
    if (!all) return false;
    await clickEl(all, { wait: 2500 });
    return selectedDetailIds().length > 0;
  }

  /** 读取三处模板候选（产品/SKU、尺码表都优先直连；直连不成立才回落开弹窗。全程只读：不应用、不保存） */
  async function readAllTemplates() {
    if (uiState.running) {
      toast(false, '执行中', '等当前步骤跑完再改设置');
      return;
    }
    const btn = refs.setReadTpl;
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
    const report = [];
    try {
      // 产品模板 / SKU 模板是**两条独立接口**（不再共用 getSiteTemplateMap，见 §二 E），
      // 各自直连、各自回落开弹窗；一个失败不影响另一个。
      const jobs = [
        { kind: 'product', menu: '产品模板', title: '批量引用模板', label: '产品模板', api: itemTemplateNames },
        { kind: 'sku', menu: 'SKU模板', title: '批量引用SKU模板', label: 'SKU 模板', api: skuTemplateNames }
      ];
      for (const j of jobs) {
        let directErr = null;
        try {
          let names = null;
          let how = '';
          try {
            names = await j.api();
            how = '直连';
            rememberTemplates(j.kind, names, true);
          } catch (e) {
            directErr = e;
            warn('直连读' + j.label + '失败，回落开弹窗:', e.message || e);
          }
          if (!names || !names.length) {
            names = await probeTemplateOptions(j.kind, j.menu, j.title, j.label);
            how = '弹窗';
          }
          report.push(j.label + ' ' + names.length + '（' + how + '）');
        } catch (e) {
          warn('读取' + j.label + '选项失败:', e);
          // 直连失败的原因要带出来，否则用户只看到「失败」无从自查
          const why = directErr && directErr.message ? directErr.message : (e.message || e);
          report.push(j.label + ' 失败（' + why + '）');
        }
      }
      // 尺码表：优先直连接口（少开一次弹窗）；直连不成立再回落到「开弹窗读下拉」
      try {
        let names = null;
        let how = '';
        let directErr = null;
        try {
          names = await probeSizeChartOptionsByApi();
          how = '直连';
        } catch (e) {
          directErr = e;
          // 最常见的原因：不在采集箱列表页 / 没勾选商品 —— 那就自动跳过去、必要时全选，再试一次
          if (/没勾选商品/.test(e.message || '')) {
            const jumped = await ensureOnCollectBox();
            const picked = await ensureSomeSelection();
            if (jumped) report.push('已自动跳转采集箱页');
            if (picked) report.push('已自动全选商品');
            if (jumped || picked) {
              try {
                names = await probeSizeChartOptionsByApi();
                how = '直连';
              } catch (e2) { directErr = e2; }
            }
          }
          if (!names) warn('直连读尺码表模板失败，回落开弹窗:', (directErr && (directErr.message || directErr)) || e);
        }
        if (!names || !names.length) {
          try {
            names = await probeSizeChartOptions();
            how = '弹窗';
          } catch (e2) {
            // 两条路都不行：以「直连失败的原因」为准（最常见：不在此页 / 没勾选商品）
            throw new Error(directErr && directErr.message
              ? directErr.message
              : ('两条路都读不到：' + (e2.message || e2)));
          }
        }
        report.push('尺码表模板 ' + names.length + '（' + how + '）');
      } catch (e) {
        warn('读取尺码表模板选项失败:', e);
        report.push('尺码表模板 失败（' + (e.message || e) + '）');
      }
      renderSettingsOptions();
      saveSettings();
      const failed = report.filter((r) => /失败/.test(r));
      const ok = !failed.length;
      // 只差「没勾选商品」时，标题直接给可操作的动作，别让用户对着「部分失败」发呆
      const onlyNoSel = failed.length === 1 && /尺码表模板 失败（没勾选商品）/.test(failed[0]);
      const title = ok ? '模板列表已读取' : (onlyNoSel ? '尺码表要先勾选商品' : '模板列表部分失败');
      const tail = onlyNoSel ? '｜到采集箱列表页 → 勾选（或全选）商品 → 再点本按钮' : '';
      toast(ok, title, report.join(' · ') + tail);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText || '读取模板列表'; }
    }
  }

  /** 把 settings 的状态刷进设置区（v1.8.0 起没有开关：设置里是什么就用什么） */
  function syncSettingsUI() {
    if (!refs.settings) return;
    renderSettingsOptions();
    renderWordsChips();
  }


  function buildSettings() {
    const box = el('div', 'settings');

    /* 三类模板下拉（直接显示真实模板名）+ 读取按钮。
       v1.8.0 起没有「模板预设」开关：下拉里选中的模板就是步骤执行时用的模板，改动即时落盘 */
    const fields = el('div', 'set-tpl-fields');
    refs.tplSelects = {};
    TPL_KEYS.forEach(({ key, label }) => {
      const f = buildTplField(key, label);
      fields.appendChild(f.wrap);
      refs.tplSelects[key] = f.sel;
    });
    const readBtn = el('button', 'set-btn is-plain set-read-tpl', '读取模板列表');
    readBtn.type = 'button';
    readBtn.addEventListener('click', () => { readAllTemplates(); });
    fields.appendChild(readBtn);
    box.appendChild(fields);

    /* 词库：「管理词库（N）」按钮占满整行、居中；展开后才显示词标签 + 输入框 + 立即更新 */
    const wordsWrap = el('div', 'set-field');
    const wordsBtn = el('button', 'set-btn is-plain set-words-toggle', '管理词库（0）');
    wordsBtn.type = 'button';
    wordsBtn.title = '展开/收起词库：查看全部词条、粘贴新词条后点「立即更新」（不会自动保存）';
    wordsBtn.addEventListener('click', () => {
      if (uiState.running) return;
      setWordsOpen(refs.setWordsBody.classList.contains('is-hidden'));
    });

    const wordsBody = el('div', 'set-words-body is-hidden');

    const chips = el('div', 'word-chips');
    // 滚动条默认隐藏：滚动时才淡显（滚完 800ms 淡出）；悬停/按住由 CSS 负责变深
    let chipsScrollTimer = 0;
    chips.addEventListener('scroll', () => {
      chips.classList.add('is-scrolling');
      clearTimeout(chipsScrollTimer);
      chipsScrollTimer = setTimeout(() => chips.classList.remove('is-scrolling'), 800);
    }, { passive: true });

    const importTa = el('textarea', 'set-textarea set-import-ta');
    importTa.spellcheck = false;
    // v1.13.0：输入框不再自动保存 —— 只有点「立即更新」才写词库，边打字不会改动任何数据
    importTa.placeholder = '粘贴词条，用中英文逗号分隔：短袖,弹力，透气（输入后点「立即更新」才生效）';

    const applyBtn = el('button', 'set-btn is-plain set-apply-words', '立即更新');
    applyBtn.type = 'button';
    applyBtn.title = '按中英文逗号解析输入框内容，整体替换词库';
    applyBtn.addEventListener('click', () => {
      if (uiState.running) return;
      // 只在这里写词库（v1.13.0 起没有防抖自动保存）
      applyWordImport(importTa.value);
    });

    wordsBody.append(chips, importTa, applyBtn);
    wordsWrap.append(wordsBtn, wordsBody);
    box.appendChild(wordsWrap);

    refs.settings = box;
    refs.setReadTpl = readBtn;
    refs.setWordsChips = chips;
    refs.setWordsBody = wordsBody;
    refs.setWordsBtn = wordsBtn;
    refs.setImportTa = importTa;
    return box;
  }

  /**
   * 视图：'settings'＝设置页（首次默认），'run'＝执行页（步骤 + 一键编辑）。
   * 视图来自持久化：刷新后仍是上次那一页（localStorage['msxb-ui-v1'] 的 view 字段）。
   */
  function applyView() {
    const showSettings = uiState.view === 'settings';
    if (refs.settings) refs.settings.classList.toggle('is-open', showSettings);
    if (refs.list) refs.list.classList.toggle('is-hidden', showSettings);
    if (refs.foot) refs.foot.classList.toggle('is-hidden', showSettings);
    if (refs.gear) {
      refs.gear.classList.toggle('is-open', showSettings);
      refs.gear.title = (showSettings ? '切换到执行页（步骤 + 一键编辑）' : '切换到设置页（模板 / 词库）')
        + ' · 面板 v' + SCRIPT_VERSION;
    }
  }

  /** 齿轮：在「设置页」与「执行页」之间切换；执行中不允许切（避免和页面交互抢焦点） */
  function toggleView(force) {
    if (!refs.settings) return;
    if (uiState.running) {
      toast(false, '执行中', '等当前步骤跑完再切');
      return;
    }
    const toSettings = typeof force === 'boolean' ? force : (uiState.view !== 'settings');
    const nextView = toSettings ? 'settings' : 'run';
    if (nextView !== uiState.view) {
      uiState.view = nextView;
      // 视图也持久化（刷新后停在上次那一页）。但**只在真的切换时写** ——
      // 重建路径（restorePersistedUi）会直接塞 uiState.view 再调 applyView()，
      // 那里不能顺手落盘，否则「只读缓存」变成了「写缓存」。
      saveUiState({ view: nextView });
    }
    if (toSettings) {
      syncSettingsUI();
      if (isPanelCollapsed()) setCollapsed(false);   // 同步 fold 图标与持久化状态
    } else {
      setWordsOpen(false);   // 离开设置页时把词库区收起
      closeSelectMenu();     // 切页时一并收起下拉浮层
    }
    applyView();
  }

  /**
   * 建面板。
   * 见 步骤.md §二 D（面板生命周期）：SPA 切页时**不拆掉重建**（见下方看护循环）；
   * 「面板被页面冲掉」仍需自愈重建。
   * 重建时必须跳过入场动画（.no-anim），否则用户眼里就是"一切页闪一下"。
   * 同理，用户拖过的位置要保留 —— 重建后面板不该跳回右上角默认位。
   */
  function buildPanel() {
    if (document.getElementById('msxb-panel')) return;
    const host = document.createElement('div');
    host.id = 'msxb-panel';
    // 打版本号：boot() 与看护循环靠它识别「这个面板是不是本版建的」
    host.dataset.msxbVersion = SCRIPT_VERSION;
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    // 首次挂载才播入场动画；重建（自愈 / 顶掉旧版）直接出成品。
    // 注意 mounted 的置位在 appendChild 之后 —— 这里只读不写，否则首次出现也会被当成"重建"
    const panel = el('div', 'panel' + (uiState.mounted ? ' no-anim' : ''));

    // 还原用户拖动后的位置（内存 dragPos 优先，其次 localStorage）。
    // 按当前视口夹一下：窗口变小后重建，面板不该跑到屏幕外找不回来。
    const wantPos = dragPos || persistedUi.pos;
    if (wantPos) {
      const maxL = Math.max(0, window.innerWidth - 120);
      const maxT = Math.max(0, window.innerHeight - 60);
      const l = Math.max(0, Math.min(maxL, Number(wantPos.left) || 0));
      const t = Math.max(0, Math.min(maxT, Number(wantPos.top) || 0));
      panel.style.left = l + 'px';
      panel.style.top = t + 'px';
      panel.style.right = 'auto';
      dragPos = { left: l, top: t };
    }
    // 折叠状态：**刷新后也要保持**（用户点名要求的第二件事）
    if (persistedUi.collapsed) panel.classList.add('is-collapsed');

    /* 头：单行 = 状态点 + 标题 + 红线胶囊 + 状态文字 + 设置 + 折叠 */
    const head = el('div', 'head');
    const status = el('div', 'status', '就绪');
    const gear = el('button', 'gear', '⚙');
    gear.type = 'button';
    gear.title = '设置：模板 / 词库（模板选中即存；词库点「立即更新」才存） · 面板 v' + SCRIPT_VERSION;
    const fold = el('button', 'fold', '−');
    fold.title = '折叠 / 展开';
    /* 「更新」标记：默认隐藏，检测到 GreasyFork 版本与本地不一致时显形。
       放在「不发布」右边（用户指定位置），点击打开 GreasyFork 脚本主页。 */
    const upd = el('button', 'upd', '更新');
    upd.type = 'button';
    upd.hidden = true;
    upd.title = '检测 GreasyFork 上的最新版本';
    head.append(
      el('div', 'dot'),
      el('div', 'title', '采集箱助手'),
      el('div', 'pill', '不发布'),
      upd,
      status,
      gear,
      fold
    );
    panel.appendChild(head);

    /* 进度线：兼作头与列表的分隔 */
    const bar = el('div', 'bar');
    const barFill = el('div', 'bar-fill');
    bar.appendChild(barFill);
    panel.appendChild(bar);

    /* 内容 */
    const body = el('div', 'body');

    /* 设置抽屉：点齿轮展开，放在步骤列表之上 */
    body.appendChild(buildSettings());

    /* 步骤列表：单行，右侧小字 */
    const list = el('div', 'list');
    refs.rows = {};
    STEPS.forEach((s) => {
      const row = el('button', 'row');
      row.type = 'button';
      const badge = el('div', 'badge');
      const name = el('div', 'name', s.name);
      const detail = el('div', 'detail', s.hint);
      row.append(badge, name, detail);
      row.title = s.name + ' · ' + s.hint;
      row.addEventListener('click', () => runSequence([s]));
      list.appendChild(row);
      refs.rows[s.id] = { row, badge, detail };
    });
    body.appendChild(list);

    /* 主按钮：一键编辑；运行中变成「停止编辑」 */
    const foot = el('div', 'foot');
    const mainBtn = el('button', 'main-btn', '一键编辑');
    mainBtn.type = 'button';
    mainBtn.addEventListener('click', () => {
      if (uiState.running) { stopEditing(); return; }
      runSequence(STEPS);
    });
    foot.appendChild(mainBtn);
    body.appendChild(foot);

    panel.appendChild(body);

    /* 下拉浮层容器：position: fixed，避免被 .panel 的 overflow: hidden 裁掉 */
    const menuLayer = el('div', 'menu-layer');
    shadow.appendChild(panel);
    shadow.appendChild(menuLayer);

    /* 提示层（固定屏幕顶部居中） */
    const toasts = el('div', 'toasts');
    shadow.appendChild(toasts);

    refs.panel = panel;
    refs.status = status;
    refs.bar = bar;
    refs.barFill = barFill;
    refs.mainBtn = mainBtn;
    refs.toasts = toasts;
    refs.menuLayer = menuLayer;
    refs.gear = gear;
    refs.fold = fold;
    refs.list = list;
    refs.foot = foot;

    updBtn = upd;
    renderUpdateBadge();        // 面板重建后把检测结果立刻画上去（缓存在，不必等网络）

    upd.addEventListener('click', (e) => {
      e.stopPropagation();
      checkUpdate(true);        // 强制重查一次，顺带刷新 tooltip
      window.open(GF_PAGE_URL, '_blank', 'noopener');
    });

    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleView();
    });

    fold.addEventListener('click', () => {
      setCollapsed(!panel.classList.contains('is-collapsed'));   // 内部会同步图标 + 落盘
    });

    /* 拖拽（用面板自身定位，避免 left/top 与 right 混用）。
       见 步骤.md §二 D（面板生命周期）：早先 mousemove/mouseup 每轮 buildPanel 都往 document 上
       新增一份且从不移除，面板重建 N 次就累积 N 个监听 —— 现在整组监听只挂一次，用 dragRef
       指向当前面板。位置要**跨刷新保持** —— mousemove 只更新内存 dragPos（每帧写 localStorage
       是同步 IO，会拖慢拖动），真正落盘放在 mouseup。 */
    dragRef = { panel };
    if (!dragBound) {
      dragBound = true;
      document.addEventListener('mousemove', (e) => {
        if (!drag || !dragRef || !dragRef.panel) return;
        const x = Math.max(0, Math.min(window.innerWidth - 120, drag.l + (e.clientX - drag.x)));
        const y = Math.max(0, Math.min(window.innerHeight - 60, drag.t + (e.clientY - drag.y)));
        dragRef.panel.style.left = x + 'px';
        dragRef.panel.style.top = y + 'px';
        dragPos = { left: x, top: y };   // 记下来，重建时还原
      });
      document.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = null;
        // 拖动结束才写盘：刷新后位置能回到原处
        if (dragPos) {
          persistedUi.pos = { ...dragPos };
          saveUiState({ pos: dragPos });
        }
      });
    }
    head.addEventListener('mousedown', (e) => {
      if (e.target === fold || e.target === gear || e.target === upd) return;   // 头部的按钮不触发拖拽
      const r = panel.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, l: r.left, t: r.top };
      panel.style.right = 'auto';
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      dragPos = { left: r.left, top: r.top };
      e.preventDefault();
    });

    // 视图先定好再挂进 DOM：面板出现的第一帧就是目标页（不会先画执行页再切回去）。
    // v1.14.0 起**不再强制回设置页** —— 用户上次停在哪一页，刷新后就在哪一页
    // （位置/折叠/视图三者都是持久化的；只有正在执行时才强制保留执行页，
    //  否则跑全链时切路由会看不见进度）。
    if (!uiState.running) {
      const want = persistedUi.view;
      uiState.view = (want === 'run' || want === 'settings') ? want : 'settings';
    }
    applyView();
    // 折叠图标按持久化状态同步（panel 上已经加了 is-collapsed，但 fold 的符号/标题还没跟着变）
    if (refs.fold) {
      const collapsed = panel.classList.contains('is-collapsed');
      refs.fold.textContent = collapsed ? '+' : '−';
      refs.fold.classList.toggle('is-open', collapsed);
      refs.fold.title = collapsed ? '展开面板' : '折叠面板';
    }

    document.body.appendChild(host);
    // 挂进 DOM 之后才算「已挂载」：首次出现仍播入场动画，之后的任何重建都直接出成品（§二 D）
    uiState.mounted = true;
    render();
    syncSettingsUI();
  }

  /* ============================ 启动 ============================ */

  /**
   * 全局挂载：任何妙手页面都建面板，第 0 步负责导航过去。
   *
   * 见 步骤.md §二 D（面板生命周期）：Tampermonkey 里若同时留着旧版和当前版，
   * 旧版先跑、先建出 #msxb-panel，本版 boot() 见到「面板已存在」就直接 return，
   * 结果用户看到的永远是旧界面 —— 表现为「更新了却没区别」。
   * 对策：给面板打上版本号，发现现存面板不是本版建的，**顶掉重建**。
   */
  const boot = () => {
    if (!document.body) return setTimeout(boot, 500);
    const host = document.getElementById('msxb-panel');
    if (host && host.dataset.msxbVersion === SCRIPT_VERSION) {
      return;   // 已是本版面板，沿用现有 DOM
    }
    if (host) {
      // 旧版（或没打版本号的）面板：顶掉，避免新界面永远不生效
      warn('发现旧版面板（' + (host.dataset.msxbVersion || '未标注') + '），已替换为 ' + SCRIPT_VERSION);
      host.remove();
    }
    buildPanel();
  };

  // 先读用户设置，再建面板（面板要按设置渲染词表与模板选项）
  loadSettings();

  // 尽早装上「选中集旁听器」：它必须在页面发出第一次 getCollectItemInfoList 之前就位，
  // 否则拿不到权威选中集（详见 verifySaved 说明 ①）。装它只旁听、不改页面行为。
  installSelectionWatcher();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 版本检测：每次刷新都跑一次，并用缓存把上次结论先画出来（首帧零延迟）。
     放在 boot 之后 —— 先出面板，再让标记异步显形，绝不让网络拖慢首屏。
     只有「上次失败且不足 60s」时跳过本轮；失败只 warn，不弹 toast、不影响业务流程。 */
  checkUpdate(false);

  /**
   * 看护循环：处理「面板节点被页面重渲染冲掉」与「版本不符」，只做两件事：
   *
   *   ① **自愈**：妙手很多操作会让页面自身重渲染 / 清空 body 尾部节点（采集箱跳转、
   *      批量操作后刷新列表等），面板被一起冲掉、路径却不变 —— 所以每轮先看面板是否
   *      还在文档里，不在就重建，不能只靠监听路由。
   *   ② **接管旧版**：面板在、但 dataset.msxbVersion 不是本版（Tampermonkey 里还装着
   *      旧版，旧版先建了面板），顶掉重建，否则新版界面永远不生效。
   *
   * 路由变化本身**不需要**处理：面板是 position:fixed 挂在 body 上，SPA 切路由不会销毁它。
   * 反过来「路由变 → remove → buildPanel」是自找的：拆掉 + 重建 = 0.28s 入场动画重播，
   * 中间还有若干帧面板是空的，用户看到的就是「切页闪一下」（见 步骤.md §二 D）。
   */
  setInterval(() => {
    // 注意：路由变化**不需要**任何处理 —— 面板是 position: fixed 挂在 body 上的，
    // SPA 切路由不会销毁它（拆掉重建只会让「切页闪一下」，见 步骤.md §二 D）

    const host = document.getElementById('msxb-panel');   // 只认"在文档里"的面板
    if (host && host.dataset.msxbVersion === SCRIPT_VERSION) return;   // 面板在、版本对 → 什么都不做

    // body 还没就绪（页面正在重建 DOM）→ 等下一轮，别硬塞
    if (!document.body) return;
    if (host) {
      // 版本不符（Tampermonkey 里还装着旧版、旧版先建了面板）：顶掉，交给 boot() 重建
      warn('发现旧版面板（' + (host.dataset.msxbVersion || '未标注') + '），已替换为 ' + SCRIPT_VERSION);
      host.remove();
    } else {
      // 面板不在文档里（被页面重渲染冲掉）→ 自愈重建
      warn('面板被页面冲掉，正在自愈重建');
    }

    closeSelectMenu();   // 浮层挂在 shadow 里、document 上还留着监听，先收干净
    shadow = null;
    refs.panel = null;
    refs.rows = {};
    refs.status = null;
    refs.bar = null;
    refs.barFill = null;
    refs.mainBtn = null;
    // toasts 也要清：boot() 在 body 未就绪时会延后 500ms，这期间 toast() 只判 refs.toasts
    // 非空，不清掉就会把提示写进已脱离文档的旧节点（用户看不到）
    refs.toasts = null;
    refs.settings = null;
    refs.gear = null;
    refs.fold = null;
    updBtn = null;      // 面板被顶掉/冲掉时一并清空「更新」标记引用，重建后会重新挂
    refs.list = null;
    refs.foot = null;
    refs.tplSelects = null;
    refs.menuLayer = null;
    refs.setReadTpl = null;
    refs.setWordsChips = null;
    refs.setWordsBody = null;
    refs.setWordsBtn = null;
    refs.setImportTa = null;
    boot();
  }, 800);   // 500→800ms：够快让人察觉不到面板消失，也不会和页面自己的重渲染抢节奏
})();
