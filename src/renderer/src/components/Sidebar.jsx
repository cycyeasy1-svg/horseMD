import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { baseName, dirName as parentDir, joinPath as join, isMarkdownName, isValidName, isExistsError } from '../paths.js'
import { copyToClipboard } from '../ui.js'

export default function Sidebar({ workspaces, activePath, openTabPaths, openTabPathsRaw, onOpenFile, onOpenRight, onExportPdf, onAddFolder, onRemoveFolder, onReorderFolder, refreshNonce }) {
  const { t } = useI18n()
  const copyText = (text) => copyToClipboard(text, t('code.copied'))
  const [childrenMap, setChildrenMap] = useState({}) // path -> nodes[]
  const [expanded, setExpanded] = useState(() => new Set())
  const [menu, setMenu] = useState(null) // { x, y, node }
  const [rename, setRename] = useState(null) // { path, value }
  // Inline creation: { dir, type: 'file'|'folder', value }
  const [creating, setCreating] = useState(null)
  // Guards against committing a creation twice (e.g. Enter immediately followed
  // by the input's blur, or a click on the confirm button + blur).
  const committingRef = useRef(false)
  // Drag-and-drop: path being dragged, and the folder currently hovered as a
  // drop target (for highlighting).
  const dragPathRef = useRef(null)
  const [dragOver, setDragOver] = useState(null)
  // Separate channel for reordering workspace roots by dragging their headers (vs
  // dragPathRef, which moves files/folders INTO a directory). rootDrop marks the
  // hovered root + side ('before'|'after') so we can draw an insertion line.
  const dragRootRef = useRef(null)
  const [rootDrop, setRootDrop] = useState(null) // { path, pos }
  // Live mirror of childrenMap so the "follow active file" effect can check what's
  // already loaded without re-running every time the map changes.
  const childrenRef = useRef(childrenMap)
  childrenRef.current = childrenMap
  // The DOM row of the currently-open file, used to scroll it into view.
  const activeRowRef = useRef(null)
  // Last path we scrolled to — so we reveal a file once when it's opened, not on
  // every later manual expand/collapse of unrelated folders.
  const lastScrolledRef = useRef(null)
  // Open-tab paths we've already auto-revealed, so re-expanding doesn't fight a
  // folder the user later collapses by hand (reset when the workspace changes).
  const revealedRef = useRef(new Set())

  const roots = workspaces || []
  // Stable identity for the set of roots, so the init effect only re-runs when the
  // roots actually change (childrenMap/expanded are keyed by absolute path, so they
  // happily hold many roots' subtrees at once).
  const rootsKey = roots.map((w) => w.rootPath).join('\n')

  const loadDir = useCallback(async (dir) => {
    const nodes = await window.api.readDir(dir)
    setChildrenMap((m) => ({ ...m, [dir]: nodes }))
    return nodes
  }, [])

  // Load + expand any root we haven't seen yet, leaving already-loaded roots'
  // expansion and children untouched — adding a folder must not collapse the
  // others. (Removed roots just stop rendering; their cached children are inert.)
  useEffect(() => {
    if (!roots.length) return
    const newRoots = roots.filter((w) => childrenRef.current[w.rootPath] === undefined)
    if (!newRoots.length) return
    setExpanded((s) => {
      const n = new Set(s)
      newRoots.forEach((w) => n.add(w.rootPath))
      return n
    })
    newRoots.forEach((w) => loadDir(w.rootPath))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, loadDir])

  // Refresh all currently-loaded dirs when the watcher fires
  useEffect(() => {
    if (!roots.length || refreshNonce === 0) return
    Object.keys(childrenMap).forEach((dir) => loadDir(dir))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

  // Expand the ancestor folders of the given files so they're revealed in the
  // tree. Additive — only ever adds to `expanded`, never collapses what the user
  // opened. Loads each ancestor dir (so its children render) before expanding.
  // Used both to follow the active file and to surface restored open tabs.
  const revealAncestors = useCallback(
    async (paths, isCancelled) => {
      if (!roots.length) return
      const norm = (p) => p.replace(/\\/g, '/')
      const rootPaths = roots.map((w) => norm(w.rootPath))
      const ancestors = new Set()
      for (const p of paths) {
        if (!p) continue
        const np = norm(p)
        // Find the root that owns this path; skip files outside every workspace.
        const root = rootPaths.find((r) => np.startsWith(r + '/'))
        if (!root) continue
        let d = parentDir(p)
        let guard = 0
        while (d && guard++ < 50) {
          ancestors.add(d)
          if (norm(d) === root) break
          const up = parentDir(d)
          if (!up || up === d) break
          d = up
        }
      }
      if (!ancestors.size) return
      for (const dir of ancestors) {
        if (isCancelled?.()) return
        if (!childrenRef.current[dir]) await loadDir(dir)
      }
      if (isCancelled?.()) return
      setExpanded((s) => {
        const n = new Set(s)
        ancestors.forEach((a) => n.add(a))
        return n
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootsKey, loadDir]
  )

  // Issue #11: follow the active file — when a file is opened/switched (via the
  // tree, search, recents, internal links… all of which update activePath),
  // auto-expand its ancestor folders so it's revealed in the tree.
  useEffect(() => {
    if (!activePath) return
    let cancelled = false
    revealAncestors([activePath], () => cancelled)
    return () => {
      cancelled = true
    }
  }, [activePath, revealAncestors])

  // Reveal every open tab's folder too, not just the active one — so a restored
  // session (many tabs deep in the tree) shows them all, with their open-file
  // dots. Each path is revealed only once (`revealedRef`), so this never fights a
  // folder the user later collapses manually; it only expands newly-seen tabs.
  useEffect(() => {
    if (!roots.length || !openTabPathsRaw?.length) return
    const fresh = openTabPathsRaw.filter((p) => p && !revealedRef.current.has(p))
    if (!fresh.length) return
    fresh.forEach((p) => revealedRef.current.add(p))
    let superseded = false
    // Expand unconditionally (additive + idempotent) so every open tab reveals
    // even as more tabs stream in during restore — don't cancel the expansion.
    revealAncestors(fresh).then(() => {
      // The tree just grew (folders expanded) — re-pin the active file's row into
      // view. Wait for the next paint so we scroll to its *final* position, not the
      // spot it sat at before these folders expanded below/around it. Bypasses the
      // lastScrolledRef guard on purpose; runs only for freshly-seen tabs (restore /
      // new opens), never on the user's own manual folder expansion. `superseded`
      // keeps only the last batch's scroll, so the view ends on the active file.
      if (superseded) return
      requestAnimationFrame(() => {
        if (superseded || !activeRowRef.current) return
        activeRowRef.current.scrollIntoView({ block: 'nearest' })
      })
    })
    return () => {
      superseded = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabPathsRaw, rootsKey, revealAncestors])

  // Scroll the active file's row into view once it (and its ancestors) are
  // rendered. Guarded by lastScrolledRef so we only reveal on open, not on every
  // unrelated expand/collapse.
  useEffect(() => {
    if (!activePath) return
    if (activeRowRef.current && lastScrolledRef.current !== activePath) {
      activeRowRef.current.scrollIntoView({ block: 'nearest' })
      lastScrolledRef.current = activePath
    }
  }, [activePath, expanded, childrenMap])

  const toggle = async (node) => {
    const next = new Set(expanded)
    if (next.has(node.path)) {
      next.delete(node.path)
    } else {
      next.add(node.path)
      if (!childrenMap[node.path]) await loadDir(node.path)
    }
    setExpanded(next)
  }

  const closeMenu = useCallback(() => setMenu(null), [])
  useEffect(() => {
    if (!menu) return
    window.addEventListener('click', closeMenu)
    window.addEventListener('blur', closeMenu)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('blur', closeMenu)
    }
  }, [menu, closeMenu])

  const refreshParentOf = async (path) => {
    const p = parentDir(path)
    if (childrenMap[p] !== undefined) await loadDir(p)
  }

  // Start inline creation for a file. `dir` is an explicit folder path (a root
  // header or a folder's context menu); falls back to the first root.
  const startNewFile = (dir) => {
    const target = dir || roots[0]?.rootPath
    if (!target) return
    setCreating({ dir: target, type: 'file', value: 'untitled.md' })
    setExpanded((s) => new Set(s).add(target))
    if (!childrenMap[target]) loadDir(target)
  }

  // Start inline creation for a folder
  const startNewFolder = (dir) => {
    const target = dir || roots[0]?.rootPath
    if (!target) return
    setCreating({ dir: target, type: 'folder', value: t('prompt.newFolderDefault') })
    setExpanded((s) => new Set(s).add(target))
    if (!childrenMap[target]) loadDir(target)
  }

  // Commit the inline creation
  const commitCreate = async () => {
    if (!creating || committingRef.current) return
    committingRef.current = true
    const { dir, type, value } = creating
    const name = value.trim()
    setCreating(null)
    if (!name) {
      committingRef.current = false
      return
    }
    if (!isValidName(name)) {
      committingRef.current = false
      window.alert((t('err.invalidName') || 'Invalid name: ') + name)
      return
    }

    try {
      if (type === 'file') {
        let fileName = name
        if (!/\.[a-z0-9]+$/i.test(fileName)) fileName += '.md'
        const path = join(dir, fileName)
        await window.api.createFile(path, '')
        await loadDir(dir)
        onOpenFile(path)
      } else {
        await window.api.createDir(join(dir, name))
        await loadDir(dir)
        setExpanded((s) => new Set(s).add(dir))
      }
    } catch (e) {
      window.alert(
        isExistsError(e)
          ? t('err.nameExists')
          : (type === 'file' ? t('err.createFile') : t('err.createFolder')) + e.message
      )
    } finally {
      committingRef.current = false
    }
  }

  const doDelete = async (node) => {
    if (!window.confirm(t('confirm.trash', { name: node.name }))) return
    try {
      await window.api.deleteItem(node.path)
      await refreshParentOf(node.path)
    } catch (e) {
      window.alert((t('err.delete') || 'Could not delete: ') + e.message)
    }
  }

  const doDuplicate = async (node) => {
    try {
      await window.api.duplicate(node.path)
      await refreshParentOf(node.path)
    } catch (e) {
      window.alert(isExistsError(e) ? t('err.nameExists') : (t('err.duplicate') || 'Could not duplicate: ') + e.message)
    }
  }

  // Recursively load every subfolder and expand them all. Depth-capped and
  // visited-guarded so a symlink cycle or a pathologically deep tree can't spin
  // into unbounded IPC recursion.
  const expandAll = async () => {
    if (!roots.length) return
    const dirs = new Set(roots.map((w) => w.rootPath))
    const seen = new Set()
    const walk = async (dir, depth) => {
      if (depth > 30 || seen.has(dir)) return
      seen.add(dir)
      let nodes = childrenMap[dir]
      if (nodes === undefined) nodes = await loadDir(dir)
      for (const n of nodes || []) {
        if (n.type === 'dir') {
          dirs.add(n.path)
          await walk(n.path, depth + 1)
        }
      }
    }
    for (const w of roots) await walk(w.rootPath, 0)
    setExpanded(dirs)
  }

  // Move a dragged file/folder into a destination directory.
  const moveInto = async (srcPath, destDir) => {
    if (!srcPath || !destDir) return
    const src = srcPath.replace(/\\/g, '/')
    const dest = destDir.replace(/\\/g, '/')
    // No-op if it's already in that folder; never move a folder into itself or
    // one of its own descendants.
    if (parentDir(src) === dest) return
    if (dest === src || dest.startsWith(src + '/')) return
    try {
      await window.api.rename(srcPath, join(destDir, baseName(srcPath)))
    } catch (e) {
      window.alert(isExistsError(e) ? t('err.nameExists') : (t('err.move') || 'Could not move: ') + e.message)
      return
    }
    await refreshParentOf(srcPath)
    if (childrenMap[destDir] !== undefined) await loadDir(destDir)
    setExpanded((s) => new Set(s).add(destDir))
  }

  // Drop handlers wired onto folder rows (and the root area).
  const dropProps = (destDir) => ({
    onDragOver: (e) => {
      if (!dragPathRef.current) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dragOver !== destDir) setDragOver(destDir)
    },
    onDragLeave: () => setDragOver((d) => (d === destDir ? null : d)),
    onDrop: (e) => {
      e.preventDefault()
      e.stopPropagation()
      const src = dragPathRef.current
      dragPathRef.current = null
      setDragOver(null)
      moveInto(src, destDir)
    }
  })

  // 'before' if the pointer is in the top half of a root header, else 'after'.
  const dropPos = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY - r.top < r.height / 2 ? 'before' : 'after'
  }

  // DnD wired onto a root header row. Branches on which drag is in flight: a root
  // header (reorder) or a file/folder (move into this root, like dropProps).
  const rootDnd = (rootPath) => ({
    draggable: true,
    onDragStart: (e) => {
      dragRootRef.current = rootPath
      dragPathRef.current = null // make sure this isn't read as a file move
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', rootPath)
      e.stopPropagation()
    },
    onDragEnd: () => {
      dragRootRef.current = null
      setRootDrop(null)
      setDragOver(null)
    },
    onDragOver: (e) => {
      if (dragRootRef.current) {
        if (dragRootRef.current === rootPath) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        const pos = dropPos(e)
        setRootDrop((cur) => (cur?.path === rootPath && cur?.pos === pos ? cur : { path: rootPath, pos }))
      } else if (dragPathRef.current) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (dragOver !== rootPath) setDragOver(rootPath)
      }
    },
    onDragLeave: () => {
      setRootDrop((cur) => (cur?.path === rootPath ? null : cur))
      setDragOver((d) => (d === rootPath ? null : d))
    },
    onDrop: (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (dragRootRef.current) {
        const from = dragRootRef.current
        const pos = dropPos(e)
        dragRootRef.current = null
        setRootDrop(null)
        if (from !== rootPath) onReorderFolder?.(from, rootPath, pos)
      } else if (dragPathRef.current) {
        const src = dragPathRef.current
        dragPathRef.current = null
        setDragOver(null)
        moveInto(src, rootPath)
      }
    }
  })

  const commitRename = async () => {
    if (!rename || committingRef.current) return
    const { path, value } = rename
    const clean = value.trim()
    setRename(null)
    if (!clean || clean === baseName(path)) return
    if (!isValidName(clean)) {
      window.alert((t('err.invalidName') || 'Invalid name: ') + clean)
      return
    }
    committingRef.current = true
    try {
      await window.api.rename(path, join(parentDir(path), clean))
      await refreshParentOf(path)
    } catch (e) {
      window.alert(isExistsError(e) ? t('err.nameExists') : (t('err.rename') || 'Could not rename: ') + e.message)
    } finally {
      committingRef.current = false
    }
  }

  if (!roots.length) {
    return (
      <div className="sidebar-empty">
        <Icon name="folder" size={26} />
        <p>{t('side.noFolder')}</p>
        <button className="btn-primary" onClick={() => (onAddFolder ? onAddFolder() : window.dispatchEvent(new Event('mm:openFolder')))}>
          {t('side.openFolder')}
        </button>
      </div>
    )
  }

  // Inline confirm (✓) / cancel (✗) buttons shown while creating or renaming.
  // onMouseDown preventDefault keeps the input focused so clicking a button
  // doesn't first fire the input's blur-to-commit.
  const editActions = (onConfirm, onCancel) => (
    <span className="tree-edit-actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="tree-edit-btn confirm"
        title={t('edit.confirm')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onConfirm() }}
      >
        <Icon name="check" size={13} />
      </button>
      <button
        type="button"
        className="tree-edit-btn cancel"
        title={t('edit.cancel')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onCancel() }}
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  )

  // Render the inline creation input
  const renderCreatingInput = (depth) => (
    <div className="tree-row creating-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-chevron" />
      <Icon name={creating.type === 'file' ? 'file' : 'folder'} size={15} className="tree-icon" />
      <input
        className="tree-rename"
        autoFocus
        value={creating.value}
        onFocus={(e) => {
          // Preselect the name without its extension — once, on mount. (Doing
          // this in an effect keyed on `creating` reselected on every keystroke,
          // so each new character overwrote the last.)
          const dot = creating.value.lastIndexOf('.')
          if (dot > 0) e.target.setSelectionRange(0, dot)
          else e.target.select()
        }}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setCreating({ ...creating, value: e.target.value })}
        // Commit when focus leaves the input (clicking elsewhere), matching the
        // rename field — so a typed name is never silently lost.
        onBlur={commitCreate}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); commitCreate() }
          if (e.key === 'Escape') setCreating(null)
        }}
      />
      {editActions(commitCreate, () => setCreating(null))}
    </div>
  )

  const renderNode = (node, depth) => {
    const isDir = node.type === 'dir'
    const isOpen = expanded.has(node.path)
    const isActive = node.path === activePath
    // Open in a tab but not the active one → gets a dot marker (see .tree-row.opened).
    const isOpenTab = !isDir && !isActive && openTabPaths?.has(node.path.replace(/\\/g, '/'))
    const renaming = rename && rename.path === node.path
    const isDropTarget = isDir && dragOver === node.path
    return (
      <div key={node.path}>
        <div
          ref={isActive ? activeRowRef : undefined}
          className={`tree-row${isActive ? ' active' : ''}${isOpenTab ? ' opened' : ''}${isDropTarget ? ' drag-over' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!renaming}
          onDragStart={(e) => {
            dragPathRef.current = node.path
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', node.path)
          }}
          onDragEnd={() => {
            dragPathRef.current = null
            setDragOver(null)
          }}
          {...(isDir ? dropProps(node.path) : {})}
          onClick={() => (isDir ? toggle(node) : onOpenFile(node.path))}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, node })
          }}
          title={node.path}
        >
          {isDir ? (
            <Icon name="chevron-right" size={14} className={`tree-chevron${isOpen ? ' chevron-expanded' : ''}`} />
          ) : (
            <span className="tree-chevron" />
          )}
          <Icon name={isDir ? (isOpen ? 'folder-open' : 'folder') : 'file'} size={15} className="tree-icon" />
          {renaming ? (
            <>
              <input
                className="tree-rename"
                autoFocus
                value={rename.value}
                onFocus={(e) => {
                  // Preselect the name (without extension), like the new-file input.
                  const dot = rename.value.lastIndexOf('.')
                  if (dot > 0) e.target.setSelectionRange(0, dot)
                  else e.target.select()
                }}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRename({ ...rename, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRename(null)
                }}
                onBlur={commitRename}
              />
              {editActions(commitRename, () => setRename(null))}
            </>
          ) : (
            <span className="tree-label">{node.name}</span>
          )}
        </div>
        {/* Inline creation input inside this directory */}
        {isDir && isOpen && creating && creating.dir === node.path && renderCreatingInput(depth + 1)}
        {isDir && isOpen && (childrenMap[node.path] || []).map((c) => renderNode(c, depth + 1))}
        {/* Expanded but nothing to show (the tree only lists Markdown/text and
            subfolders) — say so instead of looking like the click did nothing. */}
        {isDir && isOpen && childrenMap[node.path]?.length === 0 &&
          !(creating && creating.dir === node.path) && (
            <div className="tree-empty tree-empty-nested" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              {t('side.emptyFolder')}
            </div>
          )}
      </div>
    )
  }

  // A workspace root: its own collapsible tree, with hover actions on the header
  // row (new file/folder in this root, and remove-from-sidebar). Children render at
  // depth 1 so they indent under the root header.
  const renderRoot = (ws) => {
    const rootPath = ws.rootPath
    const isOpen = expanded.has(rootPath)
    const rootNodes = childrenMap[rootPath] || []
    const isDropTarget = dragOver === rootPath
    const dropLine = rootDrop?.path === rootPath ? ` root-drop-${rootDrop.pos}` : ''
    return (
      <div key={rootPath} className="tree-root">
        <div
          className={`tree-row tree-root-row${isDropTarget ? ' drag-over' : ''}${dropLine}`}
          style={{ paddingLeft: 8 }}
          {...rootDnd(rootPath)}
          onClick={() => toggle({ path: rootPath })}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, node: { type: 'dir', path: rootPath, name: ws.rootName, isRoot: true } })
          }}
          title={rootPath}
        >
          <Icon name="chevron-right" size={14} className={`tree-chevron${isOpen ? ' chevron-expanded' : ''}`} />
          <Icon name={isOpen ? 'folder-open' : 'folder'} size={15} className="tree-icon" />
          <span className="tree-label tree-root-label">{ws.rootName}</span>
          <span className="tree-root-actions" onClick={(e) => e.stopPropagation()}>
            <button title={t('side.newFile')} onClick={() => startNewFile(rootPath)}>
              <Icon name="file-plus" size={14} />
            </button>
            <button title={t('side.newFolder')} onClick={() => startNewFolder(rootPath)}>
              <Icon name="folder-plus" size={14} />
            </button>
            <button title={t('side.removeFolder')} onClick={() => onRemoveFolder?.(rootPath)}>
              <Icon name="close" size={13} />
            </button>
          </span>
        </div>
        {isOpen && (
          <>
            {creating && creating.dir === rootPath && renderCreatingInput(1)}
            {rootNodes.length === 0 && !(creating && creating.dir === rootPath) ? (
              <div className="tree-empty tree-empty-nested" style={{ paddingLeft: 8 + 14 }}>{t('side.empty')}</div>
            ) : (
              rootNodes.map((n) => renderNode(n, 1))
            )}
          </>
        )}
      </div>
    )
  }

  // Collapsed when nothing beyond the roots themselves is expanded.
  const collapsed = expanded.size <= roots.length

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">{t('cmd.files')}</span>
        <div className="sidebar-head-actions">
          <button title={t('side.addFolder')} onClick={() => onAddFolder?.()}>
            <Icon name="plus" size={15} />
          </button>
          <button
            title={collapsed ? t('side.expandAll') : t('side.collapseAll')}
            onClick={collapsed ? expandAll : () => setExpanded(new Set(roots.map((w) => w.rootPath)))}
          >
            <Icon name={collapsed ? 'expand' : 'collapse'} size={15} />
          </button>
        </div>
      </div>
      <div className="tree">
        {roots.map((ws) => renderRoot(ws))}
      </div>

      {menu && (
        <div className="context-menu" style={{
          left: Math.min(menu.x, window.innerWidth - 210),
          top: Math.min(menu.y, window.innerHeight - 340)
        }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { startNewFile(menu.node ? (menu.node.type === 'dir' ? menu.node.path : parentDir(menu.node.path)) : null); setMenu(null) }}>{t('side.ctxNewFile')}</button>
          <button onClick={() => { startNewFolder(menu.node ? (menu.node.type === 'dir' ? menu.node.path : parentDir(menu.node.path)) : null); setMenu(null) }}>{t('side.ctxNewFolder')}</button>
          {menu.node?.type === 'file' && onOpenRight && (
            <>
              <div className="menu-sep" />
              <button onClick={() => { onOpenRight(menu.node.path); setMenu(null) }}>{t('tab.openRight')}</button>
            </>
          )}
          {menu.node && <div className="menu-sep" />}
          {menu.node && <button onClick={() => { copyText(menu.node.path); setMenu(null) }}>{t('tab.copyPath')}</button>}
          {menu.node && <button onClick={() => { copyText(menu.node.name); setMenu(null) }}>{t('tab.copyName')}</button>}
          {menu.node && window.api.capabilities?.revealInFolder !== false && <button onClick={() => { window.api.showInFolder(menu.node.path); setMenu(null) }}>{t('side.reveal')}</button>}
          {/* Root folders: remove from the sidebar (does not touch disk). */}
          {menu.node?.isRoot && (
            <>
              <div className="menu-sep" />
              <button onClick={() => { onRemoveFolder?.(menu.node.path); setMenu(null) }}>{t('side.removeFolder')}</button>
            </>
          )}
          {menu.node && !menu.node.isRoot && <div className="menu-sep" />}
          {menu.node && !menu.node.isRoot && <button onClick={() => { setRename({ path: menu.node.path, value: menu.node.name }); setMenu(null) }}>{t('side.rename')}</button>}
          {menu.node?.type === 'file' && <button onClick={() => { doDuplicate(menu.node); setMenu(null) }}>{t('side.duplicate')}</button>}
          {menu.node?.type === 'file' && isMarkdownName(menu.node.name) && window.api.capabilities?.pdfExport !== false && (
            <button onClick={() => { onExportPdf?.(menu.node.path); setMenu(null) }}>{t('side.exportPdf')}</button>
          )}
          {menu.node && !menu.node.isRoot && <div className="menu-sep" />}
          {menu.node && !menu.node.isRoot && <button className="danger" onClick={() => { doDelete(menu.node); setMenu(null) }}>{t('side.delete')}</button>}
        </div>
      )}
    </div>
  )
}
