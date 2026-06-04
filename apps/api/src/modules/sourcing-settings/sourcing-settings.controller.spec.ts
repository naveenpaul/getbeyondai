import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import type { SourcingSettingsResponse } from '@getbeyond/shared';
import { SourcingSettingsController } from './sourcing-settings.controller';
import type { SourcingSettingsService } from './sourcing-settings.service';

const USER = { orgId: 'org-1', userId: 'u-1' } as unknown as CurrentUserPayload;

const RESPONSE: SourcingSettingsResponse = {
  priority: ['zoominfo', 'snov'],
  threshold: 'verified',
  defaults: { priority: ['zoominfo', 'snov'], threshold: 'verified' },
};

function makeController(): {
  controller: SourcingSettingsController;
  getSettings: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
} {
  const getSettings = vi.fn(async () => RESPONSE);
  const saveSettings = vi.fn(async () => RESPONSE);
  const service = { getSettings, saveSettings } as unknown as SourcingSettingsService;
  return {
    controller: new SourcingSettingsController(service),
    getSettings,
    saveSettings,
  };
}

describe('SourcingSettingsController', () => {
  it('GET delegates to the service scoped to the session org', async () => {
    const { controller, getSettings } = makeController();
    const result = await controller.get(USER);
    expect(getSettings).toHaveBeenCalledWith('org-1');
    expect(result).toBe(RESPONSE);
  });

  it('PUT validates then delegates a well-formed body', async () => {
    const { controller, saveSettings } = makeController();
    const result = await controller.save(
      { priority: ['snov', 'zoominfo'], threshold: 'any' },
      USER,
    );
    expect(saveSettings).toHaveBeenCalledWith('org-1', {
      priority: ['snov', 'zoominfo'],
      threshold: 'any',
    });
    expect(result).toBe(RESPONSE);
  });

  it('PUT rejects an invalid body with BadRequestException (service untouched)', async () => {
    const { controller, saveSettings } = makeController();
    await expect(
      controller.save({ priority: ['apollo'], threshold: 'verified' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
