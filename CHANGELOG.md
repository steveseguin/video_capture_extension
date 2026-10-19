# Changelog

## 1.1.11

- Remember generated Discord camera and screen-share links across calls in the same browser profile when the participant can be identified.
- Allow a remembered Discord link to restart after a page reload when its previous publisher is confirmed to have ended.

## 1.1.10

- Keep identifiable VDO.Ninja, Google Meet, and Microsoft Teams videos associated with their existing capture IDs when tiles move or return.
- Capture Twitch's separate stream preview during detected ad breaks. When no stream video is available, suppress captured video and Twitch audio until the stream returns, while keeping the publisher connected.
- Refresh Twitch capture streams when their underlying media reloads, and preserve the optional microphone mix during ad transitions.
- Preserve Discord source identities while tile labels load and prefer live, visible copies during layout transitions.

## 1.1.9

- Update the bundled VDO.Ninja SDK to 1.6.2.
- Keep Discord stream IDs and viewer links when identifiable video sources move or return after layout changes and camera interruptions.
- Distinguish Discord cameras from screen shares and avoid assigning ambiguous tiles to another source.
- Preserve Discord's original media tracks when replacing or stopping captures, and keep microphone mixing during source replacement.
- Keep active stream controls when cleanup from a timed-out publish finishes after a successful retry.

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
