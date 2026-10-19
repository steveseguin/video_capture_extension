# Chrome Web Store Permission Justifications

## Single Purpose

Capture a user-selected video or browser tab and publish it to viewers through VDO.Ninja using WebRTC. Users choose what to publish, configure the connection, share viewer links, and stop their streams from the extension. An optional microphone can be mixed into an individual video capture when the user selects it and grants browser permission.

## Permissions

### activeTab

Access the tab the user invokes the extension on for video selection and capture actions.

### Host permissions: `<all_urls>`

Detect and capture video elements on the websites users choose, including video sites, meeting pages, and embedded frames. The extension captures videos from those websites and sends them through VDO.Ninja; it is not limited to pages hosted on VDO.Ninja. Browser restrictions still apply to protected pages and protected media.

### scripting

Run the extension's packaged capture functions in the selected tab and its frames to detect videos, produce thumbnails, and start or stop individual video publishers.

### storage

Save quality and connection settings and active-stream information in the browser. Local storage retains preferences across popup closures; session storage retains publisher bookkeeping while the background worker is suspended. This information supports stream controls and viewer links.

For identifiable Discord videos, local storage also associates the participant's numeric user ID and camera or screen-share type with a randomly generated stream ID, so viewer links can be reused across calls. The Discord user ID is not included in viewer links or sent to the signaling service by this feature.

### tabs

Identify source tabs, read their titles and URLs for stream selection and labels, route capture controls to the correct tab, and clean up captures when a source tab closes.

### tabCapture

Obtain the video and audio of the selected browser tab when the user chooses whole-tab capture. This is separate from capturing an individual video element.

### offscreen

Run the packaged offscreen document that obtains the tab-capture MediaStream and maintains its WebRTC publisher after the popup closes. The Manifest V3 background worker cannot host those media APIs itself.

## Packaged Code

The content scripts, popup, background worker, offscreen document, and VDO.Ninja SDK are included in the extension package. The extension does not download JavaScript for execution. Network requests used to establish streams exchange signaling and relay configuration data.

Content scripts load on matching websites, but media publishing starts only when the user starts a capture. The extension does not automatically publish the videos it detects.

## Data Use

- Selected video, tab audio, and optional microphone audio are transmitted to connected viewers when the user publishes a stream.
- Stream and room identifiers, labels, and WebRTC connection information are used to establish and manage connections through the selected signaling service.
- Media travels directly between peers when possible. TURN servers can relay encrypted media when a direct connection is unavailable.
- Peer connections and network services can receive IP addresses and connection metadata needed for WebRTC. Viewer links and room settings determine how viewers connect.
- Preferences and active-stream information are stored in the browser. The extension does not include analytics, advertising trackers, or an account system.

See the [privacy policy](https://extension.vdo.ninja/privacy.html) for service information and user responsibilities.
