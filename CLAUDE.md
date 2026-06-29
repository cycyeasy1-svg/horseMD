# CLAUDE.md

Guidance for Claude / AI agents (and new devs) working in this repo. Keep it
short; deep detail lives in [`docs/`](./docs/).

## What this is

**EasyMarkdown** — a warm, Typora-style Markdown editor. Electron shell + Vite +
React, with **Milkdown Crepe** (ProseMirror-based WYSIWYG) as the editor engine.
Core idea: every file opens as a **tab in one window**, not a new process. The
shell (tabs, file tree, command palette, outline, themes, i18n, welcome screen)
is all hand-written.

## Commands

```bash
npm install            # if Electron download is slow: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev            # electron-vite dev (HMR)
npm run build          # build main + preload + renderer → out/
npm start              # run the built app
npm run dist           # build + electron-builder package for the HOST platform
npm run dist:dir       # unpacked build (no installer)
```

`npm run dist` packages for whatever OS you run it on — **Windows NSIS** on
Windows, **macOS dmg + zip** on macOS (a dmg must be built on macOS). If the
electron-builder binaries download slowly:
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

Builds are **unsigned**: Windows shows SmartScreen ("更多信息 → 仍要运行");
macOS Gatekeeper blocks first launch (right-click → Open, or
`xattr -dr com.apple.quarantine /Applications/EasyMarkdown.app`).

## Layout

```
src/main/index.js      main process: window, IPC (fs/dialog/watch), menu, file watching
src/preload/index.js   contextBridge → window.api (whitelisted IPC)
src/renderer/src/
  App.jsx              shell: tabs, state, session, split, theme, lang, editor routing
  components/Editor.jsx  Crepe wrapper + block controls + enhancements
  components/{Sidebar,Tabs,Outline,CommandPalette,StatusBar,icons}.jsx
  components/{Welcome,WindowControls,UpdateToast,RenameModal}.jsx  leaf views split out of App
  components/editor-{html,images,copy,mermaid,tablebreak}.js  Editor helpers: HTML node view · img paths · rich-copy · mermaid widget · table-cell <br>
  {paths,find,ui,settings,customThemes}.js  pure helpers: session · find · toast · prefs (page width / font size / zoom) · custom-theme injection
  {blocks,themes,i18n,onboarding}.{js,jsx}
  styles/app.css       all styles + theme variables
build/                 icon.ico (Windows) + icon.icns (macOS) + installer.nsh (NSIS uninstall: keep user files)
scripts/               CDP-based e2e helpers (etv.mjs, inspect.mjs)
docs/                  architecture / features / implementation-notes / development
```

## Conventions & rules

- **Cross-platform — do not break the other OS.** This app ships on Windows and
  macOS from one codebase. Platform-specific code is gated:
  - main process: `process.platform === 'darwin' | 'win32'`
  - renderer: `window.api.platform` → an `.app.is-win` / `.app.is-mac` class on
    the root; write platform CSS under those selectors only.
  - title bar: `hiddenInset` + `trafficLightPosition` on macOS (top bar spans
    full width, activity bar drops below the traffic lights). On Windows the
    native `titleBarOverlay` is **disabled** — the renderer draws its own
    minimize/maximize/close buttons (`WindowControls` in `App.jsx`, gated to
    `platform === 'win32'`), driven by `window:*` IPC; main pushes
    `window:maximized` on `maximize`/`unmaximize` so the restore icon stays in
    sync. Keep both paths working when touching the top bar, and always leave a
    draggable area even when tabs fill the strip.
  - shortcuts accept both `Ctrl` and `Cmd` (`metaKey`).
  - launch args: `extractArgs()` in `main/index.js` splits argv into markdown
    **files** (→ `open-paths`, tabs) and **folders** (→ `open-folder`, workspace
    — from the Explorer "Open with EasyMarkdown" folder entry). Keep both handled.
- **Markdown vs plain text.** Supported extensions are centralized:
  `MD_EXTS`/`MD_RE` in `main/index.js` (open dialog + folder scan), and
  `MD_DOC_RE` in `App.jsx`. `.md/.markdown/.mdx` open in the Crepe rich editor;
  `.txt` (and any other file with a path) opens in the **plain textarea** —
  feeding plain text through Milkdown collapses line breaks and hangs on large
  files. New untitled tabs (no path) use the rich editor.
- **ProseMirror view**: get it via `crepe.editor.ctx.get(editorViewCtx)` —
  `crepe.editor.view` is `undefined` in this Milkdown version.
- **Crepe content callback**: register `crepe.on(markdownUpdated)` **before**
  `crepe.create()`, or changes never fire (saves would write stale content).
- **Lazy-mounted editors**: a rich tab's `<Editor>` is created only on its first
  activation, then kept mounted (`mountedIds` in `App.jsx`). This keeps startup /
  session-restore fast (restoring N tabs spins up one editor, not N). Code that
  needs a tab's editor API (`editorApis[id]`) must activate the tab first — see
  `exportPathToPdf`, which opens/activates then waits for `getDocHTML`.
