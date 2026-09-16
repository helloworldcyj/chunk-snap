import { domToCanvas } from 'modern-screenshot'

const IOS_MAX_CANVAS_PIXELS = 16777216
const SAFETY_RATIO = 0.85
const MAX_SLICE_HEIGHT = 2000
const STRADDLE_FACTOR = 3

function isInlineLevel(node) {
  if (node.nodeType === Node.TEXT_NODE) return true
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  return getComputedStyle(node).display.startsWith('inline')
}

/**
 * 把 el 在 [fromY, toY) 区间内的内容「物理裁剪」成独立小 DOM：
 * - block 级子节点：区间外丢弃；比窗口还高的递归再拆
 * - 连续 inline 内容（裸文本 + inline 元素）打包一组，整组克隆进
 *   「宽度 = 内容区宽度」的绝对定位容器，组内 inline 排版原样重排
 */
function createSlice(el, fromY, toY, totalHeight) {
  const rect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const sliceHeight = toY - fromY

  const slice = el.cloneNode(false)
  slice.removeAttribute('id')
  slice.style.cssText += `;position:absolute;left:0;top:0;` +
    `width:${rect.width}px;height:${sliceHeight}px;` +
    `margin:0;overflow:hidden;transform:none;box-sizing:border-box;`

  if (fromY > 0) {
    slice.style.borderTopWidth = '0'
    slice.style.borderTopLeftRadius = '0'
    slice.style.borderTopRightRadius = '0'
  }
  if (toY < totalHeight) {
    slice.style.borderBottomWidth = '0'
    slice.style.borderBottomLeftRadius = '0'
    slice.style.borderBottomRightRadius = '0'
  }

  // 测量值是 border box 相对坐标，绝对定位 left/top 相对 padding box，
  // 原点差 = border + padding，必须整体补偿（坐标系换算，非多减）
  const borderX = parseFloat(cs.borderLeftWidth)
  const borderY = fromY > 0 ? 0 : parseFloat(cs.borderTopWidth)
  const originX = borderX + parseFloat(cs.paddingLeft)
  const originY = borderY + parseFloat(cs.paddingTop)
  const contentWidth = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const preserveWs = cs.whiteSpace.startsWith('pre')

  let run = []
  const flushRun = () => {
    if (!run.length) return
    const nodes = run
    run = []
    // 纯空白组（且非 pre 排版）无视觉效果，直接丢弃
    if (!preserveWs && !nodes.some(n => n.nodeType !== Node.TEXT_NODE || /\S/.test(n.data))) return
    appendInlineRun(slice, nodes, rect, fromY, toY, originX - borderX, originY, contentWidth)
  }

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) continue

    if (isInlineLevel(node)) {
      run.push(node)
      continue
    }
    flushRun()

    const childRect = node.getBoundingClientRect()
    const top = childRect.top - rect.top
    if (top >= toY || top + childRect.height <= fromY) continue // 区间外：物理丢弃

    let child
    if (childRect.height > sliceHeight && node.children.length) {
      // 比窗口还高的子节点：递归按孙子节点裁剪。
      // 递归产物内部已把「窗口起点」归一化到自身顶部，
      // 外层必须对齐窗口顶部，禁止再做 top - fromY 位移（否则双重位移）
      child = createSlice(node, fromY - top, toY - top, childRect.height)
      child.style.left = `${childRect.left - rect.left - originX}px`
      child.style.top = `${-originY}px`
    } else {
      child = node.cloneNode(true)
      child.style.cssText += `;position:absolute;` +
        `width:${childRect.width}px;height:${childRect.height}px;` +
        `margin:0;transform:none;box-sizing:border-box;`
      child.style.left = `${childRect.left - rect.left - originX}px`
      child.style.top = `${top - fromY - originY}px`
    }
    slice.appendChild(child)
  }
  flushRun()

  return slice
}

function appendInlineRun(slice, run, elRect, fromY, toY, left, originY, contentWidth) {
  const range = document.createRange()
  range.setStartBefore(run[0])
  range.setEndAfter(run[run.length - 1])
  const runRect = range.getBoundingClientRect()
  if (runRect.top >= toY || runRect.bottom <= fromY) return // 区间外：丢弃

  // 起点取内容区左缘、宽度取内容区宽度：组内文本以与原布局
  // 完全一致的可用宽度重新换行，行序与原排版逐行对齐
  const wrapper = document.createElement('div')
  wrapper.style.cssText = `position:absolute;` +
    `left:${left}px;` +
    `top:${runRect.top - elRect.top - fromY - originY}px;` +
    `width:${contentWidth}px;` +
    `margin:0;transform:none;box-sizing:border-box;`
  for (const n of run) wrapper.appendChild(n.cloneNode(true))
  slice.appendChild(wrapper)
}

export async function safeExportLongImage(sourceEl, fileName = 'screenshot.png') {
  const width = sourceEl.offsetWidth
  const height = sourceEl.offsetHeight
  if (!width || !height) throw new Error('[Screenshot] 目标节点尺寸为 0，无法截图')

  let finalScale = 1
  const totalPixels = width * height
  if (totalPixels > IOS_MAX_CANVAS_PIXELS) {
    finalScale = Math.min(1, Math.sqrt((IOS_MAX_CANVAS_PIXELS * SAFETY_RATIO) / totalPixels))
  }

  const sliceHeight = Math.max(1, Math.min(
    height,
    MAX_SLICE_HEIGHT,
    Math.floor((IOS_MAX_CANVAS_PIXELS * SAFETY_RATIO) / (Math.max(width, 1) * STRADDLE_FACTOR)),
  ))

  console.log(`[Screenshot] 原始尺寸: ${width}x${height}, 切片高度: ${sliceHeight}px, 缩放率: ${finalScale.toFixed(2)}`)

  const finalCanvas = document.createElement('canvas')
  finalCanvas.width = Math.round(width * finalScale)
  finalCanvas.height = Math.round(height * finalScale)
  const ctx = finalCanvas.getContext('2d')

  const bg = getComputedStyle(sourceEl).backgroundColor
  if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height)
  }

  try {
    for (let top = 0; top < height; top += sliceHeight) {
      const bottom = Math.min(top + sliceHeight, height)
      const sliceEl = createSlice(sourceEl, top, bottom, height)

      // wrapper 做序列化根：modern-screenshot 会删根节点的 position，
      // 包一层让切片保持 absolute 定位上下文
      const wrapper = document.createElement('div')
      wrapper.style.cssText = `position:absolute;left:-99999px;top:0;width:${width}px;height:${bottom - top}px;overflow:hidden;`
      wrapper.appendChild(sliceEl)

      const mount = sourceEl.parentNode || document.body
      mount.appendChild(wrapper)

      try {
        const chunkCanvas = await domToCanvas(wrapper, {
          width,
          height: bottom - top,
          scale: finalScale,
        })
        const yTop = Math.round(top * finalScale)
        const yBottom = Math.round(bottom * finalScale)
        ctx.drawImage(chunkCanvas, 0, yTop, finalCanvas.width, yBottom - yTop)
      } finally {
        wrapper.remove()
      }
    }

    await new Promise((resolve, reject) => {
      finalCanvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Canvas 导出 Blob 失败'))
        const fileUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.download = fileName
        link.href = fileUrl
        link.click()
        setTimeout(() => URL.revokeObjectURL(fileUrl), 60000)
        resolve()
      }, 'image/png')
    })
  } catch (error) {
    console.error('[Screenshot] 导出失败:', error)
    alert('生成图片失败，请重试')
  }
}
