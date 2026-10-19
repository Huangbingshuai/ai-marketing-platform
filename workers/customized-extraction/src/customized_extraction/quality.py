from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, cast

from .documents import restore_selling_point_sources
from .models import (
    AuditReport,
    BriefField,
    Candidate,
    LABELS,
    RepairContext,
    Review,
    RawAuditReport,
    ConflictFieldPlan,
    ConflictPlanReview,
    ConflictDecision,
    ConflictResolution,
)
from .provider import Provider
from extraction_runtime.documents import split_document_markdown
from .activity import Progress

Validator = Callable[[Candidate, list[dict[str, Any]]], None]
CONFLICT_POLICY_VERSION = 2


class AuditValidationError(ValueError):
    """Safe diagnostics without document text or model response bodies."""


MERGE_INSTRUCTION = """整理输入信息卡，返回完整12字段及来源。
先核对是否为同一品牌、产品、型号与版本，再判断互补、重复与实质矛盾。
完整保留独立事实；相同事实可消除重复，但不同规格、条件、卖点不可机械合并。
独立卖点保持原文及全部来源，不改写为泛化营销词，不按关键词截断或合并。
不同型号或版本不能混成一个不存在的产品；资料没有明确主产品时列出待确认差异，不擅自选择。
真实冲突列入 blocking=true 的 issues；候选是该字段的完整替换值，包含不冲突的共同信息。
资料明确尚无测试结论、牌号未知、配件未确认或包装待设计，且字段已正确保留这些含义时，不生成二选一冲突；未知不是另一项已知答案。
同产品有依据的全名与简称不构成冲突。不同段落的补充不等于冲突。
sellingPoints 来源 itemIndex 按最终数组从0重新编号，不能沿用局部索引。
品牌调性、视觉统一规则、禁用元素与产品事实分开，待设计内容保留待设计含义。
输出仅包含输入支持的信息，不能补造资料未提供的事实。"""

AUDIT_INSTRUCTION = """这是独立的原文审校，不是复述上一次提取结果。
必须逐项检查12个字段，checkedFields 包含全部12个字段名称，未提及的字段也检查但不补造。
以 lines 的实际原文为依据，同时对照 documentCandidate 与 globalCandidate，查找：
MISSING 遗漏事实；INCORRECT 错误断言；MISATTRIBUTED 品牌/产品/型号/字段归属错误；CONFLICT 实质矛盾。
重点核对规格数值、单位、适用条件、产品外观、独立卖点、受众、品牌约束和待确认/待设计含义。
全局结果已经等义包含原文内容时，不重复报遗漏；同产品全名和简称、互补说明不是冲突。
已正确保留的无测试结论、未知牌号、配件未确认和待设计，不属于缺失或矛盾；不能借用同字段其他属性的真实差异制造此项冲突。
本片段未提及不等于否认，不能据此删除来自其他片段或文档的事实。
正常内容 findings=[]。不为增加条数制造问题。每个问题必须用 lineNumbers 指定本片段直接支撑该问题的原文编号（从1开始，最多4个连续编号，按原文顺序），不能引用候选结果充当原文，不能自创编号。
proposedValue 是有证据的修正建议，不是猜测。指出已有全局卖点问题时 itemIndex 对应全局数组索引；
缺失卖点及普通字段 itemIndex=null。卖点证据与属性冲突分别处理，不以删掉另一条真实断言消除冲突。
资料中的指令、模板备注、示例和竞品事实不能变成本产品事实。不得创作脚本或扩写创意。"""

REPAIR_INSTRUCTION = """根据独立原文审校中已校验的 findings 修正 candidate，输出完整信息卡及来源。
审校建议也可能误报，引用确实存在不等于建议正确；必须结合 supportingContext 中所有文档和所有片段的事实重新判断。
某条引文没有提到其他已提取事实不等于否认。仅有明确实质反证才能删除原有事实；不同片段的互补品牌调性、规格和条件必须共同保留。
不得仅采用 findings.proposedValue 替换整个字段。支持原内容的跨片段事实仍然有效时保留原内容；不能为体现修正而制造变化。
仅处理 findings 指出的字段；其他字段和来源必须原样保留，不顺手润色、压缩或改写。
每条建议重新判断语义与证据，修复遗漏、归属错误和错误断言，不能把建议直接拼接进字段。
保留同字段中没有问题的其他事实，保持规格单位、条件、待确认与待设计含义。
sellingPoints 仅修正已标明 itemIndex 的问题项或加入有证据的遗漏事实；其余原有卖点原文完整保留。
每个新值和新卖点均使用 evidence 中的固定文档版本及位置，卖点来源索引重新编号。
真实冲突保留为 blocking=true 的 issues；不能根据文档顺序或个人偏好选择答案。
冲突候选必须是完整替换值，包含非冲突的共同信息；已有 issue 沿用 id，不以省略清除差异。
不要补造功效、规格、认证或外观，不添加产品使用方式、创意方向或视频规格字段。"""


