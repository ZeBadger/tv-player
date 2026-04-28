import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = join(__dirname, 'dist');

const port = Number(process.env.PORT ?? 80);
const hdhomerunHost = process.env.HDHOMERUN_HOST ?? '192.168.0.49';
const apiBase = `http://${hdhomerunHost}`;
const streamBase = `http://${hdhomerunHost}:5004`;
const transcodePreset = process.env.TRANSCODE_PRESET ?? 'ultrafast';
const transcodeScale = process.env.TRANSCODE_SCALE ?? '960:-2';
const transcodeFps = process.env.TRANSCODE_FPS ?? '25';
const transcodeVideoBitrate = process.env.TRANSCODE_VIDEO_BITRATE ?? '1800k';
const transcodeVideoMaxrate = process.env.TRANSCODE_VIDEO_MAXRATE ?? '2200k';
const transcodeVideoBufsize = process.env.TRANSCODE_VIDEO_BUFSIZE ?? '4400k';
const transcodeAudioBitrate = process.env.TRANSCODE_AUDIO_BITRATE ?? '96k';
const ffprobeTimeoutMs = Number(process.env.FFPROBE_TIMEOUT_MS ?? 10000);
const ffmpegStartTimeoutMs = Number(process.env.FFMPEG_START_TIMEOUT_MS ?? 12000);
const ffmpegIdleTimeoutMs = Number(process.env.FFMPEG_IDLE_TIMEOUT_MS ?? 25000);
// How long to wait after killing the previous ffmpeg before starting the next
// one, to give the HDHomeRun time to release the tuner slot.
const tunerReleaseDelayMs = Number(process.env.TUNER_RELEASE_DELAY_MS ?? 300);

// EPG configuration (allow runtime updates)
const defaultSidecarEpgSourceUrl = 'http://iptv-epg:3000/guide.xml';
const epgChannelsFilePath = join(__dirname, 'epg', 'channels.xml');
const epgGuideFilePath = join(__dirname, 'epg', 'guide.xml');
const iptvOrgTreeUrl = 'https://api.github.com/repos/iptv-org/epg/git/trees/master?recursive=1';
const iptvOrgRawBaseUrl = 'https://raw.githubusercontent.com/iptv-org/epg/master/';
const iptvOrgChannelListCacheTtlMs = 6 * 3600 * 1000;
const dockerCliCommand = process.env.DOCKER_CLI_COMMAND ?? 'docker';
const epgSidecarServiceName = process.env.EPG_SIDECAR_SERVICE_NAME ?? 'iptv-epg';
let epgSourceUrl = process.env.EPG_SOURCE_URL ?? null;
const epgCacheDir = process.env.EPG_CACHE_DIR ?? '/tmp/epg';
const epgRefreshIntervalHours = Number(process.env.EPG_REFRESH_INTERVAL_HOURS ?? 12);
const epgRetryIntervalSeconds = Number(process.env.EPG_RETRY_INTERVAL_SECONDS ?? 60);
const epgCachePath = join(epgCacheDir, 'guide.json');

// Single active playback session for this server process. Any new channel
// request (HD stream, radio stream, or transcode) cancels the previous one
// first so we don't leave stale tuner allocations behind.
let currentFfmpeg = null;
let currentPassthroughAbort = null;

// EPG data cache
let epgData = null;
let epgLastFetchTime = null;
let epgLastFreshTime = null;
let epgLastAttemptTime = null;
let epgLastError = null;
let epgConsecutiveFailures = 0;
let epgLastHttpStatus = null;
let lineupCache = null;
let lineupCacheAt = null;
let iptvOrgChannelListCache = null;
let iptvOrgChannelListCacheAt = 0;
let epgSidecarRebuildInProgress = false;
let epgSidecarLastRequestedAt = null;
let epgSidecarLastRestartedAt = null;
let epgSidecarLastError = null;
let epgSidecarLastContainerName = null;

const lineupCacheTtlMs = Number(process.env.LINEUP_CACHE_TTL_MS ?? 60000);
const normalizedHdhrHost = new URL(`http://${hdhomerunHost}`).hostname;

const parseProbeFps = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '0/0') return null;
  if (!raw.includes('/')) {
    const direct = Number(raw);
    return Number.isFinite(direct) && direct > 0 ? Number(direct.toFixed(2)) : null;
  }

  const [numRaw, denRaw] = raw.split('/');
  const num = Number(numRaw);
  const den = Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return Number((num / den).toFixed(2));
};

const validateProbeSourceUrl = (source) => {
  const url = new URL(String(source ?? ''));
  if (url.protocol !== 'http:') throw new Error('Only http stream URLs are supported');
  if (url.hostname !== normalizedHdhrHost) throw new Error('Probe source must target configured HDHomeRun host');
  return url.toString();
};

