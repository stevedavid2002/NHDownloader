# NHDownloader
<img width="281" height="436" alt="21124512" src="https://github.com/user-attachments/assets/6010f6d8-0821-4de2-a994-ceafab6191a7" />
<img width="281" height="436" alt="21124512" src="https://github.com/user-attachments/assets/207a8dd8-fc03-4a05-b3cd-9a1f46833d2b" />

Click the download button on a gallery cover to add it to the download queue.

A lightweight browser extension for queue-based downloading on nhentai-style gallery websites.

Currently supports: nhentai.net & nhentai.xxx

Built for users who want a cleaner and more automated download workflow.
## Features

* Queue-based task management
* One-click queue buttons on supported pages
* Floating queue panel
* Sequential download processing
* Download progress tracking
* Local browser storage support
* Lightweight Manifest V3 architecture

## Workflow

Queued items are processed one at a time in background tabs while keeping the browsing experience clean and uninterrupted.

The extension tracks:

* waiting tasks
* active downloads
* completed items
* failed tasks

## Installation

1. Open `chrome://extensions` or `edge://extensions`
2. Enable Developer Mode
3. Click `Load unpacked`
4. Select the extension folder

## Permissions

* `downloads` — monitors download progress
* `storage` — stores queue data locally
* `tabs` — handles background processing
* `alarms` — resumes interrupted tasks
* `declarativeNetRequest` — keeps supported requests working correctly

## Notes

This project is intended for personal workflow and archival purposes.

Users are responsible for complying with local laws and website terms of service.

## Support

Development support and future updates may be available through external creator platforms.

## License

GPL-3.0-only
