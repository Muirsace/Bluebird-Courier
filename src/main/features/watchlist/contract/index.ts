import type {
  Detail,
  DetailValues,
  FetchedGlance,
  Glance,
  GlanceValues,
  RepoInputResult,
} from '../../../../domain/types';

/** The watchlist feature's small caller-facing interface. */
export interface WatchlistFeature {
  inspectInput(input: unknown): RepoInputResult;
  list(): Glance[];
  findById(id: number): Glance | null;
  findByFullName(fullName: string): Glance | null;
  add(values: FetchedGlance): Glance;
  remove(id: unknown): void;
  applyGlance(id: number, values: GlanceValues): Glance;
  applyDetail(id: number, values: DetailValues): Detail;
}

export type {
  Detail,
  DetailValues,
  FetchedGlance,
  Glance,
  GlanceValues,
  RepoInputResult,
};
