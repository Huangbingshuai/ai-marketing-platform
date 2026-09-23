import { BadRequestException, Injectable } from '@nestjs/common';
import type { EffectVoiceCatalog, EffectVoiceSelection } from '@ai-marketing/contracts';

type ConfiguredVoice = EffectVoiceSelection & { enabled: boolean; verifiedAt: string };
/** Verified again by the 2026-09-23 voice-library paid smoke test; see its evidence note. */
const defaults: ConfiguredVoice[] = [
  {
    id: 'vivi',
    name: 'Vivi',
    gender: 'FEMALE',
    description: '自然清晰 · 商品讲解',
    version: 'seed-tts-2.0:1',
    speaker: 'zh_female_vv_uranus_bigtts',
    resourceId: 'seed-tts-2.0',
    enabled: true,
    verifiedAt: '2026-09-23T03:23:41.503Z',
  },
];
export function readVoiceCatalog(raw: string | undefined): ConfiguredVoice[] {
  const rows: unknown = raw === undefined ? defaults : JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('音色库配置格式无效');
  const ids = new Set<string>();
  for (const r of rows) {
    if (
      !r ||
      typeof r !== 'object' ||
      typeof r.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) ||
      ids.has(r.id) ||
      !['FEMALE', 'MALE'].includes(r.gender) ||
      typeof r.name !== 'string' ||
      !r.name.trim() ||
      r.name.length > 80 ||
      typeof r.description !== 'string' ||
      r.description.length > 200 ||
      typeof r.version !== 'string' ||
      !r.version ||
      r.version.length > 100 ||
      typeof r.speaker !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(r.speaker) ||
      !['seed-tts-2.0', 'seed-tts-1.0', 'seed-tts-1.0-concurr'].includes(r.resourceId) ||
      typeof r.enabled !== 'boolean' ||
      (r.enabled &&
        (typeof r.verifiedAt !== 'string' || !Number.isFinite(Date.parse(r.verifiedAt))))
    )
      throw new Error('音色库条目缺少有效配置或验证记录');
    ids.add(r.id);
  }
  return rows as ConfiguredVoice[];
}
@Injectable()
export class EffectVoiceCatalogService {
  private readonly entries = readVoiceCatalog(process.env.TEMPLATE_MIX_VOICE_CATALOG_JSON);
  selection(id?: string): EffectVoiceSelection {
    const row = id
      ? this.entries.find((r) => r.id === id && r.enabled)
      : this.entries.find((r) => r.enabled);
    if (!row) throw new BadRequestException('所选音色未配置或未验证，请重新选择音色');
    const { id: profileId, name, gender, description, version, speaker, resourceId } = row;
    return { id: profileId, name, gender, description, version, speaker, resourceId };
  }
  publicCatalog(disabled: Set<string> = new Set()): EffectVoiceCatalog {
    const profiles = this.entries
      .filter((r) => r.enabled && !disabled.has(`${r.id}:${r.version}`))
      .map(({ id, name, description, gender, version }) => ({
        id,
        name,
        description,
        gender,
        version,
      }));
    return { profiles, defaultId: profiles[0]?.id ?? null };
  }
}
