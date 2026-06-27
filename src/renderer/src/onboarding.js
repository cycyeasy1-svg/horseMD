// First-run guide, shown as the first tab after install — and also written to
// the program directory as README.md at package time (scripts/gen-readme.mjs).
// Positioned as a usage guide; the focus is "keep mode" (source-backed, zero-diff
// editing), which is the day-to-day editing experience for `.md` files.
//
// NOTE: keep mode renders a paragraph's source lines joined with <br>, so each
// paragraph / list item MUST stay on ONE physical line here — a hard wrap would
// show up as a visible line break. Let the editor soft-wrap on screen.

const EN = `# EasyMarkdown — User Guide 📝

**EasyMarkdown** is a warm, Typora-style **Markdown editor**. Every file opens as a **tab in one window**, not a new app. Browse a whole folder in the sidebar, flip between files in tabs, and edit \`.md\` in **keep mode** — a source-backed editor that saves a *zero-diff* result (only the bytes you actually changed).

> This guide also ships as \`README.md\` in the program folder. Edit this tab or close it — it won't appear again on the next launch.

## Two editing modes

\`.md\` / \`.markdown\` / \`.mdx\` open in **keep mode by default**. \`.txt\` and very large files open in a plain-text editor.

- **Keep mode (default)** — the original file text *is* the source of truth. Rendering is read-only; you edit in place, one spot at a time, and saving never re-formats the rest. Built for Markdown specs tracked in Git, where stray diffs are not acceptable.
- **Milkdown mode** — the most free-form WYSIWYG typing (slash menu, formatting toolbar, LaTeX, Mermaid, image preview), great for drafting from scratch. **Trade-off: on save it re-serializes the whole document, so it may change the original formatting** — whitespace, list markers \`-\`/\`*\`, blank lines, table alignment — and cannot guarantee a zero diff. That is exactly why \`.md\` defaults to keep mode. Switch with the **Keep / Milkdown** button at the bottom-right, or the command palette (\`Ctrl+P\` → *Toggle Editor Mode*). Switching back to keep mode warns you about unsaved changes, since the re-flowed text would be carried over.

## Keep mode: editing (the important part)

- **Edit a table cell** — *double-click* it, type, \`Enter\` to confirm / \`Esc\` to cancel. Only that one cell on that one line is rewritten; everything else stays byte-for-byte. Cells containing \`<br>\` open in a multi-line box.
- **Edit content (block source)** — for a paragraph, heading, list or quote, click the **Edit content** button at the block's top-right, change the raw text in the box, and confirm. Only that block's lines are replaced.
- **Add / remove table rows & columns** — *right-click* a cell: insert row above / below, delete row, insert column left / right, delete column (the last column is protected).
- **Excel-style column filter** — click the **▼** on a column header, then check values or search to temporarily hide rows. Multiple columns combine with AND; the status bar shows \`Filtered X/Y\`. **Display only — it never touches the file or affects saving.**
- **Zero-diff save** — no re-formatting, no whitespace/bullet/quote churn, line endings preserved (mixed LF/CRLF kept as-is). \`git diff\` shows exactly the edits you made and nothing else.

Keep mode renders headings, paragraphs, lists, tables, code blocks, quotes and horizontal rules, with inline **bold**, *italic*, \`code\`, links and \`<br>\`. For slash commands, LaTeX math, Mermaid diagrams and inline image preview, switch to Milkdown mode.

## General features

- **Tabs** — many files in one window (\`Ctrl+Tab\` to cycle). Right-click a tab to close others / to the left / to the right.
- **Folder workspace** — a file tree on the left; create, rename, delete in place.
- **Command palette** (\`Ctrl+P\`) — fuzzy-jump to any file or command.
- **Outline panel** — click a heading to jump; follows your edits live.
- **Find** (\`Ctrl+F\`) — search text, or click the mode button to switch to **Go to line** and jump by line number.
- **Themes** — Warm Light / Dark plus three **Morandi** palettes, and Typora-compatible custom \`.css\` themes.
- **Languages** — English / 中文 / 日本語, switchable anytime (bottom-right).
- **Ctrl/Cmd + Click** a link to open it in your browser; relative-path images just work; external edits to an open file reload automatically.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New file | \`Ctrl+N\` |
| Open file / folder | \`Ctrl+O\` / \`Ctrl+Shift+O\` |
| Save / Save As | \`Ctrl+S\` / \`Ctrl+Shift+S\` |
| Command palette | \`Ctrl+P\` |
| Find in file | \`Ctrl+F\` |
| Toggle sidebar / outline | \`Ctrl+B\` / \`Ctrl+Shift+L\` |
| Toggle source mode | \`Ctrl+/\` |
| Cycle theme | \`Ctrl+Shift+T\` |

Happy writing! ✨
`

