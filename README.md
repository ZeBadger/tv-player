# TV Player

A self-hosted web-based TV player for [HDHomeRun](https://www.silicondust.com/) tuners receiving UK Freeview DVB-T/T2.

Streams live TV in the browser with no plugins required. SD channels are transcoded to H.264 for browser compatibility; HD channels are passed through directly.

Created by [ZeBadger](https://github.com/ZeBadger).

**Features**

- Live TV and radio playback in the browser
- Channel list with HD/SD/Radio filtering
- Channel visibility management (hide channels you don't want)
- DVB subtitle burn-in for supported channels

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
| `MAX_CONCURRENT_STREAMS` | `1` | Maximum simultaneous playback sessions served by this app. Set to your tuner capacity (for example `4` on FLEX QUATRO) |
| `TRANSCODE_PRESET` | `medium` | ffmpeg x264 preset (`ultrafast` → `veryslow`). Faster = lower CPU, lower quality |
| `TRANSCODE_SCALE` | `960:-2` | Output resolution for SD transcode. `-2` preserves aspect ratio |
| `TRANSCODE_FPS` | `25` | Output frame rate |
| `TRANSCODE_VIDEO_BITRATE` | `1800k` | Target video bitrate |
| `TRANSCODE_VIDEO_MAXRATE` | `2200k` | Maximum video bitrate |
| `TRANSCODE_VIDEO_BUFSIZE` | `4400k` | Video rate control buffer size |
| `TRANSCODE_AUDIO_BITRATE` | `96k` | AAC audio bitrate |

## EPG (Electronic Program Guide)

TV Player can display a free EPG (now/next programme information). By default, this project includes an `iptv-org/epg` Docker sidecar that generates `guide.xml` locally from `epg/channels.xml`.

### Quick Start: Built-in EPG Server (Recommended)

`compose.yaml` includes a separate `iptv-epg` service:

- Input channels file: `epg/channels.xml`
- Generated guide URL inside compose network: `http://iptv-epg:3000/guide.xml`
- Refresh schedule: every 12 hours (and at startup)

Start both services:

```bash
docker compose up --build -d
```

**Configure your country/provider:**

1. Open TV Player and click **EPG settings**
2. Use the **iptv-org Channel Lists** filter and selectors to choose a site/provider XML list
3. Click **Use Selected List**
4. If a rebuild is not started automatically, click **Rebuild Guide Now**
5. Wait for the **Guide build** status to show that the guide file is up to date
6. TV Player will load the rebuilt guide automatically, or you can click **Reload Current Guide**

**Debugging:**

If you want to expose the guide outside Docker for debugging, add a port mapping to `iptv-epg` (for example `3000:3000`) and then open `http://localhost:3000/guide.xml`.

### External EPG Server (Optional)

To use a manual XMLTV feed URL instead of the built-in sidecar:

1. Open TV Player and click **EPG settings**
2. Select **Use an external EPG server**
3. Paste an XMLTV feed URL into the source field
4. Click **Save**
5. Click **Reload Guide** to import the data

Or set `EPG_SOURCE_URL` in `compose.yaml`:

```yaml
services:
  tv-player:
    environment:
      - EPG_SOURCE_URL=https://example.com/guide.xml
```

### Manual Channel List Setup

The repository ships with a starter `epg/channels.xml` file. This is only a default example and may not match your country/provider.

**To manually replace the channel list:**

1. Open the iptv-org channels folder: `https://github.com/iptv-org/epg/tree/master/sites`
2. Find your provider/country file named `*.channels.xml`
3. Download the raw XML file
4. Replace local `epg/channels.xml` with that file
5. Open **EPG settings** and click **Rebuild Guide Now**

Then open TV Player and click **EPG settings** -> **Reload Current Guide** if it has not auto-loaded yet.

### Setup Notes

- Sidecar first build can take several minutes.
- Guide content refreshes automatically, but channel definitions come from `epg/channels.xml`.
- If channels are added/removed by your provider, repeat the replacement steps above.
- Docker control from the settings modal uses the mounted Docker socket in the default compose setup.
- EPG data is cached locally so it persists across restarts.
- If fetch fails, the last cached data is used.

### Recommended EPG Sources

- **iptv-org EPG** (built-in, multi-country support, recommended)
  - UK Freeview channels map: `https://raw.githubusercontent.com/iptv-org/epg/master/sites/freeview.co.uk/freeview.co.uk.channels.xml`
  - See [iptv-org](https://github.com/iptv-org/epg) for other countries
  - Note: current iptv-org workflow is to generate `guide.xml` locally (or in Docker) from a channels list

- **XMLTV UK Freeview** (external, manual setup)
  - Visit [xmltv.org](https://wiki.xmltv.org/index.php/Main_Page)
  - Requires local grabber configuration

### Options

| Variable | Default | Description |
|---|---|---|
| `EPG_SOURCE_URL` | `http://iptv-epg:3000/guide.xml` | URL to an XMLTV feed (leave blank to disable EPG) |
| `EPG_CACHE_DIR` | `/tmp/epg` | Where to cache the downloaded guide data |
| `EPG_REFRESH_INTERVAL_HOURS` | `12` | How often to refresh the guide (set to 0 to disable auto-refresh) |

### Endpoints

- `GET /epg/status` — Returns EPG health (enabled, last fetch time, channel count)
- `GET /epg/now-next` — Returns current and next programme for each mapped channel (JSON)
- `POST /epg/configure` — Update EPG source URL at runtime (request body: `{"sourceUrl": "..."}`)
- `POST /epg/refresh` — Trigger manual EPG refresh

### Notes

- EPG data is cached locally so it persists across restarts.
- If fetch fails, the last cached data is used.
- Channel mapping from HDHomeRun to XMLTV ids is done automatically based on channel names and numbers.
