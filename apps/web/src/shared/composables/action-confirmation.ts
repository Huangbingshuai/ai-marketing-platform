import { reactive, readonly } from 'vue';

export type ActionConfirmationTone = 'danger' | 'warning';

export type ActionConfirmationOptions = {
  eyebrow?: string;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ActionConfirmationTone;
};

type ActionConfirmationState = Required<ActionConfirmationOptions> & {
  open: boolean;
};

const state = reactive<ActionConfirmationState>({
  open: false,
  eyebrow: '',
  title: '',
  description: '',
  confirmLabel: '确认',
  cancelLabel: '取消',
  tone: 'warning',
});

let pendingResolution: ((confirmed: boolean) => void) | null = null;

const settleActionConfirmation = (confirmed: boolean): void => {
  const resolve = pendingResolution;
  pendingResolution = null;
  state.open = false;
  resolve?.(confirmed);
};

export const requestActionConfirmation = (options: ActionConfirmationOptions): Promise<boolean> => {
  if (pendingResolution) settleActionConfirmation(false);
  Object.assign(state, {
    open: true,
    eyebrow: options.eyebrow ?? '',
    title: options.title,
    description: options.description,
    confirmLabel: options.confirmLabel ?? '确认',
    cancelLabel: options.cancelLabel ?? '取消',
    tone: options.tone ?? 'warning',
  });
  return new Promise<boolean>((resolve) => {
    pendingResolution = resolve;
  });
};

export const useActionConfirmation = () => ({
  state: readonly(state),
  confirm: (): void => settleActionConfirmation(true),
  cancel: (): void => settleActionConfirmation(false),
});
