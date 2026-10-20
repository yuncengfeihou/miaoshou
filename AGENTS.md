# AGENTS.md — 妙手 ERP · TEMU 全托管采集箱批处理

面向接手此项目的 AI Agent / 协作者。**先读本文动手，细节查 `步骤.md`。**

---

## 1. 项目目标与硬红线

在妙手 ERP 的 **TEMU 全托管采集箱**（`/pddkj/collect_box/items`）上，把固定的商品规范化流程
（套模板 → 清标题 → 套尺码表 → 设模特 → 插颜色图）自动化，交付一个油猴脚本，按钮驱动。

### 1.1 三条硬红线（按优先级，违反任何一条都算事故）

> **红线 1：全程禁止发布产品。**
> 只允许「保存修改 / 应用至选中 / 应用 / 使用」这类保存型操作。
> **绝不点「批量发布 / 发布 / 保存并发布」。** 每次改动后必须 `Select-String -Pattern "发布"` 自查。

> **红线 2：只允许操作「未发布」列表里的产品。**
>
> - 必须先把列表筛选切到 **「未发布 (N)」**，确认分页区显示的是未发布状态，才能做任何选择/勾选。
> - **严禁切换到「全部 (N)」或「已发布 (N)」后勾选任何商品**——包括只勾 1 条、只看一眼、只读接口、
>   「测试一下」也不行。已发布是**线上在售数据**，任何触碰都可能触发平台侧同步。
> - **测试、调试、验证、复现问题，一律只准用「未发布」。** 未发布列表为空时也应停下来说明，不得借用已发布。
> - 违反本条的典型错误姿势（本仓库曾发生过，见 §9）：为了验证「选中集旁听器会不会变陈旧」，
>   切到「已发布 (2687)」勾了 1 条并打开批量编辑面板。**即使没保存，也不允许。**

> **红线 3：审查 / 调试任务中，禁止任何实际写入。**
>
> - 「允许保存修改」是**脚本运行时的业务权限**，不是**Agent 调试时的权限**。
> - 做审查、复现、验证时，**只准只读或只改前端预览（preview）**，并且必须用「取消」+
>   「确定（放弃修改）」关闭弹窗，绝不点「保存修改 / 应用至选中 / 应用」。
> - **连"写入一个与现值相同、业务上等于无变化的值"也不行。** 那仍会刷新 `saveDetailTs`，
>   让系统认为该商品被修改过（可能进入下一轮同步）。
> - 需要验证「保存成功 → 落库复核通过」这类正向链时，**必须先把方案报给用户、拿到明确同意**，
>   或直接标注「未验证」写进报告。**不得自行决定"改个无影响的值"来补测。**
> - 想确认某条数据是否被写过：只查 `saveDetailTs` 等元数据，不写。

---

## 2. 文件职责

| 文件 | 作用 |
|---|---|
| `妙手采集箱助手.user.js` | **交付物**。油猴脚本 v1.17.4，单文件、零依赖、`@grant none` |
| `步骤.md` | 知识库：能复用的坑与对策、元素定位表、操作顺序。**改脚本前先查这里** |
| `README.md` | 门面：安装 / 用法 / 三条红线 / 自检命令 / 当前版本变更摘要 |
| `图片1/2/3.png` | 颜色图原始图的**本地备份**（截至 2026-10-20 **仓库中不存在**，未纳入版本管理）。脚本实际用网络直链，**不读本地文件**，因此缺失不影响运行 |
| `.playwright-mcp/` | 临时产物（快照/日志/注入体/测试脚本）。**注入体产物可删可重建；9 个脚本请保留**：6 个 `test-*.mjs`（纯函数 + 虚拟滚动仿真覆盖 + 词库版本库）+ 1 个 `mutate-coverage.mjs`（变异验证）+ 2 个 `make-inject*.mjs`（唯一可用的剥头实现，见 §4） |

> **`@name` 从 2026-10-20 起固定不带版本号**：版本只由 `@version` / `SCRIPT_VERSION` 表达。
> 若 TM 里还留着旧 `@name`（带 `1.15.x` 前缀）的条目，升级后请删除；否则 TM 会把它当成另一个脚本，
> 触发 §4 的「双实例互顶」，表现为点了没反应 / 步骤跑一半断 / toast 不见。

---

## 3. 当前状态（只写"现在是什么"）

**脚本 v1.17.4，10 步：0 导航 + 1 切筛选 + 2–9。**

