import { fetchChannels, streamUrl, isRadio } from './hdhomerun';
import type { Channel } from './hdhomerun';
import { destroyPlayer, initPlayer, playStream } from './player';
import { renderChannelList, setChannelListError } from './channelList';

type Mode = 'tv' | 'radio';
type TvFilter = 'sd' | 'hd' | 'both';

type AppSettings = {
  mode: Mode;
  tvFilter: TvFilter;
  hiddenChannelIds: string[];
  showGuideSnippets: boolean;
};

type StreamInfo = {
  probedAt: string;
  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
  } | null;
  audio: {
    codec: string | null;
    channels: number | null;
    sampleRate: number | null;
  } | null;
  hasSubtitles: boolean;
  subtitleTracks: number;
};

type IptvOrgChannelFile = {
  name: string;
  path: string;
  rawUrl: string;
  variant: string | null;
};

type IptvOrgChannelSite = {
  slug: string;
  label: string;
  fileCount: number;
  files: IptvOrgChannelFile[];
};

const SETTINGS_KEY = 'tv-player-settings-v1';
const EPG_LAST_SITE_KEY = 'epg-last-site-slug';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CAPTION_DISCOVERY_TRIES = 10;
const CAPTION_DISCOVERY_INTERVAL_MS = 1000;
const ALIGNED_REFRESH_OFFSET_MS = 3000;

const channelId = (channel: Channel): string => `${channel.GuideNumber}|${channel.GuideName}|${channel.URL}`;

const defaultSettings: AppSettings = {
  mode: 'tv',
  tvFilter: 'both',
  hiddenChannelIds: [],
  showGuideSnippets: true,
};

const loadSettings = (): AppSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultSettings;

    const mode = (parsed as Record<string, unknown>).mode;
    const tvFilter = (parsed as Record<string, unknown>).tvFilter;
    const hiddenChannelIds = (parsed as Record<string, unknown>).hiddenChannelIds;
    const showGuideSnippets = (parsed as Record<string, unknown>).showGuideSnippets;

    return {
      mode: mode === 'radio' ? 'radio' : 'tv',
      tvFilter: tvFilter === 'sd' || tvFilter === 'hd' || tvFilter === 'both' ? tvFilter : 'both',
      hiddenChannelIds: Array.isArray(hiddenChannelIds)
        ? hiddenChannelIds.filter((v): v is string => typeof v === 'string')
        : [],
      showGuideSnippets: typeof showGuideSnippets === 'boolean' ? showGuideSnippets : true,
    };
  } catch {
    return defaultSettings;
  }
};

const saveSettings = (settings: AppSettings): void => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};

const app = document.getElementById('app')!;

app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <header class="sidebar-header">
        <h1>TV Player</h1>
        <div class="channel-controls">
          <div class="controls-row">
            <div class="control-inline">
              <label for="mode-filter">Mode</label>
              <select id="mode-filter">
                <option value="tv">TV</option>
                <option value="radio">Radio</option>
              </select>
            </div>
            <div id="tv-filter-row" class="control-inline">
              <label for="tv-filter">Filter</label>
              <select id="tv-filter">
                <option value="both">SD + HD</option>
                <option value="sd">SD only</option>
                <option value="hd">HD only</option>
              </select>
            </div>
          </div>
          <div class="controls-row">
            <button id="captions-toggle" class="hidden-settings-btn ctrl-btn" type="button" disabled>Subtitles: Off</button>
            <button id="guide-snippets-toggle" class="hidden-settings-btn ctrl-btn" type="button">Guide Detail: On</button>
          </div>
        </div>
      </header>
      <div id="channel-list-container" class="channel-list-container">
        <p class="channel-loading">Loading channels…</p>
      </div>
      <div class="sidebar-footer">
        <button id="visibility-btn" class="hidden-settings-btn" type="button">Channel visibility</button>
        <button id="epg-settings-btn" class="hidden-settings-btn" type="button">EPG settings</button>
      </div>
    </aside>
    <main class="main">
      <video id="video" class="video-player" controls autoplay></video>
      <div id="radio-card" class="radio-card" aria-hidden="true">
        <div class="radio-icon">&#9654;</div>
        <div id="radio-name" class="radio-name"></div>
      </div>
      <div id="playback-status" class="playback-status" hidden>
        <div class="playback-status-main">
          <span id="playback-status-text"></span>
        </div>
        <div class="playback-status-actions">
          <button id="playback-status-close" type="button">Dismiss</button>
          <button id="hide-failing-channel-btn" type="button" hidden>Hide this channel</button>
        </div>
      </div>
      <div id="now-playing" class="now-playing"></div>
      <div id="guide-panel" class="guide-panel"></div>
      <div id="toast-container" class="toast-container" aria-live="polite"></div>
    </main>
  </div>

  <section id="epg-settings-modal" class="epg-settings-modal" hidden>
    <div class="epg-settings-dialog" role="dialog" aria-modal="true" aria-label="EPG settings">
      <div class="epg-settings-header">
        <h2>EPG Settings</h2>
        <button id="epg-settings-close" type="button">Close</button>
      </div>
      <div class="epg-settings-content">
        <div class="epg-mode-selector">
          <label class="epg-mode-option">
            <input type="radio" name="epg-mode" id="epg-mode-builtin" value="builtin">
            <span>Run built-in EPG server</span>
          </label>
          <label class="epg-mode-option">
            <input type="radio" name="epg-mode" id="epg-mode-external" value="external">
            <span>Use an external EPG server</span>
          </label>
        </div>
        <div class="epg-status-section">
          <h3>Status</h3>
          <div id="epg-status-info" class="epg-status-info">Loading…</div>
        </div>
        <div id="epg-builtin-section">
          <div class="epg-picker-section">
            <h3>Channel List</h3>
            <p class="epg-picker-copy">Browse iptv-org channel lists and apply one to the built-in EPG server.</p>
            <input id="epg-site-filter" type="text" placeholder="Filter by site, country, provider, or file name" class="epg-url-input epg-site-filter">
            <div class="epg-picker-grid">
              <div class="epg-picker-column">
                <label for="epg-site-select">Site</label>
                <select id="epg-site-select" class="epg-picker-select" size="8"></select>
              </div>
              <div class="epg-picker-column">
                <label for="epg-site-file-select">XML list</label>
                <select id="epg-site-file-select" class="epg-picker-select" size="8"></select>
              </div>
            </div>
            <div class="epg-picker-actions">
              <button id="epg-apply-site-file" type="button" class="epg-button">Use Selected List</button>
            </div>
            <div id="epg-picker-info" class="epg-picker-info">Load a site list to start browsing.</div>
          </div>
          <div class="epg-refresh-section">
            <button id="epg-sidecar-rebuild-btn" type="button" class="epg-button">Rebuild Guide Now</button>
            <button id="epg-refresh-btn" type="button" class="epg-button">Reload Current Guide</button>
          </div>
        </div>
        <div id="epg-external-section" hidden>
          <div class="epg-source-section">
            <h3>EPG Source URL</h3>
            <p class="epg-picker-copy">Enter the URL of an XMLTV-format guide file.</p>
            <div class="epg-input-row">
              <input id="epg-source-url" type="text" placeholder="https://example.com/guide.xml" class="epg-url-input">
              <button id="epg-source-save" type="button" class="epg-button">Save</button>
            </div>
          </div>
          <div class="epg-refresh-section">
            <button id="epg-external-refresh-btn" type="button" class="epg-button">Reload Guide</button>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="visibility-modal" class="visibility-modal" hidden>
    <div class="visibility-dialog" role="dialog" aria-modal="true" aria-label="Channel visibility settings">
      <div class="visibility-header">
        <h2>Channel Visibility</h2>
        <button id="visibility-close" type="button">Close</button>
      </div>
      <div class="visibility-settings">
        <div class="control-row">
          <label for="modal-mode-filter">Mode</label>
          <select id="modal-mode-filter">
            <option value="tv">TV</option>
            <option value="radio">Radio</option>
          </select>
        </div>
        <div id="modal-tv-filter-row" class="control-row">
          <label for="modal-tv-filter">TV Filter</label>
          <select id="modal-tv-filter">
            <option value="both">SD + HD</option>
            <option value="sd">SD only</option>
            <option value="hd">HD only</option>
          </select>
        </div>
      </div>
      <div class="visibility-columns">
        <div class="visibility-column">
          <h3>Visible channels</h3>
          <p class="visibility-note">Click a channel to hide it.</p>
          <div id="visible-channel-list" class="visibility-list"></div>
        </div>
        <div class="visibility-column">
          <h3>Hidden channels</h3>
          <p class="visibility-note">Click a channel to show it.</p>
          <div id="hidden-channel-list" class="visibility-list"></div>
        </div>
      </div>
      <div class="visibility-footer">
        <button id="show-all-btn" class="show-all-btn" type="button">Show all channels</button>
      </div>
    </div>
  </section>