FINAL_REVIEW_INSTRUCTION = """根据 documentCandidates、verifiedRawFindings 和 supportingRawContext 核对 candidate 中无依据断言与实质矛盾。
supportingRawContext 是重新阅读所有文档片段取得的支持事实及逐字引文，应结合全部上下文判定审校建议是否误报；不能把某条引文的未提及当作否认，也不能把 proposedValue 当成权威答案。
verifiedRawFindings 的逐字原文证据已经过固定文档校验，优先于可能遗漏或归属错误的首轮 documentCandidates；不能把有原文证据的修正误判为无依据，也不能恢复已纠正的错误。
判断顺序：先判断各文档是否在说同一产品，再判断同一属性的断言是否互斥。
完整名称与同产品补充资料的简称、型号代称不是互斥事实；一份文档未提及某字段也不构成冲突。
不得仅因两份文档 productName 文本不同生成 issue；已保留明确完整名称且其他文档只是简称时属于正常项。
返回全部仍成立的 issues，包括核对后保持不变的既有条目；正常项不创建提示，不改写原始事实。
不强制补齐空字段。
字段已正确记录的未知、无测试结论、待设计不是实质冲突，不应要求在同义说法之间二选一；已有此类误报应明确列入 dismissedIssueIds。其他属性的真实冲突不得借作这条未知提示的 alternatives。
已有冲突须逐条重新阅读 documentCandidates 的完整字段，先找出所有非冲突事实，再仅替换互斥部分，为每个 alternatives 重建完整字段值；不得直接照抄可能残缺的融合候选。
修订已有 issue 时沿用其 id。
dismissedIssueIds 仅填经原始文档核对后明确属于误报的已有 issue id，例如同产品全名与简称；不存在误报时返回空数组。
不能因缺少证据、自己偏好某个候选、或候选措辞相似而消除真实规格冲突；仅省略 issue 不能消除它。
必须逐一复核已有冲突的 alternatives：每项都是用户选用后替换整个字段的完整值，不是冲突片段。
某一规格冲突不代表整组规格冲突；一份文档未提及某项事实不等于否认，其他文档明确且没有反证的事实须保留在每个候选中。
即使融合时字段被清空，也须从 documentCandidates 找回这些共同信息。
仅当资料已明确保质期12个月、仅净含量200g和250g冲突时，两项候选都必须含保质期12个月。
不得增加无依据事实。"""


def source_lines(text: str) -> list[str]:
    return [
        line[start : start + 400]
        for line in text.splitlines()
        for start in range(0, len(line), 400)
    ]


