from effect_extraction.document_facts import extract_structured_document_facts


def test_extracts_user_facts_from_information_card_table_without_video_config() -> None:
    markdown = """
| 信息层 | 字段 | 用户填写内容 |
| --- | --- | --- |
| 产品基础层 | 产品品类 | 腊味肉制品 |
|  | 产品名称 | 广式腊肠 |
|  | 核心规格 | 500g 真空袋装 |
|  | 价格信息 | 20 元/袋 |
|  | 视觉特征 | 红白相间，表面油润 |
| 卖点层 | 核心卖点 | 三七肥瘦黄金配比；广府糖酒腌制工艺；咸甜酒香回甘 |
|  | 次要卖点 | 纯猪肉无淀粉；真空锁鲜 |
| 用户层 | 目标受众画像 | 家庭厨房决策者；美食爱好者 |
|  | 核心痛点 | 日常佐餐选择少；担心口感不稳定 |
| 场景层 | 典型使用场景 | 煲仔饭烹饪；蒸制切片 |
|  | 购买场景 | 家庭日常采购；春节送礼 |
| 制作规则层 | 视频时长 | 60 秒 |
|  | 画幅比例 | 9:16 |
"""

    result = extract_structured_document_facts(markdown)

    assert result is not None
    assert result.product_category == "腊味肉制品"
    assert result.product_name == "广式腊肠"
    assert result.core_specification == "500g 真空袋装"
    assert result.price_range == "20 元/袋"
    assert result.selling_points == [
        "三七肥瘦黄金配比",
        "广府糖酒腌制工艺",
        "咸甜酒香回甘",
        "纯猪肉无淀粉",
        "真空锁鲜",
        "家庭厨房决策者",
        "美食爱好者",
        "日常佐餐选择少",
        "担心口感不稳定",
        "煲仔饭烹饪",
        "蒸制切片",
        "家庭日常采购",
        "春节送礼",
    ]
    assert set(result.model_fields_set) == {
        "product_category",
        "product_name",
        "core_specification",
        "price_range",
        "visual_features",
        "selling_points",
    }


def test_returns_none_for_unstructured_markdown_so_ai_can_handle_it() -> None:
    assert (
        extract_structured_document_facts("# 商品介绍\n这是一段普通产品说明。") is None
    )


def test_extracts_docling_heading_and_list_information_card() -> None:
    markdown = """
# 广式腊肠产品资料

## 产品基础层

### 品类
腊味肉制品

### 产品名称
广式三七瘦腊肠

### 核心规格
500g 真空袋装

### 价格信息
20 元/袋

## 卖点层

### 核心卖点
- 三七肥瘦黄金配比
- 广府糖酒腌制工艺
- 咸甜酒香回甘

### 次要卖点
- 纯猪肉无淀粉
- 真空锁鲜

## 用户层

### 目标受众画像
- 25-45 岁家庭厨房决策者
- 美食爱好者

### 核心痛点
- 日常佐餐缺少方便又有风味的肉食搭配

## 场景层

### 典型使用场景
- 煲仔饭烹饪
- 家庭日常佐餐

### 情绪氛围场景
- 家庭围餐的烟火气
- 春节团圆的喜庆氛围

填写确认：以上内容由资料提供方确认，作为本次效果类项目的信息提炼依据

## 制作规则层

### 视频时长
60 秒
"""

    result = extract_structured_document_facts(markdown)

    assert result is not None
    assert result.product_name == "广式三七瘦腊肠"
    assert result.selling_points == [
        "三七肥瘦黄金配比",
        "广府糖酒腌制工艺",
        "咸甜酒香回甘",
        "纯猪肉无淀粉",
        "真空锁鲜",
        "25-45 岁家庭厨房决策者",
        "美食爱好者",
        "日常佐餐缺少方便又有风味的肉食搭配",
        "煲仔饭烹饪",
        "家庭日常佐餐",
        "家庭围餐的烟火气",
        "春节团圆的喜庆氛围",
    ]


def test_preserves_decimal_specifications_in_heading_values_and_lists() -> None:
    markdown = """
### 产品名称
宠物循环饮水机

### 产品品类
宠物饮水用品

### 核心规格
2.5L 容量，USB 供电

### 核心卖点
- 循环水流保持持续可见的饮水动态
- 2.5L 容量适合日常家庭使用

### 核心痛点
- 忙碌时容易忘记查看和补充水量

### 核心使用场景
- 客厅日常饮水
"""

    result = extract_structured_document_facts(markdown)

    assert result is not None
    assert result.core_specification == "2.5L 容量，USB 供电"
    assert result.selling_points == [
        "循环水流保持持续可见的饮水动态",
        "2.5L 容量适合日常家庭使用",
        "忙碌时容易忘记查看和补充水量",
        "客厅日常饮水",
    ]


def test_stops_a_list_field_before_plain_confirmation_footer() -> None:
    markdown = """
### 产品名称
广式腊肠

### 产品品类
腊味肉制品

### 核心规格
500g 真空袋装

### 核心卖点
- 三七肥瘦黄金配比

### 核心痛点
- 担心肥瘦比例和口感不稳定

### 情绪氛围场景
- 家庭围餐的烟火气
- 节庆阖家欢聚的氛围

填写确认：以上内容由资料提供方确认，作为本次效果类项目的信息提炼依据
"""

    result = extract_structured_document_facts(markdown)

    assert result is not None
    assert result.selling_points == [
        "三七肥瘦黄金配比",
        "担心肥瘦比例和口感不稳定",
        "家庭围餐的烟火气",
        "节庆阖家欢聚的氛围",
    ]
    assert all("填写确认" not in value for value in result.selling_points)


def test_treats_explicit_empty_values_as_missing_facts() -> None:
    markdown = """
| 信息层 | 字段 | 用户填写内容 |
| --- | --- | --- |
| 产品基础层 | 产品名称 | 测试商品 |
|  | 产品品类 | 食品 |
| 卖点层 | 核心卖点 | 真实卖点 |
|  | 次要卖点 | 无 |
|  | 信任背书 | 暂无。 |
| 用户层 | 核心痛点 | 选择困难 |
| 场景层 | 使用场景 | 家庭餐桌 |
"""

    result = extract_structured_document_facts(markdown)

    assert result is not None
    assert result.selling_points == ["真实卖点", "选择困难", "家庭餐桌"]
