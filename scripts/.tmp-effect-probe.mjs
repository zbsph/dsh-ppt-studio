/** 语义探针：Cordis 的 ctx.effect(cb) 是"立即执行 cb"还是"把 cb 当清理函数"？ */
const cordis = await import('file:///C:/Users/11867/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
const { Context } = cordis
const ctx = new Context()
const log = []
const disposer = ctx.effect(() => {
  log.push('cb-body-ran')
  return () => log.push('returned-fn-ran')
}, 'probe')
console.log('effect 调用后立刻观察：', JSON.stringify(log))
console.log('effect 返回值类型：', typeof disposer)
if (typeof disposer === 'function') {
  const r = disposer()
  if (r && typeof r.then === 'function') await r
  await new Promise((res) => setTimeout(res, 10))
  console.log('手动 dispose 后：', JSON.stringify(log))
}