const ZH = `# EasyMarkdown 使用说明 📝

**EasyMarkdown** 是一款温暖的 Typora 风 **Markdown 编辑器**。每个文件都在同一个窗口里作为**标签页**打开，而不是新开一个程序。在侧边栏浏览整个文件夹，用标签页切换文件，并以**保持模式**编辑 \`.md\` —— 一种以原文为正本的编辑方式，保存结果**零差分**（只改你真正动过的字节）。

> 这份说明也会随安装包放到程序目录下的 \`README.md\`。你可以编辑本页或直接关掉它 —— 下次启动不会再出现。

## 两种编辑模式

\`.md\` / \`.markdown\` / \`.mdx\` **默认用保持模式**打开；\`.txt\` 和超大文件用纯文本编辑器打开。

- **保持模式（默认）** —— 文件原文**就是正本**。渲染只用于显示，编辑是逐处进行的，保存绝不会重排其余内容。专为用 Git 管理的 Markdown 规范文档设计，不容忍多余差分。
- **Milkdown 模式** —— 自由度最高的所见即所得输入（斜杠菜单、格式工具条、LaTeX、Mermaid、图片预览），适合从零起草、随手排版。**代价：保存时会把整篇文档重新序列化，可能改动原有格式**——空白、列表符号 \`-\`/\`*\`、空行、表格对齐等，无法保证零差分。这正是 \`.md\` 默认用保持模式的原因。用右下角的 **保持 / Milkdown** 按钮切换，或命令面板（\`Ctrl+P\` → *切换编辑器模式*）。从 Milkdown 切回保持模式时，若有未保存内容会先提示，因为重排后的文本会被带回。

## 保持模式：编辑功能（重点）

- **编辑表格单元格** —— **双击**单元格输入，\`Enter\` 确认 / \`Esc\` 取消。只改这一格、这一行，其余字节原样不动。含 \`<br>\` 的单元格会用多行文本框编辑。
- **内容编辑（改源码）** —— 段落、标题、列表、引用等块，点块右上角的 **内容编辑** 按钮，在文本框里改原文后确认，只替换该块所在的行。
- **表格行列增删** —— 在单元格上**右键**：上方/下方插入行、删除本行、左侧/右侧插入列、删除本列（最后一列受保护，不能删）。
- **Excel 式列筛选** —— 点表头的 **▼**，勾选取值或搜索，临时隐藏不需要的行。多列之间为 AND；状态栏显示「筛选 X/Y」。**仅影响显示，绝不写入文件、不影响保存。**
- **零差分保存** —— 不重排版，不动空白/符号/引用，行尾保留（LF/CRLF 混排原样保留）。\`git diff\` 里只出现你真正改动的那几处，别无其他。

保持模式可渲染标题、段落、列表、表格、代码块、引用、分隔线，以及行内 **粗体**、*斜体*、\`代码\`、链接和 \`<br>\`。需要斜杠菜单、LaTeX 公式、Mermaid 图、行内图片预览时，切到 Milkdown 模式。

## 通用功能

- **标签页** —— 一个窗口开多个文件（\`Ctrl+Tab\` 循环）。标签右键可关闭其他/左侧/右侧。
- **文件夹工作区** —— 左侧文件树，可原地新建 / 重命名 / 删除。
- **命令面板**（\`Ctrl+P\`）—— 模糊跳转到任意文件或命令。
- **大纲面板** —— 点标题跳转，随编辑实时更新。
- **查找**（\`Ctrl+F\`）—— 文本检索，或点模式按钮切到**按行号定位**，输入行号跳转。
- **多套主题** —— 暖光 / 暖夜，外加三套**莫兰迪**配色，并支持 Typora 兼容的自定义 \`.css\` 主题。
- **多语言** —— 英文 / 中文 / 日文随时切换（右下角）。
- 按 **Ctrl/Cmd 点击**链接用浏览器打开；相对路径图片开箱即用；外部修改正在打开的文件会自动刷新。

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建文件 | \`Ctrl+N\` |
| 打开文件 / 文件夹 | \`Ctrl+O\` / \`Ctrl+Shift+O\` |
| 保存 / 另存为 | \`Ctrl+S\` / \`Ctrl+Shift+S\` |
| 命令面板 | \`Ctrl+P\` |
| 文件内查找 | \`Ctrl+F\` |
| 切换侧边栏 / 大纲 | \`Ctrl+B\` / \`Ctrl+Shift+L\` |
| 切换源码模式 | \`Ctrl+/\` |
| 切换主题 | \`Ctrl+Shift+T\` |

祝写作愉快！✨
`

