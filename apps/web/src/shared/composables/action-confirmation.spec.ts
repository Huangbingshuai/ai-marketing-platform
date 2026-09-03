import { describe, expect, it } from 'vitest';

import { requestActionConfirmation, useActionConfirmation } from './action-confirmation';

describe('action confirmation service', () => {
  it('exposes the requested copy and resolves true only after confirmation', async () => {
    const service = useActionConfirmation();
    const result = requestActionConfirmation({
      eyebrow: '删除资料',
      title: '删除这条资料？',
      description: '删除后需要重新导入。',
      confirmLabel: '确认删除',
      tone: 'danger',
    });

    expect(service.state).toMatchObject({
      open: true,
      eyebrow: '删除资料',
      title: '删除这条资料？',
      confirmLabel: '确认删除',
      tone: 'danger',
    });

    service.confirm();

    await expect(result).resolves.toBe(true);
    expect(service.state.open).toBe(false);
  });

  it('resolves false when cancelled and cancels an older pending request', async () => {
    const service = useActionConfirmation();
    const first = requestActionConfirmation({
      title: '第一次操作？',
      description: '第一次操作说明。',
    });
    const second = requestActionConfirmation({
      title: '第二次操作？',
      description: '第二次操作说明。',
    });

    await expect(first).resolves.toBe(false);
    expect(service.state.title).toBe('第二次操作？');

    service.cancel();

    await expect(second).resolves.toBe(false);
    expect(service.state.open).toBe(false);
  });
});
