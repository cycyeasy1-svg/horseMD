/* ───────────────────────────────────────────────────────────
   HorseMD 官网 — 交互：i18n / reveal / 主题画廊 / 进度线 / tilt
   ─────────────────────────────────────────────────────────── */

/* ── i18n ─────────────────────────────────────────────────── */
const I18N = {
  zh: {
    'nav.features': '特性', 'nav.themes': '主题', 'nav.compare': '对比 Typora', 'nav.download': '下载',
    'hero.kicker': 'WINDOWS & MACOS · 免费开源 · MIT',
    'hero.l1': '一个窗口，', 'hero.l2': '装下所有文件。',
    'hero.sub': 'HorseMD 是一款温暖安静的 Typora 风格 Markdown 编辑器 —— 所见即所得的书写画布，加上 Typora 一直缺席的东西：<strong>标签页</strong>与<strong>文件树工作区</strong>。每个文件都在同一个窗口里打开，而不是再弹出一个新实例。',
    'hero.ctaDownload': '免费下载',
    'strip.tabs': '标签页', 'strip.tree': '文件树', 'strip.i18n': 'EN / 中文', 'strip.themes': '6 套主题',
    'features.title': '为多文件写作而生',
    'features.sub': 'Typora 有的它都有；下面这些，是 Typora 没有的。',
    'f1.title': '标签页', 'f1.body': '所有文件在同一个窗口里打开。在访达 / 资源管理器中双击文件，是新增一个标签，而不是再启动一个应用。',
    'f2.title': '文件夹工作区', 'f2.body': '侧边栏装下整个文件夹：新建、重命名、删除、在系统中显示，全部就地完成；外部改动自动刷新。',
    'f3.title': '所见即所得', 'f3.body': '输入 Markdown，当场渲染。表格、代码高亮、LaTeX 公式、任务列表、斜杠菜单 —— 由 Milkdown / ProseMirror 驱动。',
    'f4.title': '命令面板', 'f4.body': '模糊搜索直达任何文件、任何命令。大纲面板点标题即跳转，长文档不再上下翻找。',
    'f5.title': '源码模式', 'f5.body': '一个快捷键切回纯 Markdown 源码；.txt 文件走极速纯文本编辑器，超大文件秒开不卡顿。',
    'f6.title': '双语界面', 'f6.body': '整个界面同时讲 English 和中文。富文本复制保留样式，粘到微信、邮件、Notion 都不丢格式。',
    'themes.title': '六种心情，一张书桌',
    'themes.sub': '明亮、暗夜，以及四套莫兰迪 —— 雾、鼠尾草、玫瑰、暮色。',
    'themes.light': '明亮', 'themes.dark': '暗夜', 'themes.mist': '雾',
    'themes.sage': '鼠尾草', 'themes.rose': '玫瑰', 'themes.dusk': '暮色',
    'compare.title': '和 Typora 比一比',
    'compare.sub': '不是替代品的替代品 —— 是把那扇一直关着的窗户打开。',
    'compare.col0': ' ',
    'compare.r1': '所见即所得编辑', 'compare.r2': '表格 / 代码高亮 / LaTeX',
    'compare.r3': '标签页（多文件一窗）', 'compare.r4': '文件树就地增删改',
    'compare.r5': '命令面板模糊跳转', 'compare.r6': '双击文件 → 同窗新标签',
    'compare.r7': '免费开源（MIT）',
    'compare.note': '● 支持　○ 不支持　$ 付费（约 $14.99）',
    'dl.title': '把它带回家', 'dl.sub': '免费、开源、无账号。下载即写。',
    'dl.winTitle': 'Windows 安装包', 'dl.macTitle': 'macOS 镜像',
    'dl.get': '前往下载 <span class="arrow-pull">→</span>',
    'dl.noteTitle': '⚠ 构建未签名 — 首次启动：',
    'dl.noteWin': '<strong>Windows</strong>：SmartScreen 提示时点「更多信息 → 仍要运行」。',
    'dl.noteMac': '<strong>macOS</strong>：右键 → 打开；或执行 <code class="mono">xattr -dr com.apple.quarantine /Applications/HorseMD.app</code>',
    'dl.srcTitle': '或者，从源码构建：',
    '_title': 'HorseMD — 一个窗口，装下所有 Markdown',
    '_desc': 'HorseMD：温暖安静的 Typora 风格 Markdown 编辑器。标签页 + 文件树工作区 + 所见即所得，Windows 与 macOS 双平台，免费开源。',
  },
  en: {
    'nav.features': 'Features', 'nav.themes': 'Themes', 'nav.compare': 'vs Typora', 'nav.download': 'Download',
    'hero.kicker': 'WINDOWS & MACOS · FREE & OPEN SOURCE · MIT',
    'hero.l1': 'One window.', 'hero.l2': 'Every file.',
    'hero.sub': 'HorseMD is a calm, Typora-style Markdown editor — a WYSIWYG writing canvas, plus what Typora never shipped: <strong>tabs</strong> and a <strong>file-tree workspace</strong>. Every file opens in the same window, not another app instance.',
    'hero.ctaDownload': 'Download free',
    'strip.tabs': 'Tabs', 'strip.tree': 'File tree', 'strip.i18n': 'EN / 中文', 'strip.themes': '6 themes',
    'features.title': 'Built for multi-file writing',
    'features.sub': 'Everything Typora has — and the things it never had.',
    'f1.title': 'Tabs', 'f1.body': 'Every file opens in the same window. Double-click a file in Finder or Explorer and it becomes a tab — not another app instance.',
    'f2.title': 'Folder workspace', 'f2.body': 'Your whole folder lives in the sidebar: create, rename, delete, reveal — all in place. External changes refresh automatically.',
    'f3.title': 'WYSIWYG', 'f3.body': 'Type Markdown, watch it render in place. Tables, syntax-highlighted code, LaTeX math, task lists, a slash menu — powered by Milkdown / ProseMirror.',
    'f4.title': 'Command palette', 'f4.body': 'Fuzzy-jump to any file or command. The outline panel jumps to any heading — no more scrolling through long documents.',
    'f5.title': 'Source mode', 'f5.body': 'One shortcut back to raw Markdown. Plain .txt files open in a fast plain editor — huge files load instantly.',
    'f6.title': 'Bilingual UI', 'f6.body': 'The whole interface speaks English and 中文. Rich-text copy keeps formatting in WeChat, email, and Notion.',
    'themes.title': 'Six moods, one desk',
    'themes.sub': 'Light, dark, and four Morandi palettes — mist, sage, rose, dusk.',
    'themes.light': 'Light', 'themes.dark': 'Dark', 'themes.mist': 'Mist',
    'themes.sage': 'Sage', 'themes.rose': 'Rose', 'themes.dusk': 'Dusk',
    'compare.title': 'HorseMD vs Typora',
    'compare.sub': 'Not another clone — it opens the window Typora kept shut.',
    'compare.col0': ' ',
    'compare.r1': 'WYSIWYG editing', 'compare.r2': 'Tables / code highlight / LaTeX',
    'compare.r3': 'Tabs (many files, one window)', 'compare.r4': 'File tree with in-place CRUD',
    'compare.r5': 'Command-palette fuzzy jump', 'compare.r6': 'Double-click → tab in same window',
    'compare.r7': 'Free & open source (MIT)',
    'compare.note': '● yes　○ no　$ paid (~$14.99)',
    'dl.title': 'Take it home', 'dl.sub': 'Free, open source, no account. Download and write.',
    'dl.winTitle': 'Windows installer', 'dl.macTitle': 'macOS image',
    'dl.get': 'Get it <span class="arrow-pull">→</span>',
    'dl.noteTitle': '⚠ Unsigned builds — first launch:',
    'dl.noteWin': '<strong>Windows</strong>: when SmartScreen appears, click “More info → Run anyway”.',
    'dl.noteMac': '<strong>macOS</strong>: right-click → Open, or run <code class="mono">xattr -dr com.apple.quarantine /Applications/HorseMD.app</code>',
    'dl.srcTitle': 'Or build from source:',
    '_title': 'HorseMD — One window. Every file.',
    '_desc': 'HorseMD: a calm, Typora-style Markdown editor with tabs and a file-tree workspace. WYSIWYG, bilingual, free & open source for Windows and macOS.',
  },
}

