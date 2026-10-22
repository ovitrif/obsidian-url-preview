# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Command **Preview link at cursor**, so a preview can be opened from the keyboard or on a touch device.
- An API for other plugins: `app.plugins.plugins['url-preview'].api.open(url, { anchor, side })` opens a preview of `url` beside `anchor`, or straight in the side panel with `side: true`.
- Browser keys in the preview: Cmd+[ and Cmd+] go back and forward, Cmd+L selects the address (Ctrl on Windows and Linux).
- `api.openNote(path, { anchor })` shows a vault note in the side panel beside a note or board, with zoom, in Reading view or Live Preview for editing, with back and forward through the notes it showed (hold either for the list).

### Changed

- The side panel docks beside a Kanban board as well as beside a note, and beside the note or board the preview was opened from.
- Cached previews are silenced while they are out of sight and released five minutes after they are closed.
- Preview, divider, hover card and toolbar tooltip now sit on Obsidian's own layers rather than fixed numbers, so Obsidian's popovers no longer cover a preview.
- Badge decorations are built from a cached parse and only for the visible part of the note.
- The embedded skeleton font is subset to the two characters it draws, taking `styles.css` from 82 KB to 26 KB.
- Escape closes a docked side panel when the panel, its divider or nothing holds focus — including right after docking with the toolbar button — and leaves the key to the toolbar's own fields and to the note.
- Escape closes a floating preview only when nothing else has claimed that keystroke, so dismissing a modal or the command palette no longer closes the preview with it. With Vim key bindings on, an Escape typed in the editor leaves insert mode and the next one closes the preview; anything typed in between starts over.
- **Preview link at cursor** moves focus into the preview and gives it back to the editor when the preview closes.
- A preview is found again by the URL the link asked for as well as by the page it ended up on, so a link that redirects reuses its preview instead of opening a second one.
- Page-title requests stay anonymous and time out after ten seconds.
- "Copy PR ID" is now "Copy issue or PR ID", and the pull-request setting names issues too, since both were always handled.

### Removed

- GitHub auth button from the preview toolbar; sign in and out using the website's own controls inside the preview.

### Fixed

- Modifier-clicking an internal `[[wikilink]]` opened a blank preview instead of the note, in every mode.
- A note containing both `[[Design]]` and `[Design](…)` previewed the external link when the wikilink was clicked.
- URLs written inside inline code or a fenced code block were given previews and GitHub badges.
- A note in reading view containing a GitHub pull request link rescanned the whole document every frame, for as long as it stayed open.
- Resolving the link under the pointer re-parsed the whole note, several times per mouse move.
- A closed preview of a page playing audio kept playing it from an invisible element.
- A link conversion could land in whichever note the editor was showing when the title arrived, or be silently dropped while reporting success.
- A bare URL ending in a parenthesis, such as a Wikipedia disambiguation link, was truncated, including when converting it to a Markdown link.
- Converting a link whose page returned an HTTP error wrote the error page's title into the note.
- "Copy agent session title" could copy the note's own link text as though it were the page's title.
- The side panel swallowed every preview in its window while it was hidden in a background tab, lost unsaved input when it was retargeted, and returned the panel's geometry instead of the preview's own.
- A half-typed value in Maximum height or Maximum width was written to disk and could leave previews unopenable; a value below the minimum is now clamped rather than discarded.
- Settings written in quick succession could overwrite each other.
- Holding an arrow key on the side-panel divider wrote settings on every repeat.
- A popout window's handlers were never released when it closed.
- A navigation that failed after the first page said nothing at all.
- "Open in right-side panel" did nothing when the most recent note was in another window.
- A reopened preview came back labelled "Restore preview size" at its normal size, and the zoom box kept the previous domain's number.
- The preview toolbar, the inline buttons and the size and zoom inputs had no visible keyboard focus ring, hidden inline controls stayed in the tab order, and the spinners ignored the reduced-motion setting.
- The side panel squeezed the note's view header, the popup's shadow and edge were unreadable in light themes, and generic class names styled or removed other plugins' elements.
- A page that handed off to a mail client or an app scheme while it was still loading was hidden behind "Failed to load preview".
- The right-click menu offered to convert a URL inside a fenced block or inline code, silently rewriting a command in a code sample.
- Converting an image embed's URL broke the embed; link reference definitions and raw HTML `href`/`src` values were treated as links too.
- A bare `gist.github.com/…` or `docs.github.com/…` previewed `github.com/…`, a different page than the note names.
- `[[note#3]]` was given a GitHub issue badge and previewed as a GitHub issue instead of opening the note, and a URL in a note's frontmatter was treated as a link.
- A URL wrapped in `**`, backticks or `~~` carried the closing markers into the address.
- Resizing or expanding a preview while its page refreshed in the background was undone a moment later, and typing in the toolbar during that refresh lost what was typed.
- Taking a sticky preview back out of the side panel left it impossible to dismiss by clicking in the note.
- A GitHub pull request badge was copied along with the paragraph it sits in.
- A `www.github.com` issue link in reading view made the plugin rescan the note continuously and never showed its badge.
- The preview button beside a link stayed on the link the pointer had left, could not move between two links in the same paragraph, and survived scrolling and resizing.
- A `target="_blank"` link inside a previewed page did nothing at all; the preview follows it now.
- The close button's corner started a resize instead of closing the preview.
- The side panel divider could not be moved at all in a note narrower than 560 px.
- The second GitHub reference in a sentence could never be hovered, and the card stayed pinned over unrelated text after scrolling.
- An issue title containing `<` disappeared from the note when the link was converted.
- Clicking a link after browsing elsewhere inside its preview reopened the page you had browsed to, and a link that redirects opened a second preview every time.
- Escape in the zoom box committed the typed value instead of reverting it.
- Releasing a resize drag past the window edge closed the preview, and restoring an expanded preview after shrinking the window put it off screen.
- A preview refreshed in the background handed focus back to the note while staying open.
- A backslash written immediately before a blank line made the plugin treat two paragraphs as one link, and converting that link deleted the paragraph break and everything between.

