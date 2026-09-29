import { describe, expect, it } from 'vitest';

import { useActionConfirmation } from '../../../shared/composables/action-confirmation';
import { confirmDiscardEffectEdit } from './effect-edit-session';

describe('effect edit session cancellation', () => {
  it('warns that the draft is discarded while the published version remains', async () => {
    const confirmation = useActionConfirmation();
    const decision = confirmDiscardEffectEdit();

    expect(confirmation.state.open).toBe(true);
    expect(confirmation.state.title).toBe('确定放弃本次编辑？');
    expect(confirmation.state.description).toContain('已自动保存的修改');
    expect(confirmation.state.description).toContain('已发布版本保持不变');
    expect(confirmation.state.cancelLabel).toBe('继续编辑');
    expect(confirmation.state.confirmLabel).toBe('放弃编辑');

    confirmation.cancel();
    await expect(decision).resolves.toBe(false);
  });
});