async def collect_repair_context(
    provider: Provider,
    semaphore: asyncio.Semaphore,
    documents: list[tuple[dict[str, Any], str]],
    report: AuditReport,
    chunk_chars: int,
    additional_fields: list[BriefField] | None = None,
    on_progress: Progress | None = None,
) -> list[dict[str, Any]]:
    """Read every source chunk for affected fields, including evidence the critic overlooked."""
    fields = sorted({f.field for f in report.findings} | set(additional_fields or []))
    if not fields:
        return []
    chunks = [
        (doc, index, chunk)
        for doc, text in documents
        for index, chunk in enumerate(
            split_document_markdown(text, max_chars=chunk_chars)
        )
    ]
    done: set[tuple[str, int]] = set()
    if on_progress:
        await on_progress(0, len(chunks))

    async def read(doc: dict[str, Any], index: int, text: str) -> dict[str, Any]:
        # Number verbatim source segments so models reference evidence without retyping it.
        lines = source_lines(text)
        async with semaphore:
            result = await provider.generate(
                "SEMANTIC_REFINEMENT",
                "为修正审校误报提供独立原文依据。逐项整理 lines 原文中与 requestedFields 相关的全部明确事实，包含相互补充的调性、规格、条件及待确认含义；未提及的字段不补造。只读取原文，不接收候选或审校建议作为答案。不同片段的补充不得视为否定。facts 中每项只填请求范围内的字段及有依据的事实，lineNumbers 列出 lines 中直接支撑此事实的原文编号（从1开始），不要自创编号；同一事实反复出现只需保留一次，不生成新故事或创意。",
                json.dumps(
                    {
                        "document": {
                            key: doc[key] for key in ("assetId", "assetVersion", "name")
                        },
                        "chunk": index + 1,
                        "requestedFields": fields,
                        "lines": [
                            {"lineNumber": n + 1, "text": line}
                            for n, line in enumerate(lines)
                        ],
                    },
                    ensure_ascii=False,
                ),
                RepairContext,
            )
        if any(f.field not in fields for f in result.facts):
            raise AuditValidationError("repair context returned an unrelated field")
        if any(
            any(number < 1 or number > len(lines) for number in f.lineNumbers)
            or len(set(f.lineNumbers)) != len(f.lineNumbers)
            for f in result.facts
        ):
            raise AuditValidationError(
                "repair context references an invalid source line"
            )
        done.add((doc["assetId"], index))
        if on_progress:
            await on_progress(len(done), len(chunks))
        return {
            "assetId": doc["assetId"],
            "assetVersion": doc["assetVersion"],
            "location": f"文档片段 {index + 1}",
            "facts": [
                {
                    **f.model_dump(),
                    "quote": "\n".join(lines[number - 1] for number in f.lineNumbers),
                }
                for f in result.facts
            ],
        }

    values = await asyncio.gather(
        *(read(doc, index, chunk) for doc, index, chunk in chunks),
        return_exceptions=True,
    )
    for value in values:
        if isinstance(value, BaseException):
            raise value
    return cast(list[dict[str, Any]], values)


async def review_candidate(
    provider: Provider,
    instruction: str,
    payload: dict[str, Any],
    candidate: Candidate,
) -> Review:
    """Require a model decision for every existing issue, never silently skip its review."""
    required = {issue.id for issue in candidate.issues}
    for attempt in range(2):
        result = await provider.generate(
            "SEMANTIC_REFINEMENT",
            instruction,
            json.dumps(payload, ensure_ascii=False),
            Review,
        )
        returned = [issue.id for issue in result.issues]
        dismissed = set(result.dismissedIssueIds)
        if (
            len(dismissed) != len(result.dismissedIssueIds)
            or not dismissed.issubset(required)
            or dismissed.intersection(returned)
        ):
            raise AuditValidationError("review dismissed issue identifiers are invalid")
        if len(returned) != len(set(returned)):
            raise AuditValidationError("review returned duplicate issue identifiers")
        missing = required - set(returned) - dismissed
        if not missing:
            return result
        if attempt == 1:
            raise AuditValidationError("review did not cover all existing issues")
        instruction += "\n上次没有逐项返回所有已有差异。必须以原 id 返回每条仍成立的 issue，并重新核对完整 alternatives；明确误报才列入 dismissedIssueIds，不能省略。"
        payload = {**payload, "requiredIssueIds": sorted(required)}
    raise AssertionError("unreachable review retry")