const probeStreamInfo = async (sourceUrl) => {
  return await new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      '-analyzeduration', '2M',
      '-probesize', '2M',
      '-i', sourceUrl,
    ]);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      if (!ffprobe.killed) ffprobe.kill('SIGKILL');
    }, ffprobeTimeoutMs);

    ffprobe.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    ffprobe.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffprobe.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ffprobe.on('exit', (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error('ffprobe timed out'));
        return;
      }

      if (code !== 0) {
        const message = stderr.trim() || `ffprobe exited with code ${code}`;
        reject(new Error(message));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error('ffprobe returned invalid JSON'));
        return;
      }

      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      const videoStream = streams.find((s) => s?.codec_type === 'video') ?? null;
      const audioStream = streams.find((s) => s?.codec_type === 'audio') ?? null;
      const subtitleStreams = streams.filter((s) => s?.codec_type === 'subtitle');

      resolve({
        probedAt: new Date().toISOString(),
        video: videoStream
          ? {
              codec: videoStream.codec_name ?? null,
              width: Number(videoStream.width) || null,
              height: Number(videoStream.height) || null,
              fps: parseProbeFps(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
            }
          : null,
        audio: audioStream
          ? {
              codec: audioStream.codec_name ?? null,
              channels: Number(audioStream.channels) || null,
              sampleRate: Number(audioStream.sample_rate) || null,
            }
          : null,
        hasSubtitles: subtitleStreams.length > 0,
        subtitleTracks: subtitleStreams.length,
      });
    });
  });
};

const normalizeChannelName = (value) => {
  const raw = String(value ?? '').toUpperCase();
  return raw
    .replace(/\bHD\b/g, ' ')
    .replace(/\bSD\b/g, ' ')
    .replace(/\b\+1\b/g, ' PLUS1 ')
    .replace(/\s+/g, ' ')
    .trim();
};

const tokenizeChannelName = (value) => {
  return normalizeChannelName(value)
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
};

const nameMatchScore = (a, b) => {
  const na = normalizeChannelName(a);
  const nb = normalizeChannelName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 90;

  const ta = tokenizeChannelName(a);
  const tb = tokenizeChannelName(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const setA = new Set(ta);
  const setB = new Set(tb);
  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }

  const denom = Math.max(setA.size, setB.size);
  return Math.round((overlap / denom) * 70);
};

const getHdhrLineup = async () => {
  const now = Date.now();
  if (lineupCache && lineupCacheAt && now - lineupCacheAt < lineupCacheTtlMs) {
    return lineupCache;
  }

  const res = await fetch(`${apiBase}/lineup.json`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HDHomeRun lineup fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('HDHomeRun lineup response invalid');

  lineupCache = data;
  lineupCacheAt = now;
  return data;
};

const getIsoFromStatMs = (ms) => {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
};

const getFileStatus = (filePath) => {
  if (!existsSync(filePath)) {
    return {
      exists: false,
      modifiedAt: null,
      sizeBytes: null,
      mtimeMs: null,
    };
  }

  const stats = statSync(filePath);
  return {
    exists: true,
    modifiedAt: getIsoFromStatMs(stats.mtimeMs),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  };
};

const getSidecarGuideStatus = () => {
  const channelsFile = getFileStatus(epgChannelsFilePath);
  const guideFile = getFileStatus(epgGuideFilePath);
  const usingSidecar = epgSourceUrl === defaultSidecarEpgSourceUrl;

  let guideBuildState = 'manual';
  if (usingSidecar) {
    if (!channelsFile.exists) {
      guideBuildState = 'no-channels-file';
    } else if (epgSidecarRebuildInProgress) {
      guideBuildState = 'rebuilding';
    } else if (!guideFile.exists) {
      guideBuildState = 'guide-missing';
    } else if ((guideFile.mtimeMs ?? 0) < (channelsFile.mtimeMs ?? 0)) {
      guideBuildState = 'guide-stale';
    } else {
      guideBuildState = 'guide-ready';
    }
  }

  return {
    serviceName: epgSidecarServiceName,
    dockerSocketMounted: existsSync('/var/run/docker.sock'),
    rebuildInProgress: epgSidecarRebuildInProgress,
    lastRequestedAt: epgSidecarLastRequestedAt,
    lastRestartedAt: epgSidecarLastRestartedAt,
    lastError: epgSidecarLastError,
    lastContainerName: epgSidecarLastContainerName,
    guideBuildState,
    channelsFile,
    guideFile,
  };
};

const stripAnsi = (value) => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');

const summarizeSidecarLogs = (logOutput) => {
  const lines = String(logOutput ?? '')
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);

  const recentLines = lines.slice(-6);
  let progress = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const match = line.match(/\[(\d+)\/(\d+)\]/);
    if (!match) continue;

    const current = Number(match[1]);
    const total = Number(match[2]);
    progress = {
      current,
      total,
      percent: total > 0 ? Math.round((current / total) * 100) : null,
      line,
    };
    break;
  }

  return {
    recentLines,
    progress,
    lastLine: recentLines[recentLines.length - 1] ?? null,
  };
};

