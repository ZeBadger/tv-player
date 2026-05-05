import { describe, it, expect, vi, afterEach } from 'vitest';
import { isRadio, streamUrl, fetchChannels } from '../src/hdhomerun';
import type { Channel } from '../src/hdhomerun';

const tvHd: Channel = {
  GuideNumber: '101',
  GuideName: 'BBC ONE HD',
  URL: 'http://192.168.0.49:5004/auto/v101',
  HD: true,
  VideoCodec: 'H264',
  AudioCodec: 'AAC',
};

const tvSd: Channel = {
  GuideNumber: '1',
  GuideName: 'BBC ONE',
  URL: 'http://192.168.0.49:5004/auto/v1',
  HD: false,
  VideoCodec: 'MPEG2',
  AudioCodec: 'AC3',
};

const radio: Channel = {
  GuideNumber: '700',
  GuideName: 'BBC Radio 1',
  URL: 'http://192.168.0.49:5004/auto/v700',
  HD: false,
  AudioCodec: 'MPEG',
  // VideoCodec absent — this is what marks it as radio
};

describe('isRadio', () => {
  it('returns true for a channel with AudioCodec and no VideoCodec', () => {
    expect(isRadio(radio)).toBe(true);
  });

  it('returns false for an HD TV channel', () => {
    expect(isRadio(tvHd)).toBe(false);
  });

  it('returns false for an SD TV channel', () => {
    expect(isRadio(tvSd)).toBe(false);
  });

  it('returns false when both AudioCodec and VideoCodec are present', () => {
    expect(isRadio({ ...radio, VideoCodec: 'H264' })).toBe(false);
  });

  it('returns false when neither codec is present', () => {
    expect(isRadio({ GuideNumber: '0', GuideName: 'Empty', URL: 'http://device/auto/v0' })).toBe(false);
  });
});

describe('streamUrl', () => {
  it('returns the radio path for a radio channel', () => {
    expect(streamUrl(radio)).toBe('/hdhomerun-radio/auto/v700');
  });

  it('returns the passthrough path for an HD TV channel', () => {
    expect(streamUrl(tvHd)).toBe('/hdhomerun-stream/auto/v101');
  });

  it('returns the transcode path for an SD TV channel', () => {
    expect(streamUrl(tvSd)).toBe('/hdhomerun-transcode/auto/v1');
  });

  it('returns the transcode path when forceTranscode is set on an HD channel', () => {
    expect(streamUrl(tvHd, { forceTranscode: true })).toBe('/hdhomerun-transcode/auto/v101');
  });

  it('appends captions=burn for SD transcode when captionsMode is burn', () => {
    const url = streamUrl(tvSd, { captionsMode: 'burn' });
    expect(url).toContain('/hdhomerun-transcode/auto/v1');
    expect(url).toContain('captions=burn');
  });

  it('appends captions=burn for forceTranscode HD when captionsMode is burn', () => {
    const url = streamUrl(tvHd, { forceTranscode: true, captionsMode: 'burn' });
    expect(url).toContain('/hdhomerun-transcode/auto/v101');
    expect(url).toContain('captions=burn');
  });

  it('does not append captions query for radio channels', () => {
    const url = streamUrl(radio, { captionsMode: 'burn' });
    expect(url).not.toContain('captions');
  });

  it('does not append captions query for HD passthrough', () => {
    const url = streamUrl(tvHd, { captionsMode: 'burn' });
    expect(url).not.toContain('captions');
  });

  it('preserves query string parameters from the device URL', () => {
    const ch: Channel = { ...tvSd, URL: 'http://192.168.0.49:5004/auto/v1?transcode=mobile' };
    const url = streamUrl(ch);
    expect(url).toContain('transcode=mobile');
  });
});

describe('fetchChannels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a parsed channel array on success', async () => {
    const mockData = [
      { GuideNumber: '101', GuideName: 'BBC ONE HD', URL: 'http://device:5004/auto/v101', HD: 1, VideoCodec: 'H264', AudioCodec: 'AAC' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    }));

    const channels = await fetchChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].GuideName).toBe('BBC ONE HD');
    expect(channels[0].HD).toBe(true);
    expect(channels[0].VideoCodec).toBe('H264');
  });

  it('normalises HD field to a boolean', async () => {
    const mockData = [
      { GuideNumber: '1', GuideName: 'BBC ONE', URL: 'http://device:5004/auto/v1', HD: 0 },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    }));

    const channels = await fetchChannels();
    expect(channels[0].HD).toBe(false);
  });

  it('omits VideoCodec and AudioCodec when absent', async () => {
    const mockData = [
      { GuideNumber: '700', GuideName: 'BBC Radio 1', URL: 'http://device:5004/auto/v700', AudioCodec: 'MPEG' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    }));

    const channels = await fetchChannels();
    expect(channels[0].VideoCodec).toBeUndefined();
    expect(channels[0].AudioCodec).toBe('MPEG');
  });

  it('throws when the server returns a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }));
    await expect(fetchChannels()).rejects.toThrow('503');
  });

  it('throws when the response is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ error: 'not an array' }),
    }));
    await expect(fetchChannels()).rejects.toThrow('Unexpected');
  });

  it('skips malformed entries and returns valid ones', async () => {
    const mockData = [
      { GuideNumber: '1', GuideName: 'BBC ONE', URL: 'http://device:5004/auto/v1' },
      null,
      'invalid',
      42,
      { GuideNumber: '2', GuideName: 'BBC TWO', URL: 'http://device:5004/auto/v2' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    }));

    const channels = await fetchChannels();
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.GuideNumber)).toEqual(['1', '2']);
  });
});
