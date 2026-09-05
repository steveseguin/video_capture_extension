# Changelog

## 1.1.8

- Update both bundled SDK copies to the official VDO.Ninja SDK 1.6.0 and include its MPL-2.0 license.
- Preserve stream controls across background-worker restarts and fix tab-capture startup, cancellation, and shutdown.
- Support video detection and publishing inside frames, with distinct capture IDs and correctly routed thumbnails.
- Fix concurrent publishing, duplicate stream IDs, late publish results, and failed-stop retry controls.
- Apply bitrate and codec settings correctly, restore saved settings, and normalize identifiers consistently with viewer links.
- Release temporary video elements, microphone resources, and canvas redraw loops when capture stops or fails.
- Prevent stale popup refreshes from replacing newer results; add visible status messages and keyboard-focus styling.
- Handle offscreen setup errors explicitly and pass manual release inputs safely as shell data.
- Add automated regression, Chromium extension-runtime, and release-script checks. Runtime tests use local media and stub signaling; live network playback is not covered.
