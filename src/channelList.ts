import type { Channel } from './hdhomerun';
import { isRadio } from './hdhomerun';

export function renderChannelList(
  container: HTMLElement,
  channels: Channel[],
  onSelect: (channel: Channel) => void,
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

    if (channel.HD) {
      const badge = document.createElement('span');
      badge.className = 'channel-hd';
      badge.textContent = 'HD';
      item.appendChild(number);
      item.appendChild(name);
      item.appendChild(badge);
    } else if (isRadio(channel)) {
      const badge = document.createElement('span');
      badge.className = 'channel-radio';
      badge.textContent = 'RADIO';
      item.appendChild(number);
      item.appendChild(name);
      item.appendChild(badge);
    } else {
      item.appendChild(number);
      item.appendChild(name);
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
