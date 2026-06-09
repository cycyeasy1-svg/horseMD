# 实现笔记：踩过的坑、根因与决策

这份文档记录开发过程中发现的关键问题、根本原因、修复方式，以及一些设计决策。很多 bug 是用 CDP 端到端实测（见 [development.md](./development.md)）才定位到的。

---

## 致命 bug 1：所有"视图相关"功能静默失效

**现象**：改标题层级的按钮"点不动"、`Ctrl+1/2/3` 没反应（数字还被打进正文）、右键菜单不弹、选中浮条不出现、Ctrl+点链接/富文本复制/图片解析全不工作。

**根因**：这些功能都依赖底层 ProseMirror 的 `EditorView`，而代码用 `crepe.editor.view` 取它 —— 在本项目的 Milkdown 版本里这是 `undefined`。于是所有 `if (view) { … }` 的逻辑从未执行，监听器一个都没挂上。

**修复**（`Editor.jsx`）：
```js
import { editorViewCtx } from '@milkdown/kit/core'
const view = crepe.editor.ctx.get(editorViewCtx)   // 不是 crepe.editor.view
```

**教训**：一个底层引用取错，会让一大片上层功能"看起来各自坏了"，其实是同一个根。

---

## 致命 bug 2：编辑内容不同步、保存会丢编辑

**现象**：编辑器里改了内容，但大纲不更新、字数不变、"● 已修改"不亮 —— 最严重的是 `Ctrl+S` 会把文件存回**初始内容**，悄悄丢掉所有编辑。

**根因**：内容变更回调 `markdownUpdated` 注册在 `crepe.create()` **之后**。Crepe 在 `create()` 时就把监听器接好了，之后再注册的永远不触发，于是 `tab.content` 一直停在打开时的初始值，所有派生状态（大纲/字数/脏标记/保存内容）都跟着冻结。

**修复**（`Editor.jsx`）：把 `crepe.on(markdownUpdated)` 移到 `create()` **之前**。

```js
crepe.on((api) => api.markdownUpdated((_ctx, md) => { if (ready) onChange?.(md, false) }))
await crepe.create()
```

---

## bug 3：选中/双击时内容整体上移 + 表格里看不见光标

**现象**：在编辑器里选中段落或双击时，内容会"整体向上跳"；表格单元格里完全看不到光标。

**根因**：Crepe 默认开启 **virtual cursor**（`prosemirror-virtual-cursor`），用一个自定义元素替换原生光标。它在选区/聚焦时往文本流里插入元素 → 触发回流（内容跳动）；同时把原生光标设为透明 → 表格里看不见。

**修复**：
- `Editor.jsx` 关闭该特性：`[CrepeFeature.Cursor]: false`，改用原生光标
- `styles/app.css` 给原生光标上色：`caret-color: var(--accent)`，并显式覆盖表格单元格
- 顺手去掉 `.editor-scroll` 的 `scroll-behavior: smooth`（它把每次隐式滚动变成肉眼可见的滑动），加 `overflow-anchor: none`

---

## bug 4：选中浮条永远不出现

**现象**：选中文字后，自研的浮动控件不显示。

**根因**：判断条件用了 `sel instanceof TextSelection`，而 Crepe 自带一份打包好的 `prosemirror-state`，view 的 selection 是它那份 `TextSelection` 的实例，跟我们 `import` 的不是同一个类 → `instanceof` 永远 false。

**修复**：改成鸭子类型判断（`sel.empty || sel.from === sel.to`），不依赖 `instanceof`。

> 后来该浮条整体被"工具条注入按钮"方案替代（见下）。

---

## bug 5：右键菜单/上下文相关的时序假象

**现象**：自动化测试里右键菜单"没打开"。

**根因**：是测试脚本的时序问题 —— 原生监听器调 React `setState` 是异步渲染，脚本同步查 DOM 太早。给测试加上等待后即正常。

**教训**：区分"真 bug"和"测试方法的假象"很重要。多个最初看似失败的项（键盘转换、浮条、图片）最后都被证明是 CDP 合成事件的局限（合成拖拽不驱动 ProseMirror 选区、`requestAnimationFrame` 在窗口被遮挡时被节流等），而非应用本身的问题。

---

## bug 6：标签去重竞态（会话恢复出现重复标签）

**现象**：恢复会话时出现多个重复的 README 标签。

**根因**：`openPaths` 用 `setTabs` 回调异步读 `existing`，但紧接着同步判断，读不到刚加的，导致同一文件被重复打开。

**修复**：用一个始终最新的 `tabsRef` 同步快照来去重 + 调用内 `seen` 集合去重。会自愈（下次恢复时折叠重复项）。

---

## 决策：改标题层级整合进 Crepe 工具条

需求是把"改层级"做成加粗/斜体工具条里的一个按钮，悬浮展开 H1/H2/H3/¶。Crepe 工具条的 `buildToolbar` 只支持扁平的"图标+点击"，**不支持子菜单**。