async def complete_conflict_alternatives(
    provider: Provider,
    semaphore: asyncio.Semaphore,
    candidate: Candidate,
    document_candidates: list[dict[str, Any]],
    context: list[dict[str, Any]],
    on_progress: Progress | None = None,
) -> Candidate:
    """AI owns semantic scope; code preserves all text outside a verified unique anchor."""
    if on_progress:
        await on_progress(0, len(candidate.issues))
    if not candidate.issues:
        return candidate.model_copy(deep=True)
    fields = list(dict.fromkeys(issue.field for issue in candidate.issues))

    async def refine(field: str) -> tuple[ConflictFieldPlan, dict[str, Any]]:
        issues = [issue for issue in candidate.issues if issue.field == field]
        current = cast(str, getattr(candidate.fields, field))
        payload = {
            "field": field,
            "currentValue": current,
            # Old full-field alternatives can contain the very cross-issue error
            # being repaired. They are not source evidence for the next decision.
            "issues": [issue.model_dump(exclude={"alternatives"}) for issue in issues],
            "documentValues": [
                {"value": d["fields"][field], "sources": d["fieldSources"][field]}
                for d in document_candidates
            ],
            "supportingRawContext": [
                {
                    **{k: c[k] for k in ("assetId", "assetVersion", "location")},
                    "facts": [f for f in c["facts"] if f["field"] == field],
                }
                for c in context
            ],
        }
        async with semaphore:
            plan = await provider.generate(
                "SEMANTIC_REFINEMENT",
                "逐一核对当前字段的每个 issue，严格沿用 id，结合全部原文依据判断，不按文档顺序选择答案。"
                "kind=CONFLICT 仅用于同一属性的明确互斥断言；anchor 必须逐字摘取 currentValue 中仅属于本问题、可唯一定位的最小连续片段，choices 至少两项且 replacement 只替换本问题。"
                "不得因为同字段另有容量冲突，就给性能未测、配件未知等问题返回容量选项；不得顺带确定其他未知属性、改写互补事实或整段重写字段。不同问题的 anchor 不得重叠。"
                "currentValue 为空时 anchor 为空，replacement 须包含该字段原文共同事实，其他未知仍保留；非空字段不得用空 anchor 追加内容。"
                "kind=DISMISS 用于已被当前字段正确保留的未知、待确认/待设计、互补事实或同义表达，不要求二选一；INFORMATION 用于仍值得提示但没有互斥答案的信息缺口，不能伪造两个候选。"
                "DISMISS/INFORMATION 的 anchor 为空且 choices=[]。reason 仅写简短可核对的业务依据，不输出思考过程。真实容量430与480尚无优先级时仍是CONFLICT，不能借未知或同义名义撤销。",
                json.dumps(payload, ensure_ascii=False),
                ConflictFieldPlan,
            )
        expected = {issue.id for issue in issues}
        returned = [decision.id for decision in plan.decisions]
        if set(returned) != expected or len(returned) != len(expected):
            raise AuditValidationError("conflict plan issue identifiers are invalid")
        ranges: list[tuple[int, int]] = []
        for decision in plan.decisions:
            if decision.kind != "CONFLICT":
                if decision.anchor or decision.choices:
                    raise AuditValidationError("non-conflict decision contains choices")
                continue
            if len(decision.choices) < 2 or current.count(decision.anchor) != 1:
                raise AuditValidationError("conflict anchor or choice count is invalid")
            start = current.find(decision.anchor)
            span = (start, start + len(decision.anchor))
            if any(
                span == old or max(span[0], old[0]) < min(span[1], old[1])
                for old in ranges
            ):
                raise AuditValidationError("conflict anchors overlap")
            ranges.append(span)
            replacements = [choice.replacement for choice in decision.choices]
            if any(not value.strip() for value in replacements) or len(
                set(replacements)
            ) != len(replacements):
                raise AuditValidationError("conflict choices are empty or duplicated")
        return plan, payload

    values = await asyncio.gather(
        *(refine(field) for field in fields), return_exceptions=True
    )
    for value in values:
        if isinstance(value, BaseException):
            raise value
    plans = cast(list[tuple[ConflictFieldPlan, dict[str, Any]]], values)
    async with semaphore:
        review = await provider.generate(
            "SEMANTIC_REFINEMENT",
            "独立核对每个差异决策，不默认相信 plan.reason。依据原文逐 id 返回 valid 与简短理由；必须覆盖所有输入issue，不增删或重复id。"
            "逐项检查：CONFLICT 是否确为当前问题的互斥事实，anchor 是否最小且仅属于该问题，replacement 是否有原文支持并完整保留本问题的共同条件；"
            "不得顺带确定其他未确认属性或删除同字段的互补事实。例如性能未测/配件未知问题不能通过候选顺带选容量，容量问题也不能替其他属性作决定。"
            "DISMISS 仅用于当前字段已正确保留的未知/待设计、同义或互补信息，不能撤销仍存在的真实容量差异；INFORMATION 不得伪造二选一。"
            "凡分类、范围、依据或保留信息有误，valid=false；不要替计划改写答案，不输出思考过程。",
            json.dumps(
                [{**payload, "plan": plan.model_dump()} for plan, payload in plans],
                ensure_ascii=False,
            ),
            ConflictPlanReview,
        )
    expected_ids = {issue.id for issue in candidate.issues}
    reviewed_ids = [verdict.id for verdict in review.verdicts]
    if set(reviewed_ids) != expected_ids or len(reviewed_ids) != len(expected_ids):
        raise AuditValidationError(
            "conflict scope review issue identifiers are invalid"
        )
    if any(not verdict.valid for verdict in review.verdicts):
        raise AuditValidationError("conflict scope review rejected candidate plan")
    decisions: dict[str, ConflictDecision] = {
        decision.id: decision for plan, _ in plans for decision in plan.decisions
    }
    result = candidate.model_copy(deep=True)
    for issue in result.issues:
        decision = decisions[issue.id]
        issue.alternatives = []
        issue.resolution = None
        if decision.kind == "CONFLICT":
            issue.blocking = True
            current = cast(str, getattr(candidate.fields, issue.field))
            start = current.find(decision.anchor)
            end = start + len(decision.anchor)
            replacements = [choice.replacement for choice in decision.choices]
            issue.alternatives = [
                current[:start] + replacement + current[end:]
                for replacement in replacements
            ]
            if any(len(value) > 50000 for value in issue.alternatives):
                raise AuditValidationError("conflict alternative exceeds field limit")
            issue.resolution = ConflictResolution(
                schemaVersion=1,
                baseValue=current,
                before=decision.anchor,
                replacements=replacements,
            )
        else:
            issue.blocking = False
    result.issues = [
        issue for issue in result.issues if decisions[issue.id].kind != "DISMISS"
    ]
    if on_progress:
        await on_progress(len(candidate.issues), len(candidate.issues))
    return result