| 步 | 名称 | 说明 |
|---|---|---|
| 0 | 进入采集箱 | SPA 导航到 `/pddkj/collect_box/items` |
| **1** | **切到未发布** | 非「未发布」则**自动切换**；已是则跳过（红线 2 的第一层，见 §6） |
| 2 | 分页 500 + 全选 | |
| 3–9 | 产品模板 / SKU 模板 / 英语标题 / 标题 / 尺码表 / 模特信息 / 颜色图 | |

| 能力 | 实现要点 |
|---|---|
| 面板 | Shadow DOM，Apple HIG 取向，纯中性白 + 系统蓝 `#0A84FF` 点级强调 |
| 视图 | 齿轮切「设置页 ↔ 执行页」；**位置 / 折叠 / 视图跨刷新持久化**（`localStorage['msxb-ui-v1']`） |
| 主按钮 | 「一键编辑」↔ 运行中「停止编辑 · 12s」（按钮内实时计时），两态无边框不发光，可随时中断 |
| 设置区 | 三类模板下拉（自绘）+「读取模板列表」**三条链路各自直连**（失败自动回落开弹窗） |
| 词库 | v1.17.0：只有 `commitWords()` 能改它（弹窗「保存为新版本」）；执行侧只读 `settings.deleteWords` |
| 词库版本库 | 居中弹窗 + 遮罩：最近 10 版（带时间戳）、版本内搜索、按版本导出 TXT、更新页实时差异；**标题左侧 chevron 折叠版本列表（默认收起）**；当前版不编号（只显示「当前」），历史版自上而下 `#1 #2 …`；历史版只读 —— 整条标签栏隐藏、只剩「词库」页，行内**零按钮**、工具条只有 `复制 / 导出 TXT`（v1.17.4 删掉「恢复为当前」）。存储 `localStorage['msxb-words-v1']`；**不变量：最新版 === `settings.deleteWords`**（加载后 + 每次开跑前对账，方向只有「实际值 → 历史」） |
| 落库复核 | 每步保存后调接口核对结果（v1.15.0，见 §5.6） |
| 等待策略 | v1.16.0：新判据一律「条件等待 + **连续两次采样成立**」(`waitStable`)，超时**抛错不吞**；提速只来自去掉空等 |
| 版本检测 | 每次刷新比对 GreasyFork `/scripts/600852.json`，不一致显示「更新」 |

**版本演进不在此记录。** 想知道某处为什么这样写，按主题查 `步骤.md` §二 A–F（落库复核见 §二 C 与 §5.6，词库版本与弹窗见 §二 F）。

**未验证/未做**（接手先看）：

1. **`verifySaved` 从未在真实保存后跑过。** 逻辑已用「未保存状态」做负向验证（该失败的失败、该通过的通过），
   但「保存成功 → 复核通过」这条正向链**没有真实数据确认**。这是当前最大的空白。
2. **整链 0–9 未做长时间稳定性验证。** 单步实测过，全链约 4 分钟；工具调用 >100s 会被截断（非脚本失败），
   验证要分段观察。
3. **第 1 个商品的颜色图有重复**（历史遗留，用户明确**暂不清理**）。要修得在颜色图面板手工删图。
4. **`productTpl` / `skuTpl` 两步没有可断言的落库目标** —— 接口不暴露模板 id，判据只标
   `noAssertion`、不做前后比对（见 §5.6）。
5. **两处「漏改却报成功」的缺口（`审查报告.md` §三 T1 / §四 T2）**：
   ① `stepTitle` 的 `expected === 0` 只 `warn` 不抛错 → **覆盖断言整段被跳过**。
      **v1.16.0 已修**（改抛错）：用例从 KNOWN 转正为 `test-title-coverage.mjs` 第 8 例，
      `mutate-coverage.mjs` 的 M7 专测它。
   ② `setAllColors` 的 `goPage` 失败只 `warn` + `continue` → **整页漏改不进 `wrongRows`**。
      **仍未修**（`test-color-coverage.mjs` 的 KNOWN 用例）；但正常业务量走不到 ——
      「未发布」≤400 条、每个分页入口先切 500 条/页 → `pages === 1`。
