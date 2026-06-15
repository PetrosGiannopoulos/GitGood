<div align="center">

# ⚜ GitGood ⚜

> *A medieval crusader-themed Git GUI client, forged for the faithful coder.*

[![Electron](https://img.shields.io/badge/Electron-31-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![simple-git](https://img.shields.io/badge/simple--git-3.x-F05032?style=for-the-badge&logo=git&logoColor=white)](https://github.com/steveukx/git-js)
[![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)](https://developer.mozilla.org/docs/Web/HTML)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)](https://developer.mozilla.org/docs/Web/CSS)
[![License: MIT](https://img.shields.io/badge/License-MIT-c8a04a?style=for-the-badge)](#license)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-444?style=for-the-badge)](#build-a-portable-build)

</div>

---

GitGood is a fully functional **Electron** desktop Git client wrapped in a medieval / crusader aesthetic (white, red, black). It drives your **real system Git** via `simple-git` — all standard Git terminology and behaviour is preserved, only the visuals are themed. No telemetry, no account, no cloud — just a fast local cockpit for your repositories.

## ✦ Highlights

- **Real Git, real fast** — shells out to your installed Git; the renderer is plain HTML/CSS/JS (no framework) for instant startup.
- **Visual commit graph** — lane-based DAG with drag-to-move ref pills, merge edges, and collapsible branch lines.
- **Side-by-side & unified diffs** — toggle per taste; clean file headers with the raw `diff --git` plumbing stripped out.
- **Per-file commit browser** — pick a file from a commit to see just its changes, instead of loading everything at once.
- **Restore files from any commit** — select files (checkboxes + select-all) and bring their version into your working tree.
- **Detached-HEAD aware** — check out any commit, then return to your branch with one click.
- **Five main themes** — Crusader (default) plus Tyrian, Verdant, Midnight, and Sandstone.
- **+175 alacrity themes** to elevate your experience with the day to day use of the app.

## ✦ Features

### Repository
- Open, initialize, and clone repositories (with SSH support and live clone progress)
- Recent-repositories list persisted across sessions
- Full-screen blocking **loading overlay** while a repo opens, so you never click into a half-loaded view
- SSH key generator ("Forge SSH Key")

### Commit Graph
- Lane-layout DAG rendered as SVG with colored lanes and merge connections
- **Drag-to-move ref pills** (branches/tags) directly on the graph
- **Per-commit folding** — collapse a branch line below a commit (double-click, right-click, or inline ▾)
- Global newest-N collapse toggle for very tall histories
- Commit hash is **always visible** and never clipped, even on a narrow pane; hover the description or hash to bring it forward

### History & Diffs
- Commit history with author, email, date, and hash
- **Unified / Split (side-by-side) diff** toggle — choice persists across sessions and applies everywhere
- Split view shows two clearly separated panes with a center divider and aligned add/remove rows
- **Per-file browser** in commit previews: a file list (with A / M / D / R status badges) + a single-file diff
- Git plumbing lines (`diff --git`, `index`, `---`, `+++`, mode/rename markers) are filtered out for a clean read
- Large-diff line cap with a graceful truncation notice
- LRU cache of recently viewed commit diffs

### Working Tree (Changes)
- Stage / unstage / discard individual files, multiple selections, or everything at once
- Conflict-aware listing with a 3-way conflict resolver
- Per-file diff with the same unified/split toggle as the rest of the app
- Stash system: create, apply, pop, drop — plus a stash browser

### Files from Commits
- **Checkboxes** on each file in a commit preview, with a **Select all** control and live selection count
- **Right-click context menu**: restore the selected file(s) to your working tree, or copy path(s)
- **↩ Restore selected** button — runs `git checkout <commit> -- <files>` behind a confirmation dialog

### Branches & Remotes
- Create, checkout, merge (smart merge), delete and force-delete branches
- Checkout remote branches as local
- **Detached-HEAD checkout** of any commit or tag, with a gold "Return to branch" banner
- View, copy URL, open in browser, and remove remotes
- Push / pull / fetch with ahead/behind badge indicators

### Search, Disk & Quality of Life
- **Search / filter** the graph and history (matches message, author, email, or hash; supports multiple AND terms)
- **Disk management** sidebar — async repository size scan (only when you ask, never blocking)
- Full **Git LFS** support
- Context menus on commits, branches, files, stashes, and remotes
- Resizable panes (validated so a bad layout can never persist), collapsible sidebar sections, whole-sidebar toggle (`Ctrl+B`)
- Toast notifications and a live status bar (branch, change count, ahead/behind)
- Operation progress widget for long-running tasks

### Appearance
- Six color themes selectable in **Settings → Appearance** (swatch previews, persisted)
- Adjustable font scale
- Typography: **Cinzel**, **MedievalSharp**, **EB Garamond**, and **JetBrains Mono**

## ✦ Prerequisites

- **Node.js 18+** — required only for first-time setup and for building the portable bundle
- **Git** installed and on your `PATH` — GitGood drives your system Git through `simple-git`

## ✦ Quick Start

From inside the `GitGood` folder:

```bash
# 1. install dependencies (first run only)
npm install

# 2. launch
npm start
```

Or just use the bundled launchers, which install dependencies automatically on first run:

| Platform | Launch | Launch with DevTools |
| --- | --- | --- |
| Windows | `run-gitgood.bat` | `run-gitgood-debug.bat` |
| macOS / Linux | `./run-gitgood.sh` | `./run-gitgood-debug.sh` |

The whole folder (including `node_modules`) is self-contained — copy it to another machine with Node installed and run `npm start` without reinstalling.

## ✦ Build a Portable Build

```bash
npm run build:win     # Windows portable .exe  → dist/
npm run build:linux   # Linux AppImage          → dist/
npm run build:mac     # macOS .dmg              → dist/
```

The Windows target produces a single self-contained `.exe` — no installation and no host dependencies.

## ✦ Project Structure

```
GitGood/
├── package.json              # Dependencies and build config
├── run-gitgood.{bat,sh}      # One-click launchers (+ -debug variants)
├── src/
│   ├── main/
│   │   ├── main.js           # Electron main process — all IPC + git operations
│   │   └── preload.js        # Secure contextBridge to the renderer
│   ├── renderer/
│   │   ├── index.html        # UI structure
│   │   ├── styles.css        # Themes + all styling
│   │   └── renderer.js       # All UI logic
│   └── assets/
│       └── icon.svg          # App icon
└── README.md
```

## ✦ Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open repository |
| `Ctrl+Shift+O` | Clone repository |
| `Ctrl+Enter` | Commit (when the commit summary is focused) |
| `Ctrl+B` | Toggle the sidebar |
| `Esc` | Close a modal / context menu / clear a search filter |

## ✦ Tech Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Desktop shell | **Electron 31** | Cross-platform native window + Node access |
| Git engine | **simple-git 3.x** | Thin, reliable wrapper over your real Git |
| Renderer | **Vanilla HTML / CSS / JS** | No framework → tiny footprint, instant startup |
| Packaging | **electron-builder** | Portable `.exe`, AppImage, and `.dmg` targets |
| Typography | Cinzel · MedievalSharp · EB Garamond · JetBrains Mono | The medieval voice |

## ✦ License

Released under the **MIT License**.

<div align="center">

⚜ *Deus vult* ⚜

![GitGood Preview](src/assets/screenshot1.png)
![GitGood Preview](src/assets/screenshot2.png)
![GitGood Preview](src/assets/screenshot3.png)
![GitGood Preview](src/assets/screenshot4.png)

</div>