## [0.8.0] - 2026-09-08

### Added

- Preview toolbar navigation with back and forward buttons plus an editable address bar.
- Setting to show the inline preview eye button while hovering links, disabled by default.

### Changed

- GitHub link conversion now supports scheme-less `github.com/...` URLs and short references such as `owner/repo#123` from both the inline action and editor context menu.
- Desktop previews now use Obsidian's persistent embedded browser session when available so login state survives across previews more reliably.

### Fixed

- Preview loader now waits for navigation and rendering to finish, handles overlapping loads safely, and fades out instead of exposing a blank page.

## [0.7.0] - 2026-09-01

### Added

- Editor context menu actions for GitHub pull request and issue links: add repo name prefix (inserts `repo: ` before the link), copy PR ID, and copy agent session title.

### Changed

- GitHub pull request ID badges and hover-card references now copy `#123` on click, or `owner/repo#123` when holding ⌘ on macOS / `Alt` elsewhere.
- GitHub hover card titles now show computed repo initials plus the issue/PR number before the title (for example `ba#1141 fix: ...`).
- Convert URL context menu item now uses the GitHub icon for GitHub links.

## [0.6.0] - 2026-08-08

### Added

- Toolbar zoom controls with hidden per-domain zoom persistence.
- GitHub auth button in the preview toolbar so GitHub auth can persist across live previews.
- Bottom-positioned toolbar button tooltips.
- Inline eye button beside hovered links to open previews directly.
- Inline GitHub button beside bare GitHub URLs to convert them to Markdown links.
- Editor context menu action to convert external URLs to Markdown links using the page title.
- Subtle pull request number badges beside GitHub PR links in Live Preview and reading mode.
- Setting to toggle GitHub pull request ID badges.
- Clickable GitHub pull request ID badges that copy the `owner/repo#123` reference to the clipboard.
- Settings sidebar icon for URL Preview.
- Toolbar size controls with a pin toggle to remember the current preview dimensions.
- GitHub hover cards for pull request and issue links on regular link hover.

### Changed

- Preview trigger now uses configured modifier keys plus click instead of modifier-hover.
- Refined toolbar zoom controls with the zoom-out button next to the input, a reset icon, and a muted percent suffix.
- Previews now always load as live iframes instead of static snapshots so browser session cookies can apply.
- GitHub auth button switches between sign-in and sign-out when desktop GitHub session cookies can be detected.
- GitHub previews now use the actual preview width for zoom and responsive layout instead of a forced desktop viewport.
- GitHub pull request ID badges now render after Obsidian's external-link icon.
- GitHub pull request and issue tooltips now use short `owner/repo#123` references.

### Removed

- Hover-trigger settings: require modifier key, close on key release, hover delay, and mouse stillness delay.
- Static page snapshot cache and image cache support.

### Fixed

