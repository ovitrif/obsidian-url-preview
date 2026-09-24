# AGENTS.md

This file provides guidance to AI agents like [Claude Code](https://claude.ai/code) or [Warp](https://warp.dev) when working with code in this repository.

## Project Overview

This is an Obsidian plugin ("URL Preview") that displays a website preview when an external link is clicked with the configured modifier keys held. It is built with TypeScript and uses `esbuild` for bundling.

## Build Commands

```bash
npm run dev      # Start development mode with watch (uses esbuild)
npm run build    # Production build (lint + tsc type-check + esbuild)
npm run lint     # Run ESLint with eslint-plugin-obsidianmd (zero warnings allowed)
npm run lint:fix # Run ESLint with auto-fix
npm run version  # Updates the version in manifest.json and versions.json (requires git)
```

- **Dev mode** (`npm run dev`): Outputs to `dist/` which is symlinked to the vault's plugin directory. The [hot-reload](https://github.com/pjeby/hot-reload) plugin picks up changes automatically — no manual copy needed.
- **Prod mode** (`npm run build`): Outputs `main.js` to the project root for releases.

## Architecture

This is an Obsidian plugin with a single-file architecture (`main.ts`).

### Core Structure

- **Entry Point**: `main.ts` exports the `LinkPreviewPlugin` class, which extends Obsidian's `Plugin` class.
- **Manifest**: `manifest.json` defines plugin metadata (ID, version, author).
- **Styles**: `styles.css` defines the appearance of the preview window (e.g., `.hover-popup`, `.preview-iframe-wrapper`).

### Key Components

#### LinkPreviewPlugin

The main plugin class handles the lifecycle and core logic:

- **`onload()`**:
  - Loads settings.
  - Waits for layout ready to call `registerGlobalHandler()`.
  - Registers the `editor-menu` and `url-menu` handlers, the CodeMirror badge extension, the `preview-link-at-cursor` command and the settings tab.
- **`registerGlobalHandler()`**:
  - Registers the per-document `mouseover`, `contextmenu`, `click`, `mousemove`, `keydown` and `scroll` handlers, plus the window's `blur` and `resize`, on a child `Component` per document, so a popout's handlers are released when its window closes.
  - `mouseover` and `mousemove` track the pointer in two separate pairs of fields. `lastMouseX/Y` answers "where is the pointer now" for the mouse-out grace period; `lastMoveX/Y` is the previous *mousemove* position. They have to stay separate: `mouseover` fires before the `mousemove` that caused it, with the same coordinates, so sharing one pair makes every move that crosses an element boundary read as no movement.
  - Handles modifier keys (CMD/CTRL) to toggle specific behaviors during editing.
- **`handleLinkClick(event)`**:
  - Previews open on modifier+click, not on hover. Resolves the clicked element with `findLinkElement` and defers to Obsidian when it resolves nothing.
- **`api.open(url, { anchor, side? })`**:
  - The public entry point for other plugins (documented in README). Opens through `openPreviewForLink` with `anchor` as the link and `api:<url>` as its source key, so one anchor can open several URLs; `side` then docks the preview.
- **`showPreview(link, url, hoverElement, sourceKey?)`**:
  - Reuses a visible side panel that owns the link, otherwise opens a floating preview.
  - Each call takes a request token; anything that resumes after an `await` drops out when a newer click has started.
- **`showFloatingPreview`**:
  - Reuses a cached entry for the same document and URL, or builds one with `createCachedPreview`.
  - Positions it with `calculatePreviewBounds` and loads the URL in a `webview` (an `iframe` where `webview` is unavailable).
- **`dockPreview(container)`**:
  - Docks the preview as a `PreviewSidePanel` in a Markdown note or a Kanban board (view type `kanban`) in the preview's window: the one holding the preview's link, else the most recent, else any.

#### LinkPreviewSettingTab

Settings UI for configuring plugin behavior:
- `modifierKeys`: which of meta/ctrl/alt/shift must be held, with a platform-aware default; at least one is always selected.
- `stickyPopup`: keep the preview open until Escape or a click outside.
- `showOpenInBrowser`, `showCloseButton`, `showLoadingIndicators`: preview chrome.
- `showInlinePreviewButton`, `showInlineExternalLinkIcon`, `showGitHubHoverCard`, `showGitHubPullRequestIds`: inline link affordances.
- `maxPreviewHeight` / `maxPreviewWidth`: dimensions of the preview window, clamped by `sanitizePreviewSize`.
- `allowResize`, `persistResize`, `persistedWidth` / `persistedHeight`: drag-to-resize and whether the size is reused.
- `domainZoomLevels`, `sidePanelRatio`: per-domain zoom and the side-panel divider position.

#### Utilities

- **`findLinkElement`**: Traverses up the DOM tree from the event target to find a valid anchor or link-like element.
- **`extractUrlFromElement`**: Extracts the URL from `href`, `data-href`, or text content.
- **`calculatePreviewBounds`**: Determines the best position (above/below) for the preview window based on screen real estate.

### Link Detection

The plugin detects external links using the selector: `a.external-link, a[href^="http"], span.external-link, .cm-hmd-external-link, .cm-link .cm-underline, .cm-url, [data-href], [data-url]`. This covers both reading mode and editor mode (CodeMirror classes like `.cm-url`).

Two rules keep it off Obsidian's own links and off documentation:
- `extractUrlFromElement` runs an anchor's resolved `href` through `normalizeUrl`, which only accepts `http(s)`, so an internal link's `app://` URL resolves to nothing and the click falls through to Obsidian. `getEditorLinkInfo` additionally refuses to match an element carrying `data-href` or inside `.internal-link` by its display text.
- `isRangeInsideCode` consults the editor's syntax tree, so a URL inside inline code, a fenced block, a comment or the frontmatter gets neither a badge nor a preview. All three write paths consult it — the command, the hover paths, and the editor context menu, which resolves links from raw text and would otherwise rewrite a URL inside a code sample.
- `parseMarkdownLinks` bounds each half of a link: `findClosingBracket` and `findClosingParen` stop at the next blank line and at a length cap (1024 for the text, 16384 for the destination). Without the bound an unmatched `[` — LaTeX writes `\[`, and interval notation writes `$[0, 1)$` — scans to end of file, which is quadratic in the note's length and is paid on every keystroke.

### Preview Lifecycle

1. `handleLinkClick` - modifier+click resolves the link and calls `openPreviewForLink`
2. `showPreview` - reuses the side panel when it owns the link, otherwise `showFloatingPreview`
3. `createCachedPreview` / `activateCachedPreview` - builds or reactivates the entry, unmutes it and clears its expiry
4. `cleanupActivePreview` - marks the entry `is-cached`, mutes it and arms a five-minute expiry; non-sticky previews close after a 300 ms grace period
5. `disposeCachedPreview` - closes the dock, cancels a refresh, detaches the guest keyboard listener and removes the element

The cache holds at most five entries (`PREVIEW_CACHE_LIMIT`), evicts least-recently-activated first, and never evicts the active or docked entry. An entry is found by the URL its link asked for as well as by the page it is currently showing, but the first of those only counts while the page is still the one its load settled on — otherwise browsing inside a preview makes that page answer for the link. Each cached entry is a live renderer process: on the live vault four cached pages added 865 MB and four processes, which is why they are muted while hidden and dropped after `PREVIEW_CACHE_TTL_MS`.

### Platform Handling

Uses `Platform.isMacOS` to determine modifier key (Meta vs Control) for editor mode link previews.

## Rules

- Trunk-based: commit on `master`. No feature or release branches unless needed.
- ALWAYS build after changes
- ALWAYS lint before pushing (`npm run lint`). The `build` script includes linting automatically.
- In dev mode, the `dist/` symlink handles deployment to the vault automatically. For production/release builds, copy built files manually: `cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/url-preview/"`
- NEVER use direct style manipulation (`element.style.*`, `style.cssText`). Use CSS classes, `setCssStyles()`, or `setCssProps()` instead.

## Obsidian Plugin Guidelines

This plugin must pass ObsidianBot automated review. Follow these rules to avoid PR rejection.

### Required (will block PR approval)

1. **No direct style manipulation** - Use CSS classes or Obsidian's style APIs
   - ❌ `element.style.visibility = 'visible'`
   - ❌ `element.style.opacity = '0.5'`
   - ❌ `element.style.cssText = '...'`
   - ✅ `element.addClass('is-visible')` — for toggling states (define in `styles.css`)
   - ✅ `element.setCssStyles({ left: '10px' })` — for dynamic/computed values
   - ✅ `element.setCssProps({ '--my-var': '10px' })` — for CSS custom properties

2. **No unnecessary type assertions**
   - ❌ `element.querySelector('a') as HTMLAnchorElement`
   - ✅ `const el = element.querySelector('a'); if (el instanceof HTMLAnchorElement) { ... }`

3. **No unused variables**
   - ❌ `catch (e) { return null; }` (if `e` unused)
   - ✅ `catch { return null; }`

### Best Practices

- Use `Platform.isMacOS` for OS detection (not `navigator` API)
- Use Obsidian's APIs over browser APIs where available
- Avoid regex lookbehinds (iOS Safari compatibility)
- Use sentence case for UI strings

### References

- [Obsidian ESLint Plugin](https://github.com/obsidianmd/eslint-plugin) — installed locally as `eslint-plugin-obsidianmd`
- [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [PR Review History](https://github.com/obsidianmd/obsidian-releases/pull/9474)

## Release Procedure

When preparing a release, follow these steps in order:

### 1. Update CHANGELOG.md

Add a new version entry following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format:
- Use sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`
- Date format: `YYYY-MM-DD`
- List user-facing changes only

### 2. Version Bump

Follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html):
- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

Steps:
1. Update `version` in `package.json`
2. Run `npm run version` (updates `manifest.json` and `versions.json`)

### 3. Update README.md

Review if changes warrant README updates:
- New features → Update Features section
- New settings → Update Settings section
- Changed behavior → Update Usage section

### 4. Demo Recording

Consider re-recording the demo GIF if:
- UI changed visually
- New user-facing feature added
- Existing behavior changed significantly

Save as `demo.gif` in project root.

### 5. Build & Deploy for Testing

Read `VAULT` path from `.env` file, then:
```bash
npm run build
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/url-preview/"
```

### 6. Commit & Tag

After user confirms testing is complete:
```bash
git add -A
git commit -m "Release X.Y.Z"
git tag X.Y.Z
git push && git push --tags
```

Pushing the tag triggers the `.github/workflows/release.yml` workflow, which automatically builds the plugin and creates a GitHub release with `main.js`, `manifest.json`, and `styles.css` attached. No manual asset upload needed.
