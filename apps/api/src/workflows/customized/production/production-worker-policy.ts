import { customizedConflict } from '../../../platform/workflow/customized-branches';

export type ProductionWorkerNode = 'ASSETS' | 'VIDEO';

export function productionQueue(operation: string) {
  if (!['ASSETS', 'SHOTS', 'PROMPT'].includes(operation))
    return customizedConflict('未知制作任务类型');
  return operation === 'ASSETS' ? 'customized.assets.requested' : 'customized.production.requested';
}

export function workerNodeForPath(path: string): ProductionWorkerNode | undefined {
  const match = path.match(/(?:^|\/)internal\/workers\/customized-(assets|production)(?:\/|$)/);
  return match?.[1] === 'assets' ? 'ASSETS' : match?.[1] === 'production' ? 'VIDEO' : undefined;
}

export function assertWorkerOperation(operation: string, node?: ProductionWorkerNode) {
  productionQueue(operation);
  if (node && (operation === 'ASSETS') !== (node === 'ASSETS'))
    return customizedConflict('任务不属于此节点 Worker');
}