`;

const videoEl = document.getElementById('video') as HTMLVideoElement;
const channelContainer = document.getElementById('channel-list-container')!;
const nowPlaying = document.getElementById('now-playing')!;
const mainEl = document.querySelector('.main')!;
const radioName = document.getElementById('radio-name')!;
const playbackStatusEl = document.getElementById('playback-status')!;
const playbackStatusTextEl = document.getElementById('playback-status-text')!;
const playbackStatusCloseBtn = document.getElementById('playback-status-close') as HTMLButtonElement;
const hideFailingChannelBtn = document.getElementById('hide-failing-channel-btn') as HTMLButtonElement;
const toastContainer = document.getElementById('toast-container')!;
const modeFilterEl = document.getElementById('mode-filter') as HTMLSelectElement;
const tvFilterEl = document.getElementById('tv-filter') as HTMLSelectElement;
const tvFilterRowEl = document.getElementById('tv-filter-row')!;
const visibilityBtn = document.getElementById('visibility-btn') as HTMLButtonElement;
const visibilityModal = document.getElementById('visibility-modal')!;
const visibilityClose = document.getElementById('visibility-close') as HTMLButtonElement;
const modalModeFilterEl = document.getElementById('modal-mode-filter') as HTMLSelectElement;
const modalTvFilterEl = document.getElementById('modal-tv-filter') as HTMLSelectElement;
const modalTvFilterRowEl = document.getElementById('modal-tv-filter-row')!;
const visibleChannelListEl = document.getElementById('visible-channel-list')!;
const hiddenChannelListEl = document.getElementById('hidden-channel-list')!;
const showAllBtn = document.getElementById('show-all-btn') as HTMLButtonElement;
const captionsToggleBtn = document.getElementById('captions-toggle') as HTMLButtonElement;
const guideSnippetsToggleBtn = document.getElementById('guide-snippets-toggle') as HTMLButtonElement;
const epgSettingsBtn = document.getElementById('epg-settings-btn') as HTMLButtonElement;
const epgSettingsModal = document.getElementById('epg-settings-modal')!;
const epgSettingsClose = document.getElementById('epg-settings-close') as HTMLButtonElement;
const epgStatusInfo = document.getElementById('epg-status-info')!;
const epgSourceUrl = document.getElementById('epg-source-url') as HTMLInputElement;
const epgSourceSave = document.getElementById('epg-source-save') as HTMLButtonElement;
const epgRefreshBtn = document.getElementById('epg-refresh-btn') as HTMLButtonElement;
const epgExternalRefreshBtn = document.getElementById('epg-external-refresh-btn') as HTMLButtonElement;
const epgSidecarRebuildBtn = document.getElementById('epg-sidecar-rebuild-btn') as HTMLButtonElement;
const epgModeBuiltinEl = document.getElementById('epg-mode-builtin') as HTMLInputElement;
const epgModeExternalEl = document.getElementById('epg-mode-external') as HTMLInputElement;
const epgBuiltinSectionEl = document.getElementById('epg-builtin-section')!;
const epgExternalSectionEl = document.getElementById('epg-external-section')!;
const epgSiteFilterEl = document.getElementById('epg-site-filter') as HTMLInputElement;
const epgSiteSelectEl = document.getElementById('epg-site-select') as HTMLSelectElement;
const epgSiteFileSelectEl = document.getElementById('epg-site-file-select') as HTMLSelectElement;
const epgApplySiteFileBtn = document.getElementById('epg-apply-site-file') as HTMLButtonElement;
const epgPickerInfo = document.getElementById('epg-picker-info')!;

let allChannels: Channel[] = [];
let settings = loadSettings();
let visibilityMode: Mode = settings.mode;
let visibilityTvFilter: TvFilter = settings.tvFilter;
let activeChannel: Channel | null = null;
let activeChannelFailureCount = 0;
let playSessionId = 0;
let retryTimer: number | null = null;
let playbackStatusTimer: number | null = null;
let captionsEnabled = false;
let captionDiscoveryTimer: number | null = null;
let burnInCaptionsEnabled = false;
let currentNowNextData: Record<string, unknown> = {};
let currentStreamInfo: StreamInfo | null = null;
let streamInfoLoading = false;
let streamInfoRequestToken = 0;
let epgStatusPollTimer: number | null = null;
let activeToast: { message: string; kind: 'info' | 'error'; element: HTMLElement; timeoutId: number } | null = null;
let iptvOrgSites: IptvOrgChannelSite[] = [];
let filteredIptvOrgSites: IptvOrgChannelSite[] = [];
let pendingGuideReloadAfterSidecar = false;
let epgAutoReloadInProgress = false;
let currentSidecarSourceUrl = 'http://iptv-epg:3000/guide.xml';

initPlayer(videoEl);
videoEl.setAttribute('controlsList', 'nodownload noplaybackrate');

const getCaptionTracks = (): TextTrack[] => {
  const tracks: TextTrack[] = [];
  for (let i = 0; i < videoEl.textTracks.length; i += 1) {
    const track = videoEl.textTracks[i];
    if (track.kind === 'captions' || track.kind === 'subtitles') {
      tracks.push(track);
    }
  }
  return tracks;
};

const applyCaptionMode = () => {
  for (const track of getCaptionTracks()) {
    track.mode = captionsEnabled ? 'showing' : 'disabled';
  }
};

const refreshCaptionsUi = (): boolean => {
  const canUseBurnIn = Boolean(activeChannel && !isRadio(activeChannel));

  if (burnInCaptionsEnabled) {
    captionsToggleBtn.disabled = !canUseBurnIn;
    captionsToggleBtn.textContent = 'Subtitles: On';
    return true;
  }

  const tracks = getCaptionTracks();
  if (tracks.length === 0) {
    captionsToggleBtn.disabled = !canUseBurnIn;
    captionsToggleBtn.textContent = 'Subtitles: Off';
    return false;
  }

  captionsToggleBtn.disabled = !canUseBurnIn;
  captionsToggleBtn.textContent = captionsEnabled ? 'Subtitles: On' : 'Subtitles: Off';
  applyCaptionMode();
  return true;
};

const clearCaptionDiscovery = () => {
  if (captionDiscoveryTimer !== null) {
    window.clearInterval(captionDiscoveryTimer);
    captionDiscoveryTimer = null;
  }
};

const startCaptionDiscovery = (sessionId: number) => {
  clearCaptionDiscovery();

  let triesLeft = CAPTION_DISCOVERY_TRIES;
  const check = () => {
    if (sessionId !== playSessionId) {
      clearCaptionDiscovery();
      return;
    }

    const found = refreshCaptionsUi();
    if (found || triesLeft <= 0) {
      clearCaptionDiscovery();
      return;
    }

    triesLeft -= 1;
  };

  check();
  captionDiscoveryTimer = window.setInterval(check, CAPTION_DISCOVERY_INTERVAL_MS);
};

const clearRetryTimer = () => {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
};

const showToast = (message: string, kind: 'info' | 'error', timeoutMs: number) => {
  if (activeToast && activeToast.element.parentElement) {
    if (activeToast.message === message && activeToast.kind === kind) {
      window.clearTimeout(activeToast.timeoutId);
      const activeElement = activeToast.element;
      activeToast.timeoutId = window.setTimeout(() => {
        if (activeToast?.element === activeElement) {
          activeElement.remove();
          activeToast = null;
        }
      }, timeoutMs);
      return;
    }

    window.clearTimeout(activeToast.timeoutId);
    activeToast.element.remove();
    activeToast = null;
  }

  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;

  const text = document.createElement('div');
  text.className = 'toast-message';
  text.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.textContent = 'Dismiss';

  const removeToast = () => {
    if (toast.parentElement) {
      toast.remove();
    }
    if (activeToast?.element === toast) {
      activeToast = null;
    }
  };

  closeBtn.addEventListener('click', removeToast);

  toast.appendChild(text);
  toast.appendChild(closeBtn);
  toastContainer.appendChild(toast);

  const timeoutId = window.setTimeout(removeToast, timeoutMs);
  activeToast = { message, kind, element: toast, timeoutId };
};

const setPlaybackStatus = (
  message: string,
  kind: 'info' | 'error' = 'info',
  options: { timeoutMs?: number; persistent?: boolean } = {},
) => {
  if (!options.persistent) {
    clearPlaybackStatus();
    showToast(message, kind, options.timeoutMs ?? (kind === 'error' ? 8000 : 5000));
    return;
  }

  if (playbackStatusTimer !== null) {
    window.clearTimeout(playbackStatusTimer);
    playbackStatusTimer = null;
  }

  playbackStatusEl.hidden = false;
  playbackStatusEl.classList.toggle('error', kind === 'error');
  playbackStatusTextEl.textContent = message;

  if (options.timeoutMs) {
    const timeoutMs = options.timeoutMs;
    playbackStatusTimer = window.setTimeout(() => {
      clearPlaybackStatus();
    }, timeoutMs);
  }
};

const clearPlaybackStatus = () => {
  if (playbackStatusTimer !== null) {
    window.clearTimeout(playbackStatusTimer);
    playbackStatusTimer = null;
  }

  playbackStatusEl.hidden = true;
  playbackStatusEl.classList.remove('error');
  playbackStatusTextEl.textContent = '';
  hideFailingChannelBtn.hidden = true;
};

playbackStatusCloseBtn.addEventListener('click', () => {
  clearPlaybackStatus();
});

const setModeUi = () => {
  const tvMode = settings.mode === 'tv';
  tvFilterRowEl.hidden = !tvMode;
  tvFilterEl.disabled = !tvMode;
};

const syncControlValues = () => {
  modeFilterEl.value = settings.mode;
  tvFilterEl.value = settings.tvFilter;
  guideSnippetsToggleBtn.textContent = `Guide Detail: ${settings.showGuideSnippets ? 'On' : 'Off'}`;
};

const setVisibilityFilterUi = () => {
  const tvMode = visibilityMode === 'tv';
  modalTvFilterRowEl.hidden = !tvMode;
  modalTvFilterEl.disabled = !tvMode;
};

const syncVisibilityControlValues = () => {
  modalModeFilterEl.value = visibilityMode;
  modalTvFilterEl.value = visibilityTvFilter;
};

const setHiddenState = (channel: Channel, hidden: boolean) => {
  const id = channelId(channel);
  const hiddenSet = new Set(settings.hiddenChannelIds);

  if (hidden) {
    hiddenSet.add(id);
  } else {
    hiddenSet.delete(id);
  }

  settings.hiddenChannelIds = [...hiddenSet];
  saveSettings(settings);
};

const normalizeCodecLabel = (codec: string | null): string | null => {
  if (!codec) return null;
  const key = codec.toLowerCase();

  const map: Record<string, string> = {
    mpeg2video: 'MPEG-2',
    h264: 'H.264',
    hevc: 'H.265',
    aac_latm: 'AAC-LATM',
    aac: 'AAC',
    mp2: 'MP2',
  };

  return map[key] ?? codec.toUpperCase();
};

const formatVideoClass = (video: StreamInfo['video']): string | null => {
  if (!video?.width || !video?.height) return null;

  const minDim = Math.min(video.width, video.height);
  if (minDim <= 576) return '[SD]';
  if (minDim <= 720) return '[720p]';
  if (minDim <= 1080) return '[1080p]';
  if (minDim <= 2160) return '[4K]';
  return `[${video.width}x${video.height}]`;
};

const formatStreamInfoSummary = (info: StreamInfo | null, loading: boolean): string => {
  if (loading) return 'Probing stream...';
  if (!info) return 'Stream info unavailable';

  const video = info.video
    ? [
        formatVideoClass(info.video) ?? (info.video.width && info.video.height ? `${info.video.width}x${info.video.height}` : null),
        normalizeCodecLabel(info.video.codec),
        info.video.fps ? `${info.video.fps}fps` : null,
      ].filter(Boolean).join(' ')
    : 'Audio only';

  const audio = info.audio
    ? [
        normalizeCodecLabel(info.audio.codec) ?? 'AUDIO',
        info.audio.channels ? `${info.audio.channels}ch` : null,
        info.audio.sampleRate ? `${Math.round(info.audio.sampleRate / 1000)}kHz` : null,
      ].filter(Boolean).join(' ')
    : 'No audio';

  const subtitles = info.hasSubtitles ? `Subs: ${info.subtitleTracks}` : 'Subs: none';
  return `${video} | ${audio} | ${subtitles}`;
};

const fetchStreamInfo = async (showLoading: boolean = false) => {
  if (!activeChannel) {
    currentStreamInfo = null;
    streamInfoLoading = false;
    renderNowPlayingBar();
    return;
  }

  const token = ++streamInfoRequestToken;
  if (showLoading) {
    streamInfoLoading = true;
    renderNowPlayingBar();
  }

  try {
    const source = encodeURIComponent(activeChannel.URL);
    const res = await fetch(`/stream-info?source=${source}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json() as StreamInfo;
    if (token !== streamInfoRequestToken) return;

    currentStreamInfo = data;
    streamInfoLoading = false;
    renderNowPlayingBar();
  } catch (err) {
    if (token !== streamInfoRequestToken) return;
    if (showLoading) {
      currentStreamInfo = null;
    }
    streamInfoLoading = false;
    renderNowPlayingBar();
  }
};

