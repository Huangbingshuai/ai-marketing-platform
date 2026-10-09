/** Space belongs to playback in the active workbench, not the last focused control. */
export function ownsPlayerSpace(
  event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>,
  context: { active: boolean; blocked: boolean; textEditing: boolean; inDialog: boolean },
): boolean {
  return (
    (event.code === 'Space' || event.key === ' ') &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.isComposing &&
    context.active &&
    !context.blocked &&
    !context.textEditing &&
    !context.inDialog
  );
}
