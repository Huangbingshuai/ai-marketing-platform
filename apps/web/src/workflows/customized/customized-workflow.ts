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
    label: '分镜创作',
    status: '待接入',
    title: '分镜脚本',
    description: '围绕标准化 Brief 创作、导入和编辑多个分镜版本',
  },
  {
    label: 'Prompt',
    status: '待接入',
    title: '镜头 Prompt',
    description: '基于主分镜版本逐镜生成提示词与校验建议',
  },
  {
    label: '逐镜视频',
    status: '待接入',
    title: '逐镜视频',
    description: '按分镜准备和绑定项目资产，逐镜生成独立视频片段',
  },
  {
    label: '素材交付',
    status: '待接入',
    title: '素材交付',
    description: '整理镜头素材和交付清单，交付给后期剪辑',
  },
].map((node, index) => ({ ...node, id: CUSTOMIZED_WORKFLOW_NODES[index]! }));
