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
};

const SETTINGS_KEY = 'tv-player-settings-v1';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CAPTION_DISCOVERY_TRIES = 10;
const CAPTION_DISCOVERY_INTERVAL_MS = 1000;

const channelId = (channel: Channel): string => `${channel.GuideNumber}|${channel.GuideName}|${channel.URL}`;

const defaultSettings: AppSettings = {
  mode: 'tv',
  tvFilter: 'both',
  hiddenChannelIds: [],
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

    return {
      mode: mode === 'radio' ? 'radio' : 'tv',
      tvFilter: tvFilter === 'sd' || tvFilter === 'hd' || tvFilter === 'both' ? tvFilter : 'both',
      hiddenChannelIds: Array.isArray(hiddenChannelIds)
        ? hiddenChannelIds.filter((v): v is string => typeof v === 'string')
        : [],
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
          <div class="control-row">
            <label for="mode-filter">Mode</label>
            <select id="mode-filter">
              <option value="tv">TV</option>
              <option value="radio">Radio</option>
            </select>
          </div>
          <div id="tv-filter-row" class="control-row">
            <label for="tv-filter">TV Filter</label>
            <select id="tv-filter">
              <option value="both">SD + HD</option>
              <option value="sd">SD only</option>
              <option value="hd">HD only</option>
            </select>
          </div>
          <button id="captions-toggle" class="hidden-settings-btn" type="button" disabled>Subtitles: Off</button>
        </div>
      </header>
      <div id="channel-list-container" class="channel-list-container">
        <p class="channel-loading">Loading channels…</p>
      </div>
      <div class="sidebar-footer">
        <button id="visibility-btn" class="hidden-settings-btn" type="button">Channel visibility</button>
      </div>
    </aside>
    <main class="main">
      <video id="video" class="video-player" controls autoplay></video>
      <div id="radio-card" class="radio-card" aria-hidden="true">
        <div class="radio-icon">&#9654;</div>
        <div id="radio-name" class="radio-name"></div>
      </div>
      <div id="playback-status" class="playback-status" hidden>
        <span id="playback-status-text"></span>
        <button id="hide-failing-channel-btn" type="button" hidden>Hide this channel</button>
      </div>
      <div id="now-playing" class="now-playing"></div>
    </main>
  </div>

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
const hideFailingChannelBtn = document.getElementById('hide-failing-channel-btn') as HTMLButtonElement;
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

let allChannels: Channel[] = [];
let settings = loadSettings();
let visibilityMode: Mode = settings.mode;
let visibilityTvFilter: TvFilter = settings.tvFilter;
let activeChannel: Channel | null = null;
let activeChannelFailureCount = 0;
let playSessionId = 0;
let retryTimer: number | null = null;
let captionsEnabled = false;
let captionDiscoveryTimer: number | null = null;
let burnInCaptionsEnabled = false;

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

  captionsToggleBtn.disabled = false;
  captionsToggleBtn.textContent = captionsEnabled ? 'Captions: On' : 'Captions: Off';
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

const setPlaybackStatus = (message: string, kind: 'info' | 'error' = 'info') => {
  playbackStatusEl.hidden = false;
  playbackStatusEl.classList.toggle('error', kind === 'error');
  playbackStatusTextEl.textContent = message;
};

const clearPlaybackStatus = () => {
  playbackStatusEl.hidden = true;
  playbackStatusEl.classList.remove('error');
  playbackStatusTextEl.textContent = '';
  hideFailingChannelBtn.hidden = true;
};

const setModeUi = () => {
  const tvMode = settings.mode === 'tv';
  tvFilterRowEl.hidden = !tvMode;
  tvFilterEl.disabled = !tvMode;
};

const syncControlValues = () => {
  modeFilterEl.value = settings.mode;
  tvFilterEl.value = settings.tvFilter;
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

const startChannelPlayback = (channel: Channel, resetFailures: boolean) => {
  clearRetryTimer();
  clearCaptionDiscovery();
  captionsToggleBtn.disabled = true;
  captionsToggleBtn.textContent = 'Captions: Checking...';

  if (resetFailures || !activeChannel || channelId(activeChannel) !== channelId(channel)) {
    activeChannelFailureCount = 0;
  }

  activeChannel = channel;
  const sessionId = ++playSessionId;
  hideFailingChannelBtn.hidden = true;
  setPlaybackStatus('Connecting to stream...');

  nowPlaying.textContent = `${channel.GuideNumber}  ${channel.GuideName}`;
  if (burnInCaptionsEnabled && !isRadio(channel)) {
    const ccBadge = document.createElement('span');
    ccBadge.className = 'cc-badge';
    ccBadge.textContent = 'CC';
    nowPlaying.appendChild(ccBadge);
  }
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

      setPlaybackStatus('Channel failed repeatedly. Try another channel, or hide this one.', 'error');
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
  });
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
  setPlaybackStatus('Live', 'info');
  window.setTimeout(() => {
    if (activeChannelFailureCount === 0) {
      clearPlaybackStatus();
    }
  }, 1500);
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

fetchChannels()
  .then((channels) => {
    allChannels = channels;
    renderVisibilityModal();
    renderChannels();
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : 'Failed to load channels';
    setChannelListError(channelContainer, msg);
  });
