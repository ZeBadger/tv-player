# TV Player

A self-hosted web-based TV player for [HDHomeRun](https://www.silicondust.com/) tuners receiving UK Freeview DVB-T/T2.

Streams live TV in the browser with no plugins required. SD channels are transcoded to H.264 for browser compatibility; HD channels are passed through directly.

**Features**

- Live TV and radio playback in the browser
- Channel list with HD/SD/Radio filtering
- Channel visibility management (hide channels you don't want)
- DVB subtitle burn-in for supported channels
- TV guide via HDHomeRun's built-in EPG

## Requirements

- [HDHomeRun](https://www.silicondust.com/) network tuner (tested on FLEX QUATRO)
- Docker and Docker Compose

## Quick start

```bash
git clone https://github.com/ZeBadger/tv-player.git
cd tv-player
```

Edit `compose.yaml` and set `HDHOMERUN_HOST` to your HDHomeRun's IP address:

```yaml
- HDHOMERUN_HOST=192.168.0.X
```

Then build and start:

```bash
docker compose up --build -d
```

Open [http://localhost:8080](http://localhost:8080) in your browser.

## Configuration

All settings are in `compose.yaml`:

| Variable | Default | Description |
|---|---|---|
| `HDHOMERUN_HOST` | _(required)_ | IP address of your HDHomeRun device |
| `TRANSCODE_PRESET` | `medium` | ffmpeg x264 preset (`ultrafast` → `veryslow`). Faster = lower CPU, lower quality |
| `TRANSCODE_SCALE` | `960:-2` | Output resolution for SD transcode. `-2` preserves aspect ratio |
| `TRANSCODE_FPS` | `25` | Output frame rate |
| `TRANSCODE_VIDEO_BITRATE` | `1800k` | Target video bitrate |
| `TRANSCODE_VIDEO_MAXRATE` | `2200k` | Maximum video bitrate |
| `TRANSCODE_VIDEO_BUFSIZE` | `4400k` | Video rate control buffer size |
| `TRANSCODE_AUDIO_BITRATE` | `96k` | AAC audio bitrate |