const LANG_KEY = 'horsemd.site.lang'
let lang = localStorage.getItem(LANG_KEY)
  || (navigator.language && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')

function applyLang() {
  const dict = I18N[lang]
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n
    if (dict[key] != null) el.innerHTML = dict[key]
  })
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = dict['_title']
  const meta = document.querySelector('meta[name="description"]')
  if (meta) meta.content = dict['_desc']
  document.getElementById('langToggle').textContent = lang === 'zh' ? 'EN' : '中文'
  localStorage.setItem(LANG_KEY, lang)
}
document.getElementById('langToggle').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh'
  applyLang()
})
applyLang()

/* ── 滚动进度细线 ─────────────────────────────────────────── */
const onScroll = () => {
  const h = document.documentElement
  const p = h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)
  h.style.setProperty('--p', p.toFixed(4))
}
document.addEventListener('scroll', onScroll, { passive: true })
onScroll()

/* ── reveal on scroll ─────────────────────────────────────── */
const io = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
  })
}, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 3) * 90}ms`
  io.observe(el)
})

/* hero split-line：加载后逐行升起 */
requestAnimationFrame(() => {
  document.querySelectorAll('.split-line').forEach((el, i) => {
    setTimeout(() => el.classList.add('in'), 150 + i * 160)
  })
})

/* ── hero 截图：鼠标视差 tilt ─────────────────────────────── */
const frame = document.getElementById('heroFrame')
if (frame && matchMedia('(hover: hover)').matches) {
  frame.addEventListener('mousemove', e => {
    const r = frame.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    frame.style.transform = `perspective(1400px) rotateX(${(-y * 2.4).toFixed(2)}deg) rotateY(${(x * 2.4).toFixed(2)}deg)`
  })
  frame.addEventListener('mouseleave', () => { frame.style.transform = '' })
}

/* ── 主题画廊：双图交叉淡入 ───────────────────────────────── */
const imgA = document.getElementById('themeImgA')
const imgB = document.getElementById('themeImgB')
const themeTitle = document.getElementById('themeTitle')
let frontIsA = true
document.querySelectorAll('.swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    const back = frontIsA ? imgB : imgA
    const front = frontIsA ? imgA : imgB
    const swap = () => {
      back.classList.add('on')
      front.classList.remove('on')
      frontIsA = !frontIsA
    }
    back.src = `./assets/${btn.dataset.img}`
    if (back.complete) swap()
    else back.onload = swap
    themeTitle.textContent = `theme — ${btn.dataset.name}`
  })
})

/* ── 磁吸按钮：朝指针轻微吸附 ─────────────────────────────── */
if (matchMedia('(hover: hover)').matches) {
  document.querySelectorAll('.btn, .lang-toggle').forEach(el => {
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect()
      const dx = (e.clientX - r.left - r.width / 2) * 0.12
      const dy = (e.clientY - r.top - r.height / 2) * 0.2
      el.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`
    })
    el.addEventListener('mouseleave', () => { el.style.transform = '' })
  })
}

