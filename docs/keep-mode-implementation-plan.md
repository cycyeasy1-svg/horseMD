# 「保持モード（source-backed 編集）」実装計画

> 本書は **新しいセッション（会話履歴なし）でそのまま着手できる**ことを目的とした自己完結型の実装計画である。
> 着手者（AI / 開発者）は、まず本書の「0. 前提・最初に読むもの」を順に読むこと。

---

## 0. 前提・最初に読むもの

着手前に必ず以下を確認する。

1. **動作する参照実装（プロトタイプ）**: `E:\AI\20260624\md-prototype.html`
   - 単一 HTML。Chrome / Edge で開き、`.md` を読み込んで動作確認済み。
   - 本計画の「保持モード」のロジック（解析・セル編集・ブロック源码編集・表フィルタ・差分ゼロ保存）は**すべてこの中に実装済み**。移植元。
2. **検証用ファイル**: `E:\AI\20260624\編集フラグ設定仕様 _old.md`（行末コード混在＝LF と CRLF が混在。`\r` の扱いが要点。後述）
3. **改修対象コード**:
   - `src/renderer/src/App.jsx`（エディタ振り分け・保存・脏标记・モード切替）
   - `src/renderer/src/components/Editor.jsx`（既存 Milkdown 実装。`onReady` API 契約の参考）
   - `src/renderer/src/paths.js`（`isPlainTextDoc` / `isHeavyDoc` / `MD_DOC_RE` 等）
   - `src/renderer/src/styles/app.css`（テーマ変数）
4. **プロジェクト規約**: ルートの `CLAUDE.md`（クロスプラットフォーム規約、Milkdown まわりの非自明な挙動）

---

## 1. 背景とゴール

### 何を解決するか
EasyMarkdown は `.md` を **Milkdown（Crepe / ProseMirror）の WYSIWYG** で開く。Milkdown は
「原文 → 文書モデル → 保存時に全文を再シリアライズ」する構造のため、**1文字直しただけでも全文が
再整形され、想定外の差分**が出る（表セルの空白詰め、箇条書き記号 `-`→`*`、リスト項目間の空行挿入 等）。

対象ユーザーは **Git でチーム管理する Markdown 仕様書**を扱うため、
**「実内容の変更以外の差分を一切出さない（差分ゼロ）」が必須要件**。

### 方針（ユーザー決定済み）
- **方案A を採用**: `.md` は **既定で「保持モード」**で開く。Milkdown は**手動切替**に降格。
- 「保持モード」= **原文テキストを正本として保持し、表示はレンダリング、編集は箇所限定（セル編集／ブロック源码編集）で該当箇所だけ原文に差し戻す**方式。全文再シリアライズをしないので差分ゼロ。
- 代償: Milkdown のような自由 WYSIWYG タイピングではなく、**箇所限定編集**になる（ユーザー合意済み）。
- 追加価値: 表に **Excel 風の列フィルタ**（表示専用・保存に影響なし）を同梱する（元々の要望#3）。

---

## 2. 保持モードの核となる仕組み（プロトタイプより）

`md-prototype.html` の実装を正とする。要点：

1. **原文を1行ずつ `rawLines`（配列）に保持**＝唯一の正本。保存は `rawLines.join('\n')`。
2. **行末コード保持**: ファイルは LF / CRLF が混在しうる。`rawLines` は `\r` 込みでそのまま保持する
   （`text.split('\n')` のまま）。**パースと表示のときだけ `\r` を取り除いた `viewLines` を使う**。
   - これを怠ると、CRLF 行で正規表現（`/^(#{1,6})\s+(.*)$/` の `.` / `$`）が壊れ、
     ディスパッチャと段落除外条件が食い違って **`i` が前進せず無限ループ → 配列オーバーフロー
     （`RangeError: Invalid array length`）**になる。プロトタイプで実際に踏んだ罠。
3. **source map**: パース時に各ブロックの原文行範囲を記録。表は `headerLine` / `dataRows[{lineIdx, cells}]` /
   `headers` を持つ。レンダリングしたセルに `data-line`（原文行 index）と `data-ci`（論理列 index）を埋める。
4. **セル編集**: `replaceCellInLine(line, colIdx, newValue)` が**その行だけ**を未エスケープ `|` で分割し、
   **対象セルの区画だけ**差し替えて結合。他セル・他行・行末 `\r` は不変。
5. **ブロック源码編集**: 非表ブロック（見出し/段落/リスト等）は「改源码」ボタンで原文行を textarea 編集 →
   `rawLines.splice(start, len, ...newLines)`。**元ブロックの行末コード（`\r` 有無）を踏襲**して書き戻す。
