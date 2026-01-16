# URL Preview for Obsidian

A plugin for [Obsidian](https://obsidian.md) that shows a preview of external URLs on hover without leaving Obsidian. Works in **Editor**, **Live Preview**, and **Reader** modes.

![Demo of URL Preview](demo.gif)

## Features

- Hold a modifier key (⌘/Ctrl) + hover to preview any external link
- Works in all editing modes (Editor, Live Preview, Reader)
- Press ESC to dismiss the preview
- Configurable modifier key (Command, Control, Alt, or Shift)
- Customizable preview window size and hover delay
- Clean interface that matches Obsidian's theme

## Installation

1. Open Obsidian Settings
2. Go to Community Plugins and disable Safe Mode
3. Click Browse and search for "URL Preview"
4. Install the plugin and enable it

## Settings

- **Require Modifier Key**: Only show preview when holding a modifier key (enabled by default)
- **Modifier Key**: Choose which key to hold (Command, Control, Alt, or Shift)
- **Close on Key Release**: Close preview when modifier key is released (or keep open until mouse leave/ESC)
- **Hover Delay**: How long to wait before showing the preview (in milliseconds)
- **Maximum Height**: Maximum height of the preview window (in pixels)
- **Maximum Width**: Maximum width of the preview window (in pixels)

## Usage

Hold your modifier key (⌘ on Mac, Ctrl on Windows/Linux by default) and hover over any external link to see a preview.

## Limitations

Some websites block iframe embedding and cannot be previewed. This is a browser security restriction that cannot be bypassed.

## Support

If you encounter issues or have suggestions, please file them on the [GitHub repository](https://github.com/ovitrif/obsidian-url-preview/issues).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT. See [LICENSE](LICENSE).
