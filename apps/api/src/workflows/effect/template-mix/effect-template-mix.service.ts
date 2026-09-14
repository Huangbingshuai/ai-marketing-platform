import type {
  EffectTemplateMixDraft,
  EffectTemplateMixMaterial,
  EffectTemplateMixSlot,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspace,
  EffectTemplateMixWorkspaceData,
  ValidateEffectTemplateMixData,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import { ApiHttpException } from '../../../common/api-http-exception';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { WorkingArtifactUpsertInput } from '../../../platform/workflow/workflow-working.repository';
import { applyVariantToTemplate, createVariant, fillVariant } from './effect-template-mix.domain';

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const draftOf = (value: unknown): EffectTemplateMixDraft => {
  const draft = object(value);
  const templates = Array.isArray(draft?.templates) ? draft.templates : null;
  const valid =
    draft?.schemaVersion === 1 &&
    typeof draft.activeTemplateId === 'string' &&
    templates !== null &&
    templates.length <= 50 &&
    new Set(templates.map((entry) => object(entry)?.id)).size === templates.length &&
    templates.every((rawEntry) => {
      const entry = object(rawEntry);
      const workspace = object(entry?.workspace);
      const template = object(workspace?.template);
      return (
        typeof entry?.id === 'string' &&
        entry.id.length > 0 &&
        Number.isInteger(workspace?.editVersion) &&
        typeof template?.name === 'string' &&
        Number.isInteger(template.editVersion) &&
        Array.isArray(template.slots) &&
        Array.isArray(workspace?.variants) &&
        workspace.variants.length <= 100 &&
        workspace.variants.every((rawVariant) => {
          const variant = object(rawVariant);
          return (
            typeof variant?.id === 'string' &&
            Array.isArray(variant.slots) &&
            object(variant.bindings) !== null &&
            object(variant.bindingRevisions) !== null &&
            object(variant.offsets) !== null &&
            Array.isArray(variant.manualSlotIds) &&
            Array.isArray(variant.conflictSlotIds) &&
            Array.isArray(variant.captions)
          );
        })
      );
    });
  if (!valid) {
    throw new ApiHttpException(
      '混剪草稿版本无效，请刷新后重试',
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
    );
  }
  return value as EffectTemplateMixDraft;
};

const emptyDraft = (): EffectTemplateMixDraft => ({
  schemaVersion: 1,
  templates: [],
  activeTemplateId: '',
});

const slotsValid = (slots: EffectTemplateMixSlot[]): boolean =>
  slots.length > 0 &&
  slots.length <= 30 &&
  new Set(slots.map(({ id }) => id)).size === slots.length &&
  slots.every(
    ({ id, label, duration }) =>
      typeof id === 'string' &&
      typeof label === 'string' &&
      label.trim().length > 0 &&
      label.length <= 80 &&
      Number.isFinite(duration) &&
      duration >= 0.1 &&
      duration <= 120,
  );

const payload = (artifact: WorkingArtifact): Record<string, unknown> =>
  object(artifact.payload) ?? {};
const clipDuration = (artifact: WorkingArtifact): number =>
  Number(payload(artifact).durationSeconds ?? 0);
const clipHash = (artifact: WorkingArtifact): string => String(payload(artifact).contentHash ?? '');
const clipSupports = (artifact: WorkingArtifact, purpose: string): boolean => {
  const value = payload(artifact);
  return (
    value.primaryPurpose === purpose ||
    (Array.isArray(value.compatiblePurposes) && value.compatiblePurposes.includes(purpose))
  );
};

const materialPurpose = (value: unknown): EffectTemplateMixMaterial['purpose'] | null => {
  if (
    value === 'HOOK' ||
    value === 'EFFECT' ||
    value === 'PRODUCT_DISPLAY' ||
    value === 'END_CONVERSION'
  ) {
    return value;
  }
  return null;
};

const materialFrom = (artifact: WorkingArtifact): EffectTemplateMixMaterial | null => {
  if (
    artifact.nodeId !== 'SEGMENT_RENDER' ||
    !artifact.artifactKey.startsWith('render-clip:') ||
    artifact.kind !== 'FILE' ||
    !artifact.contentUrl
  ) {
    return null;
  }
  const data = payload(artifact);
  const duration = Number(data.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const primaryPurpose = materialPurpose(data.primaryPurpose);
  if (!primaryPurpose) return null;
  const compatiblePurposes = Array.isArray(data.compatiblePurposes)
    ? [
        ...new Set(
          data.compatiblePurposes
            .map(materialPurpose)
            .filter((item): item is EffectTemplateMixMaterial['purpose'] => Boolean(item)),
        ),
      ]
    : [];
  return {
    id: artifact.id,
    artifactId: artifact.id,
    artifactKey: artifact.artifactKey,
    artifactRevision: artifact.revision,
    fileObjectId: typeof data.fileObjectId === 'string' ? data.fileObjectId : '',
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : '',
    contentUrl: artifact.contentUrl,
    code: typeof data.renderCode === 'string' ? data.renderCode : artifact.name,
    name: artifact.name.replace(/\s+视频片段$/u, ''),
    duration,
    purpose: primaryPurpose,
    compatiblePurposes,
    ratio: typeof data.ratio === 'string' ? data.ratio : '',
    resolution: typeof data.resolution === 'string' ? data.resolution : '',
    available: artifact.availability === 'AVAILABLE' && artifact.freshness === 'CURRENT',
  };
};

@Injectable()
export class EffectTemplateMixService {
  constructor(
    @Inject(WorkflowWorkingService)
    private readonly working: WorkflowWorkingService,
  ) {}

  async workspace(
    projectId: string,
    workflowRunId: string,
  ): Promise<EffectTemplateMixWorkspaceData> {
    const [nodeState, artifactData] = await Promise.all([
      this.working.getNodeStateOrNull(projectId, workflowRunId, 'TEMPLATE_MIX'),
      this.working.listArtifacts(projectId, { workflowRunId }),
    ]);
    return this.toWorkspaceData(
      nodeState ? draftOf(nodeState.state) : emptyDraft(),
      nodeState?.revision ?? null,
      artifactData.items,
    );
  }

  async saveDraft(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number | null,
    value: unknown,
  ): Promise<EffectTemplateMixWorkspaceData> {
    const draft = draftOf(value);
    const result = await this.working.putNodeState(projectId, workflowRunId, 'TEMPLATE_MIX', {
      expectedRevision,
      schemaVersion: 1,
      state: draft,
    });
    const artifacts = await this.working.listArtifacts(projectId, { workflowRunId });
    return this.toWorkspaceData(draft, result.nodeState.revision, artifacts.items);
  }

  async createVariant(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    expectedRevision: number,
  ): Promise<EffectTemplateMixWorkspaceData> {
    return this.mutate(projectId, workflowRunId, expectedRevision, templateId, (workspace) => {
      if (workspace.variants.length >= 100) {
        throw new ApiHttpException(
          '单个模板最多保留 100 个成片工程',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      }
      const variant = createVariant(workspace);
      workspace.variants.push(variant);
      workspace.editVersion += 1;
    });
  }

  async refillVariant(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    variantId: string,
    expectedRevision: number,
  ): Promise<EffectTemplateMixWorkspaceData> {
    return this.mutate(projectId, workflowRunId, expectedRevision, templateId, (workspace) => {
      const variant = workspace.variants.find(({ id }) => id === variantId);
      if (!variant) this.notFound('当前成片工程不存在');
      fillVariant(workspace, variant!);
      workspace.editVersion += 1;
    });
  }

  async applyVariant(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    sourceVariantId: string,
    syncOtherVariants: boolean,
    expectedRevision: number,
  ): Promise<EffectTemplateMixWorkspaceData> {
    return this.mutate(projectId, workflowRunId, expectedRevision, templateId, (workspace) => {
      const variant = workspace.variants.find(({ id }) => id === sourceVariantId);
      if (!variant) this.notFound('当前成片工程不存在');
      applyVariantToTemplate(workspace, variant!, syncOtherVariants);
    });
  }

  async validate(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number,
    templateId: string,
  ): Promise<ValidateEffectTemplateMixData> {
    const nodeState = await this.working.getNodeState(projectId, workflowRunId, 'TEMPLATE_MIX');
    if (nodeState.revision !== expectedRevision) {
      throw new ApiHttpException(
        '混剪草稿已在其他页面更新，请刷新后重试',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    }
    const draft = draftOf(nodeState.state);
    const entry = draft.templates.find(({ id }) => id === templateId);
    if (!entry) {
      throw new ApiHttpException('当前混剪模板不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    }
    const { template, variants } = entry.workspace;
    if (
      !template.name.trim() ||
      template.name.length > 40 ||
      !slotsValid(template.slots) ||
      variants.length < 1 ||
      variants.length > 100
    ) {
      throw new ApiHttpException(
        '请完善模板名称、槽位和成片工程',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    }

    const sourceData = await this.working.listArtifacts(projectId, {
      workflowRunId,
      nodeId: 'SEGMENT_RENDER',
    });
    const sources = new Map(
      sourceData.items
        .filter(({ artifactKey }) => artifactKey.startsWith('render-clip:'))
        .map((artifact) => [artifact.id, artifact]),
    );
    const inputs: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }> = [];
    const allSourceIds = new Set<string>();
    for (const variant of variants) {
      this.validateVariant(variant, sources, allSourceIds);
    }
    const dependenciesFor = (sourceIds: Iterable<string>) =>
      [...sourceIds].map((artifactId) => {
        const source = sources.get(artifactId)!;
        return {
          sourceType: 'WORKING_ARTIFACT' as const,
          sourceNodeId: 'SEGMENT_RENDER',
          sourceArtifactId: source.id,
          sourceKey: source.artifactKey,
          sourceRevision: source.revision,
          sourceHash: clipHash(source),
        };
      });
    inputs.push({
      artifactKey: 'mix-template:' + templateId,
      input: {
        kind: 'STRUCTURED',
        name: template.name,
        directory: 'EDITING_PROJECTS',
        type: 'MIX_TEMPLATE',
        tags: ['效果类', '混剪模板'],
        payload: {
          schemaVersion: 1,
          templateId,
          workspaceVersion: entry.workspace.editVersion,
          template,
        },
        metadata: { templateId, variantCount: variants.length },
        dependencies: dependenciesFor(allSourceIds),
      },
    });
    for (const variant of variants) {
      inputs.push({
        artifactKey: 'timeline-project:' + templateId + ':' + variant.id,
        input: {
          kind: 'STRUCTURED',
          name: variant.name,
          directory: 'EDITING_PROJECTS',
          type: 'TIMELINE_PROJECT',
          tags: ['效果类', '时间轴工程'],
          payload: { schemaVersion: 1, templateId, templateVersion: template.editVersion, variant },
          metadata: {
            templateId,
            variantId: variant.id,
            durationSeconds: variant.slots.reduce((sum, slot) => sum + slot.duration, 0),
          },
          dependencies: dependenciesFor(new Set(Object.values(variant.bindings))),
        },
      });
    }
    const committed = await this.working.commitValidatedArtifacts(
      projectId,
      workflowRunId,
      'TEMPLATE_MIX',
      inputs,
    );
    return {
      artifacts: committed.map(({ artifact, unchanged }) => ({
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        revision: artifact.revision,
        unchanged,
      })),
    };
  }

  private async mutate(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number,
    templateId: string,
    mutation: (workspace: EffectTemplateMixWorkspace) => void,
  ): Promise<EffectTemplateMixWorkspaceData> {
    const [nodeState, artifactData] = await Promise.all([
      this.working.getNodeState(projectId, workflowRunId, 'TEMPLATE_MIX'),
      this.working.listArtifacts(projectId, { workflowRunId }),
    ]);
    if (nodeState.revision !== expectedRevision) {
      throw new ApiHttpException(
        '混剪草稿已在其他页面更新，请刷新后重试',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    }
    const draft = draftOf(nodeState.state);
    const entry = draft.templates.find(({ id }) => id === templateId);
    if (!entry) this.notFound('当前混剪模板不存在');
    const workspace: EffectTemplateMixWorkspace = {
      ...entry!.workspace,
      materials: artifactData.items
        .map(materialFrom)
        .filter((item): item is EffectTemplateMixMaterial => Boolean(item)),
    };
    mutation(workspace);
    entry!.workspace = {
      editVersion: workspace.editVersion,
      template: workspace.template,
      variants: workspace.variants,
    };
    const saved = await this.working.putNodeState(projectId, workflowRunId, 'TEMPLATE_MIX', {
      expectedRevision,
      schemaVersion: 1,
      state: draft,
    });
    return this.toWorkspaceData(draft, saved.nodeState.revision, artifactData.items);
  }

  private toWorkspaceData(
    draft: EffectTemplateMixDraft,
    draftRevision: number | null,
    artifacts: WorkingArtifact[],
  ): EffectTemplateMixWorkspaceData {
    const materials = artifacts
      .map(materialFrom)
      .filter((item): item is EffectTemplateMixMaterial => Boolean(item));
    const commits = artifacts
      .filter(
        ({ nodeId, artifactKey }) =>
          nodeId === 'TEMPLATE_MIX' && artifactKey.startsWith('mix-template:'),
      )
      .map((artifact) => {
        const data = payload(artifact);
        const template = object(data.template);
        return {
          templateId: String(data.templateId ?? artifact.artifactKey.slice('mix-template:'.length)),
          revision: artifact.revision,
          contentHash: '',
          stale: artifact.freshness === 'STALE',
          editVersion: Number(data.workspaceVersion ?? template?.editVersion ?? 0),
        };
      });
    return { draft, draftRevision, materials, commits };
  }

  private notFound(message: string): never {
    throw new ApiHttpException(message, HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
  }

  private validateVariant(
    variant: EffectTemplateMixVariant,
    sources: Map<string, WorkingArtifact>,
    allSourceIds: Set<string>,
  ): void {
    if (!variant.name.trim() || !slotsValid(variant.slots) || variant.conflictSlotIds.length) {
      throw new ApiHttpException(
        '成片工程仍有素材缺口或槽位配置无效',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    }
    const used = new Set<string>();
    const slotIds = new Set(variant.slots.map(({ id }) => id));
    if (Object.keys(variant.bindings).some((slotId) => !slotIds.has(slotId))) {
      throw new ApiHttpException(
        '成片工程包含已移除槽位的素材引用',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    }
    for (const slot of variant.slots) {
      const artifactId = variant.bindings[slot.id];
      const source = artifactId ? sources.get(artifactId) : undefined;
      const offset = variant.offsets[slot.id] ?? 0;
      if (
        !source ||
        source.availability !== 'AVAILABLE' ||
        source.freshness !== 'CURRENT' ||
        variant.bindingRevisions[slot.id] !== source.revision ||
        used.has(source.id) ||
        !clipSupports(source, slot.purpose) ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        offset + slot.duration > clipDuration(source) + 0.001
      ) {
        throw new ApiHttpException(
          '成片工程引用了缺失、过期、重复或时长不足的素材',
          HttpStatus.CONFLICT,
          'CONFLICT',
        );
      }
      used.add(source.id);
      allSourceIds.add(source.id);
    }
    const totalDuration = variant.slots.reduce((sum, slot) => sum + slot.duration, 0);
    for (const caption of variant.captions) {
      if (
        !caption.text.trim() ||
        caption.start < 0 ||
        caption.end <= caption.start ||
        caption.end > totalDuration + 0.001
      ) {
        throw new ApiHttpException(
          '字幕内容或时间范围无效',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      }
    }
  }
}