6. **表フィルタ**: 列ヘッダの ▼ から値チェック / テキスト検索で行を**視覚的に隠す**だけ（`display:none`）。
   `rawLines` には触れない＝保存に影響なし。複数列は AND。

### プロトタイプから移植する関数（参照名）
- `inline(text)` … 行内描画（太字/斜体/コード/リンク/`<br>` 保持、HTML エスケープ）
- `splitRow(line)` … 表行をセル配列へ
- `parseDoc(lines)` … ブロック source map 生成（`lines` は `\r` 除去済みを渡す）
- `renderTable(b, tableIdx)` / `renderList(b)` … 描画
- `replaceCellInLine(line, colIdx, newValue)` … セル差し戻し
- `openFilterPop(btn)` / `applyFilter(ti)` … 列フィルタ
- `escapeHtml` / `escapeAttr`

> プロトタイプの「差分対照パネル（`lineDiff` 等）」は検証専用。**本体組み込みでは不要**（保存は `rawLines.join` で足りる）。移植しない。

---

## 3. EasyMarkdown 側のアーキテクチャ（調査済みの接続点）

`App.jsx` の現状（行番号は調査時点・前後する可能性あり。シンボルで再特定すること）：

- **エディタ振り分け**（`tabs.map(...)` 内, 約 L1374〜1422）:
  - `heavyAsSource = tab.heavy && !richForced.has(tab.id)`
  - `usesTextarea = isPlainTextDoc(tab) || heavyAsSource || (sourceMode && isLeft)`
  - `usesTextarea` なら `<textarea class="source-editor">`、それ以外は `<Editor>`（Milkdown）を描画。
  - `<Editor onReady={(api)=> editorApis.current[tab.id]=api}>`、`onChange={(md,isInitial)=>updateContent(tab.id, md, isInitial)}`。
- **`updateContent`**（約 L384〜397）: `isInitial && content===savedContent` のとき
  **`savedContent` を Crepe 正規化出力で上書き**（＝差分の元凶）。
  **→ 保持モードはこの経路を使わない。初期 onChange を出さず、`tab.content`（原文バイト）をそのまま正本にする。**
- **脏标记**: `dirty = tab.content !== tab.savedContent`（全体で `tabs.some(...)`）。保持モードでも同一ロジックで成立。
- **`editorApis.current[id]`**: `{ setBlock, getView, getDocHTML, getMarkdown }`。保存・PDF エクスポートがこの契約を使う
  （`getMarkdown` は保存, `getDocHTML` は PDF, 約 L657 / L853）。
- **`editorHostRef`**（L90）: アクティブ富文本ペインの `.ProseMirror` スクロール容器。find / outline / scroll-ratio が参照。
  **保持モードに ProseMirror は無い**ので、ここに依存する機能（find ハイライト等）は v1 で対象外。
- **`richRoot()`**（約 L1120）: `editorHostRef.current?.querySelector('.ProseMirror')`。保持モードでは null になる → 呼び出し側のガード確認。
- **`richForced`**（L124）: heavy 文書を富文本で開くか。今回 **`milkdownForced` をこれに倣って新設**。
- **`sourceMode` / `toggleSource`**（L49 / L270〜302）: 全局生ソース表示。既存維持。
- **コマンドパレット**（約 L1110）: `cmd.source` 等の登録箇所。保持モード切替コマンドを追加。
- **`StatusBar`**（約 L1489）: モード表示/切替の UI 追加候補。
- **tab オブジェクト形状**: `{ id, path, title, content, savedContent, mtimeMs, reloadNonce, heavy }`。
- **外部編集リロード**: `<Editor key={`${tab.id}:${tab.reloadNonce}`}>`。`reloadNonce` 変化で再マウント＝新内容反映。保持モードも同じく key に `reloadNonce` を含める。

---

## 4. 変更ファイル一覧

### 新規
1. **`src/renderer/src/keep-parser.js`**
   移植: `inline` / `splitRow` / `parseDoc` / `replaceCellInLine` / `escapeHtml` / `escapeAttr`、
   および表/リスト描画ヘルパ（または描画は KeepEditor 内でも可）。純関数として切り出し、
   後日 remark(position) 版へ差し替えやすくする。`\r` 保持ロジックの責務境界を明記すること
   （`rawLines` は `\r` 込み、`parseDoc` には `\r` 除去済みを渡す）。