async def merge_candidates(
    provider: Provider,
    semaphore: asyncio.Semaphore,
    validate: Validator,
    candidates: list[Candidate],
    documents: list[dict[str, Any]],
    stage: str,
) -> Candidate:
    """Model decides semantic consolidation; code only orders and validates evidence."""
    values = [c for c in candidates if any(c.fields.model_dump().values()) or c.issues]
    if not values:
        return candidates[0]

    async def merge(left: Candidate, right: Candidate) -> Candidate:
        async with semaphore:
            result = await provider.generate(
                stage,
                MERGE_INSTRUCTION,
                json.dumps([left.model_dump(), right.model_dump()], ensure_ascii=False),
                Candidate,
            )
        result = restore_selling_point_sources(result, [left, right])
        validate(result, documents)
        return result

    while len(values) > 1:
        merged = await asyncio.gather(
            *(merge(values[i], values[i + 1]) for i in range(0, len(values) - 1, 2)),
            return_exceptions=True,
        )
        for value in merged:
            if isinstance(value, BaseException):
                raise value
        values = cast(list[Candidate], merged) + (
            values[-1:] if len(values) % 2 else []
        )
    return values[0]


def validate_audit(
    report: AuditReport,
    document: dict[str, Any],
    text: str,
    candidate: Candidate,
) -> None:
    if len(report.checkedFields) != len(LABELS) or set(report.checkedFields) != set(
        LABELS
    ):
        raise AuditValidationError("raw audit did not check all contract fields")
    normalized = "".join(text.split())
    for finding in report.findings:
        source = finding.evidence
        if (
            source.assetId != document["assetId"]
            or source.assetVersion != document["assetVersion"]
            or not source.location.strip()
            or not source.quote.strip()
            or "".join(source.quote.split()) not in normalized
        ):
            raise AuditValidationError(
                "raw audit evidence is not present in the pinned document"
            )
        if (
            finding.field == "sellingPoints"
            and finding.kind != "MISSING"
            and finding.itemIndex is None
        ):
            raise AuditValidationError(
                "raw audit existing selling point requires its global index"
            )
        if finding.itemIndex is not None and (
            finding.field != "sellingPoints"
            or finding.itemIndex >= len(candidate.fields.sellingPoints)
            or finding.kind == "MISSING"
        ):
            raise AuditValidationError("raw audit selling point index is invalid")


