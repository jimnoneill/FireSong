import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NavInputContext,
  type NavAction,
  type NavInputContextValue,
} from '@/app/providers/nav-input-context';
import type { RevealSounds } from '@/features/noraebang/audio/reveal-synth';
import { NoraebangScoreReveal } from '@/features/noraebang/components/noraebang-score-reveal';
import { buildRevealEntries, type RevealResult } from '@/features/noraebang/reveal-entries';
import { DEFAULT_REVEAL_TIMING } from '@/features/noraebang/reveal-stages';
import { setLanguage } from '@/i18n';

declare global {
  // React reads this flag to allow act() outside a test renderer.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const { firstRollMs, nextRollMs, holdMs, perfectHoldMs } = DEFAULT_REVEAL_TIMING;

function fakeSounds() {
  return {
    drumRoll: vi.fn<RevealSounds['drumRoll']>(),
    slam: vi.fn<RevealSounds['slam']>(),
    celebrate: vi.fn<RevealSounds['celebrate']>(),
    stop: vi.fn<RevealSounds['stop']>(),
  } satisfies RevealSounds;
}

type NavFire = (action: Partial<NavAction>) => void;

function navHarness(): { value: NavInputContextValue; fire: NavFire } {
  const subscribers = new Set<(action: NavAction) => void>();
  return {
    value: {
      subscribe: (fn) => {
        subscribers.add(fn);
        return () => {
          subscribers.delete(fn);
        };
      },
    },
    fire: (partial) => {
      const action = {
        up: false,
        down: false,
        left: false,
        right: false,
        confirm: false,
        back: false,
        ...partial,
      };
      for (const fn of subscribers) {
        fn(action);
      }
    },
  };
}

const result = (id: string, score: number, voicedRatio: number): RevealResult => ({
  id,
  profile: id,
  color: 'rose',
  score,
  voicedRatio,
});

const entriesFor = (results: RevealResult[], slots: Record<string, number> = {}) =>
  buildRevealEntries({
    songHash: 'song-hash',
    results,
    players: results.map(({ id }) => ({ id, microphoneId: `remote:${id}` })),
    nameFor: ({ id }) => id,
    slotFor: (microphoneId) => slots[microphoneId.replace('remote:', '')] ?? null,
  });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setLanguage('en');
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const textOf = (id: string) => byTestId(id)?.textContent ?? null;
const announcement = () => container.querySelector('output')?.textContent ?? '';

describe('NoraebangScoreReveal', () => {
  it('rolls the drum, slams the score with its tier caption, then shows the actions', () => {
    const sounds = fakeSounds();
    const onRevealed = vi.fn();
    const entries = entriesFor([result('Mina', 380, 0.85)]);
    const shown = entries[0].score;
    expect(shown.tier).toBe('excellent');

    render(
      <NoraebangScoreReveal
        title="Sunset Song"
        artist="The Originals"
        entries={entries}
        sounds={sounds}
        koreanCaptions
        onRevealed={onRevealed}
      >
        <button type="button">Next song</button>
      </NoraebangScoreReveal>,
    );

    expect(
      container.querySelector('dialog[aria-labelledby="noraebang-reveal-title"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Sunset Song');
    expect(sounds.drumRoll).toHaveBeenCalledExactlyOnceWith(firstRollMs / 1000);
    expect(byTestId('rolling-score')).not.toBeNull();
    expect(byTestId('final-score')).toBeNull();
    expect(announcement()).toBe('Counting the score…');
    expect(container.querySelector('button')).toBeNull();

    // The digits roll while the drum rolls.
    const before = textOf('rolling-score');
    const rolled = new Set<string | null>();
    for (let tick = 0; tick < 10; tick++) {
      advance(DEFAULT_REVEAL_TIMING.tickMs);
      rolled.add(textOf('rolling-score'));
    }
    expect(rolled.size).toBeGreaterThan(1);
    expect(before).toMatch(/^\d\d$/);

    advance(firstRollMs - 10 * DEFAULT_REVEAL_TIMING.tickMs);
    expect(sounds.slam).toHaveBeenCalledOnce();
    expect(sounds.celebrate).toHaveBeenCalledExactlyOnceWith('excellent');
    expect(byTestId('rolling-score')).toBeNull();
    expect(textOf('final-score')).toBe(String(shown.displayScore));
    const caption = textOf('tier-caption');
    expect(caption).toContain('훌륭해요!');
    expect(caption).toContain('Excellent!');
    expect(announcement()).toBe(`Mina: ${shown.displayScore} points, Excellent!`);
    expect(onRevealed).not.toHaveBeenCalled();
    expect(container.querySelector('button')).toBeNull();

    advance(holdMs);
    expect(onRevealed).toHaveBeenCalledOnce();
    expect(container.querySelector('button')?.textContent).toBe('Next song');
    expect(textOf('final-score')).toBe(String(shown.displayScore));

    // Nothing else is scheduled once the reveal is done.
    advance(60_000);
    expect(sounds.drumRoll).toHaveBeenCalledOnce();
    expect(onRevealed).toHaveBeenCalledOnce();
  });

  it('reveals singers in slot order, celebrates a 100 with fireworks, then ranks everyone', () => {
    const sounds = fakeSounds();
    const onRevealed = vi.fn();
    // Slot 1 sings worse than slot 2; slot 2 scores 100.
    const entries = entriesFor([result('Jun', 900, 0.95), result('Ara', 260, 0.7)], {
      Ara: 1,
      Jun: 2,
    });
    expect(entries.map(({ name }) => name)).toEqual(['Ara', 'Jun']);
    expect(entries.map(({ score }) => score.tier)).toEqual(['great', 'perfect']);
    expect(entries.map(({ rank }) => rank)).toEqual([2, 1]);

    render(
      <NoraebangScoreReveal
        title="Duet"
        artist="Two Voices"
        entries={entries}
        sounds={sounds}
        koreanCaptions
        onRevealed={onRevealed}
      />,
    );

    expect(container.textContent).toContain('Ara');
    advance(firstRollMs);
    expect(sounds.celebrate).toHaveBeenLastCalledWith('great');
    expect(container.querySelector('canvas')).toBeNull();

    advance(holdMs);
    expect(sounds.drumRoll).toHaveBeenLastCalledWith(nextRollMs / 1000);
    expect(container.textContent).toContain('Jun');
    advance(nextRollMs);
    expect(sounds.celebrate).toHaveBeenLastCalledWith('perfect');
    expect(byTestId('final-score')?.textContent).toBe('100');
    expect(container.textContent).toContain('완벽해요!');
    expect(container.querySelector('canvas')).not.toBeNull();

    advance(perfectHoldMs - 1);
    expect(onRevealed).not.toHaveBeenCalled();
    advance(1);
    expect(onRevealed).toHaveBeenCalledOnce();

    const rows = [...(byTestId('ranked-scores')?.querySelectorAll('li') ?? [])];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^#1Jun100완벽해요!Perfect!$/),
      expect.stringMatching(/^#2Ara\d+잘했어요!Well done!$/),
    ]);
    expect(announcement()).toContain('Jun: 100 points, Perfect!');
    expect(announcement()).toContain('Ara:');
  });

  it('skips to the end on OK and silences the drum roll', () => {
    const sounds = fakeSounds();
    const onRevealed = vi.fn();
    const nav = navHarness();
    const entries = entriesFor([result('Mina', 50, 0.4), result('Jun', 500, 0.9)]);

    render(
      <NavInputContext.Provider value={nav.value}>
        <NoraebangScoreReveal
          title="Skip me"
          artist="Anyone"
          entries={entries}
          sounds={sounds}
          koreanCaptions
          onRevealed={onRevealed}
        >
          <button type="button">Back to library</button>
        </NoraebangScoreReveal>
      </NavInputContext.Provider>,
    );
    advance(500);
    act(() => nav.fire({ confirm: true }));

    expect(sounds.stop).toHaveBeenCalledOnce();
    expect(onRevealed).toHaveBeenCalledOnce();
    expect(byTestId('ranked-scores')?.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('button')?.textContent).toBe('Back to library');

    // Later presses belong to the result actions, not the reveal.
    act(() => nav.fire({ back: true }));
    advance(10_000);
    expect(sounds.stop).toHaveBeenCalledOnce();
    expect(sounds.slam).not.toHaveBeenCalled();
    expect(onRevealed).toHaveBeenCalledOnce();
  });

  it('shows only the gloss when Korean captions are off', () => {
    const entries = entriesFor([result('Mina', 30, 0.05)]);
    expect(entries[0].score).toMatchObject({ displayScore: 3, tier: 'retry' });

    render(
      <NoraebangScoreReveal
        title="Quiet"
        artist="Nobody"
        entries={entries}
        sounds={fakeSounds()}
        koreanCaptions={false}
        onRevealed={() => {}}
      />,
    );
    advance(firstRollMs);

    const caption = byTestId('tier-caption')?.textContent ?? '';
    expect(caption).toBe('Try again!');
    expect(container.textContent).not.toContain('다시 도전!');
  });

  it('stops its timers and sounds when it unmounts mid-reveal', () => {
    const sounds = fakeSounds();
    render(
      <NoraebangScoreReveal
        title="Gone"
        artist="Away"
        entries={entriesFor([result('Mina', 400, 0.8)])}
        sounds={sounds}
        koreanCaptions
        onRevealed={() => {}}
      />,
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});
