"""Versioned asset preparation. All paid work and checkpoints are task-local."""
from __future__ import annotations
import asyncio
import copy
import logging
from typing import Any, cast
from .api import Api
from .provider import Provider
from .asset_models import Inventory, Definitions, AssetAudit, AssetRepair, DETAIL_KEYS

EDITABLE = ('name', 'description', 'knownFacts', 'designNotes', 'sourceText', 'imageRequirements', 'preparation')
KIND_NAMES = {'PRODUCT': '产品', 'CHARACTER': '人物', 'SCENE': '场景', 'PROP': '道具'}
FIELD_NAMES = {'structure': '结构与形态', 'material': '材质与颜色', 'markings': '标识与位置', 'appearance': '外形特征', 'styling': '服装与造型', 'layout': '空间与陈设', 'lighting': '光线与氛围', 'name': '名称', 'description': '公共形象', 'knownFacts': '已确认信息', 'designNotes': '设计内容', 'sourceText': '依据说明', 'imageRequirements': '图片制作要求', 'preparation': '分类定义'}

def source_rows(value: Any, path: str = '') -> list[dict[str, str]]:
    if isinstance(value, str):
        return [{'path': path, 'text': value}] if value.strip() else []
    if isinstance(value, list):
        return [row for i, v in enumerate(value) for row in source_rows(v, f'{path}/{i}')]
    if isinstance(value, dict):
        return [row for k, v in value.items() for row in source_rows(v, path + '/' + k.replace('~', '~0').replace('/', '~1'))]
    return []

def evidence_index(snapshot: dict[str, Any]) -> dict[tuple[str, str], str]:
    script = {k: v for k, v in snapshot['script'].items() if k not in ('assets', 'shots')}
    return {(source, row['path']): row['text'] for source, value in [('BRIEF', snapshot['brief']), ('SCRIPT', script)] for row in source_rows(value)}

def check_evidence(refs: list[dict[str, Any]], index: dict[tuple[str, str], str], kind: str) -> None:
    if not refs:
        raise ValueError('asset evidence required')
    for ref in refs:
        quote = ref['quote']
        if not quote.strip() or quote not in index.get((ref['source'], ref['path']), ''):
            raise ValueError('asset evidence quote not found')
        if kind == 'PRODUCT' and ref['field'] in ('description', 'knownFacts', 'structure', 'material', 'markings') and ref['source'] != 'BRIEF':
            raise ValueError('product fact must cite brief')

class InventoryValidationError(ValueError):
    def __init__(self, reasons: list[str]) -> None:
        self.reasons = list(dict.fromkeys(reasons))
        super().__init__('; '.join(self.reasons))


