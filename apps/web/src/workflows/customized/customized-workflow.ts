import { CUSTOMIZED_WORKFLOW_NODES } from '@ai-marketing/contracts';

export const customizedWorkflowNodes = [
  {
    label: '资料导入',
    status: '资料草稿',
    title: '资料包导入',
    description: '导入视频创作简报与可选品牌素材，明确产品信息和视频制作目标',
  },
  {
    label: '信息提炼',
    status: '待接入',
    title: '信息提炼',
    description: '整理简报中的品牌信息、产品信息与视觉约束，形成视频创作信息卡',
  },
  {
    label: '脚本创作',
    status: '待接入',
    title: '脚本创作',
    description: '围绕已确认简报创作多个完整故事，选定脚本后准备资产',
  },
  {
    label: '资产准备',
    status: '待接入',
    title: '资产准备',
    description: '从选定故事整理产品、人物、场景和道具，统一共用定义',
  },
  {
    label: '视频制作',
    status: '待接入',
    title: '视频制作',
    description: '按故事与资产目录拆镜、绑定素材并逐镜创作提示词',
  },
  {
    label: '素材交付',
    status: '待接入',
    title: '素材交付',
    description: '整理镜头素材和交付清单，交付给后期剪辑',
  },
].map((node, index) => ({ ...node, id: CUSTOMIZED_WORKFLOW_NODES[index]! }));