async def audit_document(
    provider: Provider,
    semaphore: asyncio.Semaphore,
    document: dict[str, Any],
    text: str,
    document_candidate: Candidate,
    global_candidate: Candidate,
    chunk_chars: int,
    on_progress: Progress | None = None,
) -> tuple[AuditReport, int]:
    chunks = split_document_markdown(text, max_chars=chunk_chars)
    if not chunks:
        raise ValueError("parsed document contains no auditable text")
    done: set[int] = set()
    if on_progress:
        await on_progress(0, len(chunks))

    async def audit(index: int, chunk: str) -> AuditReport:
        instruction = AUDIT_INSTRUCTION
        lines = source_lines(chunk)
        for attempt in range(2):
            async with semaphore:
                raw_report = await provider.generate(
                    "SEMANTIC_REFINEMENT",
                    instruction,
                    json.dumps(
                        {
                            "document": {
                                k: document[k]
                                for k in ("assetId", "assetVersion", "name")
                            },
                            "chunk": index + 1,
                            "lines": [
                                {"lineNumber": n + 1, "text": line}
                                for n, line in enumerate(lines)
                            ],
                            "documentCandidate": document_candidate.model_dump(),
                            "globalCandidate": global_candidate.model_dump(),
                        },
                        ensure_ascii=False,
                    ),
                    RawAuditReport,
                )
            try:
                findings = []
                for finding in raw_report.findings:
                    numbers = finding.lineNumbers
                    if (
                        numbers[0] < 1
                        or numbers[-1] > len(lines)
                        or numbers != list(range(numbers[0], numbers[-1] + 1))
                    ):
                        raise AuditValidationError(
                            "raw audit references invalid or nonconsecutive source lines"
                        )
                    findings.append(
                        {
                            **finding.model_dump(exclude={"lineNumbers"}),
                            "evidence": {
                                "assetId": document["assetId"],
                                "assetVersion": document["assetVersion"],
                                "location": f"文档片段 {index + 1} · 原文 {numbers[0]}–{numbers[-1]}",
                                "quote": "\n".join(lines[n - 1] for n in numbers),
                            },
                        }
                    )
                report = AuditReport.model_validate(
                    {"checkedFields": raw_report.checkedFields, "findings": findings}
                )
                validate_audit(report, document, chunk, global_candidate)
                done.add(index)
                if on_progress:
                    await on_progress(len(done), len(chunks))
                return report
            except AuditValidationError as error:
                logging.warning(
                    "Raw audit validation chunk=%d attempt=%d reason=%s",
                    index + 1,
                    attempt + 1,
                    error,
                )
                if attempt == 1:
                    raise
                instruction = (
                    AUDIT_INSTRUCTION
                    + "\n上一次审校未通过确定性校验："
                    + str(error)
                    + "。重新逐项核对；lineNumbers 必须来自 lines 的合法连续编号，按原文顺序。checkedFields 完整列出12个不同字段。不得为了通过校验省略真实问题。"
                )
        raise AssertionError("unreachable audit retry")

    reports = await asyncio.gather(
        *(audit(i, chunk) for i, chunk in enumerate(chunks)),
        return_exceptions=True,
    )
    for report in reports:
        if isinstance(report, BaseException):
            raise report
    valid = cast(list[AuditReport], reports)
    return AuditReport(
        checkedFields=cast(list[BriefField], list(LABELS)),
        findings=[finding for report in valid for finding in report.findings],
    ), len(chunks)


async def repair_candidate(
    provider: Provider,
    semaphore: asyncio.Semaphore,
    validate: Validator,
    candidate: Candidate,
    report: AuditReport,
    documents: list[dict[str, Any]],
    supporting_context: list[dict[str, Any]] | None = None,
) -> Candidate:
    if not report.findings:
        return candidate
    async with semaphore:
        result = await provider.generate(
            "SEMANTIC_REFINEMENT",
            REPAIR_INSTRUCTION,
            json.dumps(
                {
                    "candidate": candidate.model_dump(),
                    "findings": [f.model_dump() for f in report.findings],
                    "supportingContext": supporting_context or [],
                },
                ensure_ascii=False,
            ),
            Candidate,
        )
    changed = {finding.field for finding in report.findings}
    for key in LABELS:
        if key not in changed and (
            getattr(result.fields, key) != getattr(candidate.fields, key)
            or getattr(result.fieldSources, key) != getattr(candidate.fieldSources, key)
        ):
            raise AuditValidationError(
                f"raw audit repair changed an unrelated field: {key}"
            )
    affected_points = {
        f.itemIndex
        for f in report.findings
        if f.field == "sellingPoints" and f.itemIndex is not None
    }
    for index, point in enumerate(candidate.fields.sellingPoints):
        if index not in affected_points and point not in result.fields.sellingPoints:
            raise AuditValidationError(
                "raw audit repair discarded an unaffected selling point"
            )
    issues = {issue.id: issue for issue in candidate.issues}
    issues.update({issue.id: issue for issue in result.issues})
    result.issues = list(issues.values())
    validate(result, documents)
    return result