def align_inventory(raw: dict[str, Any], snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = Inventory.model_validate(raw).model_dump()['objects']
    errors: list[str] = []
    existing = {a['id']: a for a in snapshot['document']['assets']}
    keys = [a['key'] for a in candidates]
    if len(set(keys)) != len(keys):
        errors.append('duplicate inventory key')
    ids: dict[str, str] = {}
    for i, a in enumerate(candidates):
        old = existing.get(a['existingId'])
        if a['existingId'] is not None and (old is None or old['kind'] != a['kind']):
            errors.append('invalid existing identity')
        ids[a['key']] = a['existingId'] or f"asset-{snapshot['identitySeed']}-{i+1}"
    if len(set(ids.values())) != len(ids):
        errors.append('inventory duplicated an identity')
    target = snapshot.get('targetAssetId')
    if target and (len(candidates) != 1 or candidates[0]['existingId'] != target):
        errors.append('single asset scope changed')
    if not target and not any(a['kind'] == 'PRODUCT' for a in candidates):
        errors.append('missing product')
    index = evidence_index(snapshot)
    result = []
    for a in candidates:
        if not a['sources']:
            errors.append('asset evidence required')
        for ref in a['sources']:
            try:
                check_evidence([ref], index, a['kind'])
            except ValueError as error:
                errors.append(str(error))
        parent = ids.get(a['parentKey']) or (a['parentKey'] if a['parentKey'] in existing else None)
        if a['treatment'] == 'INDEPENDENT':
            if a['parentKey'] is not None:
                errors.append('independent object has parent')
        else:
            expected = 'SCENE' if a['treatment'] == 'SCENE_DETAIL' else 'CHARACTER'
            parent_object = next((v for v in candidates if ids[v['key']] == parent), existing.get(parent))
            if not parent or parent == ids[a['key']] or not parent_object or parent_object['kind'] != expected:
                errors.append('invalid detail parent')
        if a['kind'] == 'PRODUCT' and a['treatment'] != 'INDEPENDENT':
            errors.append('product must be independent')
        result.append({**a, 'id': ids[a['key']], 'parentId': parent})
    if errors:
        raise InventoryValidationError(errors)
    return result

def protected_fields(a: dict[str, Any]) -> list[str]:
    return list(a.get('manualFields', [] if a.get('preparation') else [k for k in EDITABLE if a.get(k)]))

def preserve_manual(assets: list[dict[str, Any]], snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    result = copy.deepcopy(assets)
    previous = {a['id']: a for a in snapshot['document']['assets']}
    for a in result:
        old = previous.get(a['id'])
        if old:
            for field in protected_fields(old):
                if field in old:
                    a[field] = copy.deepcopy(old[field])
    return result

def validate_definitions(assets: list[dict[str, Any]], inventory: list[dict[str, Any]], snapshot: dict[str, Any]) -> None:
    Definitions.model_validate({'assets': assets})
    expected = {a['id']: a for a in inventory}
    if len(assets) != len(expected) or {a['id'] for a in assets} != set(expected):
        raise ValueError('definition changed inventory identities')
    index = evidence_index(snapshot)
    for a in assets:
        original = expected[a['id']]
        if a['kind'] != original['kind']:
            raise ValueError('definition changed category')
        prep = a['preparation']
        if prep['treatment'] != original['treatment'] or prep['parentId'] != original['parentId']:
            raise ValueError('definition changed inclusion relationship')
        keys = [d['key'] for d in prep['details']]
        if len(keys) != len(set(keys)) or any(k not in DETAIL_KEYS[a['kind']] for k in keys):
            raise ValueError('invalid category field')
        check_evidence(prep['sources'], index, a['kind'])


def definition_schema(objects: list[dict[str, Any]]) -> type[Definitions]:
    """Constrain generation to this batch, rather than the contextual catalog."""
    class ScopedDefinitions(Definitions):
        @classmethod
        def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
            schema = super().model_json_schema(*args, **kwargs)
            item = schema['$defs']['AssetDefinition']['properties']
            item['id']['enum'] = [a['id'] for a in objects]
            item['kind']['enum'] = sorted({a['kind'] for a in objects})
            schema['properties']['assets'].update(minItems=len(objects), maxItems=len(objects))
            return schema
    return ScopedDefinitions


def scope_definitions(candidates: list[dict[str, Any]], batch: list[dict[str, Any]], inventory: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Recover exact batch identities from older overbroad responses; never guess IDs."""
    expected = {a['id'] for a in batch}
    known = {a['id'] for a in inventory}
    ids = [a['id'] for a in candidates]
    if len(ids) != len(set(ids)) or not set(ids) <= known or not expected <= set(ids):
        raise ValueError('definition changed inventory identities')
    return [a for a in candidates if a['id'] in expected]

def validate_audit(audit: dict[str, Any], assets: list[dict[str, Any]]) -> None:
    AssetAudit.model_validate(audit)
    ids = {a['id'] for a in assets}
    if any(f['assetId'] not in ids for f in audit['findings']):
        raise ValueError('audit outside asset scope')

def audit_schema(assets: list[dict[str, Any]]) -> type[AssetAudit]:
    class ScopedAudit(AssetAudit):
        @classmethod
        def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
            schema = super().model_json_schema(*args, **kwargs)
            schema['$defs']['Finding']['properties']['assetId']['enum'] = [a['id'] for a in assets]
            return schema
    return ScopedAudit

def apply_repair(assets: list[dict[str, Any]], repair: dict[str, Any], audit: dict[str, Any], snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    patches = AssetRepair.model_validate(repair).model_dump()['patches']
    allowed = {(f['assetId'], f['field']) for f in audit['findings'] if f['severity'] == 'REQUIRED'}
    used: set[tuple[str, str]] = set()
    result = copy.deepcopy(assets)
    by_id = {a['id']: a for a in result}
    old = {a['id']: a for a in snapshot['document']['assets']}
    for p in patches:
        key = (p['assetId'], p['field'])
        if key not in allowed or key in used or p['field'] in protected_fields(old.get(p['assetId'], {})):
            raise ValueError('repair outside editable findings')
        used.add(key)
        if p['field'] == 'preparation':
            if p['preparation'] is None or p['text'] is not None:
                raise ValueError('invalid structured patch')
            by_id[p['assetId']]['preparation'] = p['preparation']
        else:
            if p['text'] is None or p['preparation'] is not None:
                raise ValueError('invalid text patch')
            by_id[p['assetId']][p['field']] = p['text']
    if used != allowed:
        raise ValueError('repair omitted required field')
    return result

def describe(assets: list[dict[str, Any]]) -> str:
    return '\n\n'.join(f"{a['name']}\n{a['description']}\n已确认信息：{a['knownFacts']}\n设计内容：{a['designNotes']}\n" +
        '\n'.join(f"{FIELD_NAMES[d['key']]}：{d['value']}" for d in a['preparation']['details']) +
        '\n制作要求：'+a['imageRequirements']+'\n待确认：'+'；'.join(q['question'] for q in a['preparation']['questions']) for a in assets)

async def run_assets(api: Api, provider: Provider, claim: dict[str, Any]) -> None:
    snapshot = claim['input']
    steps = {s['id']: s for s in claim['steps']}
    stored = copy.deepcopy(claim.get('output') or {})
    index = evidence_index(snapshot)
    sources = [{'source': source, 'path': path, 'text': value} for (source, path), value in index.items()]
    existing = snapshot['document']['assets']
    identity = [{'id': a['id'], 'kind': a['kind'], 'name': a['name'], 'aliases': a.get('preparation', {}).get('aliases', [])} for a in existing]
    locked = [{'id': a['id'], 'fields': {k: a[k] for k in protected_fields(a) if k in a}} for a in existing]
    context = {'sources': sources, 'existingIdentities': identity, 'protectedDefinitions': locked, 'targetAssetId': snapshot.get('targetAssetId')}

    async def checkpoint(node: str, status: str, title: str, content: str) -> None:
        await api.call('PUT', 'checkpoint', {'step': {'id': node, 'status': status, 'title': title, 'content': content}, 'output': stored})
        steps[node]['status'] = status

    async def checked_audit(key: str, stage: str, node: str, values: list[dict[str, Any]], inputs: dict[str, Any], instruction: str) -> dict[str, Any]:
        schema = audit_schema(values)
        if key not in stored:
            result = await provider.generate(stage, snapshot['models']['creative'], schema, inputs, instruction)
            stored[key] = result.model_dump()
            await checkpoint(node, 'RUNNING', '核对审校引用', '审校结果已保留，正在核对问题所指对象。')
        try:
            validate_audit(stored[key], values)
        except ValueError:
            correction_key = key + 'ScopeCorrectionAttempted'
            if stored.get(correction_key):
                await checkpoint(node, 'FAILED', '审校引用需要核对', '审校引用未通过对象范围校验，已有资产与审校结果保留。')
                raise
            stored[correction_key] = True
            stored[key + 'Original'] = copy.deepcopy(stored[key])
            await checkpoint(node, 'RUNNING', '修正审校引用', '正在核对问题对应的准确对象，仅修正不合法的引用。')
            result = await provider.generate(stage + '_SCOPE', snapshot['models']['creative'], schema,
                {**inputs, 'candidate': stored[key]},
                '审校结果引用了目录外的对象。逐条对照当前assets，使用其准确id定位问题，不按近名猜测，不删除尚未解决的问题，不改写资产。遗漏对象问题定位最相关的已有对象preparation字段并说明遗漏。保留问题、依据与严重程度；只纠正引用和必要的定位说明。')
            stored[key] = result.model_dump()
            await checkpoint(node, 'RUNNING', '核对修正后的审校引用', '已保留引用修正结果，正在重新校验。')
            validate_audit(stored[key], values)
        return cast(dict[str, Any], stored[key])

    if steps['SNAPSHOT']['status'] != 'SUCCEEDED':
        await checkpoint('SNAPSHOT', 'SUCCEEDED', '本次创作依据', snapshot['script']['name']+'\n'+snapshot['script'].get('story', {}).get('content', snapshot['script'].get('synopsis', '')))
    if steps['INVENTORY']['status'] != 'SUCCEEDED':
        await checkpoint('INVENTORY', 'RUNNING', '识别对象与原文', '正在对照完整脚本和信息卡识别必要对象')
        inventory_instruction = '先识别故事实际涉及的产品、人物、场景、道具，不写完整外观，不拆分镜。每项给出用途与原文引用，source/path来自sources，quote必须逐字复制连续原文，field标明支持的内容。产品始终独立；不要按数量删掉动作必需道具。SCENE_DETAIL的父对象必须是SCENE，CHARACTER_DETAIL的父对象必须是CHARACTER，不能归属产品或道具；INDEPENDENT的parentKey为null。包袋、线材等道具的附属细节可合入该道具定义，不建立违反父类型的子项。相同身份复用已有id，不按近名猜测；新对象existingId为null，key为本次唯一代号。父对象使用key；单项整理允许父对象使用existingIdentities的id。若targetAssetId非空只整理该对象，必须保留id和kind。未知事实保持未知，不根据已有生成描述发明产品事实。'
        if 'inventoryRaw' not in stored:
            inventory = await provider.generate('ASSET_INVENTORY', snapshot['models']['creative'], Inventory, context, inventory_instruction)
            stored['inventoryRaw'] = inventory.model_dump()
            await checkpoint('INVENTORY', 'RUNNING', '对象识别待核对', '已保留识别候选，正在核对对象身份、归属与原文引用。')
        try:
            aligned = align_inventory(stored['inventoryRaw'], snapshot)
        except ValueError as error:
            safe_errors = {'asset evidence required', 'asset evidence quote not found', 'product fact must cite brief',
                'duplicate inventory key', 'invalid existing identity', 'inventory duplicated an identity',
                'single asset scope changed', 'missing product', 'independent object has parent',
                'invalid detail parent', 'product must be independent'}
            reasons = error.reasons if isinstance(error, InventoryValidationError) else [str(error)]
            reasons = [r if r in safe_errors else 'invalid inventory schema' for r in reasons]
            reason = reasons[0]
            logging.warning('Asset inventory validation reason=%s', reason)
            if stored.get('inventoryCorrectionAttempted'):
                await checkpoint('INVENTORY', 'FAILED', '对象识别需要核对', '对象身份、归属或原文引用未通过校验，候选内容已保留。')
                raise
            stored['inventoryCorrectionAttempted'] = True
            stored['inventoryValidationError'] = reason
            stored['inventoryValidationErrors'] = reasons
            await checkpoint('INVENTORY', 'RUNNING', '核对对象与引用', '正在针对对象身份、归属或原文引用进行一次校正。')
            corrected = await provider.generate('ASSET_VALIDATE_INVENTORY', snapshot['models']['creative'], Inventory,
                {**context, 'candidate': stored['inventoryRaw'], 'validationError': reason, 'validationErrors': reasons},
                inventory_instruction+'一次校正validationErrors全部机械问题，保留有效对象与原文，不删除动作必需对象来规避校验。产品已知事实只引用BRIEF；故事用途可引用SCRIPT并标usage。parentKey引用本批唯一key或合法已有身份，父对象类型必须符合treatment，不能猜测。')
            stored['inventoryRaw'] = corrected.model_dump()
            await checkpoint('INVENTORY', 'RUNNING', '对象识别校正结果', '已保留校正候选，正在重新校验。')
            aligned = align_inventory(stored['inventoryRaw'], snapshot)
        stored['inventory'] = aligned
        await checkpoint('INVENTORY', 'SUCCEEDED', '对象与原文依据', '\n\n'.join(a['name']+'：'+a['usage']+'\n'+'\n'.join(r['quote'] for r in a['sources']) for a in aligned))
    inventory = stored['inventory']
    if steps['IDENTITY']['status'] != 'SUCCEEDED':
        stored['inventory'] = align_inventory(stored['inventoryRaw'], snapshot)
        retained = [a['name'] for a in existing if a['id'] not in {v['id'] for v in inventory}]
        await checkpoint('IDENTITY', 'SUCCEEDED', '身份与制作归属', '\n'.join(a['name']+' · '+('复用已有对象' if a['existingId'] else '新对象')+' · '+{'INDEPENDENT':'独立对象','SCENE_DETAIL':'场景细节','CHARACTER_DETAIL':'人物细节'}[a['treatment']] for a in inventory)+ ('\n原有对象保留，未在本次重新整理：'+'、'.join(retained) if retained else ''))
    lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(2)
    stored.setdefault('batches', {})
    stored.setdefault('definitionCandidates', {})
    stored.setdefault('definitionCorrections', {})
    instruction = ('为指定objects生成分类定义，精确保留id、kind、treatment、parentId，不新增或遗漏对象。'
        'preparation包含aliases、usage、来源sources、分类details、待确认questions和按需图片images。'
        'PRODUCT的details只用structure/material/markings；CHARACTER只用appearance/styling；SCENE只用layout/lighting；PROP只用appearance/material。'
        '公共外观与事实分开，产品事实只以BRIEF为准，结构位置未知时写待确认，允许创作的内容放designNotes；人物、场景可按故事合理设计。'
        '人物、场景和普通道具的未指定视觉细节允许给出一套明确且统一的设计方案，写入designNotes、details和图片要求；不能写成资料已确认事实，不要并列多套互斥选项。'
        'knownFacts只记录该对象在原文中的事实，不把目标受众推导为人物的年龄职业，不把自定的安装位置或标识工艺写成已知事实；相关内容若合理只能作为明确的设计设定。'
        '资产提供跨镜复用的共用形象，不制作逐镜画面。需要独立制图时默认一张同一对象的多视角设定图：人物为面部特写与全身正侧背面（只有局部出镜则按可见范围）；实体产品和道具展示一致的多个角度及已确认关键结构；场景展示同一空间的全貌与不同方向；软件按一致界面和必要状态，不套实体三视图。不是多套备选形象，不新增对象身份，不补造未知真实结构。必要的连接、收绕、搬移关系记录在用途或设计说明，不必复现所有剧情阶段、动作或相连设备；写明的状态不能与事实冲突。'
        '场景与配套道具不得反向确定未知产品事实：若插脚、接口、连接件、容器等制式或适配规格未提供，相关插座、线材或安装位置只写与已确认部分匹配，具体制式待确认，不擅自指定国别标准、孔型或兼容性。'
        '人物styling只写实际可见的服饰配饰；只有手部出镜时无需设计全身服装，不把动作节奏写成服装。'
        '每条关键事实引用sources中的准确path与连续quote，产品description/knownFacts/结构材质标识仅引用BRIEF。'
        'questions仅记录影响产品真实结构、身份或明确品牌限制的关键资料缺口；可合理设计的墙面颜色、人物造型和普通道具材质自行设计，不反复要求用户确认，不询问分镜动作时长。不足以确定的产品结构不要自行补全。'
        'images列出实际需要的图片及用途，陈设通常并入所属场景，不强迫每个对象单独生图；软件按界面与状态制作，不套三视图。'
        '保护protectedDefinitions中的人工内容；旧AI描述不是事实来源。不要生成图片或声称看过图片。')

    async def category(kind: str) -> None:
        if steps[kind]['status'] == 'SUCCEEDED':
            return
        objects = [a for a in inventory if a['kind'] == kind]
        async with lock:
            await checkpoint(kind, 'RUNNING', KIND_NAMES[kind]+'定义', '正在整理'+KIND_NAMES[kind]+'的共用特征')
        for offset in range(0, len(objects), 6):
            key = f'{kind}:{offset}'
            batch = objects[offset:offset+6]
            if key in stored['batches']:
                validate_definitions(stored['batches'][key], batch, snapshot)
                continue
            batch_context = {**context, 'objects': batch, 'catalog': [{'id': a['id'], 'name': a['name'], 'kind': a['kind']} for a in inventory]}
            schema = definition_schema(batch)
            if key not in stored['definitionCandidates']:
                async with semaphore:
                    result = await provider.generate('ASSET_DEFINE_'+kind, snapshot['models']['detail'], schema,
                        batch_context, instruction)
                async with lock:
                    stored['definitionCandidates'][key] = result.model_dump()['assets']
                    await checkpoint(kind, 'RUNNING', KIND_NAMES[kind]+'定义待核对', '正在校验对象归属和原文引用，候选内容尚未采用。')
            try:
                assets = preserve_manual(scope_definitions(stored['definitionCandidates'][key], batch, inventory), snapshot)
                validate_definitions(assets, batch, snapshot)
            except ValueError as error:
                # These fixed codes contain no document text or provider response.
                safe_errors = {'asset evidence required', 'asset evidence quote not found', 'product fact must cite brief',
                    'definition changed inventory identities', 'definition changed category',
                    'definition changed inclusion relationship', 'invalid category field'}
                reason = str(error) if str(error) in safe_errors else 'invalid definition schema'
                logging.warning('Asset definition validation kind=%s reason=%s', kind, reason)
                if key in stored['definitionCorrections']:
                    async with lock:
                        await checkpoint(kind, 'FAILED', KIND_NAMES[kind]+'定义需要核对', '对象定义或资料引用未通过校验，已保留候选内容和其他分类结果。')
                    raise
                async with semaphore:
                    corrected = await provider.generate('ASSET_VALIDATE_'+kind, snapshot['models']['detail'], schema,
                        {**batch_context, 'candidate': stored['definitionCandidates'][key], 'validationError': reason},
                        instruction+'\n仅修正validationError指出的结构或原文引用错误，保留其他内容。quote必须是对应source/path原文中的连续逐字片段，不能合并或改写原句；产品事实引用只能来自BRIEF，故事用途引用请标usage。不要补造依据或删除有效对象。')
                async with lock:
                    stored['definitionCorrections'][key] = reason
                    stored['definitionCandidates'][key] = corrected.model_dump()['assets']
                    await checkpoint(kind, 'RUNNING', KIND_NAMES[kind]+'引用核对', '已核对引用与对象结构，正在重新校验。')
                assets = preserve_manual(scope_definitions(stored['definitionCandidates'][key], batch, inventory), snapshot)
                validate_definitions(assets, batch, snapshot)
            async with lock:
                stored['batches'][key] = assets
                completed = [a for k, values in stored['batches'].items() if k.startswith(kind+':') for a in values]
                await checkpoint(kind, 'RUNNING', KIND_NAMES[kind]+'已整理内容', describe(completed))
        async with lock:
            completed = [a for k, values in stored['batches'].items() if k.startswith(kind+':') for a in values]
            await checkpoint(kind, 'SUCCEEDED', KIND_NAMES[kind]+'定义', describe(completed) if objects else '当前脚本无需此类对象，已跳过模型调用。')

    results = await asyncio.gather(*(category(k) for k in KIND_NAMES), return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            raise result
    assets_by_id = {a['id']: a for values in stored['batches'].values() for a in values}
    assets = [assets_by_id[a['id']] for a in inventory]
    validate_definitions(assets, inventory, snapshot)
    if steps['IMAGE_PLAN']['status'] != 'SUCCEEDED':
        await checkpoint('IMAGE_PLAN', 'SUCCEEDED', '按需图片制作清单', '\n\n'.join(a['name']+'\n'+('\n'.join(i['name']+'：'+i['purpose']+'；'+i['requirements'] for i in a['preparation']['images']) or '暂不需要独立制作图片') for a in assets))
    audit_instruction = ('独立核对资产与完整脚本和BRIEF。检查必要对象遗漏、重复身份、产品事实及结构断言、分类特征、空间关系、未知信息、来源语义与图片需求。'
        '每个问题必须定位assetId和允许修改的字段，basis说明原文依据。必要修正标REQUIRED，一般优化标SUGGESTION。'
        '逐对象对照顶层description、knownFacts、designNotes、imageRequirements与结构化preparation.details、images、questions；图片制作要求既有顶层摘要也有逐图清单，两处均是实际生成依据。问题若同时出现在顶层文本和preparation内，必须分别定位这两个允许修改的字段，不能只报告顶层并留下清单中的同一错误。'
        '缺少资料但已明确待确认不是必须返修；合理人物场景设计不是产品事实错误。不要要求凭空补产品细节。'
        '明确区分资料事实与美术设计：knownFacts只能写原文已明确的内容；非产品对象的designNotes、分类details及图片要求允许确定墙面颜色、人物造型、普通道具材质等美术方案，无需原文逐项规定。不得仅因原文未规定这些设计就标REQUIRED，也不要求所有设计均待确认；产品未知结构仍不能补造。'
        '同一实质问题若影响多个字段，本次一次列全需要修改的字段；复核不应将已经允许的场景设计重新判成产品事实错误。'
        '资产公共参考图不是逐镜分镜图。仅检查已写明的对象结构与状态是否自洽，不以未复现每个剧情阶段、动作结果、全部相连设备或人物为REQUIRED；中性场景图、独立产品图均合法。逐镜动作与完整画面绑定留给视频制作节点。必要对象遗漏与已明确状态的实质矛盾仍须指出，同时核对knownFacts是否混入受众、安装位置、标识工艺等推导。'
        '跨对象设定若间接确定了未知产品结构、插脚/接口制式或兼容性，首次审校即为REQUIRED，不能只列优化建议后在复核升级。每个assetId+field只列一条，合并该字段内的全部问题。'
        '发现遗漏时定位最相关对象preparation字段并说明缺失对象；遗漏动作必需的独立对象仍属于必须修正的问题，不能用待确认说明掩盖。受保护字段存在冲突应指出，不允许自动重写。')
    if steps['REVIEW']['status'] != 'SUCCEEDED':
        await checkpoint('REVIEW', 'RUNNING', '全局独立审校', '正在核对实际对象、事实依据和制作要求')
        audit = AssetAudit.model_validate(await checked_audit('audit', 'ASSET_REVIEW', 'REVIEW', assets,
            {**context, 'inventory': inventory, 'assets': assets}, audit_instruction))
        await checkpoint('REVIEW', 'SUCCEEDED', '审校结论', audit.summary+'\n'+'\n'.join(next(a['name'] for a in assets if a['id']==f.assetId)+'：'+f.issue+'；依据：'+f.basis for f in audit.findings))
    if steps['REPAIR']['status'] != 'SUCCEEDED':
        required = [f for f in stored['audit']['findings'] if f['severity'] == 'REQUIRED']
        if required:
            # Never repeatedly pay for a repair/recheck that already failed semantic review.
            previous_findings = stored.get('recheck', {}).get('findings', [])
            if previous_findings and all(f['assetId'] in assets_by_id for f in previous_findings) and any(f['severity']=='REQUIRED' for f in previous_findings):
                raise ValueError('asset review still has unresolved issues')
            if 'revised' not in stored:
                old = {a['id']: a for a in existing}
                if any(f['field'] in protected_fields(old.get(f['assetId'], {})) for f in required):
                    await checkpoint('REPAIR', 'FAILED', '人工内容需要核对', '审校发现受保护内容存在问题，请查看审校依据后人工修改。')
                    raise ValueError('protected asset field requires manual review')
                await checkpoint('REPAIR', 'RUNNING', '修订具体字段', '\n'.join(f['issue'] for f in required))
                patch = await provider.generate('ASSET_REPAIR', snapshot['models']['creative'], AssetRepair,
                    {**context, 'assets': assets, 'findings': required},
                    '仅返回findings指定assetId和field的补丁，每个准确字段一次，不返回整份目录。正常字段不改。preparation字段填结构对象、text为null；其他字段填text、preparation为null。保留身份、归属和来源引用规则。未知信息明确待确认，不编造产品事实。')
                revised = apply_repair(assets, patch.model_dump(), stored['audit'], snapshot)
                validate_definitions(revised, inventory, snapshot)
                stored['revised'] = revised
                stored['patches'] = patch.model_dump()
                def field_text(asset: dict[str, Any], field: str) -> str:
                    return describe([asset]) if field == 'preparation' else str(asset[field])
                changes = '\n\n'.join(next(a['name'] for a in assets if a['id']==p.assetId)+' · '+FIELD_NAMES[p.field]+'\n修改前：'+field_text(next(a for a in assets if a['id']==p.assetId), p.field)+'\n修改后：'+field_text(next(a for a in revised if a['id']==p.assetId), p.field) for p in patch.patches)
                stored['repairChanges'] = changes
                await checkpoint('REPAIR', 'RUNNING', '修改内容', changes)
            assets = stored['revised']
            audit = AssetAudit.model_validate(await checked_audit('recheck', 'ASSET_RECHECK', 'REPAIR', assets,
                {**context, 'assets': assets, 'previousFindings': stored['audit']['findings']}, '核查原问题是否解决，复核修订后的完整目录。对照首次审校全部结论，解释确有新依据的问题；不能仅因未修改原建议就将其升级为必须修改。'+audit_instruction))
            await checkpoint('REPAIR', 'RUNNING', '复核结论', stored.get('repairChanges', '')+'\n\n'+audit.summary+'\n'+'\n'.join(f.issue for f in audit.findings))
            if any(f['severity'] == 'REQUIRED' for f in stored['recheck']['findings']):
                raise ValueError('asset review still has unresolved issues')
        stored['final'] = {'assets': assets, 'shots': []}
        await checkpoint('REPAIR', 'SUCCEEDED', '修订与复核结果', (stored.get('recheck', {}).get('summary') or '没有必须修改的问题，无需修订。')+'\n\n'+stored.get('repairChanges', '')+'\n\n'+describe(assets))
    await api.call('POST', 'complete', {'output': stored['final']})
