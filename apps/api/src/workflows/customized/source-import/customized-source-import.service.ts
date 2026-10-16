import { rm } from 'node:fs/promises';
import { CUSTOMIZED_IMPORT_LIMITS, type CustomizedImportSection } from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiHttpException } from '../../../common/api-http-exception';
import { AssetService, type UploadedAssetFile } from '../../../platform/asset/asset.service';
import { validateImportFile } from '../../../platform/file/import-file-validation';
import { normalizeMultipartFileName } from '../../../platform/file/file-name';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';

@Injectable()
export class CustomizedSourceImportService {
  constructor(
    @Inject(AssetService) private readonly assets: AssetService,
    @Inject(WorkflowWorkingRepository) private readonly workflows: WorkflowWorkingRepository,
  ) {}

  async upload(
    projectId: string,
    runId: string,
    section: CustomizedImportSection,
    file?: UploadedAssetFile,
  ) {
    try {
      if (section !== 'BRIEF' && section !== 'VISUAL_REFERENCE')
        throw new ApiHttpException('资料区域无效', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
      if (
        section === 'BRIEF' &&
        file &&
        !/\.(docx|pdf|xlsx|txt|md)$/i.test(normalizeMultipartFileName(file.originalname))
      )
        throw new ApiHttpException(
          '简报支持 DOCX、PDF、XLSX、TXT、Markdown；旧版 DOC/XLS 请转换后上传',
          HttpStatus.BAD_REQUEST,
          'FILE_TYPE_UNSUPPORTED',
        );
      await this.workflows.assertCustomizedImportEditable(projectId, runId);
      const validated = await validateImportFile(
        file ? { ...file, originalname: normalizeMultipartFileName(file.originalname) } : undefined,
        section === 'BRIEF' ? 'DOCUMENT' : 'IMAGE',
        section === 'BRIEF'
          ? CUSTOMIZED_IMPORT_LIMITS.maxDocumentBytes
          : CUSTOMIZED_IMPORT_LIMITS.maxImageBytes,
      );
      const [asset] = await this.assets.importMany(
        projectId,
        {
          workflow: 'CUSTOMIZED',
          space: 'CUSTOMIZED_PROJECT',
          type: 'SOURCE_MATERIAL',
          contentIdentity: `customized-source-v1:${section}`,
          editableCustomizedRunId: runId,
        },
        [validated],
      );
      // A slow upload must never attach itself to a different or cancelled edit session.
      await this.workflows.assertCustomizedImportEditable(projectId, runId);
      return asset!;
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }
}
