/**
 * 界面可见性：轮询器的统一"现在该不该发请求"判据。
 *
 * 管家有几个 15 秒定时器（工作台总览、右栏试用/用量/整理结果）。它们以前
 * 在页面被切到后台、或右栏页签被隐藏时照跑：既浪费请求，也会在回到界面时
 * 把已经过时的响应写进 UI。这里把两种"不可见"收敛成两个只读判据 + 一个
 * 可见性变化回调，轮询器只读它、不各自监听事件。
 *
 * 浏览器 API 一律做存在性判断：客户端半也会在 Node 的 fake-carrier 测试里
 * 执行，那里没有 document/window。
 *
 * @module @dsh-external/dsh-butler/client
 */

/** 文档是否处于隐藏状态（后台标签页、最小化窗口）。 */
export function documentHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState !== 'visible'
  } catch {
    return false
  }
}

/**
 * 监听文档可见性变化，只在"变回可见"时回调一次。
 * @param listener - 回到可见时调用。
 * @returns 取消监听函数；没有 DOM 时是空函数。
 */
export function onDocumentVisible(listener: () => void): () => void {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
    const handler = (): void => { if (!documentHidden()) listener() }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  } catch {
    return () => {}
  }
}

/** 右栏页签当前是否可见；由 `ButlerRightPane` 维护。 */
let rightPaneShown = true

/** 读取右栏页签可见性；右栏没挂载时按"可见"处理（不误伤其他轮询器）。 */
export function rightPaneVisible(): boolean {
  return rightPaneShown
}

/**
 * 报告右栏页签可见性。
 * @param visible - 页签是否可见。
 */
export function setRightPaneVisible(visible: boolean): void {
  rightPaneShown = visible
}
