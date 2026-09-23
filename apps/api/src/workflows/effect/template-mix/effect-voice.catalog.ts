import { BadRequestException, Injectable } from '@nestjs/common';
import type { EffectVoiceCatalog, EffectVoiceSelection } from '@ai-marketing/contracts';

type ConfiguredVoice = EffectVoiceSelection & { enabled: boolean; verifiedAt: string };
const displayName = (name: string) => name.replace(/\s*2\.0$/i, '').trim();
/** Account-visible standard voices supplied by the user from the enabled TTS 2.0 console. */
const accountVoices = `
zh_female_vv_uranus_bigtts|vivi 2.0|通用场景
saturn_zh_female_cancan_tob|知性灿灿|角色扮演
saturn_zh_female_keainvsheng_tob|可爱女生|角色扮演
saturn_zh_female_tiaopigongzhu_tob|调皮公主|角色扮演
saturn_zh_male_shuanglangshaonian_tob|爽朗少年|角色扮演
saturn_zh_male_tiancaitongzhuo_tob|天才同桌|角色扮演
zh_female_xiaohe_uranus_bigtts|小何|通用场景
zh_male_m191_uranus_bigtts|云舟|通用场景
zh_male_taocheng_uranus_bigtts|小天|通用场景
en_male_tim_uranus_bigtts|Tim|通用场景
en_female_dacey_uranus_bigtts|Dacey|通用场景
en_female_stokie_uranus_bigtts|Stokie|通用场景
zh_male_liufei_uranus_bigtts|刘飞 2.0|通用场景
zh_female_qingxinnvsheng_uranus_bigtts|清新女声 2.0|通用场景
zh_female_cancan_uranus_bigtts|知性灿灿 2.0|角色扮演
zh_female_sajiaoxuemei_uranus_bigtts|撒娇学妹 2.0|角色扮演
zh_female_tianmeixiaoyuan_uranus_bigtts|甜美小源 2.0|通用场景
zh_female_tianmeitaozi_uranus_bigtts|甜美桃子 2.0|通用场景
zh_female_shuangkuaisisi_uranus_bigtts|爽快思思 2.0|通用场景
zh_female_peiqi_uranus_bigtts|佩奇猪 2.0|视频配音
zh_female_linjianvhai_uranus_bigtts|邻家女孩 2.0|通用场景
zh_male_shaonianzixin_uranus_bigtts|少年梓辛/Brayan 2.0|通用场景
zh_male_sunwukong_uranus_bigtts|猴哥 2.0|视频配音
zh_female_yingyujiaoxue_uranus_bigtts|Tina老师 2.0|教育场景
zh_female_kefunvsheng_uranus_bigtts|暖阳女声 2.0|客服场景
zh_female_xiaoxue_uranus_bigtts|儿童绘本 2.0|有声阅读
zh_male_dayi_uranus_bigtts|大壹 2.0|视频配音
zh_female_mizai_uranus_bigtts|黑猫侦探社咪仔 2.0|视频配音
zh_female_jitangnv_uranus_bigtts|鸡汤女 2.0|视频配音
zh_female_meilinvyou_uranus_bigtts|魅力女友 2.0|通用场景
zh_female_liuchangnv_uranus_bigtts|流畅女声 2.0|通用场景
zh_male_ruyayichen_uranus_bigtts|儒雅逸辰 2.0|视频配音
zh_female_wenroumama_uranus_bigtts|温柔妈妈 2.0|通用场景
zh_male_jieshuoxiaoming_uranus_bigtts|解说小明 2.0|通用场景
zh_female_tvbnv_uranus_bigtts|TVB女声 2.0|通用场景
zh_male_yizhipiannan_uranus_bigtts|译制片男 2.0|通用场景
zh_female_qiaopinv_uranus_bigtts|俏皮女声 2.0|通用场景
zh_female_zhishuaiyingzi_uranus_bigtts|直率英子 2.0|通用场景
zh_male_linjiananhai_uranus_bigtts|邻家男孩 2.0|通用场景
zh_male_silang_uranus_bigtts|四郎 2.0|通用场景
zh_male_ruyaqingnian_uranus_bigtts|儒雅青年 2.0|通用场景
zh_male_qingcang_uranus_bigtts|擎苍 2.0|通用场景
zh_male_xionger_uranus_bigtts|熊二 2.0|通用场景
zh_female_yingtaowanzi_uranus_bigtts|樱桃丸子 2.0|通用场景
zh_male_wennuanahu_uranus_bigtts|温暖阿虎/Alvin 2.0|通用场景
zh_male_naiqimengwa_uranus_bigtts|奶气萌娃 2.0|通用场景
zh_female_popo_uranus_bigtts|婆婆 2.0|通用场景
zh_female_gaolengyujie_uranus_bigtts|高冷御姐 2.0|角色扮演
zh_male_aojiaobazong_uranus_bigtts|傲娇霸总 2.0|角色扮演
zh_male_lanyinmianbao_uranus_bigtts|懒音绵宝 2.0|有声阅读
zh_male_fanjuanqingnian_uranus_bigtts|反卷青年 2.0|角色扮演
zh_female_wenroushunv_uranus_bigtts|温柔淑女 2.0|通用场景
zh_female_gufengshaoyu_uranus_bigtts|古风少御 2.0|角色扮演
zh_male_huolixiaoge_uranus_bigtts|活力小哥 2.0|角色扮演
zh_male_baqiqingshu_uranus_bigtts|霸气青叔 2.0|角色扮演
zh_male_xuanyijieshuo_uranus_bigtts|悬疑解说 2.0|有声阅读
zh_female_mengyatou_uranus_bigtts|萌丫头/Cutey 2.0|角色扮演
zh_female_tiexinnvsheng_uranus_bigtts|贴心女声/Candy 2.0|通用场景
zh_female_jitangmei_uranus_bigtts|鸡汤妹妹/Hope 2.0|通用场景
zh_male_cixingjieshuonan_uranus_bigtts|磁性解说男声/Morgan 2.0|通用场景
zh_male_liangsangmengzai_uranus_bigtts|亮嗓萌仔 2.0|通用场景
zh_female_kailangjiejie_uranus_bigtts|开朗姐姐 2.0|通用场景
zh_male_gaolengchenwen_uranus_bigtts|高冷沉稳 2.0|通用场景
zh_male_shenyeboke_uranus_bigtts|深夜播客 2.0|多情感
zh_male_lubanqihao_uranus_bigtts|鲁班七号 2.0|角色扮演
zh_female_jiaochuannv_uranus_bigtts|娇喘女声 2.0|视频配音
zh_female_linxiao_uranus_bigtts|林潇 2.0|角色扮演
zh_female_lingling_uranus_bigtts|玲玲姐姐 2.0|角色扮演
zh_female_chunribu_uranus_bigtts|春日部姐姐 2.0|角色扮演
zh_male_tangseng_uranus_bigtts|唐僧 2.0|角色扮演
zh_male_zhuangzhou_uranus_bigtts|庄周 2.0|角色扮演
zh_male_kailangdidi_uranus_bigtts|开朗弟弟 2.0|角色扮演
zh_male_zhubajie_uranus_bigtts|猪八戒 2.0|角色扮演
zh_female_ganmaodianyin_uranus_bigtts|感冒电音姐姐 2.0|角色扮演
zh_female_chanmeinv_uranus_bigtts|谄媚女声 2.0|角色扮演
zh_female_nvleishen_uranus_bigtts|女雷神 2.0|角色扮演
zh_female_qinqienv_uranus_bigtts|亲切女声 2.0|有声阅读
zh_male_kuailexiaodong_uranus_bigtts|快乐小东 2.0|通用场景
zh_male_kailangxuezhang_uranus_bigtts|开朗学长 2.0|通用场景
zh_male_youyoujunzi_uranus_bigtts|悠悠君子 2.0|有声阅读
zh_female_wenjingmaomao_uranus_bigtts|文静毛毛 2.0|通用场景
zh_female_zhixingnv_uranus_bigtts|知性女声 2.0|有声阅读
zh_male_qingshuangnanda_uranus_bigtts|清爽男大 2.0|通用场景
zh_male_yuanboxiaoshu_uranus_bigtts|渊博小叔 2.0|通用场景
zh_male_yangguangqingnian_uranus_bigtts|阳光青年 2.0|通用场景
zh_female_qingchezizi_uranus_bigtts|清澈梓梓 2.0|通用场景
zh_female_tianmeiyueyue_uranus_bigtts|甜美悦悦 2.0|通用场景
zh_female_xinlingjitang_uranus_bigtts|心灵鸡汤 2.0|有声阅读
zh_male_wenrouxiaoge_uranus_bigtts|温柔小哥 2.0|通用场景
zh_female_roumeinvyou_uranus_bigtts|柔美女友 2.0|通用场景
zh_male_dongfanghaoran_uranus_bigtts|东方浩然 2.0|通用场景
zh_female_wenrouxiaoya_uranus_bigtts|温柔小雅 2.0|通用场景
zh_male_tiancaitongsheng_uranus_bigtts|天才童声 2.0|通用场景
zh_female_wuzetian_uranus_bigtts|武则天 2.0|角色扮演
zh_female_gujie_uranus_bigtts|顾姐 2.0|角色扮演
zh_male_guanggaojieshuo_uranus_bigtts|广告解说 2.0|通用场景
zh_female_shaoergushi_uranus_bigtts|少儿故事 2.0|有声阅读
zh_female_sophie_uranus_bigtts|魅力苏菲 2.0|通用场景
saturn_zh_male_qingxinmumu_cs_tob|清新沐沐 2.0|客服场景
`.trim();
const verifiedAt = '2026-09-23T05:43:23.000Z';
const defaults: ConfiguredVoice[] = accountVoices.split('\n').map((line) => {
  const [speaker, name, scenario] = line.split('|');
  const gender: EffectVoiceSelection['gender'] = /_(female)_/.test(speaker!) ? 'FEMALE' : 'MALE';
  return {
    // Keep the pre-existing Vivi profile ID stable for saved template drafts.
    id: speaker === 'zh_female_vv_uranus_bigtts' ? 'vivi' : speaker!,
    name: displayName(name!),
    gender,
    description: scenario!,
    version: 'seed-tts-2.0:1',
    speaker: speaker!,
    resourceId: 'seed-tts-2.0',
    enabled: true,
    verifiedAt,
  };
});
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
      !/^[a-zA-Z0-9_.:-]{1,100}$/.test(r.version) ||
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
  workerSelections(): EffectVoiceSelection[] {
    return this.entries
      .filter((row) => row.enabled)
      .map(({ id, name, gender, description, version, speaker, resourceId }) => ({
        id,
        name: displayName(name),
        gender,
        description,
        version,
        speaker,
        resourceId,
      }));
  }
  selection(id?: string): EffectVoiceSelection {
    const row = id
      ? this.entries.find((r) => r.id === id && r.enabled)
      : this.entries.find((r) => r.enabled);
    if (!row) throw new BadRequestException('所选音色未配置或未验证，请重新选择音色');
    const { id: profileId, name, gender, description, version, speaker, resourceId } = row;
    return {
      id: profileId,
      name: displayName(name),
      gender,
      description,
      version,
      speaker,
      resourceId,
    };
  }
  publicCatalog(disabled: Set<string> = new Set()): EffectVoiceCatalog {
    const profiles = this.entries
      .filter((r) => r.enabled && !disabled.has(`${r.id}:${r.version}`))
      .map(({ id, name, description, gender, version }) => ({
        id,
        name: displayName(name),
        description,
        gender,
        version,
      }));
    return { profiles, defaultId: profiles[0]?.id ?? null };
  }
}
