import { describe, expect, it, vi } from 'vitest';
import { LlmAuthError } from '../teammates/runtime/llm-types';

/**
 * KeyVerifier unit test. The provider registry (and the vendor SDKs behind it)
 * are mocked — we assert the verifier builds the provider for the right key and
 * makes a minimal probe call, and that a provider error propagates unchanged.
 */

const { createProvider, createMessage } = vi.hoisted(() => {
  const createMessage = vi.fn(async () => undefined);
  const createProvider = vi.fn(() => ({
    name: 'stub',
    capabilities: { toolUse: true },
    createMessage,
  }));
  return { createProvider, createMessage };
});

vi.mock('../teammates/runtime/providers/registry', () => ({ createProvider }));

import { KeyVerifier } from './key-verifier';

describe('KeyVerifier', () => {
  it('builds the provider for the key and probes with a 1-token call', async () => {
    createProvider.mockClear();
    createMessage.mockClear();

    await new KeyVerifier().verify('openai', 'sk-good');

    expect(createProvider).toHaveBeenCalledWith('openai', 'sk-good');
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 1 }),
    );
  });

  it('propagates the provider error thrown by the probe (e.g. auth)', async () => {
    createMessage.mockRejectedValueOnce(new LlmAuthError('openai'));

    await expect(
      new KeyVerifier().verify('openai', 'sk-bad'),
    ).rejects.toBeInstanceOf(LlmAuthError);
  });
});
