import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EffectVoicePreviewMessage, EffectVoicePreviewSnapshot } from './effect-voice';

describe('voice preview cross-process contract', () => {
  it('keeps v2 routing fields required without weakening other job messages', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(__dirname, '../schemas/effect-voice-preview-message.schema.json'),
        'utf8',
      ),
    );
    const message = {
      schemaVersion: 2,
      taskType: 'VOICE_PREVIEW',
      projectId: 'p',
      runId: 'r',
      requestId: 'q',
    } satisfies EffectVoicePreviewMessage;
    expect(Object.keys(message).sort()).toEqual(schema.required.sort());
    expect(schema.properties.taskType.const).toBe(message.taskType);
    expect(schema.additionalProperties).toBe(false);
  });
  it('freezes provider identity independently of a mutable template preference', () => {
    const snapshot: EffectVoicePreviewSnapshot = {
      sampleText: '固定文本',
      profile: {
        id: 'voice',
        name: '音色',
        gender: 'FEMALE',
        description: '自然',
        version: '1',
        speaker: 'speaker',
        resourceId: 'seed-tts-2.0',
      },
    };
    const saved = JSON.parse(JSON.stringify(snapshot));
    snapshot.profile.speaker = 'different';
    expect(saved.profile.speaker).toBe('speaker');
  });
});
