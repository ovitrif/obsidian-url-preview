# URL Preview for Obsidian

A plugin for [Obsidian](https://obsidian.md) that shows a preview of external URLs without leaving Obsidian. Works in **Editor**, **Live Preview**, and **Reader** modes.

![Demo of URL Preview](demo.gif)

## Features

- Hold configurable modifier keys (⌘, Control, Alt, or Shift) + click to preview URLs
- Works in all view modes (Editor, Live Preview, Reader)
- Works in secondary Obsidian windows/popouts
- Clean interface that matches Obsidian's theme
- Press ESC to dismiss the preview window
- Customize preview window size
- Resize preview window by dragging edges or corners
  - Toolbar button to quickly expand or restore the preview size
  - Accent-colored border highlight on resize handle hover (uses Obsidian's accent color)
  - Live size indicator showing dimensions during resize
  - Optionally persist resized dimensions across previews
- Preview controls live in a toolbar above the content, with back/forward navigation and an editable address bar
- Open one reusable right-side panel inside the current page, keeping your note on the left
- Keep up to five recent previews in memory for immediate reopening with their scroll position preserved
- Optionally show a small eye button beside hovered links to open the preview directly
- Bare GitHub URLs and short references such as `owner/repo#123` show a GitHub button to convert them to Markdown links
- Toolbar zoom controls remember zoom per domain
- Toolbar buttons show bottom-positioned action tooltips
- Sign in and out using the website's own controls inside the preview
- Right-click an editor URL to convert it to a Markdown link using the page title

## Installation

1. Open Obsidian Settings
2. Go to Community Plugins and disable Safe Mode
3. Click Browse and search for "URL Preview"
4. Install the plugin and enable it

## Settings

- **Preview Click Modifiers**: Choose which keys to hold while clicking a link (Command, Control, Alt, Shift — can combine multiple)
- **Sticky Popup**: Keep preview open until ESC or click outside
- **Show Preview Button on Link Hover**: Show the eye button beside hovered links (off on new installs)
- **Show Open in Browser Button**: Show a button to open the URL in the default browser
- **Show Close Button**: Show a button to close the preview popup
- **Show Loading Indicators**: Show the initial loading overlay and spinners (off by default); disabling it also removes the content-area background override
- **Maximum Height / Width**: Maximum dimensions of the preview window (in pixels)
- **Allow Resize**: Enable drag-to-resize on preview edges and corners
- **Persist Resize**: Remember resized dimensions for future previews (with reset button)

## Usage

Hold your configured modifier keys (⌘ on Mac, Ctrl on Windows/Linux by default) and click any external link to see a preview.

Use **Open in right-side panel** in the toolbar to place the preview beside your note without creating a workspace split or tab. Further preview links reuse that panel; Back and Forward follow both links opened from notes and navigation within the website. Closing the panel restores the note's full width. Closing a preview keeps its loaded page in memory. On reopening, the cached page appears immediately while a fresh copy loads behind it. The replacement preserves page scrolling; failed refreshes and active edits keep the existing page. Refreshes are triggered only by reopening a closed preview. The five-page cache is cleared when the plugin unloads or Obsidian closes.

In Live Preview or source mode, right-click an external URL, a scheme-less `github.com/...` URL, or a short GitHub reference such as `owner/repo#123`, then choose **Convert URL to Markdown link** to replace it with `[page title](url)`. For GitHub pull request and issue links, the menu also includes **Add repo name prefix**, **Copy PR ID**, and **Copy agent session title**.

## Authentication

On desktop, previews use Obsidian's persistent embedded browser session when available, so login state can be reused by later previews. Use the website's own sign-in and sign-out controls.

The side-panel toolbar button switches back to a floating preview without reloading. Drag the divider to resize the note and preview; its position is remembered. The divider highlights in the accent color on hover and while dragging, and supports Left/Right arrow keys when focused.

## Limitations

Some websites block iframe embedding and cannot be previewed. This is a browser security restriction that cannot be bypassed.

## Support

If you encounter issues or have suggestions, please file them on the [GitHub repository](https://github.com/ovitrif/obsidian-url-preview/issues).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT. See [LICENSE](LICENSE).
