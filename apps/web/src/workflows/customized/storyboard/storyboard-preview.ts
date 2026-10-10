import type { CustomizedStoryboardDraft, CustomizedStoryboardShot } from '@ai-marketing/contracts';
import { emptyStoryboardAssetRequirements, emptyStoryboardDraft } from './storyboard-state';
/** Explicit UI fixture. Never used by the workspace loader or draft persistence. */
export function storyboardPreview(): CustomizedStoryboardDraft {
  const shot = (
    id: string,
    title: string,
    durationSeconds: number,
    visual: string,
    shotType: string,
    cameraMovement: string,
    audio: string,
    dialogue = '',
    continuity = '',
  ): CustomizedStoryboardShot => ({
    id,
    title,
    durationSeconds,
    visual,
    shotType,
    cameraMovement,
    audio,
    continuity,
    dialogues: dialogue ? [{ id: `${id}-voice`, speaker: '旁白', text: dialogue }] : [],
  });
  const draft: CustomizedStoryboardDraft = {
    ...emptyStoryboardDraft(),
    activeScriptId: 'preview-a',
    scripts: [
      {
        id: 'preview-a',
        name: '晚餐多一点滋味',
        synopsis:
          '忙碌的一天结束，一个人用一勺青梅酱，为熟悉的晚餐添上一点期待。故事跟随取酱、蘸食与落座展开，以安静的餐桌收束。',
        structure: '归家 → 准备晚餐 → 一勺点睛 → 落座享用',
        productFocus: '以佐餐动作呈现酸甜风味，突出果肉质感与取用方便。',
        shots: [
          shot(
            'a1',
            '晚餐之前',
            4,
            '傍晚的暖光落在浅木餐桌。一个人将刚买回的烧鸭放上桌，解开外套袖口。桌上留着一只空蘸碟，餐具摆放自然。',
            '中景',
            '缓慢推进',
            '门锁轻响，纸袋窸窣，克制的器乐开始。',
            '',
            '暖色自然光；人物始终穿浅米色衬衫。',
          ),
          shot(
            'a2',
            '熟悉的那一瓶',
            4,
            '手从桌边拿起梅里青梅酱，透明直身玻璃瓶停在画面右侧。墨绿瓶盖与米白标签清晰可见，另一只手旋开瓶盖。',
            '近景',
            '固定镜头',
            '金属旋盖轻响，音乐保持低音量。',
            '熟悉的晚餐，也可以有一点新滋味。',
            '瓶盖放在瓶子右侧，下一镜保持同一位置。',
          ),
          shot(
            'a3',
            '看见果肉',
            6,
            '一把干净的小勺缓慢进入瓶口，舀起半透明金黄色酱体。细小果肉随勺面带出，酱体在勺边缓慢回落，保持浓稠而可流动的状态。',
            '微距',
            '轻微跟随',
            '取酱的轻微黏稠声，器乐留出呼吸。',
            '',
            '勺子从右侧进入，取酱后向左下方移向蘸碟。',
          ),
          shot(
            'a4',
            '一勺点睛',
            5,
            '顺接上一镜，勺子将青梅酱落入白色蘸碟。筷子夹起一块熟烧鸭，轻轻蘸过碟边，薄薄酱体附在表面。',
            '特写',
            '固定镜头',
            '瓷碟与勺子的轻碰，筷子轻响。',
            '一勺酸甜，添上梅果的滋味。',
            '同一蘸碟、同一餐桌，鸭肉必须为熟食。',
          ),
          shot(
            'a5',
            '坐下来，好好吃饭',
            6,
            '人物在桌边落座，将蘸过酱的熟食送入口中，动作从容。镜头停留在自然放松的神态，再轻移至桌上的酱瓶与餐盘。',
            '中景',
            '横向轻移',
            '轻柔餐桌环境声，音乐温暖展开。',
            '',
            '不使用夸张表情；产品瓶型和标签保持一致。',
          ),
          shot(
            'a6',
            '餐桌上的梅里',
            5,
            '青梅酱与蘸碟在前景，晚餐和人物手部在后景。暖光透过玻璃，呈现金黄色酱体与细小果肉，画面停在自然的餐桌关系中。',
            '近景',
            '缓慢推进',
            '器乐轻轻收束，保留自然环境声。',
            '梅里青梅酱，让家常多一种滋味。',
            '保持产品与餐具真实比例，不新增包装或功效文字。',
          ),
        ],
      },
      {
        id: 'preview-b',
        name: '一勺之间',
        synopsis:
          '用一勺酱的移动串起全片：从瓶中果肉、勺边流动，到蘸碟与熟食。以连贯动作和细节质感建立产品记忆。',
        structure: '果肉细节 → 舀起 → 落酱 → 蘸食 → 产品收束',
        productFocus: '半透明金黄色酱体、细小果肉和缓慢流动的质感。',
        shots: [
          shot(
            'b1',
            '光穿过酱体',
            5,
            '自然侧光穿过打开的玻璃酱瓶，金黄色酱体中可见细小果肉。干净的小勺从右侧进入画面。',
            '微距',
            '缓慢推进',
            '安静环境声与简洁钢琴动机。',
          ),
          shot(
            'b2',
            '舀起的弧线',
            6,
            '小勺带出浓稠的青梅酱，沿一个平缓弧线移向蘸碟。镜头跟随勺子，瓶身在后景逐渐虚化。',
            '特写',
            '跟随运镜',
            '细微取酱声，音乐顺着动作延续。',
          ),
          shot(
            'b3',
            '缓缓落下',
            6,
            '酱体从勺边缓慢落入白色蘸碟，形成自然堆叠。小勺轻触碟边，留下清晰的果肉纹理。',
            '微距',
            '固定镜头',
            '瓷器轻碰声。',
          ),
          shot(
            'b4',
            '风味相遇',
            7,
            '熟烧鸭被筷子夹起，轻蘸金黄色青梅酱后向画面上方移出。餐桌整体逐渐进入画面，呈现真实用餐环境。',
            '近景',
            '缓慢拉远',
            '自然餐桌声，音乐渐暖。',
            '梅果的酸甜，落在这一口。',
          ),
          shot(
            'b5',
            '留下滋味',
            6,
            '小勺放回蘸碟旁，梅里青梅酱停在餐盘一侧。瓶型、墨绿瓶盖与米白标签稳定，暖色自然光下完成收束。',
            '近景',
            '固定镜头',
            '音乐干净收尾。',
            '梅里青梅酱。',
          ),
        ],
      },
      {
        id: 'preview-c',
        name: '熟悉的一餐',
        synopsis:
          '两个人围坐在家常餐桌，用自然对话引出新的佐餐搭配。产品随着人物递碟与蘸食进入故事，让滋味成为交流的一部分。',
        structure: '落座 → 递碟 → 尝试 → 分享 → 餐桌收束',
        productFocus: '在真实餐桌关系中呈现佐餐搭配和取用方便。',
        shots: [
          shot(
            'c1',
            '今天吃什么',
            5,
            '两个人陆续在餐桌边落座，熟烧鸭放在中央。一人将空蘸碟推向另一人，镜头保持平视和自然距离。',
            '中景',
            '固定镜头',
            '椅子轻响，餐具声；轻柔器乐。',
            '今天，换个搭配。',
          ),
          shot(
            'c2',
            '把酸甜递过去',
            5,
            '手旋开青梅酱，舀入小碟，再把蘸碟递到对面。产品停在桌边，标签正面自然露出。',
            '近景',
            '横向轻移',
            '旋盖与瓷碟轻碰声。',
          ),
          shot(
            'c3',
            '这一口的细节',
            6,
            '熟食轻蘸青梅酱，半透明金黄色酱体附着在表面，细小果肉可见。用餐动作真实连贯。',
            '特写',
            '固定镜头',
            '轻微食物与餐具声。',
          ),
          shot(
            'c4',
            '熟悉里的一点不同',
            8,
            '两个人自然交谈，夹取食物，表情轻松。镜头沿餐桌轻移，酱瓶、蘸碟与熟食始终维持空间关系。',
            '中景',
            '缓慢横移',
            '自然聊天环境声，音乐温暖但不抢对白。',
          ),
          shot(
            'c5',
            '一起吃饭',
            6,
            '餐桌从近处展开，青梅酱在前景，人物在后景继续用餐。保留自然生活感，以稳定的产品画面结束。',
            '近景',
            '缓慢拉远',
            '音乐与餐桌声缓缓收束。',
            '梅里青梅酱，家常的另一种滋味。',
          ),
        ],
      },
    ],
  };
  // Explicit fixture associations, never inferred from project text or persisted as generated assets.
  draft.scripts.forEach((script, index) => {
    const product = `${script.id}-product`,
      scene = `${script.id}-scene`,
      person = `${script.id}-person`;
    script.assets = [
      {
        id: product,
        kind: 'products',
        name: '梅里青梅酱',
        description: '虚构包装方案：透明直身玻璃瓶、墨绿旋盖、米白标签；金黄色酱体含细小果肉。',
      },
      {
        id: scene,
        kind: 'scenes',
        name: '傍晚家庭餐桌',
        description: '浅木餐桌、白色蘸碟与自然餐具，暖色侧光，全片保持一致的空间方向。',
      },
    ];
    if (index !== 1)
      script.assets.push({
        id: person,
        kind: 'characters',
        name: index === 0 ? '归家者' : '用餐主人',
        description: '虚构人物方案：自然居家形象，浅米色衬衫；脸型、发型和服饰跨镜保持一致。',
      });
    if (index === 2)
      script.assets.push({
        id: `${person}-guest`,
        kind: 'characters',
        name: '用餐同伴',
        description: '虚构人物方案：深灰上衣，与用餐主人外观明确区分，跨镜保持一致。',
      });
    script.shots.forEach((s, i) => {
      const requirements = emptyStoryboardAssetRequirements();
      requirements.products =
        i === 0 && index !== 1
          ? { state: 'NONE', items: [] }
          : {
              state: 'DEFINED',
              items: [
                {
                  assetId: product,
                  description:
                    index === 0
                      ? [
                          '',
                          '标签自然露出；右手旋开瓶盖，瓶盖置于右侧。',
                          '突出瓶口、酱体与果肉，保持同一酱体颜色。',
                          '只呈现产品内容物，酱体附着于熟食表面。',
                          '瓶身在桌边保持真实比例，延续标签与瓶盖位置。',
                          '瓶身与蘸碟前景收束，暖光透过玻璃。',
                        ][i]!
                      : '延续同一包装、酱体颜色和果肉形态，按本镜画面安排露出范围。',
                },
              ],
            };
      requirements.scenes = {
        state: 'DEFINED',
        items: [
          { assetId: scene, description: '保持餐桌材质与暖光方向；景深和取景范围随镜头变化。' },
        ],
      };
      requirements.characters =
        index === 1
          ? { state: 'NONE', items: [] }
          : {
              state: 'DEFINED',
              items: [
                {
                  assetId: person,
                  description:
                    index === 0
                      ? [
                          '解开袖口并放下熟食，动作自然。',
                          '只呈现双手，保持浅米色袖口。',
                          '只呈现右手取酱，不露出面部。',
                          '只呈现持筷的手部，顺接上一镜取酱动作。',
                          '桌边落座，自然用餐，不做夸张表情。',
                          '后景保留手部，主体让位于产品。',
                        ][i]!
                      : '保持同一人物与服饰，按画面要求参与递碟和用餐动作。',
                },
              ],
            };
      if (index === 2 && [0, 3, 4].includes(i))
        requirements.characters.items.push({
          assetId: `${person}-guest`,
          description: '位于餐桌对面，保持空间关系与自然交流。',
        });
      s.assetRequirements = requirements;
    });
  });
  return draft;
}
