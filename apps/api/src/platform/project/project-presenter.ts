import type { AssetWorkflowSpace, Project, ProjectWorkflowSpaces } from '@ai-marketing/contracts';
import type { Project as ProjectRecord } from '../../generated/prisma/client';
import type { ProjectWithAssets } from './project.repository';

const emptySpaces = (): ProjectWorkflowSpaces => ({
  effect: false,
  customized: false,
  fission: { clone: false, avatar: false, localReplace: false },
});
const applySpace = (
  spaces: ProjectWorkflowSpaces,
  space: AssetWorkflowSpace | null | undefined,
): void => {
  if (space === 'EFFECT') spaces.effect = true;
  else if (space === 'CUSTOMIZED_PROJECT' || space === 'CUSTOMIZED_VOICE_LIBRARY')
    spaces.customized = true;
  else if (space === 'FISSION_CLONE') spaces.fission.clone = true;
  else if (space === 'FISSION_AVATAR') spaces.fission.avatar = true;
  else if (space === 'FISSION_LOCAL_REPLACE') spaces.fission.localReplace = true;
};
export const presentProject = (project: ProjectRecord | ProjectWithAssets): Project => {
  const spaces = emptySpaces();
  if ('defaultSpace' in project) applySpace(spaces, project.defaultSpace);
  if ('assets' in project)
    for (const asset of project.assets) applySpace(spaces, asset.workflowSpace);
  const assetCounts =
    'assets' in project
      ? project.assets.reduce<Partial<Record<AssetWorkflowSpace, number>>>(
          (counts, asset) => ({
            ...counts,
            [asset.workflowSpace]: (counts[asset.workflowSpace] ?? 0) + 1,
          }),
          {},
        )
      : undefined;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    client: 'client' in project ? project.client : null,
    productName: 'productName' in project ? project.productName : null,
    iconKey: 'iconKey' in project ? project.iconKey : null,
    workflowSpaces: spaces,
    ...(assetCounts ? { assetCounts } : {}),
    ...(project.deletionState
      ? {
          deletion: {
            status: project.deletionState as 'QUEUED' | 'RUNNING' | 'FAILED',
            phase: 'DATABASE' as const,
            ...(project.deletionError ? { message: project.deletionError } : {}),
          },
        }
      : {}),
  };
};