6. **词库弹窗：逻辑 + DOM + 视觉均已验，只有「妙手真页面注入」与「被冲掉后重建」没验。**
   `test-words-store.mjs` 覆盖存储 / 对账 / 裁剪 / diff / 配额；另在**本地 HTTP 无菌页**（`127.0.0.1` 静态页 + `inject-body.js`，
   与妙手无关、TM 不匹配）跑通完整弹窗，2026-10-20 实测：胶囊高 **16.25px**（修前被 `align-content: stretch` 拉到 ~60px）、
   标签顺序 `词库/编辑/对比` 且默认停「词库」、**无底栏**、当前版 `is-cur` 淡蓝底 + 「历史」分隔线、
   选历史版后信息行写「历史版本」、**导出 TXT 内容 === 选中那版**（打桩 `URL.createObjectURL` 读 Blob，无 BOM）、
   搜索框聚焦只有 `0 0 0 1px` 一圈、× 透明底。**未做**：① 妙手真页面注入（TM 里的 1.17.0 会与本版每轮互顶，
   见 §4 双实例互顶）；② 面板被页面冲掉后按 `wordsModalState` 重建弹窗 —— 这条只能在真页面触发。

---

## 4. 环境与运行方式

**目标环境**：妙手 ERP，已登录，页面 `/pddkj/collect_box/` 才注入面板。

**用户使用**：装 Tampermonkey → 新建脚本粘贴全文 → 打开采集箱页 → 右侧出现面板。
建议**逐条点**而非「一键编辑」跑全链，每步看状态栏「成功 N/N」。

**Agent 调试注入**：

