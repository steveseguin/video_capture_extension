# Chrome Web Store Privacy Practice Justifications

## Single Purpose Description
This extension enables users to capture and stream video content from web pages using VDO.Ninja's peer-to-peer WebRTC technology. It detects video elements on pages, allows users to stream them via P2P connections, and provides links for viewers to connect directly without any server-side video processing.

## Permission Justifications

### activeTab
**Justification:** Required to detect and capture video elements on the currently active tab. The extension needs to access the DOM to find video elements and create MediaStream captures when the user explicitly clicks the extension and chooses to stream a video.

### Host Permissions (https://*/*, http://*/*)
**Justification:** Necessary to inject content scripts that detect video elements across all websites. Users need to be able to capture videos from any website they visit (YouTube, Twitch, Discord, etc.). The extension only acts when the user explicitly interacts with it.

### Web Accessible Resources (NOT Remote Code)
**Note:** This extension does NOT use remote code. All JavaScript files are bundled locally within the extension package.

**Justification for web_accessible_resources:** Local extension files (sdk-loader.js, publisher-functions.js, bridge.js, vdoninja-sdk.js) need to be injected into the page context to establish WebRTC peer connections. These files must run in the page's JavaScript context (not the isolated extension context) to access the MediaStream API and WebRTC functionality. This is a security requirement of browsers - WebRTC cannot be initiated from the extension's isolated world.

### Scripting
**Justification:** Required to inject content scripts that:
1. Detect video elements on the page
2. Capture video streams using the MediaStream API
3. Initialize the VDO.Ninja SDK in the page context for P2P streaming
The extension cannot function without the ability to interact with page content.

### Storage
**Justification:** Used to persist:
1. Active streaming sessions across popup closures
2. User's quality settings and preferences (bitrate, codec, etc.)
3. Stream metadata (titles, IDs, timestamps)
This ensures users don't lose their active streams when closing the popup and can maintain their preferred settings.

### Tabs
**Justification:** Required to:
1. Capture entire tab content when users choose "Tab Capture" option
2. Query and interact with tabs to detect videos
3. Open VDO.Ninja links in new tabs when users click stream links
4. Access tab information (title, URL) for stream identification

## Data Usage Declaration

### Data Collection
- **No personal data is collected or transmitted to external servers**
- Video streams are transmitted peer-to-peer directly between users
- Stream IDs are randomly generated locally
- No analytics or tracking

### Data Storage
- Only stores locally:
  - Active stream session data
  - User preferences (quality settings)
  - All data remains on the user's device

### Data Sharing
- **No data is shared with third parties**
- Video streams use peer-to-peer WebRTC connections
- Optional TURN servers (if configured) only relay encrypted traffic
- No video content passes through VDO.Ninja servers

## Privacy Practices Certification

This extension:
- ✅ Does not collect or transmit personal information
- ✅ Uses permissions only for stated functionality
- ✅ Implements peer-to-peer streaming without server-side processing
- ✅ Stores data locally only
- ✅ Does not include analytics or tracking
- ✅ Does not sell or share user data
- ✅ Complies with Chrome Web Store Developer Program Policies

## Additional Notes

- All video streaming is peer-to-peer using WebRTC
- VDO.Ninja is an open-source project focused on privacy
- No account creation or login required
- Users have full control over when streaming starts/stops
- Extension only activates upon explicit user interaction