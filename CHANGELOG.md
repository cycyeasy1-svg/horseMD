# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-06-06

### Changed
- Status bar now keeps the right-side controls (block/source toggles, theme,
  language, GitHub) fixed and visible when the window narrows — the file path
  collapses (ellipsis) instead of the buttons being hidden or pushed off-screen.

### Fixed
- New-file naming overwrote the input when typing digits (the name was reselected
  on every keystroke) — the name is now preselected once.
- Editor placeholder now follows a language switch live (was baked in at create).
- Opening a moved/deleted file no longer dumps a raw IPC error — the dead entry
  is removed from Recent with a friendly message; session restore skips missing
  files silently.

## [0.1.1] - 2026-06-05

### Added
- Top-bar `+` button to create a new file, and a GitHub link in the status bar.
- Plain-text files (`.txt`) open in a fast plain-text editor instead of the
  Markdown WYSIWYG.
- macOS packaging (dmg + zip) and a native macOS title-bar layout.
- Bilingual README (English + 简体中文) with screenshots and a theme gallery; `CLAUDE.md`.
- MIT `LICENSE`, CI build check + tag-triggered release packaging, `CONTRIBUTING.md`,
  `SECURITY.md`, and issue templates.
- Explicit Electron security flags (`contextIsolation`, `nodeIntegration`) and a navigation guard.

### Fixed
- Status-bar theme/language menus were clipped by `overflow:hidden` and looked
  unclickable — they now open correctly.
- Large `.txt` files no longer hang the editor (they bypass Markdown parsing).
- Rename now preselects the filename without its extension, like new-file.

## [0.1.0] - 2026-06-05

### Added
- Initial release: tabbed, Typora-style WYSIWYG Markdown editor.
- Folder workspace with file-tree sidebar, command palette, outline panel.
- Dark/light themes, session restore, single-instance file association.
- Windows NSIS installer and macOS dmg/zip packaging.

[Unreleased]: https://github.com/BND-1/horseMD/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/BND-1/horseMD/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BND-1/horseMD/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BND-1/horseMD/releases/tag/v0.1.0