```js
// 1) 去掉 UserScript 头，生成可注入体
// ⚠ 结束标记是 `// ==/UserScript==`（带斜杠）。这里曾误写成 `// ==UserScript==`，
//   实测剥后长度 173113 → 173113，**一个字符都剥不掉**（见 `审查报告.md`）。
//   现成实现见 `.playwright-mcp/make-inject.mjs`，改脚本后重跑它即可，别手抄正则。
const body = src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==[ \t]*\r?\n/, '');
if (body.startsWith('// ==UserScript==')) throw new Error('UserScript 头没剥掉');
fs.writeFileSync('.playwright-mcp/inject-body.js', body);
// 2) 注入
await page.addScriptTag({ path: '...\\.playwright-mcp\\inject-body.js' });
```

> ⚠ **注入测试最大的坑：双实例互顶。** 若 TM 里装的版本与注入体版本不同，
> 两个实例会**每 ~800ms 互相顶掉面板**，日志刷「发现旧版面板（X），已替换为 Y」反复横跳，
> 表现为「点了没反应 / 步骤跑一半就断 / toast 不见了」这类**假故障**。
> 对策：① 先刷新页面清掉历次注入残留；② 注入体 `SCRIPT_VERSION` 对齐 TM 版本；
> ③ **取样窗口必须短于 800ms**；④ 更稳的做法是给面板打专属标记 `host.dataset.msxbTest='1'`，
> 循环「顶掉 → 注入 → 认领标记」直到标记出现再测。

---

## 5. 关键技术约束（改脚本前必读）

### 5.1 两套组件混用

页面同时用 `el-*`（Element）与 `jx-*` 前缀组件。**选择器必须两者都覆盖**，只写 `el-*` 会大面积命中不到。

### 5.2 已验证的 DOM 事实（勿凭直觉改）

「验证方式」= 这条结论当年是怎么得到的，便于你判断可信度、以及页面改版后该复查哪一类。

| 目标 | 结论 | 验证方式 |
|---|---|---|
| 分页条数 | `.pro-pagination .jx-select__placeholder` 的文本（`500条/页`）；`.jx-select__input` 是 `<input readonly>`，`innerText` 恒空、`input.value` 也为空 | 真实页面打印 DOM |
| 引用模板下拉 | 需 `mouseenter` + `mouseover`（click 无效）；菜单是 `.jx-dropdown-menu`，**左侧导航有同名项，必须限定作用域** | 真实页面逐个派发事件比对；误点导航会导致路由跳走 |
| 批量编辑 | **两级交互**：hover 按钮 → 字段浮层 `.jx-popper.is-light.jx-tooltip.jx-popover` → 点叶子 `SPAN` → 才开弹窗 | 真实页面 hover 后打印浮层结构 |
| 弹窗识别 | 除颜色图外都含「批量编辑方式」；**颜色图没有**，须用 `.sku-image-batch-editor` 判断 | 逐个打开各字段面板读 `innerText` |
| 面板切换 | 弹窗已开时点左侧 `li`（文本完全同名）切换，**不要重复点「批量编辑」** | 真实页面实测；重复点会重开/卡住 |
| 预览表行 | `.jx-pro-virtual-table__row`；`cells[2].innerText` = 编辑前原文（**不是 cells[1]**），行内 `textarea` = 编辑后 | 真实数据下逐 cell 打印 + 故意让 `item-info` 有内容复现污染 |
| 颜色图「选择 ▾」 | 必须点内部 `label.el-checkbox`，点外层 `.el-dropdown` 无效 | 真实弹窗两种点法对照（截图） |
| 图片填充 radio | `label.el-radio.jx-pro-radio`，**须等 1–3 秒面板渲染完**；文字在 label 的 `innerText` 里 | 真实弹窗测点击时机 |
| 第 N 张序号框 | 未上传图片时 `disabled`；被 label 包住会抢焦点，`keyboard.type()` 写不进 → 原生 setter + 派发事件 | 真实弹窗尝试键盘输入失败 |
| 上传入口 | `.add-image-box` → `.dropdown-btns-container` 内「使用网络图片」→ `textarea` → `确定` | 真实弹窗逐层打印 |
| 结果验收 | 含「总计」的弹窗，读 `总计/未完成/成功/失败`，**必须关闭**否则挡住后续点击 | 真实保存后观察后续点击被挡 |
| 列表行 id | `.pro-virtual-scroll__row.pro-virtual-table__row` 内 `div.shop-item[collectboxdetailid]`；勾选状态＝行内 `input[type=checkbox].checked` | 真实列表行打印属性（注意与预览表同类名区分） |
| 弹窗里同名按钮不止一个 | 标题面板实测 16 个 `button`，「取消」出现 **2 次**（一个在隐藏的内层弹窗）。**按文本找按钮必须加 `isVisible` 过滤** | 真实弹窗枚举全部 button 的可见性/尺寸 |
| **分页规模（业务前提，别过度设计）** | 「未发布」实际最多 **≈400 条**（业务量上限，不是页面限制）；脚本在**每个会分页的入口都先切 `500条/页`**（列表 `stepSelectAll` 1151、标题 `stepTitle` 1694、颜色图 `setAllColors` 2235 / `stepColorImages` 2438）→ 全部落在单页内。**不要**为「>500 条/页」「停在默认 20 条/页」去设计补偿 | 用户实际业务量 + 源码调用点 |

> ⚠ **别在这上面过度设计。** 500 条/页是页面硬上限，「未发布」上限 ≈400 条，
> 且每个分页入口都会先切到 500 —— 所以「勾选 >500 条」和「20 条/页时跨页」
> **正常使用中不会出现**。想让脚本更稳，去修真正的静默失败（`审查报告.md` §二 / §三 的 T4 / T6 / R1 / T1），
> 不要把时间花给这些不可达分支加防护，也不要为它们改动现有判据。

### 5.3 三份模板清单互不派生

| 模板 | 数据源 | 验证方式 |
|---|---|---|
| 产品模板 | `GET .../item_template/getSiteTemplateMap?sites[]=PDDKJ` → `itemTemplateId / name / cid` | 真实页面悬停「引用模板」抓包 |
| **SKU 模板** | `GET .../sku_prop_template/searchSkuPropTemplate?pageNo=1&pageSize=1000` → `skuPropTemplateList[].name`（**与产品模板是两条链路**，老版本共用是巧合） | 打开「批量引用SKU模板」弹窗抓包，与产品模板的响应**逐项比对** |
| 尺码表模板 | `POST .../collect_box/getCategorySizeTemplateList`，body `cids[0]=<所选商品的类目 id>` → `categorySizeTemplateList[].sizeTemplateList[]` 带 `sizeTemplateSource`（`erp`＝妙手模板 / `api`＝后台模板） | 改商品类目后重查，候选随之变化 |

**尺码表候选只由所选商品的当前类目决定**（类目变了候选就变；面板显示的是 localStorage 缓存，可能过时）。
验证方式：同一模板名在不同类目下未必都存在 —— 换类目重读一次即可复现。

### 5.4 直连接口的调用姿势

**同源 `fetch` + cookie + `Content-Type: application/x-www-form-urlencoded` 即可**，
页面的签名头（`x-timestamp` / `x-app-zebra` / `x-front-version` / `X-Breadcrumb`）**可以不带**。
返回 `result: 'success'` 才算成功。

> 验证方式：在真实页面 `fetch` 时把这些头**逐个去掉**再发，接口仍返回 `result: 'success'`。

### 5.5 四条"不要用"的坑

- **「删除标题中」批量框有 BUG**，删除结果不可靠 → 该框必须留空，改为在预览 textarea 内自己改。
  （验证方式：真实批量框删除后与预期不符。）
- **标题改写必须以「编辑前」原文为基准**（`cells[2]`）。基于当前 textarea 累加会二次删改（前缀重复）。
  （验证方式：连跑两次，观察前缀是否叠加。）
- **删词只做子串删除，不可替换成空格**（否则 `，`、`、`、`春/秋季` 会被破坏）。
  （验证方式：拿含这些标点的真实标题跑一遍，看标点是否变形。）
- **本地上传走不通**（CDP 注入被拒、`DataTransfer` 失效）→ 一律用网络图片直链。
  （验证方式：`DOM.setFileInputFiles` 返回 `Not allowed`；`DataTransfer` 赋值后 `files.length` 为 0。）

### 5.6 落库复核（v1.15.0，最易踩的 5 点）

保存后用 `getCollectItemInfoList` 把结果拉回来比对。实装时踩到的硬事实（每条都实测过）：

1. **范围不能用 `selectedDetailIds()`** —— 勾 217 条它只返回 **6~8** 条（只读已渲染的虚拟滚动行），
   滚动兜底最多 176。必须**旁听页面自己发的请求**（`installSelectionWatcher` 包 `XMLHttpRequest`），
   一次能拿到全部 217 个 `detailIds`。
2. **页面用的是 XHR 不是 fetch** —— 只包 `window.fetch` 抓到 0 条。
3. **接口按 `fields[]` 裁剪返回** —— 传了 `fields` 就只剩 title，尺码表/模特/颜色**全空**。复核时**不能传**。
4. **判据必须是「算出来的期望值」，不能是「值有没有变」** —— 实测 217 条里 **34 条标题本来就已经对**，
   用"变了才算成功"会把这 34 条误判成失败。
5. **模板类两步（3/4）没有可断言目标** —— `templatePid`(1755426) 与 `itemTemplateId`(1062367)、
   `skuPropTemplateId`(575646) **都不在一个号段**，接口也不返回"用了哪个模板"。这两步标注 `noAssertion`、
   **不做前后比对**，不要假装它是硬断言。

> **验证方式**：把 `__msxb.selection` 打出来看抓到的 id 数（应等于选中数）；
> 在**未保存**的预览上调 `__msxb.verify(stepId)`，应报大量失败；
> 对已处理好的数据调同一接口，应报 0 失败。两边都对上，说明判据没恒真也没误伤。

**显示语义**：复核失败**不把步骤判成 error**（数据已落库，报失败会诱导重跑 → 二次改标题），
而是记为 done + 状态行「已保存 · 落库复核未通过 N/M 条」+ 红色 toast。
模板两步（`noAssertion`）控制台只打印「N 条未核对」，**不打印「复核通过」**。

---

## 6. 脚本结构

```
CFG              配置：模板名 / 模特 / 试穿码 / 前缀 / 删词库 / 图片直链 / 颜色名
makeTitleBuilder 标题改写纯函数（预览改写与落库复核共用同一份；实测幂等）