- **Raw HTML rendering**: Milkdown's `html` node shows markup as escaped text;
  we add a ProseMirror node view (`renderHtmlNodeView` in `Editor.jsx`) that
  renders recognized block HTML (e.g. `<table>`) as real, sanitized DOM.
  Display-only — the node round-trips through `attrs.value`, so the saved Markdown
  keeps the original HTML. **Register it by appending to `nodeViewCtx`**
  (`ctx.update(nodeViewCtx, v => [...v, ['html', …]])`), NOT by setting
  `editorViewOptionsCtx.nodeViews` — the core spreads `editorViewOptionsCtx` last
  into the EditorView, so the latter would overwrite every component node view
  (image-block captions, CodeMirror, tables, list items). Same channel Milkdown's
  `$view` uses; see [implementation-notes.md](./docs/implementation-notes.md).
- **Closing the window** warns about unsaved changes: main defers `close`
  (`allowClose` guard) and sends `app-close-request`; the renderer checks dirty
  tabs and calls `confirmAppClose()` to let it close. Covers the macOS traffic
  light, the Windows close button, and Cmd/Ctrl+Q (closing a tab is separate, in
  `closeTab`).
- **App version** is injected at build time via Vite `define` (`__APP_VERSION__`
  in `electron.vite.config.mjs`, from `package.json`); shown on the welcome page.
- **Split view**: `splitId` in `App.jsx` is the tab shown in the right pane
  (`split` is the live derived flag: right tab exists, differs from `activeId`,
  not on Home). The two panes are **flex siblings inside `.editor-area`** (a flex
  row) — visibility is driven by per-tab `display`/`order`, NOT by re-parenting,
  so toggling split never re-creates an editor (no Crepe re-parse). `editorHostRef`
  stays on the left/active pane (find, outline, scroll-ratio target it);
  `focusedTabRef` tracks the last-focused pane so Save/Export hit the pane you're
  editing. The right pane never shows global source mode.
- **Custom themes (Typora-compatible)**: user `.css` lives in `userData/themes`
  (scanned **recursively** — Typora themes ship as a folder); `themes:read` rewrites
  relative `url(...)` to absolute `file://` so theme fonts/images load. The CSS is
  injected via `customThemes.js` into one `<style>`; the editor content carries
  Typora's `#write` + `markdown-body` hooks so its selectors match. While a custom
  theme is active (`body.hm-has-custom-theme`) app.css yields the writing area's
  background/width AND sets content text `color: inherit` so the theme's colors win;
  the app chrome keeps its own styling. `applyTheme` preserves `hm-*` body classes.
- **Mermaid** (`editor-mermaid.js`): rendered as the code block's **built-in
  "preview"** (the same `renderPreview`/`previewOnlyByDefault` mechanism Crepe's
  LaTeX uses) — wired via `codeBlockConfig` in `Editor.jsx`, NOT a widget
  decoration or node view (don't fight Crepe's CodeMirror). The diagram shows by
  default with the source hidden; the code block's toolbar gets a Hide/Edit
  toggle (`previewToggleText` in the `CodeMirror` feature config). A "Mermaid"
  entry is added to the language picker (`mermaidLanguage`). Mermaid is
  `import()`-ed lazily and initialized **once per theme**; renders are cached by
  `theme::code` in an LRU shared with **keep mode** — `getMermaidSvg` (promise) /
  `peekMermaidSvg` (sync peek) render diagrams OUTSIDE ProseMirror for
  `KeepEditor`, so a diagram drawn in one paints instantly in the other. A block
  holding 2+ diagrams is split into one block each by `createMermaidSplitPlugin`.
- **Math**: enable `CrepeFeature.Latex` (off by default). Block math needs `$$` on
  their own lines. Long display math scrolls (`.katex-display { overflow-x:auto }`).
- **Table-cell line breaks** (`editor-tablebreak.js`): GFM cells are single-line,
  so a break must round-trip as `<br>`. A keymap inserts a hardbreak; a custom
  remark stringify `break` handler emits `<br>` **only inside `tableCell`** (else
  default); a remark transform parses inline `<br>` back to a break. Don't let a
  cell break serialize to a newline — it corrupts the table.
- **Pasted/dropped images persist locally** (`Editor.jsx` `persistImage` +
  `image:save` / `image:savePaste` IPC): a saved doc writes the image into its
  `./assets` folder and inserts a relative path (Typora-style); an unsaved doc
  parks it in the global paste folder (relocated into `./assets` on first save);
  any failure falls back to an inline base64 data URL. Never leaves dead `blob:`
  URLs that vanish on reload.
