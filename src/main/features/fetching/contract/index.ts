import type { DetailValues, FetchedGlance } from '../../../../domain/types';

/** Provider-facing fetch orchestration exposed to the facade. */
export interface FetchingFeature {
  validateAccessToken(token: string): Promise<void>;
  fetchGlance(token: string, fullName: string): Promise<FetchedGlance>;
  fetchDetail(token: string, fullName: string): Promise<DetailValues>;
}

export type { DetailValues, FetchedGlance };
