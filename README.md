# VDO.Ninja Video Capture Extension

A Chrome extension for capturing videos from web pages and streaming them via VDO.Ninja's peer-to-peer WebRTC technology.

[![Latest Release](https://img.shields.io/github/v/release/steveseguin/video_capture_extension)](https://github.com/steveseguin/video_capture_extension/releases/latest)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-brightgreen)](https://chromewebstore.google.com/detail/vdoninja-video-capture/hppndmepdhaplfamkeblnhpjmiigcdij)

## 📥 Quick Install

### Option 1: Download Latest Release (Available Now)
1. [Download the extension ZIP](https://github.com/steveseguin/video_capture_extension/releases/latest/download/vdo-ninja-capture-extension.zip)
2. Extract the ZIP file
3. Open Chrome and go to `chrome://extensions/`
4. Enable "Developer mode"
5. Click "Load unpacked" and select the extracted folder

### Option 2: Chrome Web Store (Recommended)
[Install from Chrome Web Store](https://chromewebstore.google.com/detail/vdoninja-video-capture/hppndmepdhaplfamkeblnhpjmiigcdij)

## 📚 Documentation

Visit our documentation at [extension.vdo.ninja](https://extension.vdo.ninja/) for:
- [Installation Guide](https://extension.vdo.ninja/installation.html)
- [Privacy Policy](https://extension.vdo.ninja/privacy.html)
- [Terms of Service](https://extension.vdo.ninja/terms.html)

## Features

- 🎥 **Video Detection**: Automatically detects video elements on any webpage
- 📡 **P2P Streaming**: Stream videos directly to viewers using WebRTC
- 🖥️ **Tab Capture**: Capture and stream entire browser tabs with audio
- ⚙️ **Quality Settings**: Control bitrate, codec, and streaming parameters
- 🔒 **Privacy Focused**: All streaming is peer-to-peer, no server recording
- 🎨 **Discord Theme**: Beautiful dark UI matching VDO.Ninja's aesthetic

## Important Limitations

- **Browser:** Chrome or a compatible Chromium browser, version 116 or later.
- **Tab capture:** One entire-tab capture at a time. Multiple individual videos can be published separately.
- **Source lifetime:** Keep source tabs open. Reloading a page, restarting the browser, or reloading the extension ends its captures.
- **Identifiers:** The SDK converts punctuation to underscores and limits stream IDs to 64 characters and room IDs to 30. Viewer links use those normalized IDs. Choose a different stream ID for each publisher.
- **Restricted pages:** Browser settings pages and other protected browser pages cannot be scanned or published.

⚠️ **DRM-Protected Content**: This extension cannot capture DRM-protected videos. Sites like Netflix, Prime Video, Disney+, and other streaming services that use DRM will result in black/blank video capture. This is a browser security limitation, not a bug.

✅ **Works With**: YouTube, Discord, Twitch, Vimeo, and most non-DRM video content
❌ **Does NOT Work With**: Netflix, Prime Video, Disney+, Hulu, and other DRM-protected streaming services

## Usage

1. Navigate to any webpage containing videos (YouTube, Discord, etc.)
2. Click the VDO.Ninja Video Capture extension icon
3. Select a video from the detected videos or choose "Tab Capture"
4. Configure quality settings if desired
5. Click "Publish Video" to start streaming
6. Share the generated viewer links with your audience

Use **Active Streams** to copy links or stop publishing, including streams started
in another tab. Choose **+ Mic** to mix in your local microphone; the browser may
ask for permission. Use **Refresh videos** after the page adds or replaces videos.

After updating an unpacked extension, click **Reload** in `chrome://extensions/`
and reload the source pages before starting new captures.

## How It Works

The extension uses the [VDO.Ninja SDK](https://sdk.vdo.ninja) to establish WebRTC peer-to-peer connections between the streamer and viewers. Video content is captured using the MediaStream API and transmitted directly between browsers without passing through any servers (except optional TURN servers for NAT traversal).

## Building from Source

```bash
# Clone the repository
git clone https://github.com/steveseguin/video_capture_extension.git
cd video_capture_extension

# The extension is ready to load - no build step required
# Open Chrome, go to chrome://extensions/, enable Developer mode
# Click "Load unpacked" and select this directory
```

## Privacy

- No personal data collection
- No analytics or tracking
- All video streaming is peer-to-peer
- Settings stored locally only
- Open source for transparency

## Development

The bundled VDO.Ninja SDK is the official `@vdoninja/sdk@1.6.0` browser build
from https://www.npmjs.com/package/@vdoninja/sdk/v/1.6.0 (MPL-2.0; see
`LICENSE-SDK`). `combined-vdo-scripts.js` contains the same SDK followed by
the extension publisher code. Update both SDK copies together, preserving
everything from `// Setting up VDO publisher functions...` onward.

Run regression checks with `node --test tests/*.test.cjs`.
The release version shell check is `python tests/release-workflow.py` (requires
PyYAML and Bash).
Run extension runtime checks with `node tests/extension-runtime.cjs` and an
installed Playwright package/Chromium browser. Set `PLAYWRIGHT_MODULE` to a
Playwright package path and `CHROMIUM_PATH` to a Chromium executable if they
are not available at the defaults. The runtime checks use an isolated browser
profile and local media, with signaling stubbed to avoid publishing externally.

The extension is built with:
- Manifest V3 Chrome extension architecture
- [VDO.Ninja SDK](https://sdk.vdo.ninja) for WebRTC streaming
- Vanilla JavaScript for performance
- Discord-inspired dark theme CSS

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

The extension code is licensed under the [MIT License](LICENSE). The bundled
VDO.Ninja SDK 1.6.0 is licensed under [MPL-2.0](LICENSE-SDK).

See [CHANGELOG.md](CHANGELOG.md) for release notes. Pushing code to `main` runs
the existing automatic patch-version bump and GitHub release workflow; Chrome
Web Store submission is a separate step.

## Credits

Built with the [VDO.Ninja SDK](https://sdk.vdo.ninja) by Steve Seguin.

## Links

- [Documentation](https://steveseguin.github.io/video_capture_extension/)
- [Latest Release](https://github.com/steveseguin/video_capture_extension/releases/latest)
- [VDO.Ninja](https://vdo.ninja)
- [VDO.Ninja SDK](https://sdk.vdo.ninja)
