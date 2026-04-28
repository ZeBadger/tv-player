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

export function renderChannelList(
  container: HTMLElement,
  channels: Channel[],
  onSelect: (channel: Channel) => void,
  nowNextData?: NowNextData,
): void {
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
    item.className = 'channel-item';
    item.dataset['number'] = channel.GuideNumber;

    const number = document.createElement('span');
    number.className = 'channel-number';
    number.textContent = channel.GuideNumber;

    const name = document.createElement('span');
    name.className = 'channel-name';
    name.textContent = channel.GuideName; // textContent, never innerHTML

    const info = document.createElement('div');
    info.className = 'channel-info';
    info.appendChild(number);
    info.appendChild(name);

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

    // Add now/next guide snippet if available
    if (nowNextData && nowNextData[channel.URL]) {
      const guideData = nowNextData[channel.URL];
      if (guideData.now || guideData.next) {
        const guide = document.createElement('div');
        guide.className = 'channel-guide';
        if (guideData.now) {
          const nowDiv = document.createElement('div');
          nowDiv.className = 'guide-now';

          const nowLabel = document.createElement('span');
          nowLabel.className = 'guide-label';
          nowLabel.textContent = 'Now';

          const nowText = document.createElement('span');
          nowText.className = 'guide-text';
          nowText.textContent = guideData.now.title;
          nowText.setAttribute('data-fulltext', [guideData.now.title, guideData.now.desc].filter(Boolean).join('\n'));

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
          nextText.setAttribute('data-fulltext', [guideData.next.title, guideData.next.desc].filter(Boolean).join('\n'));

          nextDiv.appendChild(nextLabel);
          nextDiv.appendChild(nextText);
          guide.appendChild(nextDiv);
        }
        item.appendChild(guide);
      }
    }

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
