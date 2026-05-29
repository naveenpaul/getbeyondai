import { describe, expect, it } from 'vitest';
import {
  buildContentDrafterUserPrompt,
  CONTENT_DRAFTER_SYSTEM_PROMPT,
} from './content-drafter.prompts';

/**
 * Unit tests for the Content Drafter prompt builder. Locks in the
 * conditional branches (brief id present vs absent, angle present vs
 * empty) so a careless edit to the wording can't silently strip the
 * tool-call guidance.
 */

describe('CONTENT_DRAFTER_SYSTEM_PROMPT', () => {
  it('declares the cite-or-abstain invariant', () => {
    expect(CONTENT_DRAFTER_SYSTEM_PROMPT).toMatch(/Citation rules/);
    expect(CONTENT_DRAFTER_SYSTEM_PROMPT).toMatch(/abstained/);
  });

  it('locks the post shape to body + optional hashtags', () => {
    expect(CONTENT_DRAFTER_SYSTEM_PROMPT).toMatch(/"body"/);
    expect(CONTENT_DRAFTER_SYSTEM_PROMPT).toMatch(/"hashtags"/);
  });

  it('ends by directing one emit_draft with type=linkedin_post', () => {
    expect(CONTENT_DRAFTER_SYSTEM_PROMPT).toMatch(
      /emit_draft.+linkedin_post/s,
    );
  });
});

describe('buildContentDrafterUserPrompt', () => {
  it('asks the agent to start with get_voice when no brief is provided', () => {
    const prompt = buildContentDrafterUserPrompt({
      channel: 'linkedin_post',
      topic: 'shipping our changelog every Friday',
    });
    expect(prompt).toContain('Topic: shipping our changelog every Friday');
    expect(prompt).toContain('get_voice');
    expect(prompt).not.toContain('Prior research brief');
    expect(prompt).not.toContain("Founder's angle");
  });

  it('asks the agent to load both voice + brief when briefDraftId is provided', () => {
    const prompt = buildContentDrafterUserPrompt({
      channel: 'linkedin_post',
      topic: 'why we open-sourced',
      briefDraftId: 'brief-123',
    });
    expect(prompt).toContain('Prior research brief id: brief-123');
    expect(prompt).toContain('get_voice');
    expect(prompt).toContain('get_research_brief');
  });

  it('includes the founder angle when non-empty', () => {
    const prompt = buildContentDrafterUserPrompt({
      channel: 'linkedin_post',
      topic: 'the launch',
      angle: 'pitch the case study',
    });
    expect(prompt).toContain("Founder's angle: pitch the case study");
  });

  it('skips the angle line for a blank-string angle', () => {
    const prompt = buildContentDrafterUserPrompt({
      channel: 'linkedin_post',
      topic: 'the launch',
      angle: '   ',
    });
    expect(prompt).not.toContain("Founder's angle");
  });

  it('treats null briefDraftId the same as omitting it', () => {
    const prompt = buildContentDrafterUserPrompt({
      channel: 'linkedin_post',
      topic: 't',
      briefDraftId: null,
      angle: null,
    });
    expect(prompt).not.toContain('Prior research brief');
    expect(prompt).not.toContain("Founder's angle");
  });
});
