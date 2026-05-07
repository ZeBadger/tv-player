// HDHomeRun device REST API client
// Docs: https://info.hdhomerun.com/info/hdhomerun_develop

export interface Channel {
  GuideNumber: string;  // e.g. "1", "101.1"
  GuideName: string;    // e.g. "BBC ONE"
  URL: string;          // direct MPEG-TS stream URL
  HD?: boolean;
  Favorite?: boolean;
  VideoCodec?: string;  // absent on radio channels
  AudioCodec?: string;  // present on radio channels ("MPEG")
}

// Always call via same-origin proxy so clients never connect to the
// HDHomeRun device directly. In dev, Vite proxies these paths; in prod,
// nginx in the container proxies them.
const API_BASE = '/hdhomerun';
const STREAM_BASE = '/hdhomerun-stream';
const REMUX_BASE = '/hdhomerun-remux';
const RADIO_BASE = '/hdhomerun-radio';
const TRANSCODE_BASE = '/hdhomerun-transcode';

export type StreamOptions = {
  forceTranscode?: boolean;
  hdProcessingMode?: 'passthrough' | 'remux' | 'transcode' | 'transcode-quality' | 'transcode-balanced' | 'transcode-low';
  captionsMode?: 'none' | 'burn';
  transcodeProfile?: 'quality' | 'balanced' | 'low';
};

export async function fetchChannels(): Promise<Channel[]> {
  const res = await fetch(`${API_BASE}/lineup.json`);
  if (!res.ok) throw new Error(`HDHomeRun lineup fetch failed: ${res.status}`);
  const data: unknown = await res.json();
  if (!Array.isArray(data)) throw new Error('Unexpected lineup response');

  return data.flatMap((item: unknown) => {
    if (!isChannelRecord(item)) return [];
    return [{
      GuideNumber: String(item.GuideNumber),
      GuideName: String(item.GuideName),
      URL: String(item.URL),
      HD: Boolean(item.HD),
      Favorite: Boolean(item.Favorite),
      VideoCodec: item.VideoCodec ? String(item.VideoCodec) : undefined,
      AudioCodec: item.AudioCodec ? String(item.AudioCodec) : undefined,
    }];
  });
}

// Radio = has AudioCodec but no VideoCodec in lineup.json.
export function isRadio(channel: Channel): boolean {
  return !channel.VideoCodec && Boolean(channel.AudioCodec);
}

// HD channels: proxy directly (native MPEG-TS, no transcode needed).
// Radio channels: no VideoCodec but AudioCodec present — proxy directly.
// SD TV channels: transcode via server (MPEG-2 → H.264).
export function streamUrl(channel: Channel, options: StreamOptions = {}): string {
  const deviceUrl = new URL(channel.URL);
  const path = `${deviceUrl.pathname}${deviceUrl.search}`;
  const hdProcessingMode = options.hdProcessingMode ?? 'passthrough';

  // For mode-encoded HD transcode options, the profile is derived from the mode name.
  let effectiveProfile = options.transcodeProfile;
  if (hdProcessingMode === 'transcode-quality') effectiveProfile = 'quality';
  else if (hdProcessingMode === 'transcode-balanced') effectiveProfile = 'balanced';
  else if (hdProcessingMode === 'transcode-low') effectiveProfile = 'low';

  const transcodeParams = new URLSearchParams();
  if (options.captionsMode === 'burn') {
    transcodeParams.set('captions', 'burn');
  }
  if (effectiveProfile) {
    transcodeParams.set('profile', effectiveProfile);
  }

  const transcodeSuffix = transcodeParams.size > 0
    ? `${path.includes('?') ? '&' : '?'}${transcodeParams.toString()}`
    : '';

  if (!channel.VideoCodec && channel.AudioCodec) {
    return `${RADIO_BASE}${path}`;
  }

  if (options.forceTranscode || !channel.HD) {
    return `${TRANSCODE_BASE}${path}${transcodeSuffix}`;
  }

  if (channel.HD && (hdProcessingMode === 'transcode' || hdProcessingMode === 'transcode-quality' || hdProcessingMode === 'transcode-balanced' || hdProcessingMode === 'transcode-low')) {
    return `${TRANSCODE_BASE}${path}${transcodeSuffix}`;
  }

  if (channel.HD && hdProcessingMode === 'remux') {
    return `${REMUX_BASE}${path}`;
  }

  return `${STREAM_BASE}${path}`;
}

function isChannelRecord(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    'GuideNumber' in v &&
    'GuideName' in v &&
    'URL' in v
  );
}