**做法**：用 `MutationObserver` 监听 `.milkdown-toolbar` 出现，往里注入自己的 `.hm-heading-item` DOM，CSS `:hover` 展开子菜单。两个坑：
- Crepe 工具条 `overflow: hidden` 会裁掉子菜单 → 覆盖成 `overflow: visible`
- 注入用了 `requestAnimationFrame` 节流，但窗口被遮挡时 rAF 几乎不触发 → 改成同步注入（幂等）

---

## bug 7：Ctrl+B 切侧边栏时灵时不灵

**现象**：按 `Ctrl+B` 想切侧边栏，但经常不生效，或被编辑器拿去加粗。

**根因**：`Ctrl+B` 在主进程菜单注册成了加速器，而编辑器（ProseMirror）也把 `Mod-B` 绑成加粗 —— 冲突，编辑器经常先吃掉这个按键。

**修复**：
- 主进程移除 `Toggle Sidebar` 的 `CmdOrCtrl+B` 加速器（避免和渲染层双触发）
- 渲染层在 **捕获阶段** 监听 `Ctrl/Cmd+B`，先于编辑器处理：切侧边栏 + `preventDefault/stopPropagation`（编辑器收不到 → 不加粗）
- `metaKey` 一并判断，macOS 的 `Cmd+B` 同样生效

---

## 决策：应用图标

- 源图 `icon.png`，用脚本生成多分辨率 `build/icon.ico`（16–256），并裁出 **22% 圆角**（圆角外透明），避免硬直角
- macOS 图标 `build/icon.icns` 同样由 `icon.png` 生成（`iconutil`，16–1024 全尺寸）；`build.mac.icon` 指向它
- `package.json` 的 `build.win.icon` / `nsis` / 文件关联都指向 ico
- 首页 logo 用图标副本 `src/renderer/src/assets/logo.png`（CSS 加圆角）

> 注意：`System.Drawing.Icon` 解码不了 PNG 内嵌的 ICO 帧（会渲染成噪点），这是验证工具的局限，不代表 ICO 坏了 —— Windows / electron-builder 能正常读。

---

## 决策：窗口拖拽区域

无边框标题栏下，拖拽区由 `-webkit-app-region` 决定。最初 `.tabs` 被设成 `no-drag`，而标签容器占了顶栏绝大部分宽度 → 几乎整条顶栏不能拖。改成：标签**容器背景**可拖（`.tabs/.tabs-scroll`），只有标签页/按钮 `no-drag`；活动栏空白也可拖。

---

## bug 8：.txt 大文件卡死 / 加载不出来

**现象**：同样长度的内容，`.md` 秒开流畅，`.txt` 很卡甚至加载不出来。

**根因**：两者走同一条渲染路径，都被丢进 Milkdown。`.md` 段落间有空行 → 解析成很多小段落块，ProseMirror 轻松渲染；而 `.txt` 通常是"行行相连、没有空行" → 在 Markdown 里被当成**一整个超大段落**，内含几千个换行节点。ProseMirror 渲染单个超大文本块极慢，文件一大就卡死。附带问题：纯文本的换行被折叠、`*`/`#` 被误当语法。

**修复**（`App.jsx`）：按扩展名路由编辑器 —— `.md/.markdown/.mdx`（及无路径的新建文档）走 Crepe；`.txt` 等带路径的非 Markdown 文件走 `textarea`（瞬开、保留换行、不解析语法）。判定用 `MD_DOC_RE` / `isPlainTextDoc`。

> 顺带修了一个放大器：原来富文本路径给**每个**标签都挂 Crepe（哪怕隐藏），重型 txt 即使在后台也拖慢全局。现在纯文本标签只在激活时渲染。

---

## 决策：macOS 标题栏布局（红绿灯不交叉）

macOS 用 `titleBarStyle: 'hiddenInset'`，红绿灯（关/最小/最大）浮在左上角。最初它们横跨"活动栏(深色)"和"顶栏"两块背景之间，中间有色缝 → 看起来"交叉"在界面里；按钮还会压住第一个标签。

**做法**（仅 `.app.is-mac`，不影响 Windows）：
- 主进程固定 `trafficLightPosition: { x: 14, y: 14 }`，让渲染层能精确让位
- 顶栏横跨整个宽度成为一条**独立标题栏**（`grid-column: 1 / -1` + `padding-left` 给红绿灯留位）
- 活动栏下移到标题栏**下方**（`grid-row: 2 / -1`）→ 红绿灯落在同一条背景上、自成一行，不再交叉

> 平台样式一律写在 `.app.is-win` / `.app.is-mac` 选择器下；改顶栏时两个系统都要验证。

---

## bug 9：查找会匹配到查找框自己 + 上下一个卡顿

**现象**：`Ctrl+F` 查找时，输进查找框的字本身也会被算成一处命中；next/prev 还有可感知的延迟。

**根因**：旧实现用 `window.find`（会扫描整页，包含查找框这种 UI 文本），且依赖 IPC/原生选区往返。