基础工具          sleep(可打断) / waitFor / findByText / isVisible / clickEl
                  setNativeValue(原生 setter，绕 Vue 受控) / readAndCloseResultDialog
等待工具          waitStable(条件成立且连续两次采样成立才返回，超时抛错)
                  previewReady(预览表最后一列已填) / waitSizeTemplateSelect(尺码表下拉就绪)

未发布守卫        collectStatusTabs / filterNameOfTab / currentCollectFilter
                  unpublishedTab / ensureUnpublishedFilter / assertUnpublishedOnly
                  assertReadAllContext（设置区「读取模板列表」在采集箱页也要求「未发布」）
                  （三层：① 步骤 1 主动切换到「未发布」；② 写入前断言；
                    ③ 读取模板列表/开弹窗前断言。读取优先级：先读 input.value 枚举，读不到才退回文本）

写入闸门          所有落库入口都过 assertUnpublishedOnly（共 5 处）：
                    stepSelectAll 开头（第 2 步，切换之后再确认一次）
                    stepProductTemplate 点「应用至选中」前
                    stepSkuTemplate 点「应用至选中」前
                    insertOneImage 点「应用」前
                    clickSave 点「保存修改」前（最后一道）

落库复核          installSelectionWatcher（包 XHR，拿权威选中集 + 保存前快照）
                  fetchItemInfoMap（分批 200/次；不传 fields[]）
                  judgeSaved（每步绝对判据）/ verifySaved / safeVerify / attachVerify
                  resolveSizeTemplateId（模板名 → 该类目 id）

设置              loadSettings / saveSettings / parseWords / rememberTemplates

