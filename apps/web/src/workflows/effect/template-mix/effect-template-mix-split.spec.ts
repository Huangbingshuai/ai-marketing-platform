import { describe, expect, it } from 'vitest';

import { splitRangeAtPlayhead } from './effect-template-mix-split';

describe('splitRangeAtPlayhead', () => {
  it('splits at the nearest frame and keeps both pieces non-empty', () => {
    expect(splitRangeAtPlayhead(2, 4, 3.01, 30)).toEqual({
      at: 3,
      leftDuration: 1,
      rightDuration: 3,
    });
  });

  it.each([0, 2, 6, 6.1])(
    'does not split when the playhead is at or outside the clip (%s)',
    (at) => {
      expect(splitRangeAtPlayhead(2, 4, at, 30)).toBeNull();
    },
  );

  it('does not create a sub-frame sliver at a rounded edge', () => {
    expect(splitRangeAtPlayhead(2, 4, 2.001, 30)).toBeNull();
    expect(splitRangeAtPlayhead(2, 4, 5.999, 30)).toBeNull();
  });
});
