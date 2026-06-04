import { describe, expect, it } from 'vitest';
import { SaveSourcingSettingsRequestSchema } from './sourcing-settings.dto';

describe('SaveSourcingSettingsRequestSchema', () => {
  it('accepts a valid priority + threshold', () => {
    const parsed = SaveSourcingSettingsRequestSchema.safeParse({
      priority: ['zoominfo', 'snov'],
      threshold: 'verified',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty priority (no contact sourcing)', () => {
    const parsed = SaveSourcingSettingsRequestSchema.safeParse({
      priority: [],
      threshold: 'any',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-enrichment connector in the priority', () => {
    const parsed = SaveSourcingSettingsRequestSchema.safeParse({
      priority: ['apollo'],
      threshold: 'verified',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate connectors in the priority', () => {
    const parsed = SaveSourcingSettingsRequestSchema.safeParse({
      priority: ['snov', 'snov'],
      threshold: 'verified',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown threshold', () => {
    const parsed = SaveSourcingSettingsRequestSchema.safeParse({
      priority: ['snov'],
      threshold: 'best-effort',
    });
    expect(parsed.success).toBe(false);
  });
});
