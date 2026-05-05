import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted to the top of the file, so any variables used inside the
// factory must also be hoisted via vi.hoisted.
const mockPlayerInstance = vi.hoisted(() => ({
  on: vi.fn(),
  attachMediaElement: vi.fn(),
  load: vi.fn(),
  play: vi.fn().mockReturnValue(undefined),
  destroy: vi.fn(),
}));

vi.mock('mpegts.js', () => ({
  default: {
    isSupported: vi.fn().mockReturnValue(true),
    createPlayer: vi.fn().mockReturnValue(mockPlayerInstance),
    Events: { ERROR: 'error' },
  },
}));

// Import after mocks are in place.
import mpegts from 'mpegts.js';
import { playStream, destroyPlayer, initPlayer } from '../src/player';

const isSupported = mpegts.isSupported as ReturnType<typeof vi.fn>;
const createPlayer = mpegts.createPlayer as ReturnType<typeof vi.fn>;

function makeVideo(): HTMLVideoElement {
  return {
    src: '',
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLVideoElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  isSupported.mockReturnValue(true);
  createPlayer.mockReturnValue(mockPlayerInstance);
  mockPlayerInstance.play.mockReturnValue(undefined);
});

describe('initPlayer', () => {
  it('does not throw', () => {
    expect(() => initPlayer(makeVideo())).not.toThrow();
  });
});

describe('destroyPlayer', () => {
  it('does not throw when called with no active player', () => {
    expect(() => destroyPlayer()).not.toThrow();
  });

  it('calls destroy() and nulls the player when one is active', () => {
    const video = makeVideo();
    playStream(video, 'http://device:5004/auto/v1');
    expect(mockPlayerInstance.destroy).not.toHaveBeenCalled();

    destroyPlayer();
    expect(mockPlayerInstance.destroy).toHaveBeenCalledTimes(1);

    // Calling again must be safe (player is now null).
    expect(() => destroyPlayer()).not.toThrow();
  });
});

describe('playStream', () => {
  it('creates an mpegts player and attaches it to the video element', () => {
    const video = makeVideo();
    playStream(video, 'http://device:5004/auto/v1');

    expect(createPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mpegts', isLive: true }),
      expect.any(Object),
    );
    expect(mockPlayerInstance.attachMediaElement).toHaveBeenCalledWith(video);
    expect(mockPlayerInstance.load).toHaveBeenCalled();
    expect(mockPlayerInstance.play).toHaveBeenCalled();
  });

  it('destroys the previous player before starting a new stream', () => {
    const video = makeVideo();
    playStream(video, 'http://device:5004/auto/v1');
    vi.clearAllMocks();
    createPlayer.mockReturnValue(mockPlayerInstance);

    playStream(video, 'http://device:5004/auto/v2');

    expect(mockPlayerInstance.destroy).toHaveBeenCalledTimes(1);
    expect(createPlayer).toHaveBeenCalledTimes(1);
  });

  it('uses native video src for HLS (.m3u8) streams and skips mpegts', () => {
    const video = makeVideo();
    playStream(video, 'http://device/stream.m3u8');

    expect(video.src).toBe('http://device/stream.m3u8');
    expect(createPlayer).not.toHaveBeenCalled();
  });

  it('calls onError when mpegts is not supported', () => {
    isSupported.mockReturnValue(false);
    const onError = vi.fn();

    playStream(makeVideo(), 'http://device:5004/auto/v1', { onError });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('not supported'));
    expect(createPlayer).not.toHaveBeenCalled();
  });

  it('calls onError with an actionable message when mpegts emits ERROR', () => {
    const onError = vi.fn();
    playStream(makeVideo(), 'http://device:5004/auto/v1', { onError });

    // Retrieve the handler registered with player.on('error', handler)
    const errorCall = mockPlayerInstance.on.mock.calls.find(
      ([event]: [string]) => event === (mpegts.Events.ERROR as string),
    );
    expect(errorCall).toBeDefined();
    const [, errorHandler] = errorCall!;

    errorHandler('NetworkError', 'HttpStatusCodeInvalid', {});
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('tuner'));
  });

  it('calls onError for unknown error details with a fallback message', () => {
    const onError = vi.fn();
    playStream(makeVideo(), 'http://device:5004/auto/v1', { onError });

    const errorCall = mockPlayerInstance.on.mock.calls.find(
      ([event]: [string]) => event === (mpegts.Events.ERROR as string),
    );
    const [, errorHandler] = errorCall!;

    errorHandler('MediaError', 'SomeObscureDetail', {});
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('SomeObscureDetail'));
  });

  it('calls onError when play() promise rejects with a non-abort error', async () => {
    const onError = vi.fn();
    const rejectedPlay = Promise.reject(new Error('Fake play failure'));
    mockPlayerInstance.play.mockReturnValue(rejectedPlay);

    playStream(makeVideo(), 'http://device:5004/auto/v1', { onError });

    await rejectedPlay.catch(() => {}); // flush
    // Give microtask queue one more turn
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Fake play failure'));
  });
});
