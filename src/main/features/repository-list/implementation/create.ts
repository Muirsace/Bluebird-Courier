import type { RepositoryListService } from '../contract';
import { createRepositoryListService, type RepositoryListDependencies } from './service';

export function createRepositoryList(dependencies: RepositoryListDependencies): RepositoryListService {
  return createRepositoryListService(dependencies);
}