词库版本库        WORDS_STORE_KEY / WORDS_MAX_VERSIONS / wordsStore{seq,list}
                  loadWordStore / saveWordStore（配额失败丢最旧一版重试）/ pruneWordVersions
                  pushWordVersion（seq 单调、裁剪不回收）/ syncActiveWordVersion（对账，铁律②）
                  diffWords（按词集合 · 大小写敏感 · orderOnly）/ commitWords（唯一写入口）
词库弹窗          wordsModalState（跨面板重建保留）/ buildWordsModal / mountWordsModal
                  open·closeWordsModal / renderWordsModal / paintModalHead / paintVersionList
                  paintTabState / paintWordsPane（含搜索高亮 fillHighlight）/ paintSideState
                  versionLabel（界面编号：当前版无号、历史版自上而下 #1 #2…· 必须在写库前取）
                  paintEditMeta / setWordsModalTab / selectWordVersion
                  isViewingHistory（历史版只读判定：标签栏与「更新」页隐不隐）
                  saveDraftWords / exportWordVersion / copyWordVersion
uiPersist         loadUiState / saveUiState / setCollapsed（localStorage['msxb-ui-v1']）
timer             startTimer / stopTimer（只改 .main-btn-time，不触发整面板重排）

步骤              stepGotoCollectBox 0 导航
                  stepEnsureUnpublished 1 切到未发布（ensureUnpublishedFilter）
                  stepSelectAll 2 分页 500 + 全选
                  stepProductTemplate 3 / stepSkuTemplate 4（ensureSkuCoverMode 切 cover）
                  stepEnglishTitle 5 / stepTitle 6
                  stepSizeChart 7 / stepModelInfo 8
                  stepColorImages 9（insertOneImage + setAllColors）

面板              buildPanel / boot / render / buildSettings / createAppleSelect
                  applyView / toggleView / buildTplField / renderSettingsOptions
停止              StopError / stopRequested / pendingSleepAborts / stopEditing / cleanupAfterStop
调试入口          __msxb.{selection, verify(stepId), verifyEnabled}
```

> 已删除、不要引用：`updateImportHint / settings.tplPreset / setImportOpen / toggleSettings`、
> refs `setTplToggle / setTplHint / setTplFields / setImportHint / setImport / setImportBtn`。
> 死代码清理又删掉：`SEL_RADIO / SEL_CHECKBOX / isChecked / uiState.mode / refs.setImportTa /
> settings.knownTemplates / toggleView(force)`。
> v1.17.0 词库改为弹窗后删除：`renderWordsChips / wordsBtnText / setWordsOpen / applyWordImport /
> refs.setWordsChips / refs.setWordsBody` 与 CSS `.set-words-body / .set-import-ta / .set-apply-words`。

---

## 7. 协作约定

1. **禁止发布** —— 见 §1。
2. **只碰「未发布」** —— 见 §1.1 红线 2。切到「全部 / 已发布」后勾选任何商品都算违规，
   **调试/取样/验证也不行**。代码侧有 `assertUnpublishedOnly()` 兜底（§6）。
3. **审查/调试禁止任何写入** —— 见 §1.1 红线 3。「未点保存」不等于「没动数据」：
   点了预览区的「保存修改」就会刷新 `saveDetailTs`。审查只准只读或改前端预览。
4. **真实网页优先级高于测试脚本。** `node --check` 通过不算完成，**仿真脚本全绿也不算完成**。
   判定顺序：① 能注入真实页面跑一次的，就跑真页面，不要拿脚本结果当结论；
   ② 只有**真网页进不去的分支**才用 `.playwright-mcp/` 的脚本 —— 比如「让翻页失败」、
   「只看滚了 30%」、「把 bug 注回去做变异测试」、「需要几十上百行才谈得上部分覆盖」，
   这些真页面要么做不到（未发布只有个位数条、`goPage` 不会按需失败），要么做了就碰红线 3。
   ⚠ 但「实测」的边界是红线 2/3 —— 只能对**未发布**的样本、只做**非写入**的验证。
   需要写入才能验证的，先报方案、拿同意，或标注「未验证」。
5. **实测发现的新坑回写 `步骤.md`**（按主题归类，不要再按版本号堆）。
6. **不要擅自清理业务数据**（如重复颜色图），先征得同意。
7. **临时产物放 `.playwright-mcp/`**（注入体产物已在 `.gitignore`，见 §7.1）。

---

## 7.1 Git 与仓库（2026-10-20 起）

**远端**：<https://github.com/yuncengfeihou/miaoshou>（分支 `main`）

| 项 | 值 |
|---|---|
| 工作区 | 项目根目录即仓库根（`妙手采集箱助手.user.js` 与 `.git/` 同级） |
| 用户 | `yuncengfeihou` / `117951839+yuncengfeihou@users.noreply.github.com`（全局配置） |
| 换行 | `core.autocrlf=false`、`core.safecrlf=false` —— **仓库与工作区都用 LF**，避免 CRLF 噪声 |
| 中文路径 | `core.quotepath=false`，`git status` 正常显示中文文件名 |
| 代理 | **Git 未配置全局代理**，直连会 `Recv failure: Connection was reset`。本机系统代理为 `127.0.0.1:7897`，需**显式指定**（见下） |

### 拉取 / 推送

```powershell
# 首次或换机：Git 无全局代理，必须显式带上（否则 connection reset）
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
git -c http.proxy=http://127.0.0.1:7897 pull  --rebase origin main
git -c http.proxy=http://127.0.0.1:7897 push  origin main