const renderNowPlayingBar = () => {
  if (!activeChannel) {
    nowPlaying.innerHTML = '';
    return;
  }

  const guideData = currentNowNextData[activeChannel.URL] as Record<string, unknown> | undefined;

  nowPlaying.innerHTML = '';
  nowPlaying.classList.toggle('compact-guide', !settings.showGuideSnippets);

  const channelName = document.createElement('div');
  channelName.className = 'channel-name-display';
  channelName.textContent = `${activeChannel.GuideNumber}  ${activeChannel.GuideName}`;
  nowPlaying.appendChild(channelName);

  if (!settings.showGuideSnippets && guideData && (guideData.now || guideData.next)) {
    const inlineGuide = document.createElement('div');
    inlineGuide.className = 'now-playing-inline-guide';

    if (guideData.now) {
      const now = guideData.now as Record<string, unknown>;
      const nowCell = document.createElement('span');
      nowCell.className = 'now-inline-cell now-inline-now';
      nowCell.textContent = `Now: ${String(now.title ?? '')}`;
      inlineGuide.appendChild(nowCell);
    }

    if (guideData.next) {
      const next = guideData.next as Record<string, unknown>;
      const nextCell = document.createElement('span');
      nextCell.className = 'now-inline-cell now-inline-next';
      nextCell.textContent = `Next: ${String(next.title ?? '')}`;
      inlineGuide.appendChild(nextCell);
    }

    nowPlaying.appendChild(inlineGuide);
  }

  if (burnInCaptionsEnabled && !isRadio(activeChannel)) {
    const ccBadge = document.createElement('span');
    ccBadge.className = 'cc-badge';
    ccBadge.textContent = 'CC';
    nowPlaying.appendChild(ccBadge);
  }

  const streamInfo = document.createElement('span');
  streamInfo.className = 'stream-info';
  streamInfo.textContent = formatStreamInfoSummary(currentStreamInfo, streamInfoLoading);
  streamInfo.title = streamInfo.textContent;
  nowPlaying.appendChild(streamInfo);
};

