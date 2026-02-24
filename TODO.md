# TODO

## Media Library Enhancements
- [x] Save thumbnail to disk on successful download (for offline navigation)
- [x] Show file duration in download history list
- [x] Show download date in history list (sortable in future)
- [x] Store source URL in DB for each download (for re-downloading, linking back)

## Persistent Files
- [x] Add "pin" / "keep" flag for downloads — pinned files are excluded from auto-cleanup
- [x] UI toggle (star/pin icon) on each download in history
- [x] Store `pinned` boolean in DB
- [x] Cleanup task skips pinned files
- [x] Option to pin file at download time (checkbox before starting download)
  — prevents forgetting to pin and losing file to auto-cleanup

## Tags
- [x] Add tag management for downloaded files (create, rename, delete tags)
- [x] UI for assigning tags to downloads (multi-select)
- [x] Store tags in DB (many-to-many: downloads <-> tags)
- [x] Filter history by tags
- [x] System tags (Audio, Video) — created automatically, protected from deletion
- [x] Auto-tagging: assign Audio/Video tag automatically on download completion

## UI / Side Panel
- [x] Rework side panel: tags section as primary, services collapsed
- [x] Sidebar navigation: Home / Library with icons
- [x] SPA routing (History API) between Home and Library views

## Library Page
- [x] Dedicated Library page for managing downloaded files
- [x] Search by title or URL
- [x] Filter by: all, pinned, audio, video
- [x] Filter by tag
- [x] Sort by: date, name, size, duration (asc/desc)
- [x] Bulk select with actions: pin/unpin, assign tag, delete
- [x] Direct URL access (`/library` works without 404)

## Playlists
- [x] Manual playlists: create, add/remove tracks, drag & drop reorder
- [x] Smart playlists: auto-populate from tag filters with sort options
- [x] Dedicated Playlists page with sidebar navigation
- [x] Built-in HTML5 audio/video player with prev/next/seek/volume
- [x] M3U export (download file or copy URL for external players)
- [x] Playlist integrity indicator — visually mark playlists that contain non-pinned files
  (files subject to auto-cleanup). Warn user that playlist may become incomplete
- [x] Option to auto-pin all files in a playlist
- [x] Shuffle / repeat modes

## Radio Mode
- [x] Broadcast playlists as internet radio stream
- [x] Stream endpoint (`GET /radio/stream` — continuous MP3 via FFmpeg)
- [x] Icecast-compatible HTTP streaming with icy-name header
- [x] Now playing info via API (`/api/radio/status`) and WebSocket (`/ws/radio`)
- [x] Auto-advancement with repeat (loops playlist), skip track support

## Improvements
- [x] Library: add filter for unpinned files
- [x] Auto-tagging: verified — Audio/Video system tags assigned automatically on download completion

## Synchronized Playback
- [ ] Branch `sync-snapcast`: SnapCast integration
  - Multi-room synchronized audio playback
  - SnapCast server managed within Docker container
  - Client discovery and zone management
- [ ] Branch `sync-opensound`: OpenSound integration
  - Alternative sync playback implementation
  - Compare latency and quality with SnapCast
