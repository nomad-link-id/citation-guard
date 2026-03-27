import { describe, it, expect } from 'vitest';
import { CitationGuard } from '../index.js';

function makeGuard(mode: 'strip' | 'flag' | 'strict' = 'strip') {
  return new CitationGuard({ mode, citationFormat: 'numeric' });
}

// ─── extractCitations (via verify) ────────────────────────────────────────────

describe('extractCitations', () => {
  it('extracts numeric citations from text', () => {
    const guard = makeGuard();
    const result = guard.verify('[1] text [2] more', [
      { id: '1', content: 'doc1' },
      { id: '2', content: 'doc2' },
    ]);

    expect(result.stats.total).toBe(2);
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].marker).toBe('[1]');
    expect(result.citations[1].marker).toBe('[2]');
  });

  it('returns total=0 for response without citations', () => {
    const guard = makeGuard();
    const result = guard.verify('No citations here at all.', [
      { id: '1', content: 'doc1' },
    ]);

    expect(result.stats.total).toBe(0);
    expect(result.stats.verified).toBe(0);
    expect(result.stats.removed).toBe(0);
    expect(result.stats.hallucinationRate).toBe(0);
    expect(result.cleanResponse).toBe('No citations here at all.');
  });
});

// ─── verifyIds (phantom detection) ────────────────────────────────────────────

describe('verifyIds', () => {
  it('detects phantom citation when doc ID does not exist', () => {
    const guard = makeGuard();
    const result = guard.verify('See reference [5] for details.', [
      { id: '1', content: 'doc1' },
      { id: '2', content: 'doc2' },
      { id: '3', content: 'doc3' },
    ]);

    expect(result.stats.total).toBe(1);
    expect(result.stats.verified).toBe(0);
    expect(result.stats.removed).toBe(1);
    expect(result.citations[0].verified).toBe(false);
    expect(result.citations[0].documentId).toBe('5');
  });

  it('verifies citations that match retrieved doc IDs', () => {
    const guard = makeGuard();
    const result = guard.verify('According to [1] and [2].', [
      { id: '1', content: 'First document' },
      { id: '2', content: 'Second document' },
    ]);

    expect(result.stats.verified).toBe(2);
    expect(result.stats.removed).toBe(0);
    expect(result.citations.every(c => c.verified)).toBe(true);
  });
});

// ─── stripPhantomCitations ────────────────────────────────────────────────────

describe('stripPhantomCitations', () => {
  it('removes phantom citations and keeps verified ones', () => {
    const guard = makeGuard('strip');
    const result = guard.verify(
      'Guideline [1] recommends X. Study [2] confirms. Unknown [5] disagrees.',
      [
        { id: '1', content: 'guideline content' },
        { id: '2', content: 'study content' },
      ]
    );

    expect(result.cleanResponse).toContain('[1]');
    expect(result.cleanResponse).toContain('[2]');
    expect(result.cleanResponse).not.toContain('[5]');
    expect(result.stats.verified).toBe(2);
    expect(result.stats.removed).toBe(1);
  });

  it('calculates correct hallucination rate', () => {
    const guard = makeGuard('strip');
    const result = guard.verify('A [1] B [2] C [3] D [4]', [
      { id: '1', content: 'doc' },
      { id: '2', content: 'doc' },
    ]);

    expect(result.stats.total).toBe(4);
    expect(result.stats.verified).toBe(2);
    expect(result.stats.removed).toBe(2);
    expect(result.stats.hallucinationRate).toBe(0.5);
  });
});

// ─── Duplicate citations ──────────────────────────────────────────────────────

describe('duplicate citations', () => {
  it('handles duplicate citation markers [1][1][2]', () => {
    const guard = makeGuard();
    const result = guard.verify('First [1] then again [1] and also [2].', [
      { id: '1', content: 'doc1' },
      { id: '2', content: 'doc2' },
    ]);

    expect(result.stats.total).toBe(3);
    expect(result.stats.verified).toBe(3);
    expect(result.stats.removed).toBe(0);
    expect(result.cleanResponse).toContain('[1]');
    expect(result.cleanResponse).toContain('[2]');
  });
});

// ─── Strict mode ──────────────────────────────────────────────────────────────

describe('strict mode', () => {
  it('rejects entire response when any phantom citation exists', () => {
    const guard = makeGuard('strict');
    const result = guard.verify('Valid [1] but fake [9].', [
      { id: '1', content: 'doc' },
    ]);

    expect(result.cleanResponse).toBe('');
    expect(result.stats.removed).toBeGreaterThan(0);
  });

  it('passes response through when all citations are valid', () => {
    const guard = makeGuard('strict');
    const result = guard.verify('All valid [1] and [2].', [
      { id: '1', content: 'doc1' },
      { id: '2', content: 'doc2' },
    ]);

    expect(result.cleanResponse).toContain('[1]');
    expect(result.cleanResponse).toContain('[2]');
    expect(result.stats.removed).toBe(0);
  });
});

// ─── Flag mode ────────────────────────────────────────────────────────────────

describe('flag mode', () => {
  it('marks unverified citations instead of removing them', () => {
    const guard = makeGuard('flag');
    const result = guard.verify('Source [1] and fake [3].', [
      { id: '1', content: 'doc' },
    ]);

    expect(result.cleanResponse).toContain('[1]');
    expect(result.cleanResponse).toContain('unverified');
    expect(result.stats.removed).toBe(1);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles adjacent citation markers [1][2][3]', () => {
    const guard = makeGuard();
    const result = guard.verify('Evidence [1][2][3] supports this.', [
      { id: '1', content: 'doc1' },
      { id: '2', content: 'doc2' },
      { id: '3', content: 'doc3' },
    ]);

    expect(result.stats.total).toBe(3);
    expect(result.stats.verified).toBe(3);
    expect(result.cleanResponse).toContain('[1]');
    expect(result.cleanResponse).toContain('[2]');
    expect(result.cleanResponse).toContain('[3]');
  });

  it('handles multi-digit citation markers [10][12]', () => {
    const guard = makeGuard();
    const docs = Array.from({ length: 12 }, (_, i) => ({
      id: `${i + 1}`,
      content: `doc ${i + 1}`,
    }));

    const result = guard.verify('See [10] and [12] for details.', docs);

    expect(result.stats.total).toBe(2);
    expect(result.stats.verified).toBe(2);
  });

  it('preserves sentence punctuation when stripping citations', () => {
    const guard = makeGuard();
    const result = guard.verify('Treatment is effective [5].', [
      { id: '1', content: 'doc' },
    ]);

    // Should not leave a space before the period
    expect(result.cleanResponse).toBe('Treatment is effective.');
  });
});
