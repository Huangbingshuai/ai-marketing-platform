/**
 * 智能填充与智能成片包装可能先 fork 出隔离分支。交接记录保留当前模板和成片选择，
 * 供同一工作台实例在新 Run 加载完成后恢复；若父页面因其他原因重建，也能恢复选择。
 * 只在新 Run 加载时读取，不能让旧 Run 的普通刷新提前消费。
 */
export type EffectTemplateMixWorkbenchHandoff = {
  workflowRunId: string;
  templateId: string;
  variantId: string;
};

let handoff: EffectTemplateMixWorkbenchHandoff | null = null;

export const rememberWorkbench = (next: EffectTemplateMixWorkbenchHandoff): void => {
  handoff = next;
};

/**
 * 只交接一次：无论取回时 Run 是否对得上都会清掉，否则一次没落地的切换会让这份交接留到用户
 * 之后手动切到那个分支时才生效，把人家莫名其妙带进工作台。
 */
export const takeWorkbench = (workflowRunId: string): EffectTemplateMixWorkbenchHandoff | null => {
  const taken = handoff?.workflowRunId === workflowRunId ? handoff : null;
  handoff = null;
  return taken;
};
