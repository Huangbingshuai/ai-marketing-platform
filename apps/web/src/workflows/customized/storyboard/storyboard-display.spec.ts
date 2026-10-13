import { expect, it } from 'vitest';
import { storyboardObjectDescription } from './storyboard-display';

it('shows referenced object names in catalog descriptions without editing the source objects', () => {
  const assets = [
    {
      id: 'prod_client_phone',
      kind: 'products' as const,
      name: '负责人的手机',
      description: '待设计',
    },
  ];
  const original = JSON.stringify(assets);
  expect(
    storyboardObjectDescription('另一台手机另见prod_client_phone；USB-C接口保持。', assets),
  ).toBe('另一台手机另见负责人的手机；USB-C接口保持。');
  expect(storyboardObjectDescription('prod_client_phone_extra', assets)).toBe(
    'prod_client_phone_extra',
  );
  expect(JSON.stringify(assets)).toBe(original);
});