# 本机已配置过凭据（Git Credential Manager，system 级 credential.helper=manager），无需重复登录
```

> 若代理端口变了：`Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select ProxyServer`
>
> ⚠ **2026-10-20 复验：代理不是万能钥匙，先试直连。** 当天 `127.0.0.1:7897` 在监听，
> 但对 github 报 `TLS connect error / schannel: failed to receive handshake`（curl 同样失败），
> 而**直连 `https://github.com` 返回 200** —— 于是这一天的正确做法是**不带代理**：
>
> ```powershell
> git -c http.proxy= -c https.proxy= push origin main     # 先直连（今天的成功路径）
> # 直连不通再挂代理：
> $env:HTTPS_PROXY = "http://127.0.0.1:7897"
> git -c http.proxy=http://127.0.0.1:7897 push origin main
> ```

### 入库范围

**入库**：`妙手采集箱助手.user.js`（交付物）、`README.md`、`AGENTS.md`、`步骤.md`、`审查报告.md`、
`.playwright-mcp/` 下 **9 个脚本**（6 个 `test-*.mjs` + `mutate-coverage.mjs` + 2 个 `make-inject*.mjs`，共约 61 KB）。
这 9 个脚本是唯一能验证「前置条件崩了会不会静默成功」的手段 —— 真网页跑不出这些分支（未发布只有个位数条、
`goPage` 不会按需失败、变异测试要改源码），只有真网页能验选择器与渲染时序。**两者互补，不可替代**。

**不入库**（`.gitignore` 已挡）：`inject-body.js` / `inject-test.js` 等注入体产物（可重建）、
`.playwright-mcp/_*/` 临时目录、日志、截图、`Thumbs.db`。

> 为什么注入体不入库：它们是 `.user.js` 的派生物，重建只需 `node .playwright-mcp/make-inject.mjs`；
> 而历史上曾因一份**同版本号（1.15.0）的旧快照** `inject-body-1150.js` 导致注入后新代码不生效
> （`boot()` 见版本号相同就沿用旧 DOM），该文件已于 2026-10-20 删除。**别把注入体提交回来。**

### 提交前自检

```powershell
git status --short                    # 确认没有意外新增的注入体/临时文件
node --check "妙手采集箱助手.user.js"
git diff --cached --stat
```

**改了 `妙手采集箱助手.user.js` 必须同步提交**——远端只有这一份可安装的交付物，
留一个未提交的本地改动，等于 GreasyFork 版本检测（§3）与实际代码对不上。

---

## 8. 自检清单

**顺序：先跑真实网页，再考虑脚本。** 脚本只能验「前置条件崩了会不会静默成功」，
验不了选择器对不对、渲染时序来不来得及；能在真页面点出来的结论，优先信真页面（见 §7 第 4 条）。

```powershell
node --check "妙手采集箱助手.user.js"                        # 语法
Select-String -Path "妙手采集箱助手.user.js" -Pattern "发布"  # 红线（应只命中注释/提示文字）

# 改了 judgeSaved / attachVerify / loadSettings 就必须跑这三条（见 §8.1）
node .playwright-mcp/test-judgesaved.mjs      # 19 例：6 该通过 + 13 该失败
node .playwright-mcp/test-attachverify.mjs    # 8 例：失败优先 / 不可用 / 通过 / null / 截断 / noAssertion
node .playwright-mcp/test-settings.mjs        # 7 例：knownTemplates 只迁移一次、不写回/回灌
node .playwright-mcp/test-words-store.mjs     # 27 例 + 3 变异：词库版本库 diff/裁剪/对账/配额/不变量
node .playwright-mcp/test-title-coverage.mjs  # 8 例：虚拟滚动覆盖/收敛 + expected 读不到必须抛错
node .playwright-mcp/test-color-coverage.mjs  # 3 例 + 2 KNOWN：颜色图分页遍历/翻页失败
node .playwright-mcp/mutate-coverage.mjs      # 8 变异：证明上面两个不是恒真（M7 专测 T1）
node .playwright-mcp/make-inject.mjs          # 改了脚本就重跑，重建 inject-body.js
```

