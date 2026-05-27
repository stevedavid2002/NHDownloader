# NH Downloader Free

NH Downloader Free is a lightweight Chrome/Edge Manifest V3 extension that adds one-click queue buttons to supported gallery pages.

This free edition keeps only the queue downloader:

- Adds a `Queue` button to gallery cards and gallery links.
- Keeps a small floating queue panel on supported pages.
- Downloads queued galleries one at a time by opening the gallery page in a background tab and triggering the site's ZIP download flow.
- Tracks active, completed, failed, and waiting queue items in browser local storage.
- Includes an optional Patreon support button.

The local library, reader, folder import, metadata review, favorites sync, and auto-refill features from the Pro build are not included.

## Install Locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Choose `Load unpacked`.
4. Select this folder.

## Permissions

- `downloads`: watches browser download progress so completed tasks can leave the queue.
- `storage`: stores the queue and download history locally in the browser.
- `alarms`: recovers stuck queue tasks and resumes cooldown timers.
- `tabs`: opens queued gallery pages in background tabs to trigger downloads.
- `declarativeNetRequest`: keeps thumbnail requests working on supported hosts.

## Support

Use the in-extension Support button if this project saves you time.

## License

GPL-3.0-only. See [LICENSE](LICENSE).

This project is intended for personal archival and workflow purposes only.
Users are responsible for complying with local laws and website terms of service.