const getSidecarActivity = async () => {
  if (!existsSync('/var/run/docker.sock')) {
    return {
      available: false,
      reason: 'docker-unavailable',
      recentLines: [],
      progress: null,
      lastLine: null,
    };
  }

  try {
    const containerName = epgSidecarLastContainerName ?? await findComposeServiceContainer(epgSidecarServiceName);
    epgSidecarLastContainerName = containerName;
    const { stdout, stderr } = await runCommandCapture(dockerCliCommand, ['logs', '--tail', '80', containerName], 15000);
    const output = [stdout, stderr].filter(Boolean).join('\n');
    return {
      available: true,
      containerName,
      ...summarizeSidecarLogs(output),
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      recentLines: [],
      progress: null,
      lastLine: null,
    };
  }
};

const runCommandCapture = async (command, args, timeoutMs = 30000) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error(`${command} timed out`));
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        return;
      }

      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
};

const findComposeServiceContainer = async (serviceName) => {
  const { stdout } = await runCommandCapture(dockerCliCommand, [
    'ps',
    '--filter', `label=com.docker.compose.service=${serviceName}`,
    '--format', '{{.Names}}',
  ]);

  const containerName = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  if (!containerName) {
    throw new Error(`No running container found for compose service ${serviceName}`);
  }

  return containerName;
};

const restartEpgSidecar = async () => {
  if (epgSourceUrl !== defaultSidecarEpgSourceUrl) {
    throw new Error('Sidecar rebuild is only available when the Docker sidecar source is active');
  }
  if (epgSidecarRebuildInProgress) {
    return {
      alreadyRunning: true,
      startedAt: epgSidecarLastRequestedAt,
      containerName: epgSidecarLastContainerName,
    };
  }
  if (!existsSync('/var/run/docker.sock')) {
    throw new Error('Docker control is not available in this container');
  }

  epgSidecarRebuildInProgress = true;
  epgSidecarLastRequestedAt = new Date().toISOString();
  epgSidecarLastError = null;

  try {
    const containerName = await findComposeServiceContainer(epgSidecarServiceName);
    epgSidecarLastContainerName = containerName;
    await runCommandCapture(dockerCliCommand, ['restart', containerName], 60000);
    epgSidecarLastRestartedAt = new Date().toISOString();
    return {
      alreadyRunning: false,
      startedAt: epgSidecarLastRequestedAt,
      restartedAt: epgSidecarLastRestartedAt,
      containerName,
    };
  } catch (err) {
    epgSidecarLastError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    epgSidecarRebuildInProgress = false;
  }
};

const releaseActivePlayback = async () => {
  let released = false;

  if (currentFfmpeg && !currentFfmpeg.killed) {
    currentFfmpeg.kill('SIGKILL');
    currentFfmpeg = null;
    released = true;
  }

  if (currentPassthroughAbort) {
    currentPassthroughAbort.abort();
    currentPassthroughAbort = null;
    released = true;
  }

  if (released) {
    await new Promise((r) => setTimeout(r, tunerReleaseDelayMs));
  }
};

const mimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const respond = (res, code, body, contentType = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
};

const fetchWithClientAbort = async (req, url) => {
  const controller = new AbortController();
  const abort = () => controller.abort();

  req.on('close', abort);

  try {
    return await fetch(url, {
      method: req.method ?? 'GET',
      signal: controller.signal,
    });
  } finally {
    req.off('close', abort);
  }
};

const proxyFetch = async (req, res, upstreamBase, prefix) => {
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const upstreamPath = reqUrl.pathname.slice(prefix.length) || '/';
  const upstreamUrl = new URL(upstreamPath + reqUrl.search, `${upstreamBase}/`);

  const upstreamRes = await fetchWithClientAbort(req, upstreamUrl);

  const headers = {};
  for (const [key, value] of upstreamRes.headers.entries()) {
    if (key.toLowerCase() === 'content-length') continue;
    headers[key] = value;
  }
  headers['access-control-allow-origin'] = '*';

  res.writeHead(upstreamRes.status, headers);

  if ((req.method ?? 'GET') === 'HEAD') {
    res.end();
    return;
  }

  if (!upstreamRes.body) {
    res.end();
    return;
  }

  for await (const chunk of upstreamRes.body) {
    res.write(chunk);
  }
  res.end();
};

