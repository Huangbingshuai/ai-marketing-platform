"""Build the editable Word brief and example from the same field definitions."""

from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = Path(__file__).resolve().parent
SECTIONS = [
    ("一 项目与视频用途", [
        ("项目名称", "例：618大促AI素材定制", "暮白晨间陶瓷杯新品短片"),
        ("视频用途", "信息流广告 / 社媒内容 / 电商详情页 / 品牌宣传 / 活动营销 / KOC分发 / 线下展示 / 其他", "新品介绍，展示外观与日常使用情境"),
        ("发布平台或位置", "抖音 / 小红书 / 微信 / 微博 / B站 / 快手 / 淘宝天猫 / 京东 / 线下 / 其他", "品牌官方社交账号，移动端观看"),
    ]),
    ("二 品牌与产品介绍", [
        ("品牌或产品名称", "填写品牌或产品全称", "暮白晨间 300 mL 陶瓷杯，米白款"),
        ("品牌或产品介绍", "产品介绍，可文字说明或直接上传附件", "陶瓷单杯，有弧形把手，无杯盖，适合日常盛放咖啡"),
        ("相关规格与用法", "产品规格、使用方法，可文字说明或直接上传附件", "300 mL；具体尺寸见“晨间杯产品说明.pdf”"),
    ]),
    ("三 目标受众", [
        ("目标人群年龄段", "18-24 / 25-30 / 31-40 / 41-50 / 50+ / 不限", "25-30"),
        ("性别倾向", "女性为主 / 男性为主 / 不限", "不限"),
        ("地域", "一线城市 / 全国 / 特定省份", "全国"),
        ("兴趣标签 / 人群画像", "关注什么？消费习惯？内容偏好？", "喜欢简洁家居与咖啡，关注日常生活质感，偏好安静自然的生活内容"),
    ]),
    ("四 创意需求", [
        ("核心主题 / 传达信息", "一句话概括核心卖点或信息", "留一点时间给早晨，让人感到安静、从容"),
        ("视觉风格偏好", "写实 / 插画 / 国潮 / 科技感 / 极简 / 温暖 / 高端 / 卡通 / 赛博朋克 / 复古 / 清新 / 商务 / 其他", "写实、极简，有晨间自然侧光"),
        ("主色调偏好", "如有品牌色，可填写颜色名称或色值，如 #0066FF", "以米白和浅木色为主，保留产品本身的米白色"),
        ("情绪调性", "活泼轻快 / 温馨治愈 / 高级质感 / 炫酷冲击 / 沉稳专业 / 趣味搞怪 / 待确认", "温馨治愈，安静、从容，节奏舒缓"),
        ("必须避免的元素", "行业禁忌 / 品牌红线 / 不出现的颜色或元素 / 无", "不改变杯子颜色或把手形状，不加杯盖或印花，不表达保温等未确认功能"),
    ]),
    ("五 视频规格", [
        ("视频时长", "5～15 秒 / 15～30 秒 / 30～60 秒 / 60 秒以上 / 自定义", "30 秒左右，允许 28～32 秒"),
        ("画幅或尺寸", "竖屏 9:16 / 横屏 16:9 / 方形 1:1 / 自定义尺寸", "9:16 竖屏，输出分辨率待确认"),
    ]),
]


def font(style, size, bold=False):
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "Microsoft YaHei")


def table(doc, rows, example, reference_heading):
    t = doc.add_table(rows=1, cols=3)
    t.autofit = False
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    widths = [3.5, 7.0, 6.7]
    for col, width in zip(t.columns, widths):
        col.width = Cm(width)
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        border = OxmlElement("w:" + edge)
        for key, value in {"val": "single", "sz": "4", "color": "D9D9D9"}.items():
            border.set(qn("w:" + key), value)
        borders.append(border)
    t._tbl.tblPr.append(borders)
    for cell, title in zip(t.rows[0].cells, ["填写项", "填写内容", reference_heading]):
        cell.text = title
    repeat = OxmlElement("w:tblHeader")
    t.rows[0]._tr.get_or_add_trPr().append(repeat)
    for label, options, value in rows:
        cells = t.add_row().cells
        for cell, text in zip(cells, [label, value if example else "", options]):
            cell.text = text
    for index, row in enumerate(t.rows):
        # Minimum height only: filled cells and long responses can grow naturally.
        row.height = Cm(0.67 if example else 0.78)
        cant_split = OxmlElement("w:cantSplit")
        row._tr.get_or_add_trPr().append(cant_split)
        for column, cell in enumerate(row.cells):
            cell.width = Cm(widths[column])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            margins = OxmlElement("w:tcMar")
            for side in ("top", "bottom", "left", "right"):
                margin = OxmlElement("w:" + side)
                margin.set(qn("w:w"), "75")
                margin.set(qn("w:type"), "dxa")
                margins.append(margin)
            cell._tc.get_or_add_tcPr().append(margins)
            if index == 0:
                shade = OxmlElement("w:shd")
                shade.set(qn("w:fill"), "EDF2F7")
                cell._tc.get_or_add_tcPr().append(shade)
            for p in cell.paragraphs:
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.12
                for run in p.runs:
                    run.font.size = Pt(9.5 if column == 2 else 10)
                    run.bold = index == 0
                    if column == 2 and index:
                        run.font.color.rgb = RGBColor.from_string("596579")


