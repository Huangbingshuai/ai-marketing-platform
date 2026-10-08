import { CUSTOMIZED_WORKFLOW_NODES } from '@ai-marketing/contracts';

export const customizedWorkflowNodes = [
  {
    label: '资料导入',
    status: '资料草稿',
    title: '资料包导入',
    description: '汇集品牌 Brief、产品、人设与风格参考，明确视频制作需求',
  },
  {
    label: '信息提炼',
    status: '待接入',
    title: '标准化提炼',
    description: '统一制作需求、卖点、受众、品牌调性和禁忌',
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