const passthroughStream = async (req, res, prefix) => {
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const upstreamPath = reqUrl.pathname.slice(prefix.length) || '/';
  const sourceUrl = new URL(upstreamPath + reqUrl.search, `${streamBase}/`).toString();

  await releaseActivePlayback();

  const controller = new AbortController();
  currentPassthroughAbort = controller;

  const cleanup = () => {
    controller.abort();
    if (currentPassthroughAbort === controller) currentPassthroughAbort = null;
  };
  req.on('close', cleanup);

  let upstreamRes;
  try {
    upstreamRes = await fetch(sourceUrl, { signal: controller.signal });
  } catch {
    req.off('close', cleanup);
    if (controller.signal.aborted) { res.end(); return; }
    respond(res, 503, 'Stream unavailable');
    return;
  }

  const headers = {};
  for (const [key, value] of upstreamRes.headers.entries()) {
    if (key.toLowerCase() === 'content-length') continue;
    headers[key] = value;
  }
  headers['access-control-allow-origin'] = '*';
  res.writeHead(upstreamRes.status, headers);

  if ((req.method ?? 'GET') === 'HEAD' || !upstreamRes.body) {
    req.off('close', cleanup);
    res.end();
    return;
  }

  try {
    for await (const chunk of upstreamRes.body) {
      res.write(chunk);
    }
  } catch {
    // aborted — normal on channel switch
  } finally {
    req.off('close', cleanup);
  }
  res.end();
};

const transcodeStream = async (req, res) => {
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const upstreamPath = reqUrl.pathname.slice('/hdhomerun-transcode'.length) || '/';
  const upstreamSearchParams = new URLSearchParams(reqUrl.searchParams);
  const burnCaptions = upstreamSearchParams.get('captions') === 'burn';
  upstreamSearchParams.delete('captions');
  const upstreamSearch = upstreamSearchParams.toString();
  const sourceUrl = new URL(upstreamPath + (upstreamSearch ? `?${upstreamSearch}` : ''), `${streamBase}/`).toString();
  // UK Freeview (DVB) carries subtitles as a separate stream, not as NTSC
  // EIA-608 embedded data. Burn-in overlays the DVB subtitle stream [0:s:0]
  // onto the scaled video. If the channel has no subtitle stream ffmpeg will
  // fail — the client then falls back to non-caption playback on retry.
  const videoMappingArgs = burnCaptions
    ? [
        '-filter_complex', `[0:v]yadif=mode=send_frame,scale=${transcodeScale}[v];[0:s:0]scale=${transcodeScale}[s];[v][s]overlay[out]`,
        '-map', '[out]',
        '-map', '0:a:0?',
      ]
    : [
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', `yadif=mode=send_frame,scale=${transcodeScale}`,
      ];

  if ((req.method ?? 'GET') === 'HEAD') {
    res.writeHead(200, {
      'content-type': 'video/mp2t',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'access-control-allow-origin': '*',
      connection: 'keep-alive',
    });
    res.end();
    return;
  }

  await releaseActivePlayback();

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    // Discard incoming DTS; genpts reconstructs PTS from frame rate.
    // Do NOT use -use_wallclock_as_timestamps: HDHomeRun delivers bursts
    // of TCP packets which would all receive the same wall-clock PTS,
    // causing the encoder to stall and produce periodic video freezes.
    '-fflags', '+genpts+igndts+discardcorrupt',
    // Fail fast on dead inputs so stale ffmpeg processes don't linger.
    '-rw_timeout', '10000000',
    '-analyzeduration', '2M',
    '-probesize', '2M',
    '-i', sourceUrl,
    ...videoMappingArgs,
    '-c:v', 'libx264',
    '-preset', transcodePreset,
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level', '3.1',
    '-pix_fmt', 'yuv420p',
    '-r', transcodeFps,
    // cfr: drop/duplicate frames as needed so output is always exactly
    // transcodeFps — keeps PTS monotonic regardless of input jitter.
    '-fps_mode', 'cfr',
    '-g', transcodeFps,
    '-keyint_min', transcodeFps,
    '-sc_threshold', '0',
    '-b:v', transcodeVideoBitrate,
    '-maxrate', transcodeVideoMaxrate,
    '-bufsize', transcodeVideoBufsize,
    // aresample async=1000: fill audio gaps by resampling rather than
    // inserting silence, preventing the occasional audio glitch.
    '-af', 'aresample=async=1000',
    '-c:a', 'aac',
    '-b:a', transcodeAudioBitrate,
    '-ac', '2',
    '-ar', '48000',
    '-f', 'mpegts',
    'pipe:1',
  ]);

  currentFfmpeg = ffmpeg;

  let started = false;
  let startTimer;
  let idleTimer;

  const clearWatchdogs = () => {
    if (startTimer) clearTimeout(startTimer);
    if (idleTimer) clearTimeout(idleTimer);
  };

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.error('[ffmpeg] idle timeout, force-killing process');
      stopFfmpeg(true);
    }, ffmpegIdleTimeoutMs);
  };

  const stopFfmpeg = (force = false) => {
    if (!ffmpeg.killed) {
      if (force) {
        ffmpeg.kill('SIGKILL');
      } else {
        ffmpeg.kill('SIGTERM');
        setTimeout(() => {
          if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
        }, 500);
      }
    }
    if (currentFfmpeg === ffmpeg) currentFfmpeg = null;
  };

  startTimer = setTimeout(() => {
    if (!started) {
      console.error('[ffmpeg] start timeout, force-killing process');
      stopFfmpeg(true);
    }
  }, ffmpegStartTimeoutMs);

  armIdleTimer();

  req.on('aborted', stopFfmpeg);
  req.on('close', stopFfmpeg);
  res.on('close', stopFfmpeg);

  ffmpeg.stderr.on('data', (chunk) => {
    console.error(`[ffmpeg] ${chunk.toString().trim()}`);
  });

  ffmpeg.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'access-control-allow-origin': '*',
        connection: 'keep-alive',
      });
    }

    armIdleTimer();
    res.write(chunk);
  });

  ffmpeg.on('error', () => {
    clearWatchdogs();
    if (currentFfmpeg === ffmpeg) currentFfmpeg = null;
    if (!res.headersSent) {
      respond(res, 503, 'Transcoder failed to start');
      return;
    }
    res.end();
  });

  ffmpeg.on('exit', (code) => {
    clearWatchdogs();
    if (currentFfmpeg === ffmpeg) currentFfmpeg = null;
    if (res.writableEnded) return;

    if (!started) {
      if (!res.headersSent) {
        respond(res, 503, 'Transcoder could not open stream');
      } else {
        res.end();
      }
      return;
    }

    if (code !== 0) {
      res.end();
      return;
    }

    res.end();
  });
};

