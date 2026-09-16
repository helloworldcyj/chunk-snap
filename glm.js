import { domToCanvas } from 'modern-screenshot'

/** iOS 单个 Canvas 的安全像素上限（约 4096 * 4096） */
const IOS_MAX_CANVAS_PIXELS = 16777216
const SAFETY_RATIO = 0.85
/** 单个切片 DOM 的最大高度：直接限制每次序列化进 foreignObject 的 DOM 体量 */
const MAX_SLICE_HEIGHT = 2000
/** 切片 + 上下跨界子节点，单次序列化面积约为切片的 3 倍 */
const STRADDLE_FACTOR = 3

/**
 * 把 el 在 [fromY, toY) 区间内的内容「物理裁剪」成独立小 DOM：
 * 只保留与区间相交的子节点，其余直接丢弃、不参与序列化；
 * 单个比切片还高的子节点，按它的子节点递归再拆。
 */
function createSlice(el, fromY, toY, totalHeight) {
  const rect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const sliceHeight = toY - fromY

  // 浅克隆 el 做容器：保留 class / 内联样式，背景、内边距、圆角得以延续
  const slice = el.cloneNode(false)
  slice.removeAttribute('id')
  slice.style.cssText += `;position:absolute;left:0;top:0;` +
    `width:${rect.width}px;height:${sliceHeight}px;` +
    `margin:0;overflow:hidden;transform:none;box-sizing:border-box;`

  // 中间切片去掉上下边框与圆角，避免拼接处出现横线
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

  // 绝对定位子节点以切片 padding box 为原点，需补偿 border + padding（上边框被裁时同步修正）
  const originX = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)
  const originY = (fromY > 0 ? 0 : parseFloat(cs.borderTopWidth)) + parseFloat(cs.paddingTop)

  // 纯文本等无子元素节点无法按节点拆分：退化为「裁剪窗口 + 位移整棵子树」
  if (!el.children.length) {
    const inner = el.cloneNode(true)
    inner.style.cssText += `;position:absolute;left:${-originX}px;top:${-fromY - originY}px;margin:0;transform:none;`
    slice.appendChild(inner)
    return slice
  }

  for (const child of el.children) {
    const childRect = child.getBoundingClientRect()
    const top = childRect.top - rect.top
    if (top >= toY || top + childRect.height <= fromY) continue // 区间外：物理丢弃

    let node
    if (childRect.height > sliceHeight && child.children.length) {
      // 子节点比切片还高：按孙子节点递归裁剪
      node = createSlice(child, fromY - top, toY - top, childRect.height)
    } else {
      node = child.cloneNode(true)
      node.style.cssText += `;position:absolute;` +
        `width:${childRect.width}px;height:${childRect.height}px;` +
        `margin:0;transform:none;box-sizing:border-box;`
    }
    node.style.left = `${childRect.left - rect.left - originX}px`
    node.style.top = `${top - fromY - originY}px`
    slice.appendChild(node)
  }
  return slice
}

/**
 * 安全导出长图为图片文件（支持 iOS 高清不白屏）
 * 不再给整棵大 DOM 做位移裁剪，而是按安全高度把 sourceEl 物理切成
 * N 段小 DOM（"一半一半"是 N=2 的特例），逐段截图后拼到合成画布。
 */
export async function safeExportLongImage(sourceEl, fileName = 'screenshot.png') {
  const width = sourceEl.offsetWidth
  const height = sourceEl.offsetHeight
  if (!width || !height) throw new Error('[Screenshot] 目标节点尺寸为 0，无法截图')

  // 1. 整体缩放率：保证「最终合成画布」不超 iOS 上限
  let finalScale = 1
  const totalPixels = width * height
  if (totalPixels > IOS_MAX_CANVAS_PIXELS) {
    finalScale = Math.min(1, Math.sqrt((IOS_MAX_CANVAS_PIXELS * SAFETY_RATIO) / totalPixels))
  }

  // 2. 切片高度：每个切片的 DOM 面积（含跨界子节点）与切片 canvas 都落在安全区
  const sliceHeight = Math.max(1, Math.min(
    height,
    MAX_SLICE_HEIGHT,
    Math.floor((IOS_MAX_CANVAS_PIXELS * SAFETY_RATIO) / (Math.max(width, 1) * STRADDLE_FACTOR)),
  ))

  console.log(`[Screenshot] 原始尺寸: ${width}x${height}, 切片高度: ${sliceHeight}px, 动态缩放率: ${finalScale.toFixed(2)}`)

  // 3. 最终合成画布
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

      // 4. 物理裁剪出该区间的「小 DOM」——每次序列化体量恒定在安全区内
      const sliceEl = createSlice(sourceEl, top, bottom, height)

      // 包一层 wrapper 作为序列化根节点：
      // modern-screenshot 会删除「根节点」的 position（否则白屏），
      // 包一层可让切片内部保持 absolute 定位上下文，坐标规则统一
      const wrapper = document.createElement('div')
      wrapper.style.cssText = `position:absolute;left:-99999px;top:0;width:${width}px;height:${bottom - top}px;overflow:hidden;`
      wrapper.appendChild(sliceEl)

      // 挂到源节点同级：祖先选择器、主题 class 等样式上下文保持一致
      const mount = sourceEl.parentNode || document.body
      mount.appendChild(wrapper)

      try {
        const chunkCanvas = await domToCanvas(wrapper, {
          width,
          height: bottom - top,
          scale: finalScale,
        })

        // 5. 用取整后的区间铺画，杜绝切片之间出现 1px 缝隙
        const yTop = Math.round(top * finalScale)
        const yBottom = Math.round(bottom * finalScale)
        ctx.drawImage(chunkCanvas, 0, yTop, finalCanvas.width, yBottom - yTop)
      } finally {
        wrapper.remove()
      }
    }

    // 6. 抛弃 Base64，直接导出无损 Blob 并触发下载
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
