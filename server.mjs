import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
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
const ffmpegStartTimeoutMs = Number(process.env.FFMPEG_START_TIMEOUT_MS ?? 12000);
const ffmpegIdleTimeoutMs = Number(process.env.FFMPEG_IDLE_TIMEOUT_MS ?? 25000);
// How long to wait after killing the previous ffmpeg before starting the next
// one, to give the HDHomeRun time to release the tuner slot.
const tunerReleaseDelayMs = Number(process.env.TUNER_RELEASE_DELAY_MS ?? 300);

// Single active playback session for this server process. Any new channel
// request (HD stream, radio stream, or transcode) cancels the previous one
// first so we don't leave stale tuner allocations behind.
let currentFfmpeg = null;
let currentPassthroughAbort = null;

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

createServer(async (req, res) => {
  try {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      respond(res, 405, 'Method Not Allowed');
      return;
    }

    const path = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

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

    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      respond(res, 500, 'Internal Server Error');
    } else {
      res.end();
    }
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`tv-player server listening on :${port}`);
});
