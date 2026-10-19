/**
 * 系统通知（Web Notification API）：
 *  - 仅在页面处于后台（或聊天面板收起）时弹系统通知，前台不打扰
 *  - 权限由用户在顶栏铃铛手动开启（浏览器要求用户手势触发申请）
 *  - 附带后台未读计数写入标题（前台也生效），回前台自动清零
 */

const BASE_TITLE = '星网 StarNet';
const LS_KEY = 'starnet.notify';

let enabled = false;
let unread = 0;

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notifyEnabled(): boolean {
  return enabled;
}

export async function toggleNotify(): Promise<boolean> {
  if (!supported()) {
    alert('当前浏览器不支持系统通知（局域网 http 环境部分浏览器不提供）');
    return false;
  }
  if (enabled) {
    enabled = false;
    localStorage.setItem(LS_KEY, '0');
    return false;
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm === 'granted') {
    enabled = true;
    localStorage.setItem(LS_KEY, '1');
    return true;
  }
  alert('通知权限被拒绝，请在浏览器站点设置中允许通知后重试');
  return false;
}

/** 恢复上次会话的开关状态（已授权才自动生效） */
export function restoreNotify(): void {
  if (supported() && localStorage.getItem(LS_KEY) === '1' && Notification.permission === 'granted') {
    enabled = true;
  }
}

function bumpTitle(): void {
  unread += 1;
  document.title = `(${unread}) ${BASE_TITLE}`;
}

function clearTitle(): void {
  unread = 0;
  document.title = BASE_TITLE;
}

window.addEventListener('focus', clearTitle);
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') clearTitle();
});

/** 消息级通知：内容 + 来源。后台时弹系统通知并累计标题未读数 */
export function pushNotify(title: string, body: string): void {
  bumpTitle();
  if (!enabled || document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body, tag: 'starnet-msg', silent: false });
    n.onclick = () => {
      window.focus();
      clearTitle();
      n.close();
    };
  } catch {
    /* 部分环境（Android Chrome 需 SW）失败时静默，标题计数仍然生效 */
  }
}
