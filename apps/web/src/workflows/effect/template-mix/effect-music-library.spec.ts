import { describe, expect, it } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import source from './EffectMusicLibrary.vue?raw';

describe('effect template-mix music library', () => {
  it('separates music from the voice library in the resource tabs', () => {
    expect(page).toContain("selectResourceTab('MUSIC')");
    expect(page).toContain('>音乐</button');
    expect(page).toContain('<EffectMusicLibrary');
    expect(page).toContain("resourceTab === 'VOICE'");
  });

  it('limits music imports to MP3 files and stores them as project assets', () => {
    expect(source).toContain('导入音乐');
    expect(source).toContain("const MP3_FILE_ACCEPT = 'audio/mpeg,.mp3'");
    expect(source).toContain(':accept="MP3_FILE_ACCEPT"');
    expect(source).toContain('/\\.mp3$/i.test(file.name)');
    expect(source).toContain('function isMp3Asset(asset: Asset): boolean');
    expect(source).toContain("'is-unsupported': !isMp3Asset(asset)");
    expect(source).toContain('不支持的格式');
    expect(source).not.toContain('response.data.items.filter((asset)');
    expect(source).toContain('音乐库仅支持导入 MP3 文件');
    expect(source).toContain('仅支持 MP3');
    expect(source).toContain("directory: 'AUDIO_ASSETS'");
    expect(source).toContain("type: 'VOICE_AUDIO'");
    expect(source).toContain('tags: [MUSIC_LIBRARY_TAG]');
    expect(source).toContain('await importAsset(');
    expect(source).toContain('listAssets(');
    expect(source).toContain('tag: MUSIC_LIBRARY_TAG');
  });

  it('shows imported music with native playback and cancels requests when scope changes', () => {
    expect(source).toContain(':src="asset.contentUrl"');
    expect(source).toContain("return name.replace(/\\.mp3$/i, '');");
    expect(source).toContain('displayMusicName(asset.name)');
    expect(source).not.toContain('项目音乐');
    expect(source).not.toContain('<small>{{ asset.notes');
    expect(source).toContain('watch(');
    expect(source).toContain('listController?.abort()');
    expect(source).toContain('uploadController?.abort()');
    expect(source).toContain('onBeforeUnmount');
  });

  it('plays selected music and exposes no favorite or download actions', () => {
    expect(source).toContain('class="music-player"');
    expect(source).toContain('aria-label="音乐播放进度"');
    expect(source).toContain('.play()');
    expect(source).not.toContain('收藏');
    expect(source).not.toContain('下载');
  });

  it('drags imported music to the timeline with its project asset and file identity', () => {
    expect(source).toContain("'application/x-effect-template-mix-music'");
    expect(source).toContain('workflowFileObjectId');
    expect(source).toContain('workflowRunId: props.workflowRunId');
    expect(page).toContain('@add-music-asset');
    expect(page).toContain('sourceAssetId: music.assetId');
  });
});
