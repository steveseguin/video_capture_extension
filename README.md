# VDO.Ninja Video Capture Extension

A Chrome extension for capturing and streaming videos from web pages using VDO.Ninja.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the `vdo-capture-clean` folder

## Usage

1. Navigate to any page with videos (YouTube, Discord, etc.)
2. Click the extension icon in your browser toolbar
3. The popup will show detected videos with thumbnails

### Streaming Individual Videos
- Click "Stream Video" to start streaming
- The extension will generate VDO.Ninja links automatically
- View active streams in the "Active Streams" tab
- Click "View Links" to see the streaming URLs

### Tab Capture
- Go to the "Tab Capture" tab
- Select audio/video options
- Click "Start Tab Capture" to stream the entire tab

### Settings
- **Room ID**: Optional room name for collaborative viewing
- **Stream ID**: Auto-generated or custom stream identifier
- **Server**: Choose VDO.Ninja server or custom instance

## Features

- Auto-detects videos on any webpage
- Thumbnail previews of videos
- Individual video streaming with audio
- Full tab capture mode
- Multiple concurrent streams
- Direct VDO.Ninja integration
- Copy-to-clipboard for sharing links

## Troubleshooting

If streaming doesn't start:
1. Reload the page and try again
2. Check browser console for errors (F12)
3. Ensure the video is playing/loaded
4. Try refreshing the video list

## Technical Details

The extension uses:
- Content scripts to detect and capture video elements
- VDO.Ninja SDK for WebRTC streaming
- Chrome Extension Manifest V3
- Background service worker for stream management