const serveStatic = (req, res) => {
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  let pathName = reqUrl.pathname;

  if (pathName === '/') pathName = '/index.html';

  const requested = normalize(join(distDir, pathName));
  const safeRoot = normalize(distDir + '/');

  if (!requested.startsWith(safeRoot)) {
    respond(res, 403, 'Forbidden');
    return;
  }

  if (existsSync(requested) && statSync(requested).isFile()) {
    const ext = extname(requested);
    res.writeHead(200, {
      'content-type': mimeByExt[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(requested).pipe(res);
    return;
  }

  const indexPath = join(distDir, 'index.html');
  if (existsSync(indexPath)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    createReadStream(indexPath).pipe(res);
    return;
  }

  respond(res, 404, 'Not Found');
};

// EPG management functions
const loadEpgCache = () => {
  if (!existsSync(epgCachePath)) return null;
  try {
    const cached = JSON.parse(readFileSync(epgCachePath, 'utf-8'));
    epgLastFreshTime = cached.fetchedAt;
    return cached;
  } catch (err) {
    console.error('[epg] failed to load cache:', err.message);
    return null;
  }
};

const saveEpgCache = (data) => {
  try {
    mkdirSync(epgCacheDir, { recursive: true });
    writeFileSync(epgCachePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[epg] failed to save cache:', err.message);
  }
};

const readJsonBody = async (req) => {
  return await new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
};

const formatIptvOrgVariant = (siteSlug, fileName) => {
  const suffix = '.channels.xml';
  if (!fileName.endsWith(suffix)) return null;

  const stem = fileName.slice(0, -suffix.length);
  if (stem === siteSlug) return null;

  if (stem.startsWith(`${siteSlug}_`)) {
    return stem.slice(siteSlug.length + 1).replace(/[_-]+/g, ' ').trim() || null;
  }

  return stem.replace(/[_-]+/g, ' ').trim() || null;
};

const fetchIptvOrgChannelLists = async () => {
  const now = Date.now();
  if (iptvOrgChannelListCache && now - iptvOrgChannelListCacheAt < iptvOrgChannelListCacheTtlMs) {
    return iptvOrgChannelListCache;
  }

  const res = await fetch(iptvOrgTreeUrl, {
    headers: { 'user-agent': 'tv-player' },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    throw new Error(`GitHub tree fetch failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  const tree = Array.isArray(data?.tree) ? data.tree : [];
  const sitesBySlug = new Map();

  for (const item of tree) {
    if (!item || item.type !== 'blob' || typeof item.path !== 'string') continue;
    const match = item.path.match(/^sites\/([^/]+)\/([^/]+\.channels\.xml)$/);
    if (!match) continue;

    const [, siteSlug, fileName] = match;
    const site = sitesBySlug.get(siteSlug) ?? {
      slug: siteSlug,
      label: siteSlug,
      files: [],
    };

    site.files.push({
      name: fileName,
      path: item.path,
      rawUrl: `${iptvOrgRawBaseUrl}${item.path}`,
      variant: formatIptvOrgVariant(siteSlug, fileName),
    });

    sitesBySlug.set(siteSlug, site);
  }

  const sites = [...sitesBySlug.values()]
    .map((site) => ({
      ...site,
      fileCount: site.files.length,
      files: site.files.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  iptvOrgChannelListCache = {
    generatedAt: new Date().toISOString(),
    siteCount: sites.length,
    sites,
  };
  iptvOrgChannelListCacheAt = now;

  return iptvOrgChannelListCache;
};

const applyIptvOrgChannelList = async (channelsPath) => {
  if (typeof channelsPath !== 'string' || !/^sites\/[^/]+\/[^/]+\.channels\.xml$/.test(channelsPath)) {
    throw new Error('Invalid iptv-org channel list path');
  }

  const rawUrl = `${iptvOrgRawBaseUrl}${channelsPath}`;
  const res = await fetch(rawUrl, {
    headers: { 'user-agent': 'tv-player' },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Channel list download failed: HTTP ${res.status}`);
  }

  const xml = await res.text();
  if (!xml.includes('<channels') || !xml.includes('<channel')) {
    throw new Error('Downloaded file is not a valid iptv-org channels list');
  }

  mkdirSync(dirname(epgChannelsFilePath), { recursive: true });
  writeFileSync(epgChannelsFilePath, xml, 'utf-8');
  epgSourceUrl = defaultSidecarEpgSourceUrl;

  let rebuildStarted = false;
  let rebuildQueued = false;
  let rebuildError = null;
  let rebuildResult = null;

  try {
    rebuildResult = await restartEpgSidecar();
    rebuildStarted = !rebuildResult.alreadyRunning;
    rebuildQueued = true;
  } catch (err) {
    rebuildError = err instanceof Error ? err.message : String(err);
  }

  return {
    path: channelsPath,
    rawUrl,
    filePath: epgChannelsFilePath,
    sourceUrl: epgSourceUrl,
    rebuildStarted,
    rebuildQueued,
    rebuildError,
    rebuildResult,
  };
};

const parseXmltvDate = (value) => {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/);
  if (!match) {
    const fallback = new Date(raw);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, y, mo, d, h, mi, s, sign, offH, offM] = match;
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));

  if (!sign || !offH || !offM) {
    return new Date(utcMs);
  }

  const offsetMinutes = Number(offH) * 60 + Number(offM);
  const signedMinutes = sign === '+' ? offsetMinutes : -offsetMinutes;
  return new Date(utcMs - signedMinutes * 60000);
};

const decodeXmlEntities = (value) => {
  const input = String(value ?? '');
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
};

const parseXMLTV = (xmlContent) => {
  const channels = {};
  const programmes = [];

  // Simple regex-based parser for XMLTV (production should use xml library)
  const channelMatches = xmlContent.matchAll(/<channel id="([^"]+)"[^>]*>[\s\S]*?<display-name[^>]*>([^<]+)<\/display-name>/g);
  for (const match of channelMatches) {
    channels[match[1]] = { id: match[1], name: decodeXmlEntities(match[2]) };
  }

  const progMatches = xmlContent.matchAll(/<programme[^>]*start="([^"]+)"[^>]*stop="([^"]+)"[^>]*channel="([^"]+)"[^>]*>[\s\S]*?<title[^>]*>([^<]+)<\/title>([\s\S]*?)<\/programme>/g);
  for (const match of progMatches) {
    const descMatch = match[5].match(/<desc[^>]*>([^<]+)<\/desc>/);
    programmes.push({
      start: match[1],
      stop: match[2],
      channel: match[3],
      title: decodeXmlEntities(match[4]),
      desc: descMatch ? decodeXmlEntities(descMatch[1]) : '',
    });
  }

  return { channels, programmes, fetchedAt: new Date().toISOString() };
};

