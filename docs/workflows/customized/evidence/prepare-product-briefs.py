"""Create fictional multi-product paid fixtures; never calls providers or APIs.

Run with the Codex bundled Python runtime. Only document.xml is changed in
copies of the current Word template; all other OOXML members are preserved.
"""

import copy
import hashlib
import json
import os
from pathlib import Path
from zipfile import ZipFile

from lxml import etree

ROOT = Path(__file__).resolve().parents[4]
DEST = ROOT / "素材/定制类项目素材"
TEMP = Path(os.environ["TEMP"]) / "customized-products-paid-20261010"
TEMPLATE = ROOT / "docs/workflows/customized/templates/视频创作简报模板.docx"
LABELS = [
    "品牌名称",
    "项目名称",
    "项目背景",
    "品牌调性",
    "视觉统一规则",
    "画面禁用元素",
    "产品名称",
    "产品介绍",
    "产品规格",
    "产品外观",
    "核心卖点",
    "目标受众",
]
KEYS = [
    "brandName",
    "projectName",
    "projectBackground",
    "brandTone",
    "visualConsistencyRules",
    "avoidedElements",
    "productName",
    "productDescription",
    "productSpecifications",
    "productAppearance",
    "sellingPoints",
    "targetAudience",
]

# Each row is an independent product, not eight SKUs in one extraction task.
PRODUCTS = [
    (
        "01燕麦片",
        [
            "谷晨",
            "谷晨原味燕麦片早餐短片",
            "推出面向忙碌通勤人群的原味燕麦片，展示日常早餐中的谷物质感。",
            "朴实、温暖、自然，避免夸张功效表达。",
            "燕麦片保持浅米黄色薄片，包装正面只出现谷晨标识，晨光色温全片一致。",
            "不展示减肥效果，不出现零糖认证，不虚构有机认证。",
            "谷晨原味即食燕麦片",
            "配料仅为燕麦的即食谷物食品，供家庭日常早餐搭配。",
            "净含量450g；每袋15小包，每小包30g；保质期12个月。",
            "燕麦为浅米黄色不规则薄片；独立小包为米白色哑光袋；外盒尺寸待确认，请AI设计版式。",
            [
                "配料仅为燕麦，不添加其他配料",
                "15包独立分装，单包30g便于定量取用",
                "燕麦经过压片处理，保留薄片形态",
                "单袋450g，可按小包安排早餐份量",
            ],
            "25至40岁城市通勤人群，关注早餐便利性和原料清晰度。",
        ],
        None,
    ),
    (
        "02保湿霜",
        [
            "澄序",
            "澄序基础保湿霜新品展示",
            "介绍基础保湿护肤单品，突出乳霜质地和简洁包装。",
            "干净、温和、理性，不制造容貌焦虑。",
            "瓶身始终为半透明浅蓝色，乳霜保持白色，标识统一置于瓶身正面中部。",
            "不出现治疗、修复皮肤疾病及前后对比，不使用医学认证标识。",
            "澄序日常保湿霜",
            "面部日常保湿乳霜，配方含甘油和角鲨烷，不添加香精。",
            "净含量50g；单瓶装；未开封保质期36个月。",
            "半透明浅蓝色圆柱罐，白色旋盖，内容物为白色乳霜；包装盒请AI设计，罐型和颜色不变。",
            [
                "含甘油和角鲨烷的保湿配方",
                "不添加香精",
                "50g圆罐包装便于家庭梳妆台收纳",
                "白色乳霜质地，适合呈现涂抹时的延展状态",
            ],
            "20至35岁偏好基础护肤、关注配方信息的成年人。",
        ],
        "本文件补充澄序日常保湿霜的产品规格：罐体直径58mm，高46mm。上述尺寸已确定，包装盒版式仍请AI设计。未提供临床、敏感肌适用及防晒数据，不得推断此类功效。",
    ),
    (
        "03清洁剂",
        [
            "简净",
            "简净厨房清洁剂场景展示",
            "展示厨房日常清洁用品的瓶型、泡沫和台面场景。",
            "清爽、务实、有生活气息。",
            "瓶身固定为透明淡绿色，白色扳机喷头不变，保持真实泡沫尺度。",
            "不出现杀菌率、食品接触安全及无毒可饮用宣称；不混合不同清洁剂。",
            "简净厨房油污清洁剂",
            "厨房日常油污清洁用品，采用扳机喷雾瓶和柑橘香型。",
            "净含量500mL；每箱12瓶；保质期24个月。",
            "透明淡绿色扁圆瓶身，白色扳机喷头，液体呈浅黄色；标签保持简净品牌名，其他版式待设计。",
            [
                "扳机喷头可形成喷雾",
                "透明瓶身便于查看剩余液量",
                "500mL单瓶规格适合家庭厨房收纳",
                "采用柑橘香型",
            ],
            "25至50岁承担家庭厨房清洁的成年人，关注收纳和清洁便利性。",
        ],
        None,
    ),
    (
        "04充电器",
        [
            "弧电",
            "弧电65W充电器通勤展示",
            "推出用于通勤桌面和差旅的多口充电器，准确展示端口与尺寸。",
            "精确、克制、现代。",
            "深灰色机身和橙色USB-A接口内芯全片一致，端口数量固定。",
            "不展示所有设备均可65W充电，不虚构充电速度、认证或防水能力。",
            "弧电G65氮化镓充电器",
            "采用氮化镓方案的三口电源适配器，支持USB-C与USB-A设备连接。",
            "型号G65；2个USB-C、1个USB-A；单USB-C最高65W；输入100-240V；尺寸53×42×30mm；重量118g。",
            "深灰色磨砂长方体，折叠式双插脚，正面2个USB-C和1个橙色内芯USB-A，品牌标识在侧面。",
            [
                "折叠插脚便于放入差旅收纳袋",
                "提供2个USB-C和1个USB-A端口",
                "单USB-C端口最高输出65W",
                "机身重量118g",
            ],
            "20至40岁经常携带手机和笔记本电脑通勤的成年人。",
        ],
        "弧电G65补充规格：双USB-C同时连接时功率分配为45W+20W；三口同时连接时为45W+15W合计，后两口共享15W。单口65W不等于三口各65W。功率信息是规格，不能改写成全设备通用承诺。",
    ),
    (
        "05双肩包",
        [
            "山径",
            "山径轻行双肩包城市通勤短片",
            "围绕城市步行和公共交通展示双肩包的收纳结构。",
            "轻快、可靠、自然。",
            "石墨灰织物包身、黑色拉链和双肩带结构保持一致。",
            "不出现完全防水、极限负重及不存在的户外认证。",
            "山径轻行18L双肩包",
            "用于城市通勤的织物双肩包，设置电脑隔层与侧袋。",
            "容积18L；空包重量620g；尺寸42×28×14cm；电脑隔层适配14英寸笔记本电脑。",
            "石墨灰织物包身，黑色拉链，正面单个纵向拉链袋，左右各一个侧袋；包装待设计。",
            [
                "独立电脑隔层可容纳14英寸笔记本电脑",
                "背板设置透气网布",
                "左右侧袋可放置直径7cm的水杯",
                "正面纵向拉链袋便于分区收纳",
            ],
            "25至40岁城市通勤人群，偏好简洁穿搭和分区收纳。",
        ],
        None,
    ),
    (
        "06落地灯",
        [
            "栖光",
            "栖光阅读落地灯空间展示",
            "展示适合客厅阅读角的落地灯，突出光线层次与结构比例。",
            "安静、温暖、舒展。",
            "黄铜色灯杆、米白色布灯罩、深棕色圆底座固定，光线保持暖色。",
            "不展示护眼认证、无蓝光宣称及未提供的智能语音控制。",
            "栖光弧线阅读落地灯",
            "室内落地灯，采用金属弯臂与织物灯罩，配脚踏开关。",
            "总高158cm；底座直径28cm；E27灯头；额定电压220V；灯泡另配。",
            "黄铜色金属弯臂，米白色锥台布灯罩，深棕色圆形底座；灯罩直径36cm。",
            [
                "脚踏开关便于控制开闭",
                "E27灯头可搭配相应规格灯泡",
                "弯臂结构将光源延伸至座位旁",
                "织物灯罩形成柔和的空间光感",
            ],
            "28至50岁有客厅阅读角布置需求的家庭用户。",
        ],
        "栖光弧线阅读落地灯补充：灯罩高度22cm，电源线长1.8m，底座内置配重。外观设计已经确定。灯泡另配，色温与调光能力依所配灯泡，不提供统一固定色温或调光承诺。",
    ),
    (
        "07扭矩扳手",
        [
            "矩衡",
            "矩衡T60扭矩扳手结构展示",
            "展示自行车维护工具的刻度、锁定结构和收纳盒。",
            "严谨、清晰、可靠。",
            "银色金属杆身和黑色防滑握柄固定，刻度位置保持一致。",
            "不虚构校准证书、精度等级和安全保证，不展示带电操作。",
            "矩衡T60机械扭矩扳手",
            "用于螺纹紧固维护的可调机械扭矩扳手，采用棘轮头结构。",
            "扭矩范围10-60N·m；3/8英寸方头；总长365mm；重量780g。",
            "银色金属杆身，黑色防滑握柄，尾端旋转调节圈，黑色矩形收纳盒；精度待确认。",
            [
                "10-60N·m可调扭矩范围",
                "棘轮头支持切换转向",
                "尾端锁定圈固定设定位置",
                "配套收纳盒便于分类存放",
            ],
            "成年自行车爱好者与维修人员，具备基础工具使用知识。",
        ],
        None,
    ),
    (
        "08预约软件",
        [
            "席间",
            "席间门店预约系统功能介绍",
            "向小型服务门店介绍预约与排班协作，演示真实功能路径。",
            "友好、清晰、有秩序。",
            "界面主色为深蓝，预约状态采用固定颜色，虚构示例姓名保持一致。",
            "不出现真实个人信息，不宣称保证增收，不虚构用户规模、奖项和离线能力。",
            "席间门店预约系统标准版",
            "通过浏览器使用的门店预约管理软件，包含预约日历和员工排班，不是实体硬件。",
            "标准版支持1个门店、最多10个员工账号；支持电脑与手机浏览器；按年订阅。",
            "无实体外壳和包装；界面为深蓝顶部导航、白色日历区域和浅灰侧栏，Logo位置固定在左上角；具体图标请AI设计。",
            [
                "日历视图集中展示预约时段",
                "员工排班与可预约时段关联",
                "支持导出预约记录CSV文件",
                "不同员工账号按角色查看业务页面",
            ],
            "经营美容、美甲、摄影等预约制小型门店的负责人及店员。",
        ],
        "席间标准版补充规格：单次CSV导出最多5000条预约记录；员工角色分为管理员和普通员工。没有原生手机App，没有支付收款模块。此产品为软件服务，不得补造电池、机身尺寸、材质、物流包装及硬件资产。",
    ),
]


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    TEMP.mkdir(parents=True, exist_ok=True)
    reference = TEMP / TEMPLATE.name
    reference.write_bytes(TEMPLATE.read_bytes())
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    w = "{" + ns["w"] + "}"
    with ZipFile(TEMPLATE) as source:
        original = {i.filename: source.read(i.filename) for i in source.infolist()}
        root = etree.fromstring(original["word/document.xml"])
        section = root.find(".//w:sectPr", ns)
        inventory = {k: hashlib.sha256(v).hexdigest() for k, v in original.items()}
        (TEMP / "artifact.md").write_text(
            "# Retained template contract\n"
            f"Reference: {reference}\nSHA256: {hashlib.sha256(TEMPLATE.read_bytes()).hexdigest()}\n"
            "One section; two brand/product tables; twelve slots located at word/document.xml "
            "body/tbl/tr/tc[2], matched by first-cell labels. Preserve title, introduction, "
            "section headings, third-column examples, fonts, table widths, borders and all other "
            "package parts. Fill second cells only; clone existing paragraph/run formatting. "
            "Allow normal minimum-height row expansion. Rendering blocked: runtime contains no "
            "LibreOffice; renderer failed before authoring. No visual pass claimed.\n"
            f"Section XML: {etree.tostring(section).decode()}\n"
            f"Preserve-only inventory (document.xml editable): {json.dumps(inventory)}\n",
            encoding="utf-8",
        )
        cases = []
        fixtures = []
        for name, values, supplement in PRODUCTS:
            assert len(values) == len(KEYS)
            fields = dict(zip(KEYS, values))
            out = DEST / name
            out.mkdir(exist_ok=True)
            document = copy.deepcopy(root)
            rows = document.findall(".//w:tbl/w:tr", ns)
            filled = set()
            for row in rows:
                cells = row.findall("w:tc", ns)
                label = "".join(cells[0].xpath(".//w:t/text()", namespaces=ns))
                if label not in LABELS:
                    continue
                field = KEYS[LABELS.index(label)]
                value = fields[field]
                text = "\n".join(value) if isinstance(value, list) else value
                cell = cells[1]
                paragraph = cell.find("w:p", ns)
                assert paragraph is not None
                for p in cell.findall("w:p", ns)[1:]:
                    cell.remove(p)
                for child in list(paragraph):
                    if child.tag != w + "pPr":
                        paragraph.remove(child)
                run = etree.SubElement(paragraph, w + "r")
                style = cells[0].find(".//w:rPr", ns)
                if style is not None:
                    run.append(copy.deepcopy(style))
                for index, line in enumerate(text.split("\n")):
                    if index:
                        etree.SubElement(run, w + "br")
                    etree.SubElement(run, w + "t").text = line
                filled.add(field)
            assert filled == set(KEYS)
            path = out / "视频创作简报.docx"
            with ZipFile(path, "w") as target:
                for info in source.infolist():
                    target.writestr(
                        info,
                        etree.tostring(
                            document,
                            xml_declaration=True,
                            encoding="UTF-8",
                            standalone=True,
                        )
                        if info.filename == "word/document.xml"
                        else original[info.filename],
                    )
            with ZipFile(path) as check:
                assert all(
                    check.read(k) == v
                    for k, v in original.items()
                    if k != "word/document.xml"
                )
            files = [str(path)]
            if supplement:
                extra = out / "产品补充说明.txt"
                extra.write_text(supplement, encoding="utf-8")
                files.append(str(extra))
            checks = {
                key: [value] for key, value in fields.items() if isinstance(value, str)
            }
            # Fusion may polish scalar phrasing; assert critical facts per field below instead.
            critical = {
                "02保湿霜": {
                    "productSpecifications": ["50", "36", "58", "46"],
                    "productAppearance": ["浅蓝", "白色", "设计"],
                },
                "04充电器": {
                    "productSpecifications": ["65W", "45W", "20W", "15W", "118", "53"],
                    "productAppearance": ["深灰", "USB-C", "USB-A"],
                },
                "06落地灯": {
                    "productSpecifications": ["158", "28", "E27", "220", "1.8", "另配"],
                    "productAppearance": ["黄铜", "米白", "深棕", "36"],
                },
                "08预约软件": {
                    "productSpecifications": ["10", "5000", "年"],
                    "productAppearance": ["深蓝", "白色", "左上", "设计"],
                },
            }
            if supplement:
                checks = {
                    "brandName": [fields["brandName"]],
                    "productName": [fields["productName"]],
                    **critical[name],
                }
            cases.append(
                {
                    "name": name,
                    "files": files,
                    "expectedStatus": "COMPLETED",
                    "fieldContains": checks,
                    "sellingPoints": len(fields["sellingPoints"]),
                    "noBlockingIssues": True,
                    "validateSources": True,
                    "requireUnconfirmed": True,
                    "excludes": ["暮白", "300 mL", "陶瓷杯", "有机认证的燕麦"],
                    "fieldEquals": {"sellingPoints": fields["sellingPoints"]},
                    **(
                        {
                            "fieldExcludes": {
                                "productSpecifications": ["AI", "版式", "包装盒"]
                            }
                        }
                        if name == "02保湿霜"
                        else {}
                    ),
                }
            )
            fixtures.append(
                {
                    "name": name,
                    "fields": fields,
                    "supplement": supplement,
                    "files": [
                        str(Path(f).relative_to(ROOT)).replace("\\", "/") for f in files
                    ],
                }
            )
        (DEST / "测试资料索引.json").write_text(
            json.dumps(fixtures, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (DEST / "说明.txt").write_text(
            "多产品提炼验收资料\n八个品牌及产品均为虚构测试样本，不代表真实商品、认证或功效。\n"
            "每个子目录独立上传到一个定制类项目；不要把不同产品混入同一简报。\n"
            "上传视频创作简报.docx以及同目录中的产品补充说明.txt（若有）。\n"
            "本索引、说明及其他产品目录不参与模型输入。Word保留当前十二字段模板及示例列，"
            "用于检查示例排除；产品外观中的待确认和请AI设计应保留原意。\n",
            encoding="utf-8",
        )
        (TEMP / "cases.json").write_text(
            json.dumps(cases, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    print(
        json.dumps(
            {
                "products": len(cases),
                "documents": sum(len(c["files"]) for c in cases),
                "directory": str(DEST),
                "caseDirectory": str(TEMP),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