const startChannelPlayback = (channel: Channel, resetFailures: boolean) => {
  clearRetryTimer();
  clearCaptionDiscovery();
  captionsToggleBtn.disabled = true;
  captionsToggleBtn.textContent = 'Captions: Checking...';

  if (resetFailures || !activeChannel || channelId(activeChannel) !== channelId(channel)) {
    activeChannelFailureCount = 0;
  }

  activeChannel = channel;
  currentStreamInfo = null;
  streamInfoLoading = false;
  streamInfoRequestToken += 1;
  const sessionId = ++playSessionId;
  hideFailingChannelBtn.hidden = true;
  setPlaybackStatus('Connecting to stream...');

  renderNowPlayingBar();

  refreshGuideDisplay();
  if (isRadio(channel)) {
    mainEl.classList.add('radio-mode');
    radioName.textContent = channel.GuideName;
  } else {
    mainEl.classList.remove('radio-mode');
    radioName.textContent = '';
  }

  const stream = streamUrl(channel, {
    forceTranscode: burnInCaptionsEnabled && !isRadio(channel),
    captionsMode: burnInCaptionsEnabled ? 'burn' : 'none',
  });

  void fetchStreamInfo(true);

  playStream(videoEl, stream, {
    onError: (message) => {
      if (sessionId !== playSessionId) return;
      if (!activeChannel || channelId(activeChannel) !== channelId(channel)) return;

      activeChannelFailureCount += 1;

      if (activeChannelFailureCount <= MAX_RETRIES) {
        setPlaybackStatus(`Stream issue: ${message}. Retrying ${activeChannelFailureCount}/${MAX_RETRIES}...`, 'error');
        retryTimer = window.setTimeout(() => {
          startChannelPlayback(channel, false);
        }, RETRY_DELAY_MS);
        return;
      }

      setPlaybackStatus('Channel failed repeatedly. Try another channel, or hide this one.', 'error', { timeoutMs: 20000 });
      hideFailingChannelBtn.hidden = false;
    },
  });
};

const filteredChannels = (): Channel[] => {
  const hiddenSet = new Set(settings.hiddenChannelIds);
  return allChannels.filter((channel) => {
    if (hiddenSet.has(channelId(channel))) return false;

    if (settings.mode === 'radio') {
      return isRadio(channel);
    }

    if (isRadio(channel)) return false;
    if (settings.tvFilter === 'both') return true;
    if (settings.tvFilter === 'hd') return Boolean(channel.HD);
    return !channel.HD;
  });
};

const visibilityFilterMatches = (channel: Channel): boolean => {
  if (visibilityMode === 'radio') {
    return isRadio(channel);
  }

  if (isRadio(channel)) return false;
  if (visibilityTvFilter === 'both') return true;
  if (visibilityTvFilter === 'hd') return Boolean(channel.HD);
  return !channel.HD;
};

