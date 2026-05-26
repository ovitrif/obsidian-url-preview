# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Modifier-hover link tooltip hint when modifier-click preview is available.
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
