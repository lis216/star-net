/**
 * 文件保存/分享：
 *  - 桌面端：<a download> 即可
 *  - 手机端（iOS Safari 尤其）：blob URL 下载不可靠且会忽略 download 文件名，
 *    无类型 blob 会被当 text/plain 存成 .txt。优先走系统分享面板
 *    （Web Share API，可直接存相册/转发给其他 App），失败再退回 <a download>
 */

export async function saveBlobFile(url: string, name: string, mime?: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    const raw = await res.blob();
    // blobUrl 已带正确 MIME，这里仅兜底（老消息/异常路径仍可能是无类型 blob）
    const typed = raw.type ? raw : new Blob([raw], { type: mime || 'application/octet-stream' });
    const file = new File([typed], name, { type: typed.type });

    if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return true;
      } catch (e) {
        // 用户主动关闭分享面板：不回退下载，避免重复弹出
        if (e instanceof DOMException && e.name === 'AbortError') return true;
        // 其它失败（如权限）继续尝试 <a download>
      }
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.click();
    return true;
  } catch {
    return false;
  }
}