const renderVisibilityList = (
  container: HTMLElement,
  channels: Channel[],
  actionText: string,
  action: (channel: Channel) => void,
  emptyText: string,
) => {
  container.innerHTML = '';

  if (channels.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'channel-empty';
    msg.textContent = emptyText;
    container.appendChild(msg);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'visibility-items';

  for (const channel of channels) {
    const item = document.createElement('li');
    item.className = 'visibility-item';

    const moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.className = 'visibility-move-btn';
    moveBtn.textContent = `${channel.GuideNumber} ${channel.GuideName}`;
    moveBtn.title = actionText;
    moveBtn.addEventListener('click', () => action(channel));

    item.appendChild(moveBtn);
    list.appendChild(item);
  }

  container.appendChild(list);
};

const renderVisibilityModal = () => {
  const hiddenSet = new Set(settings.hiddenChannelIds);
  const visibleChannels = allChannels.filter((channel) => !hiddenSet.has(channelId(channel)) && visibilityFilterMatches(channel));
  const hiddenChannels = allChannels.filter((channel) => hiddenSet.has(channelId(channel)) && visibilityFilterMatches(channel));

  renderVisibilityList(
    visibleChannelListEl,
    visibleChannels,
    'Hide channel',
    (channel) => {
      setHiddenState(channel, true);
      renderVisibilityModal();
      renderChannels();
    },
    'No visible channels.',
  );

  renderVisibilityList(
    hiddenChannelListEl,
    hiddenChannels,
    'Show channel',
    (channel) => {
      setHiddenState(channel, false);
      renderVisibilityModal();
      renderChannels();
    },
    'No hidden channels.',
  );
};

const normalizeGuideName = (value: string): string => {
  return value
    .toUpperCase()
    .replace(/\bHD\b/g, ' ')
    .replace(/\bSD\b/g, ' ')
    .replace(/\bTV\b/g, ' ')
    .replace(/\bCHANNEL\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const guideNameScore = (a: string, b: string): number => {
  const na = normalizeGuideName(a);
  const nb = normalizeGuideName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 85;

  const ta = new Set(na.split(/[^A-Z0-9]+/).filter(Boolean));
  const tb = new Set(nb.split(/[^A-Z0-9]+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;

  let overlap = 0;
  for (const token of ta) {
    if (tb.has(token)) overlap += 1;
  }
  return Math.round((overlap / Math.max(ta.size, tb.size)) * 70);
};

const remapNowNextByChannelName = (raw: Record<string, unknown>): Record<string, unknown> => {
  const keys = Object.keys(raw);
  if (keys.length === 0) return raw;

  // Already keyed by HDHomeRun stream URLs.
  if (keys.some((k) => k.startsWith('http://') || k.startsWith('https://'))) {
    return raw;
  }

  const entries = keys.map((key) => {
    const payload = raw[key] as Record<string, unknown>;
    return {
      key,
      payload,
      channelName: typeof payload?.channelName === 'string' ? payload.channelName : key,
    };
  });

  const mapped: Record<string, unknown> = {};
  for (const channel of allChannels) {
    let best: { payload: Record<string, unknown>; score: number } | null = null;
    for (const entry of entries) {
      const score = guideNameScore(channel.GuideName, entry.channelName);
      if (!best || score > best.score) {
        best = { payload: entry.payload, score };
      }
    }

    if (best && best.score >= 60 && (best.payload.now || best.payload.next)) {
      mapped[channel.URL] = best.payload;
    }
  }

  return Object.keys(mapped).length > 0 ? mapped : raw;
};

const parseXmltvDate = (value: unknown): Date | null => {
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

const fetchNowNextData = async () => {
  try {
    const res = await fetch('/epg/now-next');
    if (res.ok) {
      const raw = await res.json() as Record<string, unknown>;
      currentNowNextData = remapNowNextByChannelName(raw);
    }
  } catch (err) {
    console.error('[epg] failed to fetch now/next:', err);
  }
};

const refreshGuideDisplay = () => {
  if (!activeChannel) return;
  const guidePanel = document.getElementById('guide-panel')!;
  const guideData = currentNowNextData[activeChannel.URL] as Record<string, unknown> | undefined;
  guidePanel.classList.toggle('compact', !settings.showGuideSnippets);

  guidePanel.innerHTML = '';
  renderNowPlayingBar();

  if (!guideData || (!guideData.now && !guideData.next)) {
    guidePanel.innerHTML = '<p class="guide-empty">No guide data available.</p>';
    return;
  }

  if (!settings.showGuideSnippets) {
    return;
  }

  if (guideData.now) {
    const now = guideData.now as Record<string, unknown>;
    const nowCard = document.createElement('div');
    nowCard.className = 'guide-card guide-card-now';
    const startTime = parseXmltvDate(now.start);
    const stopTime = parseXmltvDate(now.stop);
    const nowTimeLabel = startTime && stopTime
      ? `${startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${stopTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Time unavailable';
    nowCard.innerHTML = `
      <div class="guide-card-time">Now: ${nowTimeLabel}</div>
      <div class="guide-card-title">${now.title}</div>
      ${now.desc ? `<div class="guide-card-desc">${now.desc}</div>` : ''}
    `;
    guidePanel.appendChild(nowCard);
  }

  if (guideData.next) {
    const next = guideData.next as Record<string, unknown>;
    const nextCard = document.createElement('div');
    nextCard.className = 'guide-card guide-card-next';
    const startTime = parseXmltvDate(next.start);
    const stopTime = parseXmltvDate(next.stop);
    const nextTimeLabel = startTime && stopTime
      ? `${startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${stopTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Time unavailable';
    nextCard.innerHTML = `
      <div class="guide-card-time">Next: ${nextTimeLabel}</div>
      <div class="guide-card-title">${next.title}</div>
      ${next.desc ? `<div class="guide-card-desc">${next.desc}</div>` : ''}
    `;
    guidePanel.appendChild(nextCard);
  }
};

const renderChannels = () => {
  const channels = filteredChannels();
  const hiddenSet = new Set(settings.hiddenChannelIds);
  const hiddenInView = allChannels.filter((ch) => {
    if (!hiddenSet.has(channelId(ch))) return false;
    if (settings.mode === 'radio') return isRadio(ch);
    if (isRadio(ch)) return false;
    if (settings.tvFilter === 'both') return true;
    if (settings.tvFilter === 'hd') return Boolean(ch.HD);
    return !ch.HD;
  }).length;
  visibilityBtn.textContent = `Channel visibility (${hiddenInView} hidden)`;
  renderChannelList(channelContainer, channels, (channel) => {
    startChannelPlayback(channel, true);
  }, currentNowNextData as Record<string, Record<string, unknown>>);
};

syncControlValues();
setModeUi();
syncVisibilityControlValues();
setVisibilityFilterUi();

const updateMode = (value: string) => {
  settings.mode = value === 'radio' ? 'radio' : 'tv';
  saveSettings(settings);
  syncControlValues();
  setModeUi();
  renderChannels();
};

const updateTvFilter = (value: string) => {
  settings.tvFilter = value === 'sd' || value === 'hd' || value === 'both' ? value : 'both';
  saveSettings(settings);
  syncControlValues();
  renderChannels();
};

modeFilterEl.addEventListener('change', () => {
  updateMode(modeFilterEl.value);
});

modalModeFilterEl.addEventListener('change', () => {
  visibilityMode = modalModeFilterEl.value === 'radio' ? 'radio' : 'tv';
  syncVisibilityControlValues();
  setVisibilityFilterUi();
  renderVisibilityModal();
});

tvFilterEl.addEventListener('change', () => {
  updateTvFilter(tvFilterEl.value);
});

modalTvFilterEl.addEventListener('change', () => {
  const value = modalTvFilterEl.value;
  visibilityTvFilter = value === 'sd' || value === 'hd' || value === 'both' ? value : 'both';
  syncVisibilityControlValues();
  renderVisibilityModal();
});

visibilityBtn.addEventListener('click', () => {
  syncVisibilityControlValues();
  setVisibilityFilterUi();
  visibilityModal.hidden = false;
  renderVisibilityModal();
});

visibilityClose.addEventListener('click', () => {
  visibilityModal.hidden = true;
});

visibilityModal.addEventListener('click', (event) => {
  if (event.target === visibilityModal) {
    visibilityModal.hidden = true;
  }
});

showAllBtn.addEventListener('click', () => {
  settings.hiddenChannelIds = [];
  saveSettings(settings);
  renderVisibilityModal();
  renderChannels();
});

videoEl.addEventListener('playing', () => {
  activeChannelFailureCount = 0;
  hideFailingChannelBtn.hidden = true;
  clearPlaybackStatus();
});

hideFailingChannelBtn.addEventListener('click', () => {
  if (!activeChannel) return;
  setHiddenState(activeChannel, true);
  clearRetryTimer();
  destroyPlayer();
  setPlaybackStatus('Channel hidden. Select another channel.', 'info');
  hideFailingChannelBtn.hidden = true;
  renderVisibilityModal();
  renderChannels();
});

captionsToggleBtn.addEventListener('click', () => {
  if (captionsToggleBtn.disabled) return;

  if (burnInCaptionsEnabled) {
    burnInCaptionsEnabled = false;
    setPlaybackStatus('Burn-in captions disabled.', 'info');
    if (activeChannel) startChannelPlayback(activeChannel, true);
    refreshCaptionsUi();
    return;
  }

  if (getCaptionTracks().length === 0) {
    if (activeChannel && !isRadio(activeChannel)) {
      burnInCaptionsEnabled = true;
      setPlaybackStatus('Using burn-in captions (experimental).', 'info');
      startChannelPlayback(activeChannel, true);
      return;
    }

    setPlaybackStatus('No selectable captions were exposed by this stream.', 'error');
    return;
  }
  captionsEnabled = !captionsEnabled;
  applyCaptionMode();
  refreshCaptionsUi();
});

guideSnippetsToggleBtn.addEventListener('click', () => {
  settings.showGuideSnippets = !settings.showGuideSnippets;
  saveSettings(settings);
  syncControlValues();
  refreshGuideDisplay();
});

videoEl.addEventListener('loadedmetadata', () => {
  startCaptionDiscovery(playSessionId);
});

videoEl.addEventListener('emptied', () => {
  clearCaptionDiscovery();
  refreshCaptionsUi();
});

videoEl.textTracks.addEventListener('addtrack', () => {
  refreshCaptionsUi();
});

videoEl.textTracks.addEventListener('removetrack', () => {
  refreshCaptionsUi();
});

// EPG settings functions
const updateEpgModeUi = () => {
  const builtin = epgModeBuiltinEl.checked;
  epgBuiltinSectionEl.hidden = !builtin;
  epgExternalSectionEl.hidden = builtin;
};

const setEpgPickerInfo = (message: string, kind: 'info' | 'error' = 'info') => {
  epgPickerInfo.textContent = message;
  epgPickerInfo.classList.toggle('error', kind === 'error');
};

const getSelectedIptvOrgSite = (): IptvOrgChannelSite | null => {
  const selected = filteredIptvOrgSites.find((site) => site.slug === epgSiteSelectEl.value);
  return selected ?? filteredIptvOrgSites[0] ?? null;
};

const renderIptvOrgFileOptions = () => {
  const site = getSelectedIptvOrgSite();
  epgSiteFileSelectEl.innerHTML = '';

  if (!site) {
    setEpgPickerInfo('No matching iptv-org sites found. Try a broader filter.', 'error');
    return;
  }

  for (const file of site.files) {
    const option = document.createElement('option');
    option.value = file.path;
    option.textContent = file.variant ? `${file.variant}  (${file.name})` : file.name;
    epgSiteFileSelectEl.appendChild(option);
  }

  if (site.files.length > 0) {
    epgSiteFileSelectEl.selectedIndex = 0;
    setEpgPickerInfo(`Showing ${site.files.length} XML list${site.files.length === 1 ? '' : 's'} for ${site.slug}.`);
  } else {
    setEpgPickerInfo(`No XML lists found for ${site.slug}.`, 'error');
  }
};

const renderIptvOrgSiteOptions = () => {
  const filter = epgSiteFilterEl.value.trim().toLowerCase();
  const currentSelection = epgSiteSelectEl.value;

  filteredIptvOrgSites = iptvOrgSites.filter((site) => {
    if (!filter) return true;
    if (site.slug.toLowerCase().includes(filter)) return true;

    return site.files.some((file) => {
      if (file.name.toLowerCase().includes(filter)) return true;
      return file.variant?.toLowerCase().includes(filter) ?? false;
    });
  });

  epgSiteSelectEl.innerHTML = '';
  for (const site of filteredIptvOrgSites) {
    const option = document.createElement('option');
    option.value = site.slug;
    option.textContent = `${site.slug} (${site.fileCount})`;
    epgSiteSelectEl.appendChild(option);
  }

  if (filteredIptvOrgSites.length === 0) {
    renderIptvOrgFileOptions();
    return;
  }

  const savedSlug = localStorage.getItem(EPG_LAST_SITE_KEY);
  let targetSlug: string;
  if (filteredIptvOrgSites.some((site) => site.slug === currentSelection)) {
    targetSlug = currentSelection;
  } else if (savedSlug && filteredIptvOrgSites.some((site) => site.slug === savedSlug)) {
    targetSlug = savedSlug;
  } else {
    targetSlug = filteredIptvOrgSites[0].slug;
  }
  epgSiteSelectEl.value = targetSlug;
  renderIptvOrgFileOptions();
};

const fetchIptvOrgSites = async () => {
  setEpgPickerInfo('Loading iptv-org channel lists...');

  try {
    const res = await fetch('/epg/iptv-org/sites');
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to load iptv-org channel lists' }));
      throw new Error(String(err.error ?? 'Failed to load iptv-org channel lists'));
    }

    const data = await res.json() as { sites?: IptvOrgChannelSite[] };
    iptvOrgSites = Array.isArray(data.sites) ? data.sites : [];

    if (iptvOrgSites.length === 0) {
      setEpgPickerInfo('No iptv-org channel lists were returned.', 'error');
      return;
    }

    renderIptvOrgSiteOptions();
  } catch (err) {
    setEpgPickerInfo(err instanceof Error ? err.message : 'Failed to load iptv-org channel lists', 'error');
  }
};

const getSidecarGuideStateLabel = (state: string): string => {
  switch (state) {
    case 'manual':
      return 'Not using Docker sidecar';
    case 'no-channels-file':
      return 'No channel list saved yet';
    case 'rebuilding':
      return 'Rebuild in progress';
    case 'guide-missing':
      return 'Guide file not built yet';
    case 'guide-stale':
      return 'Guide is out of date for the current channel list';
    case 'guide-ready':
      return 'Guide file is up to date';
    default:
      return 'Status unavailable';
  }
};

const getEpgFriendlyStateLabel = (state: string): string => {
  switch (state) {
    case 'disabled':
      return 'Disabled';
    case 'ready':
      return 'Ready';
    case 'building':
    case 'starting':
      return 'Building guide';
    case 'error':
      return 'Needs attention';
    default:
      return 'Checking status';
  }
};

const formatEpgDate = (value: unknown): string => {
  if (!value) return 'Never';
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? 'Never' : parsed.toLocaleString();
};

const parseSidecarSiteFromLine = (line: string): string | null => {
  const match = line.match(/\] ([^\s]+) \(/);
  return match?.[1] ?? null;
};

const reloadGuideIntoPlayer = async (message: string = 'Reloading guide into TV Player...') => {
  try {
    epgStatusInfo.textContent = message;
    const res = await fetch('/epg/refresh', { method: 'POST' });
    if (res.ok) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await fetchEpgStatus();
      await refreshNowNextAndUi();
    } else {
      const err = await res.json().catch(() => ({ error: 'Failed to reload guide' }));
      epgStatusInfo.textContent = `Error: ${err.error || 'Failed to reload guide'}`;
    }
  } catch (err) {
    epgStatusInfo.textContent = `Error: ${err instanceof Error ? err.message : 'Error reloading guide'}`;
  }
};

const rebuildSidecarGuide = async (message: string = 'Starting guide rebuild...') => {
  try {
    epgStatusInfo.textContent = message;
    const res = await fetch('/epg/sidecar/rebuild', { method: 'POST' });
    const payload = await res.json().catch(() => ({ error: 'Failed to rebuild guide' }));
    if (!res.ok) {
      throw new Error(String(payload.error ?? 'Failed to rebuild guide'));
    }

    pendingGuideReloadAfterSidecar = true;
    setEpgPickerInfo(`${String(payload.message ?? 'Guide rebuild started.')} TV Player will load the new guide automatically when it is ready.`);
    await fetchEpgStatus();
  } catch (err) {
    setEpgPickerInfo(err instanceof Error ? err.message : 'Failed to rebuild guide', 'error');
    await fetchEpgStatus();
  }
};

const applySelectedIptvOrgFile = async () => {
  const selectedSite = getSelectedIptvOrgSite();
  const selectedPath = epgSiteFileSelectEl.value;

  if (!selectedSite || !selectedPath) {
    setEpgPickerInfo('Choose a site and XML list first.', 'error');
    return;
  }

  epgApplySiteFileBtn.disabled = true;
  setEpgPickerInfo('Saving channel list to epg/channels.xml...');

  try {
    const res = await fetch('/epg/iptv-org/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selectedPath }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to apply channel list' }));
      throw new Error(String(err.error ?? 'Failed to apply channel list'));
    }

    const payload = await res.json() as { message?: string; rebuildStarted?: boolean; rebuildQueued?: boolean; rebuildError?: string | null };

    if (payload.rebuildQueued) {
      pendingGuideReloadAfterSidecar = true;
      const detail = payload.rebuildStarted
        ? ' The guide is being rebuilt now and will be loaded automatically when ready.'
        : ' The current rebuild will be used and TV Player will load the new guide when it is ready.';
      setEpgPickerInfo(`${payload.message ?? 'Channel list applied.'}${detail}`);
    } else if (payload.rebuildError) {
      setEpgPickerInfo(`${payload.message ?? 'Channel list applied.'} ${payload.rebuildError}`, 'error');
    } else {
      setEpgPickerInfo(payload.message ?? 'Channel list applied.');
    }

    await fetchEpgStatus();
  } catch (err) {
    setEpgPickerInfo(err instanceof Error ? err.message : 'Failed to apply channel list', 'error');
  } finally {
    epgApplySiteFileBtn.disabled = false;
  }
};

const fetchEpgStatus = async () => {
  try {
    const res = await fetch('/epg/status');
    const data = await res.json() as Record<string, unknown>;
    const enabled = data.enabled ? 'Yes' : 'No';
    const stateRaw = typeof data.state === 'string' ? data.state : 'unknown';
    const lastAttempt = data.lastAttempt ? new Date(String(data.lastAttempt)).toLocaleString() : 'Never';
    const lastFetch = data.lastFetch ? new Date(String(data.lastFetch)).toLocaleString() : 'Never';
    const channels = Number(data.channelCount ?? 0);
    const programmes = Number(data.programmeCount ?? 0);
    const lastError = data.lastError ? String(data.lastError) : '';
    const sourceUrl = data.sourceUrl ? String(data.sourceUrl) : '';
    const sidecarSourceUrl = data.sidecarSourceUrl ? String(data.sidecarSourceUrl) : 'http://iptv-epg:3000/guide.xml';
    const sidecarMode = sourceUrl === sidecarSourceUrl;
    const channelsFileConfigured = Boolean(data.channelsFileConfigured);
    const sidecar = (typeof data.sidecar === 'object' && data.sidecar) ? data.sidecar as Record<string, unknown> : {};
    const sidecarGuideState = typeof sidecar.guideBuildState === 'string' ? sidecar.guideBuildState : 'unknown';
    const sidecarDockerSocketMounted = Boolean(sidecar.dockerSocketMounted);
    const sidecarRebuildInProgress = Boolean(sidecar.rebuildInProgress);
    const sidecarLastRequestedAt = formatEpgDate(sidecar.lastRequestedAt);
    const sidecarLastRestartedAt = formatEpgDate(sidecar.lastRestartedAt);
    const sidecarLastError = sidecar.lastError ? String(sidecar.lastError) : '';
    const channelsFile = (typeof sidecar.channelsFile === 'object' && sidecar.channelsFile) ? sidecar.channelsFile as Record<string, unknown> : {};
    const guideFile = (typeof sidecar.guideFile === 'object' && sidecar.guideFile) ? sidecar.guideFile as Record<string, unknown> : {};
    const sidecarActivity = (typeof data.sidecarActivity === 'object' && data.sidecarActivity) ? data.sidecarActivity as Record<string, unknown> : {};
    const sidecarProgress = (typeof sidecarActivity.progress === 'object' && sidecarActivity.progress) ? sidecarActivity.progress as Record<string, unknown> : null;
    const activityLines = Array.isArray(sidecarActivity.recentLines)
      ? sidecarActivity.recentLines.filter((line): line is string => typeof line === 'string')
      : [];
    const latestActivityLine = activityLines[activityLines.length - 1] ?? '';
    const progressSite = latestActivityLine ? parseSidecarSiteFromLine(latestActivityLine) : null;

    epgSourceUrl.value = sourceUrl;
    currentSidecarSourceUrl = sidecarSourceUrl;
    if (sidecarMode) {
      epgModeBuiltinEl.checked = true;
    } else {
      epgModeExternalEl.checked = true;
    }
    updateEpgModeUi();
    epgRefreshBtn.textContent = 'Reload Current Guide';

    epgStatusInfo.innerHTML = '';
    const summaryLines: string[] = [];
    summaryLines.push(`Status: ${enabled === 'Yes' ? getEpgFriendlyStateLabel(stateRaw) : 'Disabled'}`);

    if (sidecarMode) {
      summaryLines.push(`Guide build: ${getSidecarGuideStateLabel(sidecarGuideState)}`);
      if (sidecarProgress) {
        const current = Number(sidecarProgress.current ?? 0);
        const total = Number(sidecarProgress.total ?? 0);
        const percent = Number(sidecarProgress.percent ?? 0);
        const siteText = progressSite ? `${progressSite} ` : '';
        summaryLines.push(`Build progress: ${siteText}${current}/${total} items processed (${percent}%)`);
      } else if (stateRaw === 'building') {
        summaryLines.push('The guide is being generated now. This can take a few minutes for larger channel lists.');
      }

      if (!channelsFileConfigured) {
        summaryLines.push('No channel list has been saved yet. Choose one below to start building a guide.');
      } else {
        summaryLines.push(`Channel list saved: ${formatEpgDate(channelsFile.modifiedAt)}`);
      }

      if (guideFile.modifiedAt) {
        summaryLines.push(`Current guide file: updated ${formatEpgDate(guideFile.modifiedAt)}`);
      }

      if (lastFetch !== 'Never') {
        summaryLines.push(`Last guide load into TV Player: ${lastFetch}`);
      } else if (lastAttempt !== 'Never' && stateRaw === 'building') {
        summaryLines.push(`Guide checks started at: ${lastAttempt}`);
      }

      if (!sidecarDockerSocketMounted) {
        summaryLines.push('Guide rebuild control is not available in this runtime.');
      } else if (sidecarRebuildInProgress) {
        summaryLines.push('Rebuild request is being sent to the sidecar.');
      } else {
        summaryLines.push('Use Rebuild Guide Now after changing the channel list. TV Player will load the new guide when it is ready.');
      }

      if (sidecarLastError) {
        summaryLines.push(`Sidecar control error: ${sidecarLastError}`);
      }

      if (lastError && stateRaw === 'error') {
        summaryLines.push(`Guide load error: ${lastError}`);
      }
    } else {
      summaryLines.push(`Guide source: ${sourceUrl || 'Not configured'}`);
      if (channels > 0 || programmes > 0) {
        summaryLines.push(`Loaded ${channels} channels and ${programmes} programmes.`);
      }
      if (lastFetch !== 'Never') {
        summaryLines.push(`Last successful load: ${lastFetch}`);
      }
      if (lastError && stateRaw === 'error') {
        summaryLines.push(`Last error: ${lastError}`);
      }
    }

    for (const line of summaryLines) {
      const p = document.createElement('p');
      p.textContent = line;
      epgStatusInfo.appendChild(p);
    }

    if (sidecarMode && activityLines.length > 0) {
      const activityWrap = document.createElement('details');
      activityWrap.className = 'epg-activity';

      const activitySummary = document.createElement('summary');
      activitySummary.className = 'epg-activity-summary';
      activitySummary.textContent = sidecarProgress ? 'Show build details' : 'Show recent sidecar activity';
      activityWrap.appendChild(activitySummary);

      const activityMeta = document.createElement('div');
      activityMeta.className = 'epg-activity-title';
      activityMeta.textContent = sidecarProgress && progressSite
        ? `Currently processing ${progressSite}`
        : sidecarProgress
          ? 'Current sidecar activity'
          : 'Recent sidecar activity';
      activityWrap.appendChild(activityMeta);

      const activityLog = document.createElement('pre');
      activityLog.className = 'epg-activity-log';
      activityLog.textContent = activityLines.join('\n');
      activityWrap.appendChild(activityLog);

      epgStatusInfo.appendChild(activityWrap);
    }

    if (sidecarMode && pendingGuideReloadAfterSidecar && !epgAutoReloadInProgress && sidecarGuideState === 'guide-ready') {
      epgAutoReloadInProgress = true;
      pendingGuideReloadAfterSidecar = false;
      setEpgPickerInfo('New guide is ready. Loading it into TV Player...');
      void reloadGuideIntoPlayer('Loading newly built guide into TV Player...').finally(() => {
        epgAutoReloadInProgress = false;
      });
    }

    return data;
  } catch (err) {
    epgStatusInfo.textContent = 'Failed to load EPG status';
    return null;
  }
};

const startEpgStatusPolling = () => {
  if (epgStatusPollTimer !== null) return;
  epgStatusPollTimer = window.setInterval(() => {
    fetchEpgStatus();
  }, 5000);
};

const stopEpgStatusPolling = () => {
  if (epgStatusPollTimer === null) return;
  window.clearInterval(epgStatusPollTimer);
  epgStatusPollTimer = null;
};

const saveEpgSource = async () => {
  if (!epgSourceUrl.value.trim()) {
    epgStatusInfo.textContent = 'Please enter a valid EPG URL';
    return;
  }
  try {
    const res = await fetch('/epg/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: epgSourceUrl.value }),
    });
    if (res.ok) {
      epgStatusInfo.textContent = 'EPG source updated. Refreshing...';
      await fetchEpgStatus();
    } else {
      const err = await res.json().catch(() => ({ error: 'Failed to save EPG source' }));
      epgStatusInfo.textContent = `Error: ${err.error || 'Failed to save EPG source'}`;
    }
  } catch (err) {
    epgStatusInfo.textContent = `Error: ${err instanceof Error ? err.message : 'Error saving EPG source'}`;
  }
};

const refreshEpg = async () => {
  await reloadGuideIntoPlayer('Reloading guide into TV Player...');
};

epgSettingsBtn.addEventListener('click', () => {
  epgSettingsModal.hidden = false;
  void fetchEpgStatus();
  if (iptvOrgSites.length === 0) {
    void fetchIptvOrgSites();
  } else {
    renderIptvOrgSiteOptions();
  }
  startEpgStatusPolling();
});

epgSettingsClose.addEventListener('click', () => {
  epgSettingsModal.hidden = true;
  stopEpgStatusPolling();
});

epgSettingsModal.addEventListener('click', (event) => {
  if (event.target === epgSettingsModal) {
    epgSettingsModal.hidden = true;
    stopEpgStatusPolling();
  }
});

epgSourceSave.addEventListener('click', saveEpgSource);
epgRefreshBtn.addEventListener('click', refreshEpg);
epgExternalRefreshBtn.addEventListener('click', refreshEpg);
epgSidecarRebuildBtn.addEventListener('click', () => {
  void rebuildSidecarGuide();
});
epgModeBuiltinEl.addEventListener('change', () => {
  updateEpgModeUi();
  // If switching to built-in, configure the backend to use the sidecar source URL
  void fetch('/epg/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceUrl: currentSidecarSourceUrl }),
  }).then(() => fetchEpgStatus());
});
epgModeExternalEl.addEventListener('change', () => {
  updateEpgModeUi();
});
epgSiteFilterEl.addEventListener('input', renderIptvOrgSiteOptions);
epgSiteSelectEl.addEventListener('change', () => {
  localStorage.setItem(EPG_LAST_SITE_KEY, epgSiteSelectEl.value);
  renderIptvOrgFileOptions();
});
epgApplySiteFileBtn.addEventListener('click', applySelectedIptvOrgFile);

const refreshNowNextAndUi = async () => {
  await fetchNowNextData();
  renderChannels();
  refreshGuideDisplay();
  if (activeChannel) {
    void fetchStreamInfo(false);
  }
};

const scheduleAlignedNowNextRefresh = () => {
  const intervalMs = 5 * 60 * 1000;
  const offsetMs = ALIGNED_REFRESH_OFFSET_MS;
  const now = Date.now();
  const bucketStart = Math.floor(now / intervalMs) * intervalMs;
  let firstRunAt = bucketStart + offsetMs;
  if (firstRunAt <= now) {
    firstRunAt += intervalMs;
  }
  const initialDelayMs = firstRunAt - now;

  window.setTimeout(() => {
    refreshNowNextAndUi().catch((err) => {
      console.error('[epg] periodic now/next refresh failed:', err);
    });

    window.setInterval(() => {
      refreshNowNextAndUi().catch((err) => {
        console.error('[epg] periodic now/next refresh failed:', err);
      });
    }, intervalMs);
  }, initialDelayMs);
};

const initializeApp = async () => {
  try {
    const channels = await fetchChannels();
    allChannels = channels;
    renderVisibilityModal();
    renderChannels();
    await refreshNowNextAndUi();
    // Refresh guide data at aligned 5-minute boundaries.
    scheduleAlignedNowNextRefresh();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to load channels';
    setChannelListError(channelContainer, msg);
  }
};

initializeApp();