**修复**（`App.jsx` 的 find-in-document helpers）：改用 **CSS Custom Highlight API**（`CSS.highlights` + `Highlight`）。只在编辑器正文（富文本 `view.dom` 或源码 `<textarea>`）里收集匹配区间并上色，**不碰查找框、不改 DOM、不插标记节点** —— 既不会匹配到自己，也不污染文档、不触发重排。当前命中用单独的 highlight 名（`hm-find-current`）高亮，上下一个纯前端切换，无 IPC 往返，并实时显示 `当前/总数`。不支持该 API 的环境优雅降级（`findHighlightSupported`）。

---

## 决策：Windows 自绘窗口按钮（弃用 titleBarOverlay）

最初 Windows 用 Electron 的 `titleBarOverlay`（系统画最小/最大/关闭）。为了能自定义 hover 态（关闭悬浮变红）并和整体配色一致，改成**渲染层自绘**三个按钮。

**做法**：
- 主进程关掉 `titleBarOverlay`，加 `window:minimize/toggleMaximize/close/isMaximized` IPC（`main/index.js`）
- 真实窗口状态会被外部操作改变（双击拖拽最大化、系统快捷键），所以主进程监听 `maximize/unmaximize` 推 `window:maximized`，渲染层据此翻"最大化/还原"图标 —— 否则图标会和实际状态脱节
- `WindowControls` 仅在 `platform === 'win32'` 渲染（macOS 保留原生红绿灯）

---

## bug 10：标签塞满后整条标题栏拖不动

**现象**：开很多标签把标签条占满后，顶栏几乎没有空白可拖动窗口。

**修复**：始终为标题栏保留一块可拖动区域（即使标签铺满整条），见 `App.jsx` / `styles/app.css` 的拖拽区调整。延续[窗口拖拽区域](#决策窗口拖拽区域)的思路 —— 标签/按钮 `no-drag`，但容器留出可拖背景。

---

## bug 11：卸载会连带删掉用户文件

**现象**：把 Markdown 笔记存在安装目录旁边，卸载 HorseMD 时会被一并清空。

**根因**：NSIS 卸载默认对安装目录做整体递归删除。

**修复**（`build/installer.nsh`）：卸载器只删 HorseMD 自己装进去的文件，保留用户文件；同时把安装位置固定到**专属的 per-user 目录**，避免被装进用户自己的文件夹里。属于 Windows 专有，不影响 macOS。

---

## 决策：源码/富文本切换保持滚动、不重建后台编辑器

切换"源码 / 富文本"时，保留当前滚动位置，且不重建后台（非激活标签）的编辑器实例，使切换明显更快（`App.jsx`）。配合"富文本标签首次激活后常驻挂载、纯文本标签按需渲染"的策略，避免每次切换都重挂一堆 Crepe。

---

## 性能：大文档卡顿 & 重开恢复很慢

**现象**：打开 8 万字符以上的大文档明显比 Typora 慢、卡；关掉重开（自动恢复上次的标签）时也很卡。

**根因**（用 CDP 做了优化前后 A/B 实测）：
1. **重开恢复**：旧版**所有 Markdown 标签一律常驻挂载**——恢复会话时会**同时创建 N 个 Crepe 编辑器**，每个在主线程上同步解析整篇 Markdown。实测恢复 4 个标签 = 启动瞬间建 4 个编辑器。这是"重开很卡"的主因。
2. **大文档打字**：v0.1.4 加的浮动块级标记绑在 `selectionchange` 上（每次按键都触发），每次都做 `coordsAtPos` + `getBoundingClientRect` 这类**强制同步重排**，在巨大 DOM 上很贵；选中工具条的 `MutationObserver` 监听整个 `document.body` 子树，**任何 DOM 变动都跑一次全文档 `querySelectorAll`**，多个编辑器挂载时还要乘以个数。

**修复**：
- **编辑器懒加载**（`App.jsx`）：用 `mountedIds` 记录"被激活过"的标签，标签**只在首次激活时**才渲染 `<Editor>`（创建 Crepe），之后保持挂载（切换仍即时）。恢复会话时只有当前激活的标签会建编辑器——实测恢复时挂载数从 **4 → 1**。
- **块级标记 rAF 节流**（`Editor.jsx` 的 `scheduleLevel`）：`selectionchange` / 滚动把多次测量合并成**每帧一次**；未聚焦的编辑器直接跳过。
- **工具条监听去抖**（`Editor.jsx`）：只在 mutation **真正新增节点**时才重扫，且每帧合并一次，不再每次编辑都全文档查询。

**结果**：恢复挂载 4→1；大文档冷启动到渲染完约 0.87s；打字尾帧（p99）有改善。

> 仍有地板：Crepe/Milkdown 的 `markdownUpdated` 监听器**每次按键都把整篇文档序列化成 Markdown**（库内部机制，我们靠它拿内容做保存/大纲/字数）。这是大文档打字的固定开销，去不掉——除非改成"空闲/保存时才序列化"，那是更大、更有风险的改动（整条内容数据流都依赖逐键回调，见上文"编辑器内容数据流"），留作后续单独处理。
