"""Scope commerce review to the actual purchase question, without treating the plan as proof."""
from .ecommerce_v2 import PLAN as PLAN, WRITE as WRITE, REVIEW as V2_REVIEW, OBSERVATION as OBSERVATION

REVIEW = V2_REVIEW + """
reviewScope.purchaseQuestion只声明本片要回应的购买疑问，是验收范围，不是已实现的证据。仍必须引用实际正文：没有兑现就FAIL，不能凭策划问题清楚而放行。实际正文若偏离或提出其他承诺，仍核查其全部主要表达，不能借范围跳过。
每份只需成立一个具体购买理由，不要求产品全部用途和卖点都出现。收纳或携带稿不因未演示供电、口感稿不因未说成分、软件某任务稿不因未展示全部功能而产生缺口；不能提出不必要的跨卖点补拍/补口播建议。只有这份正文的实际需要或主张确实依赖缺失依据时才指出，不以完整产品介绍为默认目标。
参数解释可直接解决买前的真实条件/选择问题，不必强加品牌隐喻；判断其是否已结合具体使用或选择、是否重复宣告和限制。对已正确限定的规格，不重复要求长免责声明，信息容量审查仍按实际语速和观察时间。
"""