- Inline link action buttons no longer overlap Obsidian's external-link icon and remain clickable while moving the pointer toward them.
- Preview loading spinner now remains visible through iframe load/reveal so blank previews are less jarring.
- Removed GitHub-specific iframe cropping that could create extra blank space above pull request titles.
- GitHub pull request badges no longer appear on collapsed heading placeholders in Live Preview.
- Preview size input now matches the toolbar zoom control styling when unfocused.
- GitHub pull request badges are hidden when the Markdown link text already includes the same `#123`.
- Restored GitHub pull request badges on normal Live Preview links after tightening the folded-heading fix.
- GitHub hover cards now show a Flow Circular skeleton shimmer only while uncached preview details load.
- Inline link action buttons now stay visible across the hovered visual line and use larger circular icons.
- Inline link action buttons now keep a full-width cached hover zone for the active link row.
- Preview popups now use a stronger layered shadow so they stand out from the page behind them.
- GitHub hover card excerpts now fade in after the loading skeleton is replaced.
- GitHub hover cards now prefer opening below the cursor and remain open while moving the pointer onto them.
- GitHub hover cards now measure expanded excerpt height before deciding whether to open above or below.
- GitHub hover cards no longer render a caret, keeping the shape as a rounded rectangle.
- GitHub hover cards now stay pinned after opening instead of following every mouse movement.
- Inline link action buttons now appear when hovering anywhere on the same visual line as a link.
- Inline link action buttons now render without border or shadow chrome.
- GitHub hover cards now require the configured preview modifier keys while hovering the link itself.
- GitHub hover cards now stay open after modifier release while the pointer remains on the link line or card.
- Bundled the Flow Circular font locally for GitHub hover card skeleton placeholders.
- GitHub hover card skeletons now inline the Flow Circular font and avoid readable placeholder text.
- GitHub hover cards no longer apply the legacy loading class that could draw an accent loading bar.
- GitHub hover cards now let the `owner/repo#123` header copy the reference and no longer add a duplicate reference tooltip to the link text.
- GitHub hover card reference copy affordance now renders as inline text instead of a native button.
- GitHub hover card titles now copy the title text when clicked, with the same inline clipboard affordance.
- GitHub hover cards now keep open on internal clicks, allow text selection, remove the redundant type chip, and show five excerpt lines.
- GitHub hover card descriptions now keep enough source text to fill the five-line excerpt clamp.
- GitHub hover cards now clamp excerpts to five visible lines and no longer trigger the old modifier-hover tooltip.
- Inline link actions and GitHub hover cards no longer appear from a parked cursor during edits, and both are suppressed in source mode.
- GitHub hover cards now read the PR state from the page header and show it by coloring the title icon instead of rendering a separate pill row.

## [0.5.0] - 2026-05-05

### Added

- Quick expand/restore button in the preview toolbar for fast size adjustment (#7)

### Changed

- Preview controls now appear in a toolbar above the preview content instead of overlaying the iframe (#7)
- Default settings now use a 1000ms hover delay, 1000ms mouse stillness delay, sticky popups, and no close-on-key-release while keeping Command as the default modifier on macOS and Ctrl on Windows/Linux

### Fixed

- URL previews now work in secondary Obsidian windows/popouts (#6)
- Editor links with square brackets in the link text now show previews
- Repeated editor links now resolve from the hovered link occurrence instead of matching by the first similar text

## [0.4.0] - 2026-03-31

### Added

- Resizable preview window: drag edges or corners to resize the popup
- Accent-colored border highlight on hover over resize handles (uses Obsidian's accent color)
- Live size indicator showing dimensions during resize
- Loading spinner near cursor during hover delay
- New setting: "Allow resize" (default: on)
- New setting: "Persist resize" to remember resized dimensions across previews (default: off)

### Fixed

- Preview no longer pops up unwanted when using modifier keys to edit text (keyboard trigger requires recent mouse movement)
- Pending preview cancelled when modifier keys are released before preview appears
- Pending preview cancelled when mouse leaves link before preview appears
- Orphaned preview windows that could not be closed via ESC or close button

## [0.3.0] - 2026-02-28

### Added

- Floating "Open in browser" and "Close" buttons on the preview popup
- New setting: "Show open in browser button"
- New setting: "Show close button"
- Subtle border on preview popup for better visibility against matching backgrounds

### Fixed

- Wrong preview shown when links share common text in editor mode (e.g., "Obsidian" vs "Obsidian Docs")

## [0.2.1] - 2026-02-08

### Added

- New setting: "Sticky popup" - keep preview open until ESC or click outside (#1)

### Changed

- Settings UI: grouped related settings using Obsidian's SettingGroup API (modifier keys, behavior, mouse, preview size)
- Minimum Obsidian version bumped to 1.11.0

## [0.2.0] - 2026-01-23

### Added

- Multiple modifier key support: combine keys like CMD+SHIFT for preview activation
- New setting: "Mouse stillness delay" - require mouse to be stationary before showing preview

### Changed

- Settings UI: replaced single dropdown with toggle checkboxes for modifier keys
- Automatic migration from single modifier key to new multi-key format

## [0.1.3] - 2026-01-15

### Added

- New setting: "Require modifier key" - only show preview when holding a modifier key (enabled by default)
- Configurable modifier key selection (Command/Control/Alt/Shift) with platform-aware defaults
- New setting: "Close on key release" - optionally keep preview open until mouse leave or ESC

## [0.1.2] - 2026-01-13

### Changed

- Updated default preview dimensions (960x720)
- Updated styling to hide the entire topbar on GitHub previews

## [0.1.1] - 2026-01-12

### Added

- Press ESC key to dismiss preview

### Fixed

- Use CSS classes instead of direct style manipulation (Obsidian plugin guidelines)
- Remove unnecessary type assertions
- Dark theme support: loading background now matches current theme
- Fixed rounded corner bleeding in dark themes

## [0.1.0] - 2026-01-11

### Added

- Initial release
- Hover preview for external URLs
- Support for Editor, Live Preview, and Reader modes
- Configurable hover delay
- Configurable preview window dimensions
