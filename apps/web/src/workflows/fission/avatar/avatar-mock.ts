/** Frontend-only fixtures. These never represent API assets, tasks or revisions. */
export type Tool = 'avatar' | 'voice' | 'background' | 'copy' | 'subtitle';
export type Track = 'video' | 'audio' | 'subtitle';
export type DemoAsset = {
  id: string;
  name: string;
  version: string;
  meta: string;
  tags: string[];
  icon: string;
  tone?: string;
  previewUrl?: string;
  mediaType?: string;
};
export type SubtitleStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  underline: boolean;
  color: string;
  outlineColor: string;
  highlightColor: string;
  highlightWords: string;
  letterSpacing: number;
  lineHeight: number;
  textAlign: 'left' | 'center' | 'right';
  position: string;
  positionX: number;
  positionY: number;
  backgroundEnabled: boolean;
  backgroundColor: string;
};
export type Clip = {
  id: string;
  title: string;
  text: string;
  start: number;
  duration: number;
  style?: SubtitleStyle;
};
export type DemoState = {
  schema: 1;
  projectId: string;
  tool: Tool;
  avatarId: string;
  voiceId: string;
  backgroundId: string;
  copy: string;
  speed: number;
  pitch: number;
  scale: number;
  opacity: number;
  position: string;
  status: 'idle' | 'completed';
  outputId: string;
  source: string;
  composition: string;
  tracks: Record<Track, Clip[]>;
  style: SubtitleStyle;
  stored: string[];
};
export const avatars: DemoAsset[] = [
  {
    id: 'avatar-chef',
    name: '中年粤菜大厨',
    version: 'v3',
    meta: '正面 / 左侧 / 背面三视图',
    tags: ['带货', '科普', '广式食品'],
    icon: 'user',
  },
  {
    id: 'avatar-host',
    name: '年轻带货女主播',
    version: 'v4',
    meta: '正面 / 侧面 / 手持产品',
    tags: ['带货', '直播', '活力'],
    icon: 'mic',
  },
  {
    id: 'avatar-business',
    name: '商务男性讲解员',
    version: 'v2',
    meta: '正面 / 侧面 / 演示姿态',
    tags: ['品宣', '科普', '商务'],
    icon: 'user',
  },
  {
    id: 'avatar-neighbor',
    name: '邻家生活博主',
    version: 'v3',
    meta: '正面 / 坐姿 / 居家姿态',
    tags: ['带货', '生活', '直播'],
    icon: 'user',
  },
  {
    id: 'avatar-reviewer',
    name: '探店博主',
    version: 'v2',
    meta: '正面 / 行走 / 手持探店',
    tags: ['探店', '带货', '品宣'],
    icon: 'search',
  },
  {
    id: 'avatar-senior',
    name: '中老年体验官',
    version: 'v2',
    meta: '正面 / 侧面 / 体验姿态',
    tags: ['带货', '科普', '体验'],
    icon: 'user',
  },
];
export const voices: DemoAsset[] = [
  {
    id: 'voice-1',
    name: '亲切粤语女声',
    meta: '自然亲和 · 粤语口音',
    icon: 'audio',
    version: 'v1',
    tags: [],
  },
  {
    id: 'voice-2',
    name: '清亮带货女声',
    meta: '年轻活力 · 带货推荐',
    icon: 'mic',
    version: 'v1',
    tags: [],
  },
  {
    id: 'voice-3',
    name: '沉稳商务男声',
    meta: '成熟可信 · 品牌讲解',
    icon: 'audio',
    version: 'v1',
    tags: [],
  },
  {
    id: 'voice-4',
    name: '专业讲师音色',
    meta: '吐字清晰 · 知识科普',
    icon: 'mic',
    version: 'v1',
    tags: [],
  },
  {
    id: 'voice-5',
    name: '活力青年音色',
    meta: '节奏明快 · 社交短视频',
    icon: 'audio',
    version: 'v1',
    tags: [],
  },
  {
    id: 'voice-6',
    name: '温暖长辈音色',
    meta: '舒缓温和 · 体验分享',
    icon: 'audio',
    version: 'v1',
    tags: [],
  },
];
export const backgrounds: DemoAsset[] = [
  {
    id: 'scene-kitchen',
    name: '老广厨房暖光',
    meta: '3200K 暖光 · 居家纪实',
    tone: 'kitchen',
    mediaType: 'image',
    version: 'v1',
    tags: [],
    icon: 'image',
  },
  {
    id: 'scene-restaurant',
    name: '新中式酒楼',
    meta: '柔和侧光 · 品牌品宣',
    tone: 'restaurant',
    mediaType: 'image',
    version: 'v1',
    tags: [],
    icon: 'image',
  },
  {
    id: 'scene-live',
    name: '品牌直播间',
    meta: '蓝白棚景 · 直播带货',
    tone: 'live',
    mediaType: 'video',
    version: 'v1',
    tags: [],
    icon: 'image',
  },
  {
    id: 'scene-street',
    name: '老广骑楼老街',
    meta: '傍晚暖色 · 城市人文',
    tone: 'street',
    mediaType: 'video',
    version: 'v1',
    tags: [],
    icon: 'image',
  },
  {
    id: 'scene-camp',
    name: '户外露营营地',
    meta: '日落逆光 · 户外体验',
    tone: 'camp',
    mediaType: 'video',
    version: 'v1',
    tags: [],
    icon: 'image',
  },
  {
    id: 'scene-white',
    name: '电商白底展台',
    meta: '高键光 · 电商简约',
    tone: 'white',
    mediaType: 'image',
    version: 'v1',
    tags: [],
    icon: 'image',
  },
];
export const defaultCopy =
  '还在买又干又柴的腊肠？广式腊肠坚持传统工艺，自然风干更有酒香。切片蒸熟，油润透亮，咸甜比例刚刚好。无论煲仔饭还是家常小炒，都能快速端上一份地道广府风味。现在下单，把老广味道带回家。';
