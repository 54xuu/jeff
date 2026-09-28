/**
 * Android 返回键栈。后压入的先消费。
 * 图表灯箱等临时层压入关闭函数，避免返回键直接退出会话。
 */
const stack: Array<() => void> = []

export function pushBack(fn: () => void): () => void {
  stack.push(fn)
  return () => {
    const i = stack.lastIndexOf(fn)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** 消费最上层返回处理。没有处理时返回 false，交给页面自己的返回逻辑。 */
export function consumeBack(): boolean {
  const fn = stack.pop()
  if (!fn) return false
  fn()
  return true
}
