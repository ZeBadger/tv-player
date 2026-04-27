// Wraps mpegts.js for HDHomeRun MPEG-TS HTTP streams.
// Falls back to native <video> for HLS (.m3u8) streams if present.

import mpegts from 'mpegts.js';

let player: mpegts.Player | null = null;

type PlayStreamOptions = {
  onError?: (message: string) => void;
};

const isAbortLikeError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.message.includes('interrupted by a call to pause');
};

export function initPlayer(videoEl: HTMLVideoElement): void {
  // nothing to do until a channel is selected
  void videoEl;
}

export function playStream(videoEl: HTMLVideoElement, url: string, options: PlayStreamOptions = {}): void {
  destroyPlayer();

  // mpegts.js runs its loader in a Web Worker which has no page origin,
  // so relative URLs fail to parse. Always pass an absolute URL.
  const absoluteUrl = url.startsWith('http') ? url : new URL(url, window.location.origin).href;

  if (absoluteUrl.endsWith('.m3u8')) {
    // HLS — let the browser handle it natively
    videoEl.src = absoluteUrl;
    videoEl.play().catch(() => {
      options.onError?.('Browser blocked playback');
    });
    return;
  }

  if (!mpegts.isSupported()) {
    console.error('mpegts.js is not supported in this browser');
    options.onError?.('MPEG-TS playback is not supported in this browser');
    return;
  }

  player = mpegts.createPlayer(
    {
      type: 'mpegts',
      url: absoluteUrl,
      isLive: true,
    },
    {
      enableWorker: true,
      // Auto-evict old segments from the MSE SourceBuffer to prevent the
      // browser from running out of quota on long-running streams.
      autoCleanupSourceBuffer: true,
      autoCleanupMinBackwardDuration: 30,
      autoCleanupMaxBackwardDuration: 60,
      // Be tolerant of PTS discontinuities that slip through.
      fixAudioTimestampGap: true,
      // Do not chase live latency by varying playback speed — ffmpeg cfr
      // mode keeps the output steady so speed changes only cause audio artefacts.
      liveBufferLatencyChasing: false,
    },
  );

  player.on(mpegts.Events.ERROR, (errorType: unknown, errorDetail: unknown, errorInfo: unknown) => {
    console.error('[mpegts] playback error', { errorType, errorDetail, errorInfo });
    const detail = typeof errorDetail === 'string' ? errorDetail : 'UnknownError';
    options.onError?.(`Playback error: ${detail}`);
  });

  player.attachMediaElement(videoEl);
  player.load();
  const playResult = player.play();
  if (playResult && typeof playResult.then === 'function') {
    playResult.catch((err: unknown) => {
      // Benign during rapid channel changes: old play promise rejects when
      // destroy() detaches the media element.
      if (!isAbortLikeError(err)) {
        console.error('[mpegts] play failed', err);
        const message = err instanceof Error ? err.message : 'Failed to start playback';
        options.onError?.(message);
      }
    });
  }
}

export function destroyPlayer(): void {
  if (player) {
    player.destroy();
    player = null;
  }
}