2. **`src/renderer/src/components/KeepEditor.jsx`**
   - props: `{ tabId, initialContent, docPath, onChange, onReady, onOutline }`
   - 内部 state: `rawLines`（`\r` 込み）, `viewLines`（`\r` 除去・描画/解析用）, `blocks`, `filterState`
   - 初期化: `rawLines = initialContent.split('\n')`。**初期 onChange は出さない**（基線上書き防止）。
   - 描画: `viewLines` から HTML を生成して容器へ。非表ブロックに「改源码」ボタン、表はセル `dblclick` 編集＋列フィルタ。
   - 編集確定時のみ `onChange(rawLines.join('\n'), false)` を呼ぶ（`isInitial=false`）。
   - `onReady({ getMarkdown: ()=>rawLines.join('\n'), getDocHTML, setBlock: ()=>{} })`
     - `getDocHTML`: PDF 用に、編集アフォーダンス（ボタン/▼）を除いた描画 HTML を返す。
   - `onOutline`: 見出し `[{level, text, lineIdx, id}]` を親へ渡す（大纲用、任意・低リスク）。
   - 外部リロード対応: 親が `key` に `reloadNonce` を含めるので、再マウントで `initialContent` 反映。
   - **DOM 直接操作**（プロトタイプ流）で良い。React の制御は最小限（容器 ref に innerHTML、イベント委譲）。
     セル編集/フィルタ後は再パース→再描画→フィルタ再適用、の素朴な再描画で良い。

3. **`src/renderer/src/styles/app.css` への追記**
   保持モード用スタイル（表 `.km-table`、列フィルタ `.km-filter-pop`、セル編集入力、改源码ボタン等）。
   **既存テーマ変数（`--bg`, `--border`, `--accent` 等）を使う**。`.app.is-win` / `.app.is-mac` の
   既存方針を壊さない。プロトタイプの `<style>` を流用しつつ、クラス名を衝突しない接頭辞（例 `km-`）に。

### 修正（`App.jsx`）
4. **エディタ振り分けに保持モード分岐を追加**（`usesTextarea` 判定の直後）:
   ```
   const isMd = !isPlainTextDoc(tab)          // .md/.markdown/.mdx
   const usesKeep = isMd && !heavyAsSource && !(sourceMode && isLeft) && !milkdownForced.has(tab.id)
   ```
   - `usesKeep` なら `<KeepEditor>` を描画（`editorApis` / `onChange` / `onOutline` を接続）。
   - **`.md` 既定で `usesKeep=true`**（方案A）。`milkdownForced` に入った tab のみ `<Editor>`（Milkdown）へ。
   - 描画順序・ペイン class・`onPaneFocus`・`order`・`flex` は既存 `<Editor>` と同じ扱い。
   - `editorHostRef` は ProseMirror 用なので保持モードには付けない（find/scroll は v1 対象外）。

5. **`milkdownForced` state 新設**（`richForced` を踏襲, `useState(()=>new Set())`）。
   - 切替ハンドラ: 「Milkdown で編集」→ `milkdownForced.add(id)`、「保持モードに戻す」→ `delete`。
   - **未保存編集がある状態でモード切替する際の整合**に注意：
     - 切替時は最新 `tab.content`（保持モード側が更新済み）を Milkdown の `initialContent` に渡す。
     - Milkdown→保持モードに戻す際、Milkdown が再整形した content をそのまま使うと差分が出るため、
       **未保存なら警告 or 切替前に保存を促す**（v1 は「未保存時は切替前に確認ダイアログ」で可）。
   - 切替トリガ: コマンドパレット項目（`cmd.toggleEditorMode`）＋ ステータスバー/トップバーのボタン。
   - 任意: 選択モードを session（`localStorage["easymarkdown.session.v1"]`）に per-path 保存して次回復元。

6. **大纲接続**（任意・低リスク）: KeepEditor の `onOutline` を既存 Outline パネルに供給。
   既存 outline は `editorHostRef`(ProseMirror) 依存のため、保持モード時は KeepEditor 由来の見出しリストへ分岐。
   クリックで該当要素へスクロール。**難しければ v1 では大纲は保持モード対象外**としてよい。

7. **`.ProseMirror` 前提箇所のガード**: `richRoot()` 他、`editorHostRef` 経由で PM を触る箇所が
   保持モードで null 参照しないことを確認（find 系は v1 で無効化されるので主に防御）。

---

## 5. v1 スコープ