export const defaultStyle = (): SubtitleStyle => ({
  fontFamily: '思源黑体',
  fontSize: 34,
  fontWeight: 700,
  italic: false,
  underline: false,
  color: '#ffffff',
  outlineColor: '#172033',
  highlightColor: '#4f8df7',
  highlightWords: '传统工艺,自然风干,老广味道',
  letterSpacing: 0,
  lineHeight: 1.35,
  textAlign: 'center',
  position: '底部居中',
  positionX: 50,
  positionY: 84,
  backgroundEnabled: false,
  backgroundColor: '#172033',
});
export const storageKey = (projectId: string): string =>
  `ai-marketing.mock.FISSION_AVATAR.${encodeURIComponent(projectId)}.mock-run-v1`;
export const createDemo = (projectId: string): DemoState => ({
  schema: 1,
  projectId,
  tool: 'avatar',
  avatarId: avatars[0]!.id,
  voiceId: voices[0]!.id,
  backgroundId: backgrounds[0]!.id,
  copy: defaultCopy,
  speed: 1.05,
  pitch: 0,
  scale: 100,
  opacity: 100,
  position: '居中',
  status: 'idle',
  outputId: '',
  source: '',
  composition: '',
  tracks: { video: [], audio: [], subtitle: [] },
  style: defaultStyle(),
  stored: [],
});
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const estimateDuration = (state: Pick<DemoState, 'copy' | 'speed'>): number =>
  Math.max(1, Math.round(state.copy.length / (4.3 * state.speed)));
export const sourceFingerprint = (state: DemoState): string =>
  JSON.stringify([state.avatarId, state.voiceId, state.copy.trim(), state.speed, state.pitch]);
export const compositionFingerprint = (state: DemoState): string =>
  JSON.stringify([state.backgroundId, state.scale, state.opacity, state.position, state.tracks]);
export const isSourceStale = (state: DemoState): boolean =>
  state.status === 'completed' && state.source !== sourceFingerprint(state);
export const isCompositionStale = (state: DemoState): boolean =>
  state.status === 'completed' && state.composition !== compositionFingerprint(state);