改完后注入页面，逐条点 1→9，每步状态栏应为绿色「成功 N/N」。

### 8.1 写「断言/校验类」代码的硬规矩（复核恒真通过的教训）

这一节是**代价最高的一条经验**——同样的错误在 `judgeSaved` 与 `attachVerify` 上犯了两次
（见 `步骤.md` §二 C · 「复核」自己也会恒真通过）。

1. **`return { ok: true }` 要和 `catch {}` 一样警惕。** 写完每个判据分支都问一句
   「输入缺失/异常时，它会不会误报通过」。**默认分支一律不许通过**。
2. **负向用例要覆盖每个分支**，不是"手搓一个错数据"就够 —— 未知输入、缺前值、缺期望值、字段缺失，表驱动写出来。
3. **测试全绿 ≠ 断言有效。必须做变异测试**：把 bug 重新注入，确认测试变红。
   否则你只证明了"正常路径能过"，没证明"坏路径会被抓"。
4. **批量替换后要复核影响面**（`sed`/正则全局替换尤其危险）：函数自我调用、注释、字符串都可能被误伤，
   `node --check` 查不出来。
5. **别用"跑通一次"代替"证明不会误报"**；也别把某个数字对上了当成整体正确的证据。

---

## 9. 事故档案（真实发生过，用来给红线 2/3 作证）

> 写成档案而不是"注意事项"，是因为**纯文字规矩挡不住"我就试一下"**。
> 下面两条都真实发生过，各赔了一次数据/一次越界。

### 9.1 为了验证复核链路，对「未发布」的 1 条商品执行了真实保存

- **做了什么**：审查脚本时，发现 `verifySaved` 的「保存成功 → 复核通过」正向链从没被真实验证过
  （见 §3 未验证项 1）。于是选了未发布列表里 1 条商品（`3465237295`），在「英语标题」面板把
  `multiLanguageTitleMap.en` 设为 `" "`（数据库现值本来就是 `" "`），点了**预览 → 保存修改**。
- **当时的心证**：写一个"与现值相同、业务上等于无变化"的值，应该等于没改。
- **真实后果**：业务字段确实没变（title / en / 颜色 / 图片数 / 模特 / 尺码表 / cid 前后一致），
  但 **`saveDetailTs` 从 1792400905 变成 1792419600** —— 系统认为这条商品被修改过，
  可能进入下一轮同步。
- **教训**：
  - **"无变化"只是业务视角，数据视角它是有变化的。**
  - 审查任务根本不具备写入权限；正确做法是标注「未验证」，或先报方案拿同意。
  - 事后也不该用"属无变化保存"这种措辞把影响说小。

### 9.2 为了验证「选中集旁听器会不会变陈旧」，切到「已发布」勾了 1 条

- **做了什么**：在「已发布 (2687)」筛选下勾了 1 条商品（`3460776764`），打开「批量编辑 → 标题」面板，
  调 `__msxb.verify('title')` 做只读查询，然后用「取消」关闭。
- **当时的心证**：只是打开面板看只读结果，没有保存，应该无害。
- **真实后果**：该条 `saveDetailTs` 至今仍是 `1792225884`（早于本次操作），**数据未被改动**。
  但这属于**红线 2 违规**：已发布是线上在售数据，打开面板本身就是越界。
- **教训**：
  - **"没造成后果"不等于"操作合规"。** 红线管的是行为，不是结果。
  - 验证选中集相关逻辑，用「未发布」+ 改筛选/改勾选**一样能复现**，没有理由碰已发布。

### 9.3 给后来者的自检问句

动手前依次问自己：

1. 当前列表筛选是**「未发布」**吗？（不是就停下）
2. 我接下来要点的按钮里，有没有**保存修改 / 应用至选中 / 应用 / 使用**？（有就停下）
3. 这次操作**需要写入**才能验证吗？（需要就停下，先问）
4. 如果它悄悄改了 `saveDetailTs`，我能接受吗？（不能就别点）
