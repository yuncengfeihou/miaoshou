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
| `妙手采集箱助手.user.js` | **交付物**。油猴脚本 v1.15.0，单文件、零依赖、`@grant none` |
| `步骤.md` | 知识库：能复用的坑与对策、元素定位表、操作顺序。**改脚本前先查这里** |
| `图片1/2/3.png` | 颜色图原始图（本地备份）。脚本实际用网络直链，不读本地文件 |
| `.playwright-mcp/` | 临时产物（快照/日志/注入体/测试脚本）。**注入体产物可删可重建；4 个脚本请保留**：两个 `test-*.mjs`（断言回归）+ 两个 `make-inject*.mjs`（唯一可用的剥头实现，见 §4） |

---

## 3. 当前状态（只写"现在是什么"）

**脚本 v1.15.0，10 步：0 导航 + 1 切筛选 + 2–9。**

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
| 词库 | 只在点「立即更新」时才写，输入框不自动保存 |
| 落库复核 | 每步保存后调接口核对结果（v1.15.0，见 §5.6） |
| 版本检测 | 每次刷新比对 GreasyFork `/scripts/600852.json`，不一致显示「更新」 |

**版本演进不在此记录。** 想知道某处为什么这样写，按主题查 `步骤.md` 的坑 39–64（坑 63/64 是落库复核）。

**未验证/未做**（接手先看）：

1. **`verifySaved` 从未在真实保存后跑过。** 逻辑已用「未保存状态」做负向验证（该失败的失败、该通过的通过），
   但「保存成功 → 复核通过」这条正向链**没有真实数据确认**。这是当前最大的空白。
2. **整链 0–9 未做长时间稳定性验证。** 单步实测过，全链约 4 分钟；工具调用 >100s 会被截断（非脚本失败），
   验证要分段观察。
3. **第 1 个商品的颜色图有重复**（历史遗留，用户明确**暂不清理**）。要修得在颜色图面板手工删图。
4. **`productTpl` / `skuTpl` 两步的复核只能"见证"不能"断言"** —— 接口不暴露模板 id（见 §5.6）。

---

## 4. 环境与运行方式

**目标环境**：妙手 ERP，已登录，页面 `/pddkj/collect_box/` 才注入面板。

**用户使用**：装 Tampermonkey → 新建脚本粘贴全文 → 打开采集箱页 → 右侧出现面板。
建议**逐条点**而非「一键编辑」跑全链，每步看状态栏「成功 N/N」。

**Agent 调试注入**：

```js
// 1) 去掉 UserScript 头，生成可注入体
// ⚠ 结束标记是 `// ==/UserScript==`（带斜杠）。这里曾误写成 `// ==UserScript==`，
//   实测剥后长度 173113 → 173113，**一个字符都剥不掉**（最终审查报告 P2-6）。
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
| 分页条数 | `.pro-pagination .jx-select__input`；当前值在 `innerText`（`500条/页`），**不在 input.value** | 真实页面打印 DOM，`input.value` 为空 |
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
5. **模板类两步（3/4）只能"见证"** —— `templatePid`(1755426) 与 `itemTemplateId`(1062367)、
   `skuPropTemplateId`(575646) **都不在一个号段**，接口也不返回"用了哪个模板"。这两步标注 `noAssertion`，
   不要假装它是硬断言。

> **验证方式**：把 `__msxb.selection` 打出来看抓到的 id 数（应等于选中数）；
> 在**未保存**的预览上调 `__msxb.verify(stepId)`，应报大量失败；
> 对已处理好的数据调同一接口，应报 0 失败。两边都对上，说明判据没恒真也没误伤。

**显示语义**：复核失败**不把步骤判成 error**（数据已落库，报失败会诱导重跑 → 二次改标题），
而是记为 done + 状态行「已保存 · 落库复核未通过 N/M 条」+ 红色 toast。

---

## 6. 脚本结构

```
CFG              配置：模板名 / 模特 / 试穿码 / 前缀 / 删词库 / 图片直链 / 颜色名
makeTitleBuilder 标题改写纯函数（预览改写与落库复核共用同一份；实测幂等）

基础工具          sleep(可打断) / waitFor / findByText / isVisible / clickEl
                  setNativeValue(原生 setter，绕 Vue 受控) / readAndCloseResultDialog

未发布守卫        collectStatusTabs / filterNameOfTab / currentCollectFilter
                  unpublishedTab / ensureUnpublishedFilter / assertUnpublishedOnly
                  （两层：① 步骤 1 主动切换到「未发布」；② 写入前断言。
                    README 优先级：先读 input.value 枚举，读不到才退回文本）

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

---

## 7. 协作约定

1. **禁止发布** —— 见 §1。
2. **只碰「未发布」** —— 见 §1.1 红线 2。切到「全部 / 已发布」后勾选任何商品都算违规，
   **调试/取样/验证也不行**。代码侧有 `assertUnpublishedOnly()` 兜底（§6）。
3. **审查/调试禁止任何写入** —— 见 §1.1 红线 3。「未点保存」不等于「没动数据」：
   点了预览区的「保存修改」就会刷新 `saveDetailTs`。审查只准只读或改前端预览。
4. **改脚本必实测**：`node --check` 通过**不算完成**。必须注入真实页面把受影响步骤跑一次。
   ⚠ 但「实测」的边界是红线 2/3 —— 只能对**未发布**的样本、只做**非写入**的验证。
   需要写入才能验证的，先报方案、拿同意，或标注「未验证」。
5. **实测发现的新坑回写 `步骤.md`**（按主题归类，不要再按版本号堆）。
6. **不要擅自清理业务数据**（如重复颜色图），先征得同意。
7. **临时产物放 `.playwright-mcp/`**。

---

## 8. 自检清单

```powershell
node --check "妙手采集箱助手.user.js"                        # 语法
Select-String -Path "妙手采集箱助手.user.js" -Pattern "发布"  # 红线（应只命中注释/提示文字）

# 改了 judgeSaved / attachVerify 就必须跑这两条（见 §8.1）
node .playwright-mcp/test-judgesaved.mjs      # 19 例：6 该通过 + 13 该失败
node .playwright-mcp/test-attachverify.mjs    # 6 例：失败优先 / 不可用 / 通过 / null / 截断
node .playwright-mcp/make-inject.mjs          # 改了脚本就重跑，重建 inject-body.js
```

改完后注入页面，逐条点 1→9，每步状态栏应为绿色「成功 N/N」。

### 8.1 写「断言/校验类」代码的硬规矩（坑 62/64 的教训）

这一节是**代价最高的一条经验**——同样的错误在坑 62 和坑 64 犯了两次。

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
