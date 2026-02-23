# TODO

## Media Library Enhancements
- [ ] Save thumbnail to disk on successful download (for offline navigation)
- [ ] Show file duration in download history list
- [ ] Store source URL in DB for each download (for re-downloading, linking back)

## Persistent Files
- [ ] Add "pin" / "keep" flag for downloads — pinned files are excluded from auto-cleanup
- [ ] UI toggle (star/pin icon) on each download in history
- [ ] Store `pinned` boolean in DB
- [ ] Cleanup task skips pinned files

## Tags
- [ ] Add tag management for downloaded files (create, rename, delete tags)
- [ ] UI for assigning tags to downloads (multi-select)
- [ ] Store tags in DB (many-to-many: downloads <-> tags)
- [ ] Filter history by tags

## Playlists
- [ ] Generate playlists based on tag filters (M3U/PLS format)
- [ ] Playlist preview and playback in browser
- [ ] Save/load playlist presets

## Radio Mode
- [ ] Broadcast playlists as internet radio stream
- [ ] Stream endpoint (e.g. `/radio/{playlist_id}`)
- [ ] Icecast/Shoutcast compatible output
- [ ] Now playing info via API/WebSocket
- [ ] Auto-advancement and shuffle/repeat modes

## Synchronized Playback
- [ ] Branch `sync-snapcast`: SnapCast integration
  - Multi-room synchronized audio playback
  - SnapCast server managed within Docker container
  - Client discovery and zone management
- [ ] Branch `sync-opensound`: OpenSound integration
  - Alternative sync playback implementation
  - Compare latency and quality with SnapCast