| 機能 | v1 |
|---|---|
| 保持モード描画・セル編集・改源码・**差分ゼロ保存** | ✅ |
| 表 Excel 風列フィルタ（表示専用） | ✅ |
| 脏标记・未保存提醒・PDF エクスポート（`getDocHTML`） | ✅ |
| Milkdown ⇄ 保持モード 手動切替（既定=保持モード） | ✅ |
| 既存: Milkdown / textarea(.txt・heavy・sourceMode) / 分屏 / セッション復元 | ✅ 不破坏 |
| **文档内查找ハイライト（CSS Highlight API）** | ⏸ 対象外（ProseMirror/textarea 前提のため別途） |
| **分屏内での保持モード** | ⏸ 対象外（v1 は分屏は従来通り Milkdown/textarea） |
| 大纲（保持モード） | △ 任意（容易なら入れる、難しければ後回し） |
| remark(position) ベースのロバスト解析器 | ⏸ 後日（インターフェース維持で差し替え） |

### 解析器カバー範囲（v1）
見出し / 段落 / リスト / 表 / コードブロック / 引用 / hr / セル内 `<br>`。
複雑な入れ子・脚注・生 HTML ブロック等は**「段落として原文保持」**＝表示は素朴でも
**改源码で編集可・保存は常に差分ゼロ**。

---

## 6. 実装手順（推奨タスク分解）

1. `keep-parser.js` 作成（プロトタイプの純関数を移植、`\r` 保持の責務境界をコメント明記）。
   - 単体確認: Node で `編集フラグ設定仕様 _old.md` を流し、ブロックが
     `heading paragraph list heading table` になること（無限ループしないこと）を確認。
2. `KeepEditor.jsx` 作成（描画 → セル編集 → 改源码 → フィルタ → `onReady`/`onChange`）。
3. `app.css` にスタイル追記（`km-` 接頭辞、テーマ変数準拠）。
4. `App.jsx` 配線（`usesKeep` 分岐、`milkdownForced`、切替 UI/コマンド、ガード）。
5. 大纲接続（任意）。
6. ビルド & パッケージ動作確認（`npm run dev` / 必要に応じ `npm run build`）。

実装中は TodoWrite でタスク管理すること。

---

## 7. 受け入れ基準（確認手順）

1. `.md`（`編集フラグ設定仕様 _old.md`）を開く → **保持モードで描画**（表含む、無限ループなし）。
2. **表セルを1字変更** → 保存 → `git diff`（or バックアップ比較）が**変更箇所のみ**。
   空白詰め・`-`→`*`・空行挿入などの**想定外差分が出ない**こと。
3. **改源码**で段落/見出し/リストを編集 → 保存 → 同様に差分は編集箇所のみ。
4. **行末コード混在ファイル**でも、未編集行の `\r`/`\n` が保たれる（編集行も元の行末を踏襲）。
5. トップバー/コマンドで **Milkdown に切替 → 戻す**ができる。
6. 表ヘッダ **▼ で列フィルタ** → 行が視覚的に隠れる。フィルタ後に保存しても**差分ゼロ**（フィルタは保存に無影響）。
7. 既存機能の非回帰: `.txt` は textarea、heavy 文書、全局 sourceMode、分屏、Milkdown、セッション復元が従来通り。
8. Windows / macOS 双方でレイアウト破綻なし（純 renderer のため基本問題なし。最低 Windows で確認）。

---

## 8. 注意・落とし穴

- **`\r` を絶対に正規化して捨てない**（差分ゼロ要件を壊す）。`rawLines` は `\r` 込み保持、解析/表示のみ除去。
- **初期 onChange を出さない / `savedContent` を再整形で上書きしない**（差分の元凶を避ける）。
- セル編集の `replaceCellInLine` は**生の行（`\r` 込み）**に対して行い、対象列区画のみ差し替える。
- モード切替で Milkdown を経由した内容は再整形されている可能性 → **保持モードへ戻す際は未保存時に確認**。
- クロスプラットフォーム規約（ルート `CLAUDE.md`）を遵守。`dist/`・`out/` はコミットしない。
- 既存の Milkdown / textarea 経路を壊さないこと（保持モードは**追加**であり置換ではない）。

---

## 9. 参考: プロトタイプの所在と性質

- プロトタイプ: `E:\AI\20260624\md-prototype.html`（単一 HTML、動作確認済み・ユーザー承認済み）。
  - File System Access API（`showOpenFilePicker` / `createWritable`）で原文を読み書き（Chrome/Edge）。
  - 本体組み込みでは IO は EasyMarkdown 既存の fs IPC / 保存フローに置換する（File System Access API は使わない）。
- 本体ではプロトタイプの「差分対照パネル」は不要（移植しない）。
