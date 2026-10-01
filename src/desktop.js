/** The isolated preload exposes only the desktop operations this UI needs. */
export function getDesktop() {
  const api = globalThis.suspensionDesktop;
  return api?.isDesktop === true ? api : null;
}

export function initDesktop({ notify }) {
  const desktop = getDesktop();
  if (!desktop) return;
  const commands = {
    'new-project': '#new-project-btn',
    'open-project': '#open-project-btn',
    'save-project': '#save-project-btn',
    'help': '#help-btn',
    'view-bench': '.workspace-nav a[href="#test-bench"]',
    'view-analysis': '.workspace-nav a[href="#analysis-section"]',
    'view-experiments': '.workspace-nav a[href="#experiment-workspace"]',
    'view-validation': '.workspace-nav a[href="#engineering-validation"]',
  };
  const unsubscribeCommand = desktop.onCommand(command => {
    if (!Object.hasOwn(commands, command)) return;
    const target = document.querySelector(commands[command]);
    if (target && !target.disabled) target.click();
  });
  const unsubscribeSaveResult = desktop.onSaveResult(result => {
    if (result?.error) notify(`파일 저장 실패: ${result.error}`, true);
    else if (result?.canceled) notify('파일 저장을 취소했습니다.');
    else if (result?.path) notify('파일을 저장했습니다.');
  });
  return () => { unsubscribeCommand(); unsubscribeSaveResult(); };
}