const fetchAndParseEPG = async () => {
  if (!epgSourceUrl) return null;
  epgLastAttemptTime = new Date();
  try {
    console.log('[epg] fetching from', epgSourceUrl);
    const res = await fetch(epgSourceUrl, { signal: AbortSignal.timeout(30000) });
    epgLastHttpStatus = res.status;
    if (!res.ok) {
      const statusError = new Error(`HTTP ${res.status}`);
      statusError.statusCode = res.status;
      throw statusError;
    }
    const xml = await res.text();
    
    if (!xml || xml.trim().length === 0) {
      throw new Error('Empty response from EPG source');
    }
    
    if (!xml.includes('<channel') || !xml.includes('<programme')) {
      console.warn('[epg] warning: response missing channels or programmes tags');
      console.warn('[epg] response starts with:', xml.substring(0, 200));
    }
    
    const parsed = parseXMLTV(xml);
    
    if (Object.keys(parsed.channels).length === 0) {
      console.warn('[epg] warning: no channels parsed from response');
    }
    if (parsed.programmes.length === 0) {
      console.warn('[epg] warning: no programmes parsed from response');
    }
    
    saveEpgCache(parsed);
    epgData = parsed;
    epgLastFetchTime = new Date();
    epgLastFreshTime = parsed.fetchedAt;
    epgLastError = null;
    epgConsecutiveFailures = 0;
    console.log(`[epg] fetched ${Object.keys(parsed.channels).length} channels, ${parsed.programmes.length} programmes`);
    return parsed;
  } catch (err) {
    epgConsecutiveFailures += 1;
    epgLastError = err instanceof Error ? err.message : String(err);
    if (typeof err?.statusCode === 'number') {
      epgLastHttpStatus = err.statusCode;
    }
    console.error('[epg] fetch failed:', epgLastError);
    throw err;
  }
};

