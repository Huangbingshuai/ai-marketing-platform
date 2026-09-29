import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';

export const confirmDiscardEffectEdit = (): Promise<boolean> =>
  requestActionConfirmation({
    eyebrow: '编辑草稿',
    title: '确定放弃本次编辑？',
    description: '取消后，本次编辑草稿（包括已自动保存的修改）会被放弃；已发布版本保持不变。',
    confirmLabel: '放弃编辑',
    cancelLabel: '继续编辑',
    tone: 'danger',
  });