/* ── scrollspy：导航高亮当前区块 ──────────────────────────── */
const spyMap = new Map()
document.querySelectorAll('.nav-links a[href^="#"]').forEach(a => {
  const sec = document.querySelector(a.getAttribute('href'))
  if (sec) spyMap.set(sec, a)
})
const spy = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      spyMap.forEach(a => a.classList.remove('active'))
      spyMap.get(e.target)?.classList.add('active')
    }
  })
}, { rootMargin: '-35% 0px -55% 0px' })
spyMap.forEach((a, sec) => spy.observe(sec))

/* ── GitHub Releases：填充版本号与直链 ───────────────────── */
fetch('https://api.github.com/repos/BND-1/horseMD/releases/latest')
  .then(r => (r.ok ? r.json() : null))
  .then(rel => {
    if (!rel) return
    const ver = rel.tag_name || ''
    if (ver) {
      document.getElementById('navVersion').textContent = ver
      document.getElementById('footVersion').textContent = ver
    }
    const assets = rel.assets || []
    const win = assets.find(a => /\.exe$/i.test(a.name))
    const mac = assets.find(a => /\.dmg$/i.test(a.name))
    const fmt = n => `${(n / 1048576).toFixed(0)} MB`
    if (win) {
      const a = document.getElementById('dlWin')
      a.href = win.browser_download_url
      document.getElementById('dlWinMeta').textContent = `${win.name} · ${fmt(win.size)}`
    }
    if (mac) {
      const a = document.getElementById('dlMac')
      a.href = mac.browser_download_url
      document.getElementById('dlMacMeta').textContent = `${mac.name} · ${fmt(mac.size)}`
    }
  })
  .catch(() => { /* 静默回退到 releases 页 */ })