const initializeEPG = async () => {
  if (!epgSourceUrl) {
    console.log('[epg] disabled (no EPG_SOURCE_URL configured)');
    return;
  }
  epgData = loadEpgCache();
  try {
    await fetchAndParseEPG();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[epg] initial fetch failed (${message}); continuing with startup`);
  }
  if (epgRefreshIntervalHours > 0) {
    setInterval(() => {
      fetchAndParseEPG().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[epg] scheduled refresh failed (${message})`);
      });
    }, epgRefreshIntervalHours * 3600 * 1000);
  }

  if (epgRetryIntervalSeconds > 0) {
    setInterval(() => {
      // Retry more frequently while upstream guide is still building or failing.
      if (epgData && epgData.programmes && epgData.programmes.length > 0 && epgConsecutiveFailures === 0) {
        return;
      }
      fetchAndParseEPG().catch(() => {
        // Status endpoint already exposes error details; keep retry loop quiet.
      });
    }, epgRetryIntervalSeconds * 1000);
  }
};

createServer(async (req, res) => {
  try {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

    const isEpgPostRoute = method === 'POST' && (
      path === '/epg/configure' ||
      path === '/epg/refresh' ||
      path === '/epg/iptv-org/apply' ||
      path === '/epg/sidecar/rebuild'
    );
    if (method !== 'GET' && method !== 'HEAD' && !isEpgPostRoute) {
      respond(res, 405, 'Method Not Allowed');
      return;
    }

    if (path.startsWith('/hdhomerun/')) {
      await proxyFetch(req, res, apiBase, '/hdhomerun');
      return;
    }

    if (path.startsWith('/hdhomerun-stream/')) {
      await passthroughStream(req, res, '/hdhomerun-stream');
      return;
    }

    if (path.startsWith('/hdhomerun-radio/')) {
      await passthroughStream(req, res, '/hdhomerun-radio');
      return;
    }

    if (path.startsWith('/hdhomerun-transcode/')) {
      await transcodeStream(req, res);
      return;
    }

    if (path === '/stream-info') {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const source = reqUrl.searchParams.get('source');
      if (!source) {
        respond(res, 400, JSON.stringify({ error: 'Missing source parameter' }), 'application/json; charset=utf-8');
        return;
      }

      let validatedSource;
      try {
        validatedSource = validateProbeSourceUrl(source);
      } catch (err) {
        respond(
          res,
          400,
          JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid source URL' }),
          'application/json; charset=utf-8',
        );
        return;
      }

      try {
        const info = await probeStreamInfo(validatedSource);
        respond(res, 200, JSON.stringify(info), 'application/json; charset=utf-8');
      } catch (err) {
        console.warn('[stream-info] probe failed:', err instanceof Error ? err.message : String(err));
        respond(
          res,
          502,
          JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to probe stream' }),
          'application/json; charset=utf-8',
        );
      }
      return;
    }

    if (path === '/epg/status') {
      const hasGuideData = Boolean(epgData && epgData.programmes && epgData.programmes.length > 0);
      const isLikelyBuilding = !hasGuideData && epgLastHttpStatus === 404 && Boolean(epgSourceUrl?.includes('iptv-epg'));
      const sidecar = getSidecarGuideStatus();
      const sidecarActivity = sidecar.dockerSocketMounted && sidecar.guideBuildState !== 'manual'
        ? await getSidecarActivity()
        : {
            available: false,
            reason: 'not-applicable',
            recentLines: [],
            progress: null,
            lastLine: null,
          };
      const state = !epgSourceUrl
        ? 'disabled'
        : hasGuideData
          ? 'ready'
          : isLikelyBuilding
            ? 'building'
            : epgLastError
              ? 'error'
              : 'starting';

      const status = {
        enabled: !!epgSourceUrl,
        state,
        sourceUrl: epgSourceUrl,
        sidecarSourceUrl: defaultSidecarEpgSourceUrl,
        usingSidecar: epgSourceUrl === defaultSidecarEpgSourceUrl,
        channelsFileConfigured: existsSync(epgChannelsFilePath),
        lastAttempt: epgLastAttemptTime?.toISOString() ?? null,
        lastFetch: epgLastFetchTime?.toISOString() ?? null,
        dataFreshness: epgLastFreshTime ?? null,
        channelCount: epgData ? Object.keys(epgData.channels).length : 0,
        programmeCount: epgData ? epgData.programmes.length : 0,
        lastHttpStatus: epgLastHttpStatus,
        lastError: epgLastError,
        consecutiveFailures: epgConsecutiveFailures,
        sidecar,
        sidecarActivity,
      };
      respond(res, 200, JSON.stringify(status), 'application/json; charset=utf-8');
      return;
    }

    if (path === '/epg/iptv-org/sites') {
      try {
        const payload = await fetchIptvOrgChannelLists();
        respond(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8');
      } catch (err) {
        respond(
          res,
          502,
          JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to fetch iptv-org channel lists' }),
          'application/json; charset=utf-8',
        );
      }
      return;
    }

    if (path.startsWith('/epg/now-next')) {
      if (!epgData) {
        respond(res, 503, JSON.stringify({ error: 'EPG data not available' }), 'application/json; charset=utf-8');
        return;
      }

      const now = new Date();
      const byEpgChannelId = {};
      for (const prog of epgData.programmes) {
        const progStart = parseXmltvDate(prog.start);
        const progStop = parseXmltvDate(prog.stop);
        if (!progStart || !progStop) continue;
        if (progStart <= now && now < progStop) {
          byEpgChannelId[prog.channel] = { now: prog };
        } else if (progStart > now && progStart.getTime() - now.getTime() < 3600000) {
          if (!byEpgChannelId[prog.channel]) byEpgChannelId[prog.channel] = {};
          byEpgChannelId[prog.channel].next = prog;
        }
      }

      for (const [epgId, payload] of Object.entries(byEpgChannelId)) {
        payload.channelId = epgId;
        payload.channelName = epgData.channels?.[epgId]?.name ?? epgId;
      }

      const epgChannels = Object.values(epgData.channels ?? {});
      const mapped = {};
      try {
        const lineup = await getHdhrLineup();
        for (const item of lineup) {
          if (!item || typeof item !== 'object') continue;
          const guideName = String(item.GuideName ?? '');
          const channelUrl = String(item.URL ?? '');
          if (!guideName || !channelUrl) continue;

          let bestMatch = null;
          let bestScore = 0;

          for (const epgChannel of epgChannels) {
            const score = nameMatchScore(guideName, epgChannel.name ?? epgChannel.id ?? '');
            if (score > bestScore) {
              bestScore = score;
              bestMatch = epgChannel;
            }
          }

          if (bestMatch && bestScore >= 60) {
            const payload = byEpgChannelId[bestMatch.id];
            if (payload && (payload.now || payload.next)) {
              mapped[channelUrl] = payload;
            }
          }
        }
      } catch (err) {
        console.warn('[epg] now-next mapping fallback to raw ids:', err instanceof Error ? err.message : String(err));
      }

      respond(res, 200, JSON.stringify(Object.keys(mapped).length > 0 ? mapped : byEpgChannelId), 'application/json; charset=utf-8');
      return;
    }

    if (method === 'POST' && path === '/epg/configure') {
      try {
        const config = await readJsonBody(req);
        if (config.sourceUrl !== undefined) {
          epgSourceUrl = config.sourceUrl || null;
          console.log('[epg] updated source URL to', epgSourceUrl);
        }
        respond(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
      } catch (err) {
        respond(res, 400, JSON.stringify({ error: 'Invalid JSON' }), 'application/json; charset=utf-8');
      }
      return;
    }

    if (method === 'POST' && path === '/epg/iptv-org/apply') {
      try {
        const config = await readJsonBody(req);
        const result = await applyIptvOrgChannelList(config.path);
        const message = result.rebuildQueued
          ? result.rebuildStarted
            ? 'Channel list saved. Guide rebuild started.'
            : 'Channel list saved. Guide rebuild is already running.'
          : 'Channel list saved to epg/channels.xml.';
        respond(
          res,
          200,
          JSON.stringify({
            ok: true,
            ...result,
            message,
          }),
          'application/json; charset=utf-8',
        );
      } catch (err) {
        respond(
          res,
          400,
          JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to apply channel list' }),
          'application/json; charset=utf-8',
        );
      }
      return;
    }

    if (method === 'POST' && path === '/epg/sidecar/rebuild') {
      try {
        const result = await restartEpgSidecar();
        respond(
          res,
          200,
          JSON.stringify({
            ok: true,
            ...result,
            message: result.alreadyRunning ? 'Guide rebuild is already running.' : 'Guide rebuild started.',
          }),
          'application/json; charset=utf-8',
        );
      } catch (err) {
        respond(
          res,
          503,
          JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to restart EPG sidecar' }),
          'application/json; charset=utf-8',
        );
      }
      return;
    }

    if (method === 'POST' && path === '/epg/refresh') {
      if (!epgSourceUrl) {
        respond(res, 400, JSON.stringify({ error: 'EPG not configured' }), 'application/json; charset=utf-8');
        return;
      }
      fetchAndParseEPG().then(() => {
        respond(res, 200, JSON.stringify({ ok: true, message: 'EPG refresh triggered' }), 'application/json; charset=utf-8');
      }).catch(err => {
        console.error('[epg] refresh error:', err);
        respond(res, 500, JSON.stringify({ error: err.message || 'EPG refresh failed' }), 'application/json; charset=utf-8');
      });
      return;
    }

    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      respond(res, 500, 'Internal Server Error');
    } else {
      res.end();
    }
  }
}).listen(port, '0.0.0.0', async () => {
  console.log(`tv-player server listening on :${port}`);
  await initializeEPG();
});
