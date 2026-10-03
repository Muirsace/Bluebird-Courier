import type { RepositoryDetailService } from '../contract';
import { createRepositoryDetailService, type RepositoryDetailDependencies } from './service';

export function createRepositoryDetail(dependencies: RepositoryDetailDependencies): RepositoryDetailService {
  return createRepositoryDetailService(dependencies);
}