const JA = `# EasyMarkdown 使い方ガイド 📝

**EasyMarkdown** は温かみのある Typora 風の **Markdown エディタ**です。すべてのファイルを新しいアプリではなく、同じウィンドウの**タブ**として開きます。サイドバーでフォルダ全体を見渡し、タブでファイルを切り替え、\`.md\` を**キープモード**で編集します —— 原文を正本として保持し、保存結果が**差分ゼロ**（実際に変更したバイトだけ）になる方式です。

> このガイドは、プログラムフォルダ内の \`README.md\` としても同梱されます。このタブは編集しても閉じても構いません —— 次回起動時には表示されません。

## 2 つの編集モード

\`.md\` / \`.markdown\` / \`.mdx\` は**既定でキープモード**で開きます。\`.txt\` や非常に大きなファイルはプレーンテキストエディタで開きます。

- **キープモード（既定）** —— ファイルの原文が**正本そのもの**です。描画は表示専用で、編集は箇所ごとに行い、保存で残りが再整形されることはありません。Git で管理する Markdown 仕様書のように、余計な差分が許されない用途のために作られています。
- **Milkdown モード** —— 自由度が最も高い WYSIWYG 入力（スラッシュメニュー、書式ツールバー、LaTeX、Mermaid、画像プレビュー）。ゼロから書き起こすのに向きます。**代償：保存時に文書全体を再シリアライズするため、元の書式が変わることがあります**——空白、リスト記号 \`-\`/\`*\`、空行、表の桁揃えなど。差分ゼロは保証されません。これが \`.md\` を既定でキープモードにしている理由です。右下の **キープ / Milkdown** ボタン、またはコマンドパレット（\`Ctrl+P\` → *エディタモードを切り替え*）で切り替えます。キープモードへ戻す際は、再整形後のテキストが引き継がれるため、未保存の変更があると警告します。

## キープモード：編集機能（重要）

- **表セルの編集** —— セルを**ダブルクリック**して入力、\`Enter\` で確定 / \`Esc\` で取消。そのセル・その行だけが書き換わり、他はバイト単位でそのままです。\`<br>\` を含むセルは複数行の入力欄で編集します。
- **内容を編集（ソース編集）** —— 段落・見出し・リスト・引用などのブロックは、右上の **内容を編集** ボタンから原文を書き換えて確定します。そのブロックの行だけが置換されます。
- **表の行・列の追加／削除** —— セルを**右クリック**：上に/下に行を挿入、行を削除、左に/右に列を挿入、列を削除（最後の 1 列は保護され削除できません）。
- **Excel 風の列フィルタ** —— 列ヘッダの **▼** をクリックし、値のチェックや検索で行を一時的に隠します。複数列は AND。ステータスバーに「絞り込み X/Y」と表示。**表示専用で、ファイルには一切触れず、保存にも影響しません。**
- **差分ゼロ保存** —— 再整形なし、空白・記号・引用の揺れなし、改行コードも保持（LF/CRLF 混在もそのまま）。\`git diff\` には実際に編集した箇所だけが現れます。

キープモードは見出し・段落・リスト・表・コードブロック・引用・水平線を描画し、インラインの **太字**・*斜体*・\`コード\`・リンク・\`<br>\` に対応します。スラッシュコマンド、LaTeX 数式、Mermaid 図、インライン画像プレビューが必要な場合は Milkdown モードに切り替えてください。

## 共通機能

- **タブ** —— 1 つのウィンドウで複数ファイル（\`Ctrl+Tab\` で切替）。タブ右クリックで他を閉じる/左側を閉じる/右側を閉じる。
- **フォルダワークスペース** —— 左のファイルツリーで作成・名前変更・削除をその場で。
- **コマンドパレット**（\`Ctrl+P\`）—— 任意のファイルやコマンドへあいまい検索でジャンプ。
- **アウトラインパネル** —— 見出しをクリックでジャンプ。編集に追従。
- **検索**（\`Ctrl+F\`）—— テキスト検索、またはモードボタンで**行番号ジャンプ**に切り替え。
- **テーマ** —— 暖かいライト / ダークに加え 3 種の **モランディ** パレット、Typora 互換のカスタム \`.css\` テーマにも対応。
- **多言語** —— 英語 / 中文 / 日本語をいつでも切り替え（右下）。
- リンクは **Ctrl/Cmd + クリック** でブラウザで開く。相対パス画像もそのまま動作。開いているファイルが外部で編集されると自動的に再読み込み。

## キーボードショートカット

| 操作 | ショートカット |
| --- | --- |
| 新規ファイル | \`Ctrl+N\` |
| ファイル / フォルダを開く | \`Ctrl+O\` / \`Ctrl+Shift+O\` |
| 保存 / 名前を付けて保存 | \`Ctrl+S\` / \`Ctrl+Shift+S\` |
| コマンドパレット | \`Ctrl+P\` |
| ファイル内検索 | \`Ctrl+F\` |
| サイドバー / アウトライン切り替え | \`Ctrl+B\` / \`Ctrl+Shift+L\` |
| ソースモード切り替え | \`Ctrl+/\` |
| テーマ切り替え | \`Ctrl+Shift+T\` |

楽しく執筆を！✨
`

export function welcomeDoc(lang) {
  const title =
    lang === 'zh'
      ? 'EasyMarkdown 使用说明.md'
      : lang === 'ja'
        ? 'EasyMarkdown 使い方ガイド.md'
        : 'EasyMarkdown User Guide.md'
  const content = lang === 'zh' ? ZH : lang === 'ja' ? JA : EN
  return { title, content }
}

// All three languages (中文 → 日本語 → English), for the README.md shipped in
// the program directory.
export function readmeDoc() {
  const nav = '> 中文 · 日本語 · English\n'
  return [nav, welcomeDoc('zh').content, welcomeDoc('ja').content, welcomeDoc('en').content].join(
    '\n\n---\n\n'
  )
}