def build(example=False):
    doc = Document()
    s = doc.sections[0]
    s.page_width, s.page_height = Cm(21), Cm(29.7)
    s.top_margin, s.bottom_margin = Cm(1.65), Cm(1.65)
    s.left_margin, s.right_margin = Cm(1.9), Cm(1.9)
    normal = doc.styles["Normal"]
    font(normal, 10)
    normal.paragraph_format.space_after = Pt(5)
    font(doc.styles["Title"], 22, True)
    doc.styles["Title"].paragraph_format.space_after = Pt(9)
    font(doc.styles["Heading 1"], 13, True)
    doc.styles["Heading 1"].paragraph_format.space_before = Pt(7)
    doc.styles["Heading 1"].paragraph_format.space_after = Pt(6)
    doc.add_paragraph("视频创作简报填写示例" if example else "视频创作简报", "Title")
    if example:
        doc.add_paragraph("以下品牌、产品与文件名均为虚构，仅用于说明如何填写。")
    else:
        doc.add_paragraph("你希望做一支什么样的视频？把想法和已有资料填写在下表中即可。")
        doc.add_paragraph("在“填写内容”一栏填写，右侧说明、示例与选项仅供参考。没想好的可写“待确认”或“请 AI 提方案”，不涉及的可以留空；现成的产品介绍、规格说明可作为附件上传，不用重复填写。")
    for index, (heading, rows) in enumerate(SECTIONS):
        heading_paragraph = doc.add_paragraph(heading, "Heading 1")
        if index == 2:
            heading_paragraph.paragraph_format.page_break_before = True
        table(doc, rows, example, "备注 / 示例" if index < 2 else "可选项参考")
        if index == 1:
            doc.add_paragraph("涉及成分、性能、数据或效果时，提供相关说明资料即可；尚未确认的内容请注明“待确认”。")
    doc.core_properties.author = ""
    doc.core_properties.last_modified_by = ""
    doc.core_properties.title = "视频创作简报填写示例" if example else "视频创作简报"
    # Remove the built-in title rule and any inherited paragraph borders.
    for element in [style.element for style in doc.styles] + [p._p for p in doc.paragraphs]:
        for border in element.xpath(".//w:pBdr"):
            border.getparent().remove(border)
    destination = ROOT / ("视频创作简报填写示例.docx" if example else "视频创作简报模板.docx")
    doc.save(destination)
    # Validate editable fields and the independent audience section.
    check = Document(destination)
    assert len(check.tables) == 5
    assert sum(len(t.rows) - 1 for t in check.tables) == 17
    for index, t in enumerate(check.tables):
        assert [c.text for c in t.rows[0].cells] == ["填写项", "填写内容", "备注 / 示例" if index < 2 else "可选项参考"]
        assert all(bool(row.cells[1].text) == example for row in t.rows[1:])
    content = "\n".join(c.text for t in check.tables for row in t.rows for c in row.cells)
    assert "客户" not in content
    assert all(label not in content for label in ("想重点展示的特点", "希望给谁看", "填写提示", "已有的创意或故事", "必须包含的元素", "视频风格偏好", "文案安排", "声音形式", "配乐或音效偏好", "交付内容与数量"))
    assert [row.cells[0].text for row in check.tables[2].rows[1:]] == [row[0] for row in SECTIONS[2][1]]
    assert [row.cells[0].text for row in check.tables[3].rows[1:]] == [row[0] for row in SECTIONS[3][1]]
    assert all("参考图片与补充资料" not in p.text and "其他补充" not in p.text for p in check.paragraphs)
    print(destination)


if __name__ == "__main__":
    build()
    build(example=True)