- **Unsaved scratch tabs persist**: the session stores untitled (pathless) tabs
  whose content is dirty under `untitled: [{title, content}]`, and the mount
  restore recreates them (with `savedContent: ''` so they stay marked unsaved).
  Saved files are still reopened from disk via `openPaths`. The onboarding/welcome
  doc is skipped if either `openPaths` or `untitled` is present.
- **State**: session is `localStorage["easymarkdown.session.v1"]` (includes the selected
  `customTheme`); prefs (page width, font size, zoom) are
  `localStorage["easymarkdown.settings.v1"]` (`settings.js`); onboarding flag is
  `localStorage["easymarkdown.onboarded.v1"]`; dismissed update notice is
  `localStorage["easymarkdown.update.dismissed"]`. Themes are `body` classes
  (`light|dark` + optional `theme-*`), with custom themes as an injected `<style>`.
- **Find**: in-document find uses the **CSS Custom Highlight API**
  (`CSS.highlights` + `Highlight`), not `window.find` — it searches only the
  editor body (rich `view.dom` / source `<textarea>`), never UI text, and paints
  ranges without mutating the DOM. See the find helpers in `App.jsx`.
- **File watcher must stay crash-proof.** chokidar recursively watching a tree
  with permission-protected paths throws a flood of `EACCES`/`EAGAIN`/`EBUSY`
  that, left unhandled, `abort()`s the whole main process on launch. The trap:
  a **relative** workspace path like `"."` resolves against the process CWD, which
  is `/` under Finder/launchd → it watches `/dev`, `/System/Volumes`, … (works in
  `npm run dev` only because the shell's CWD is the repo). So `watch:start` only
  watches **absolute** paths and refuses restricted roots (`isRestrictedRoot`:
  `/`, `.`, `..`, relative, `/dev`, `/System/Volumes`, …), ignores system trees,
  sets `followSymlinks:false`, and every watcher has an `'error'` handler; the
  renderer drops a non-absolute restored workspace (`sanitizeWorkspace`); and a
  process-level `unhandledRejection`/`uncaughtException` guard in `main/index.js`
  is the final safety net. Don't remove these. Also: main-process network calls
  use Electron's `net.fetch` (Chromium stack), not Node's global `fetch` (its
  c-ares resolver can abort an unsigned app under launchd).
- **Don't commit `dist/` or `out/`** (gitignored). `build/icon.*` IS tracked.

## Testing

- **Unit tests (vitest)** cover the **pure** logic — run `npm test` (or
  `npm run test:watch`). Tests live in `test/`; config is `vitest.config.mjs`.
  They're written as **characterization tests** (lock current behavior, since
  there's no design spec) over `keep-parser`, `paths`, `editor-images`,
  `main/helpers`, `settings`, `find`, `blocks`. Default env is `node`; a test
  needing `localStorage`/`document` opts into happy-dom via a
  `// @vitest-environment happy-dom` first line. **Main-process pure functions
  live in `src/main/helpers.js`** (not `index.js`, which imports `electron` and
  so can't be imported by a test) — move new pure main logic there to unit-test it.
  DOM / ProseMirror / async-render code is out of scope for unit tests.
- **E2E (Playwright)** drives the **built** app via `_electron.launch()` — run
  `npm run test:e2e` (it builds first, then runs). Specs/fixtures live in
  `test/e2e/`; the launch harness is `test/e2e/helpers.js` (`launchApp`). Non-obvious
  bits, all load-bearing: launch `out/main/index.js` with **no `ELECTRON_RENDERER_URL`**
  (so main `loadFile`s the built renderer), a per-launch **`--user-data-dir`** temp
  (isolates session + sidesteps the single-instance lock), **delete
  `ELECTRON_RUN_AS_NODE`** from the env (else electron runs as plain Node and the
  launch fails), and tear down with `app.exit(0)` (bypasses the unsaved-changes
  close guard). Opened `.md` renders in the **keep** editor (`.km-*`,
  `keep-parser.js`) while the onboarding doc is **Milkdown** (`.ProseMirror`) — so
  assert by role/text, and activate a fixture's tab before asserting. Covers smoke
  (boot, render, keep-mode relative image → `file://`) + interactions (keep-mode
  block "edit source" and table-cell edits; Milkdown Ctrl+2 and right-click block
  menu after the status-bar "切换编辑模式" toggle). Crepe's on-selection bubble
  toolbar isn't asserted — it doesn't surface reliably under automation and its
  conversion path is already covered.
- **Legacy CDP scripts** in `scripts/` (manual `--remote-debugging-port=9222`) still
  exist and are being superseded by the above — see [`docs/development.md`](./docs/development.md).
  On macOS, `osascript "tell application \"Electron\""` can launch the generic
  `node_modules` Electron bundle (a name collision); prefer the packaged
  **EasyMarkdown.app**, which has a unique name and bundle id.

## When in doubt

Read the matching doc in `docs/` before changing a subsystem — many non-obvious
behaviors (editor data flow, drag regions, watcher echo suppression, the
title-bar layout) are documented there with their root causes.
