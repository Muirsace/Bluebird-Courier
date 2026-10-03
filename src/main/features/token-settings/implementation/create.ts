import type { TokenSettingsService } from '../contract';
import { createTokenSettingsService, type TokenSettingsDependencies } from './service';

export function createTokenSettings(dependencies: TokenSettingsDependencies): TokenSettingsService {
  return createTokenSettingsService(dependencies);
}
