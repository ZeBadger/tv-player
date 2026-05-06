import type { Channel } from './hdhomerun';
import { isRadio } from './hdhomerun';

export interface EpgProgramme {
  start: string;
  stop: string;
  channel: string;
  title: string;
  desc: string;
}

export interface NowNextData {
  [channelId: string]: {
    now?: EpgProgramme;
    next?: EpgProgramme;
  };
}

type ChannelListOptions = {
  activeChannelUrl?: string;
  favoriteChannelIds?: Set<string>;
  onToggleFavorite?: (channel: Channel) => void;
};

export function renderChannelList(
  container: HTMLElement,
  channels: Channel[],
  onSelect: (channel: Channel) => void,
  nowNextData?: NowNextData,
  options: ChannelListOptions = {},
): void {
  const activeChannelUrl = options.activeChannelUrl;
  container.innerHTML = '';

  if (channels.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'channel-empty';
    msg.textContent = 'No channels found.';
    container.appendChild(msg);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'channel-list';

  for (const channel of channels) {
    const item = document.createElement('li');
    item.className = activeChannelUrl && channel.URL === activeChannelUrl
      ? 'channel-item active'
      : 'channel-item';
    item.dataset['number'] = channel.GuideNumber;

    const number = document.createElement('span');
    number.className = 'channel-number';
    number.textContent = channel.GuideNumber;

    const name = document.createElement('span');
    name.className = 'channel-name';
    name.textContent = channel.GuideName; // textContent, never innerHTML

    const details = document.createElement('div');
    details.className = 'channel-details';
    details.appendChild(name);

    // Keep now/next in the same compact block as the channel name.
    if (nowNextData && nowNextData[channel.URL]) {
      const guideData = nowNextData[channel.URL];
      if (guideData.now || guideData.next) {
        const guide = document.createElement('div');
        guide.className = 'channel-guide channel-guide-inline';

        if (guideData.now) {
          const nowDiv = document.createElement('div');
          nowDiv.className = 'guide-now';

          const nowLabel = document.createElement('span');
          nowLabel.className = 'guide-label';
          nowLabel.textContent = 'Now';

          const nowText = document.createElement('span');
          nowText.className = 'guide-text';
          nowText.textContent = guideData.now.title;
          const nowFullText = [guideData.now.title, guideData.now.desc].filter(Boolean).join('\n');
          nowText.setAttribute('data-fulltext', nowFullText);
          nowText.title = nowFullText;

          nowDiv.appendChild(nowLabel);
          nowDiv.appendChild(nowText);
          guide.appendChild(nowDiv);
        }

        if (guideData.next) {
          const nextDiv = document.createElement('div');
          nextDiv.className = 'guide-next';

          const nextLabel = document.createElement('span');
          nextLabel.className = 'guide-label';
          nextLabel.textContent = 'Next';

          const nextText = document.createElement('span');
          nextText.className = 'guide-text';
          nextText.textContent = guideData.next.title;
          const nextFullText = [guideData.next.title, guideData.next.desc].filter(Boolean).join('\n');
          nextText.setAttribute('data-fulltext', nextFullText);
          nextText.title = nextFullText;

          nextDiv.appendChild(nextLabel);
          nextDiv.appendChild(nextText);
          guide.appendChild(nextDiv);
        }

        details.appendChild(guide);
      }
    }

    const info = document.createElement('div');
    info.className = 'channel-info';
    info.appendChild(number);
    info.appendChild(details);

    const actions = document.createElement('div');
    actions.className = 'channel-actions';

    const channelKey = `${channel.GuideNumber}|${channel.GuideName}|${channel.URL}`;
    const isFavorite = options.favoriteChannelIds?.has(channelKey) ?? false;

    const favoriteBtn = document.createElement('button');
    favoriteBtn.type = 'button';
    favoriteBtn.className = `channel-action-btn ${isFavorite ? 'active' : ''}`;
    favoriteBtn.textContent = isFavorite ? '★' : '☆';
    favoriteBtn.title = isFavorite ? 'Remove favorite' : 'Add favorite';
    favoriteBtn.setAttribute('aria-label', favoriteBtn.title);
    favoriteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onToggleFavorite?.(channel);
    });

    actions.appendChild(favoriteBtn);
    info.appendChild(actions);

    if (channel.HD) {
      const badge = document.createElement('span');
      badge.className = 'channel-hd';
      badge.textContent = 'HD';
      info.appendChild(badge);
    } else if (isRadio(channel)) {
      const badge = document.createElement('span');
      badge.className = 'channel-radio';
      badge.textContent = 'RADIO';
      info.appendChild(badge);
    }

    item.appendChild(info);

    item.addEventListener('click', () => {
      document.querySelector('.channel-item.active')?.classList.remove('active');
      item.classList.add('active');
      onSelect(channel);
    });

    list.appendChild(item);
  }

  container.appendChild(list);
}

export function setChannelListError(container: HTMLElement, message: string): void {
  container.innerHTML = '';
  const msg = document.createElement('p');
  msg.className = 'channel-error';
  msg.textContent = message; // textContent, never innerHTML
  container.appendChild(msg);
}
