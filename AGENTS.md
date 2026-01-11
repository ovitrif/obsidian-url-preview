# AGENTS.md

This file provides guidance to AI agents like [Claude Code](https://claude.ai/code) or [Warp](https://warp.dev) when working with code in this repository.

## Project Overview

This is an Obsidian plugin ("URL Preview") that displays a website preview when hovering over external links within Obsidian. It is built with TypeScript and uses `esbuild` for bundling.

## Build Commands

```bash
npm run dev      # Start development mode with watch (uses esbuild)
npm run build    # Production build (runs tsc type-check then esbuild)
npm run version  # Updates the version in manifest.json and versions.json (requires git)
```

The build outputs `main.js` to the project root. For local development, copy `main.js`, `manifest.json`, and `styles.css` to your Obsidian vault's `.obsidian/plugins/url-preview/` directory.

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
  - Adds the settings tab.
- **`registerGlobalHandler()`**:
  - Attaches `mouseover` event listeners to the document to detect link hovers (`handleLinkHover`).
  - Handles modifier keys (CMD/CTRL) to toggle specific behaviors during editing.
- **`handleLinkHover(event)`**:
  - Identifies if the hovered element is a valid external link using `findLinkElement`.
  - Manages debounce logic (`hoverTimeout`) before showing the preview.
  - Sets up `mouseleave` listeners to cleanup the preview.
- **`showPreview(link, url)`**:
  - Creates the preview container (`createPreviewElement`).
  - Calculates positioning (`calculatePreviewBounds`) to ensure the preview fits within the window.
  - Injects an `iframe` to load the external URL.

#### LinkPreviewSettingTab

Settings UI for configuring preview dimensions and hover delay:
- `hoverDelay`: Time in ms before preview appears.
- `maxPreviewHeight` / `maxPreviewWidth`: Dimensions of the preview window.

#### Utilities

- **`findLinkElement`**: Traverses up the DOM tree from the event target to find a valid anchor or link-like element.
- **`extractUrlFromElement`**: Extracts the URL from `href`, `data-href`, or text content.
- **`calculatePreviewBounds`**: Determines the best position (above/below) for the preview window based on screen real estate.

### Link Detection

The plugin detects external links using the selector: `a.external-link, a[href^="http"], span.external-link, .cm-url, .cm-link, .cm-underline, [data-href], [data-url]`. This covers both reading mode and editor mode (CodeMirror classes like `.cm-url`).

### Preview Lifecycle

1. `handleLinkHover` - Triggered on mouseover, starts hover delay timer
2. `showPreview` - Creates preview popup with iframe after delay
3. `cleanupActivePreview` - Removes preview on mouse leave with 300ms grace period

### Platform Handling

Uses `Platform.isMacOS` to determine modifier key (Meta vs Control) for editor mode link previews.

## Rules

- ALWAYS build after changes