export function makeSpokenClips(copy: string, duration: number, prefix = 'audio'): Clip[] {
  const sentences =
    copy
      .match(/[^。！？!?\n]+[。！？!?]?/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [];
  const total = sentences.reduce((sum, s) => sum + s.length, 0);
  let start = 0;
  return sentences.map((text, i) => {
    const length = i === sentences.length - 1 ? duration - start : (duration * text.length) / total;
    const clip = {
      id: `${prefix}-${i + 1}`,
      title: `口播 ${String(i + 1).padStart(2, '0')}`,
      text,
      start,
      duration: length,
    };
    start += length;
    return clip;
  });
}
export function completeVideo(state: DemoState): void {
  const duration = estimateDuration(state);
  state.tracks.video = [
    { id: 'video-1', title: '数字人口播合成视频', text: '', start: 0, duration },
  ];
  state.tracks.audio = makeSpokenClips(state.copy, duration);
  state.tracks.subtitle = [];
  state.status = 'completed';
  state.outputId = 'MOCK-AVATAR-01';
  state.source = sourceFingerprint(state);
  state.stored = [];
  state.composition = compositionFingerprint(state);
}
export function completeSubtitles(state: DemoState): void {
  state.tracks.subtitle = state.tracks.audio.map((clip, i) => ({
    ...clone(clip),
    id: `subtitle-${i + 1}`,
    title: `字幕 ${i + 1}`,
    style: clone(state.style),
  }));
  state.stored = [];
}
export function splitSubtitle(clips: Clip[], id: string, time: number): boolean {
  const index = clips.findIndex((c) => c.id === id);
  const clip = clips[index];
  if (!clip || time - clip.start < 0.25 || clip.start + clip.duration - time < 0.25) return false;
  const offset = Math.max(
    1,
    Math.min(
      clip.text.length - 1,
      Math.round((clip.text.length * (time - clip.start)) / clip.duration),
    ),
  );
  const right = {
    ...clone(clip),
    id: `${clip.id}-split-${time.toFixed(2)}`,
    start: time,
    duration: clip.start + clip.duration - time,
    text: clip.text.slice(offset),
  };
  clip.duration = time - clip.start;
  clip.text = clip.text.slice(0, offset);
  clips.splice(index + 1, 0, right);
  return true;
}
/** Defensive restore: broken/foreign data cannot become a usable demo workspace. */
export function restoreDemo(raw: string | null, projectId: string): DemoState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DemoState;
    if (
      value.schema !== 1 ||
      value.projectId !== projectId ||
      typeof value.copy !== 'string' ||
      !['idle', 'completed'].includes(value.status) ||
      !['avatar', 'voice', 'background', 'copy', 'subtitle'].includes(value.tool)
    )
      return null;
    if (
      ![value.speed, value.pitch, value.scale, value.opacity].every(Number.isFinite) ||
      value.speed < 0.7 ||
      value.speed > 1.5 ||
      !value.style ||
      !Array.isArray(value.stored)
    )
      return null;
    if (
      !['avatarId', 'voiceId', 'backgroundId', 'source', 'composition', 'outputId'].every(
        (key) => typeof value[key as keyof DemoState] === 'string',
      )
    )
      return null;
    if (
      !(['video', 'audio', 'subtitle'] as Track[]).every(
        (track) =>
          Array.isArray(value.tracks?.[track]) &&
          value.tracks[track].every(
            (c) =>
              typeof c.id === 'string' &&
              typeof c.text === 'string' &&
              typeof c.title === 'string' &&
              Number.isFinite(c.start) &&
              c.start >= 0 &&
              Number.isFinite(c.duration) &&
              c.duration > 0,
          ),
      )
    )
      return null;
    return { ...value, style: { ...defaultStyle(), ...value.style } };
  } catch {
    return null;
  }
}
export const timeLabel = (time: number): string =>
  `${String(Math.floor(time / 60)).padStart(2, '0')}:${(time % 60).toFixed(1).padStart(4, '0')}`;

export function parseSubtitleFile(text: string): Clip[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const seconds = (value: string) =>
    value
      .replace(',', '.')
      .trim()
      .split(':')
      .reduce((sum, n) => sum * 60 + Number(n), 0);
  const cues: { start: number; end: number; text: string }[] = [];
  for (const match of normalized.matchAll(
    /((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{2,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g,
  ))
    cues.push({
      start: seconds(match[1]!),
      end: seconds(match[2]!),
      text: match[3]!.replace(/<[^>]+>/g, '').trim(),
    });
  if (!cues.length) {
    let fields = [
      'Layer',
      'Start',
      'End',
      'Style',
      'Name',
      'MarginL',
      'MarginR',
      'MarginV',
      'Effect',
      'Text',
    ];
    let events = false;
    for (const line of normalized.split('\n')) {
      if (line.startsWith('[')) events = /^\[Events\]/i.test(line);
      if (!events) continue;
      if (/^Format:/i.test(line))
        fields = line
          .slice(line.indexOf(':') + 1)
          .split(',')
          .map((s) => s.trim());
      if (!/^Dialogue:/i.test(line)) continue;
      const values = line.slice(line.indexOf(':') + 1).split(',');
      const get = (name: string) => values[fields.indexOf(name)] ?? '';
      const body = values
        .slice(fields.indexOf('Text'))
        .join(',')
        .replace(/\{[^}]*}/g, '')
        .replace(/\\[Nn]/g, '\n')
        .trim();
      cues.push({ start: seconds(get('Start')), end: seconds(get('End')), text: body });
    }
  }
  return cues
    .filter(
      (c) =>
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.start >= 0 &&
        c.end > c.start &&
        c.text,
    )
    .sort((a, b) => a.start - b.start)
    .map((c, i) => ({
      id: `import-subtitle-${i}`,
      title: `字幕 ${i + 1}`,
      text: c.text,
      start: c.start,
      duration: c.end - c.start,
      style: defaultStyle(),
    }));
}
