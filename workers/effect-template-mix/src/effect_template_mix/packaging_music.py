"""Whole-film music context, independent of slot narration and video cut points."""
import hashlib
from typing import Any


def film_music_context(identity: str, snapshot: dict[str, Any], vision: list[dict[str, Any]]) -> dict[str, Any]:
    # Stable within an immutable packaging item, fresh for a user-created task.
    # References for AI, never keyword-based product classification.
    digest = hashlib.sha256(identity.encode()).digest()
    styles = ('现代轻放克', '原声独立流行', '轻爵士融合', '简约电子氛围',
              '清新室内乐', '轻拉丁律动', '复古灵魂器乐', '现代民乐融合')
    textures = ('干净电钢琴与弹性贝斯', '指弹吉他与柔和弦乐', '木质键盘与轻打击乐',
                '细腻合成器与低频脉冲', '拨弦与少量钢琴', '尼龙吉他与轻沙锤',
                '柔和电吉他与贝斯', '少量民族拨弦与现代节奏组')
    grooves = ('松弛切分律动', '稳定轻盈直拍', '柔和摇摆律动', '稀疏有弹性的鼓点',
               '流动琶音与轻脉冲', '轻巧跳跃的低音律动')
    developments = ('短动机起步、逐渐丰富配器、自然收束', '稳定主题贯穿、中段加入对位、回归主旋律',
                    '轻盈开场、缓慢推进层次、柔和落点', '节奏先行、旋律自然加入、保留余韵',
                    '稀疏旋律开场、中段展开、简洁回收', '持续律动与渐变音色、避免反复重启前奏')
    descriptions = {row.get('slotId'): row.get('description', '') for row in vision}
    return {
        'scope': '整条成片的一首连续纯器乐，不为单个素材分别配乐',
        'duration': snapshot['duration'],
        'pictureSequence': [
            {'start': clip['start'], 'duration': clip['duration'],
             'picture': descriptions.get(clip['slotId'], '')}
            for clip in sorted(snapshot['clips'], key=lambda clip: clip['start'])],
        'creativeReference': {
            'style': styles[digest[0] % len(styles)],
            'texture': textures[digest[1] % len(textures)],
            'groove': grooves[digest[2] % len(grooves)],
            'development': developments[digest[3] % len(developments)],
            'tempoReferenceBpm': 76 + digest[4] % 39,
        },
    }
