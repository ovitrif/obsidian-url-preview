# URL Preview for Obsidian

A plugin for [Obsidian](https://obsidian.md) that shows a preview of external URLs on hover without leaving Obsidian. Works in **Editor**, **Live Preview**, and **Reader** modes.

![Demo of URL Preview](demo.gif)

## Features

- Hold a configurable modifier key (⌘, Control, Alt, or Shift) + hover to preview URLs
- Works in all view modes (Editor, Live Preview, Reader)
- Works in secondary Obsidian windows/popouts
- Clean interface that matches Obsidian's theme
- Press ESC to dismiss the preview window
- Customize preview window size, hover delay until it appears, mouse sensitivity tolerance
- Resize preview window by dragging edges or corners
  - Toolbar button to quickly expand or restore the preview size
  - Accent-colored border highlight on resize handle hover (uses Obsidian's accent color)
  - Live size indicator showing dimensions during resize
  - Optionally persist resized dimensions across previews
- Preview controls live in a toolbar above the content, so they do not cover the page being previewed
- Loading spinner near cursor during hover delay
- Modifier-key press alone does not open previews; move the mouse slightly while still over the link
- Hovered links show a small eye button that opens the preview directly
- Bare GitHub URLs show a small GitHub button to convert them to Markdown links
- Toolbar zoom controls remember zoom per domain
- Toolbar buttons show bottom-positioned action tooltips
- GitHub previews switch between sign-in and sign-out actions based on the detected GitHub session
- Right-click an editor URL to convert it to a Markdown link using the page title
- Smart keyboard trigger suppression while editing (prevents unwanted popups)
- Pending preview auto-cancelled if modifier keys are released or mouse leaves link

## Installation

1. Open Obsidian Settings
2. Go to Community Plugins and disable Safe Mode
3. Click Browse and search for "URL Preview"
4. Install the plugin and enable it

## Settings

- **Require Modifier Key**: Only show preview when holding a modifier key (enabled by default)
- **Modifier Keys**: Choose which keys to hold (Command, Control, Alt, Shift — can combine multiple)
- **Close on Key Release**: Close preview when modifier key is released
- **Sticky Popup**: Keep preview open until ESC or click outside
- **Show Open in Browser Button**: Show a button to open the URL in the default browser
- **Show Close Button**: Show a button to close the preview popup
- **Hover Delay**: How long to wait before showing the preview (500 ms by default)
- **Mouse Stillness Delay**: Time the mouse must be stationary before showing preview (500 ms by default)
- **Maximum Height / Width**: Maximum dimensions of the preview window (in pixels)
- **Allow Resize**: Enable drag-to-resize on preview edges and corners
- **Persist Resize**: Remember resized dimensions for future previews (with reset button)

## Usage

Hold your modifier key (⌘ on Mac, Ctrl on Windows/Linux by default) and hover over any external link to see a preview.

In Live Preview or source mode, right-click an external URL and choose **Convert URL to Markdown link** to replace it with `[page title](url)`.

## Authentication

Previews load live pages in an iframe instead of cached snapshots. If a site allows authentication inside Obsidian's embedded browser session, that login can be reused by later previews for the same site. GitHub previews use Obsidian's desktop Electron cookies to switch the toolbar action between "Sign in to GitHub" and "Sign out of GitHub" when that state can be detected.

## Limitations

Some websites block iframe embedding and cannot be previewed. This is a browser security restriction that cannot be bypassed.

## Support

If you encounter issues or have suggestions, please file them on the [GitHub repository](https://github.com/ovitrif/obsidian-url-preview/issues).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT. See [LICENSE](LICENSE).
