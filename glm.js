import { domToForeignObjectSvg } from 'modern-screenshot'

/**
 * WebKit 的 XML 解析器严格：非法控制字符 / 未配对代理对会直接 decode 失败
 * （Chromium 宽容）。对齐库 svgToDataUrl 的 removeControlCharacter 默认行为
 */
const SVG_INVALID_XML_CHARS = /[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF\uFFFE-\uFFFF]/gu
// iOS 上 Chrome/Edge 也是 WebKit 内核（CriOS/EdgiOS 不含 "Chrome/" 标记）
const isWebKit = () => /AppleWebKit/i.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent)

const logErr = (stage, e) => {
  console.error(`[Screenshot] ${stage}失败:`, e)
  console.error(`[Screenshot] ${stage}失败详情: name=${e?.name ?? '-'} code=${String(e?.code ?? '-')} stack=${e?.stack ?? '-'}`)
}

/**
 * 接管「切片 SVG → 位图」环节：显式 decode + 双帧稳定后再绘制。
 * WebKit 专属处理：
 * - Blob URL 优先（data: 兜底）：规避超长 data: URL 的加载限制，也避免
 *   宿主 App 劫持 img.src 的拦截器解析大 data: URL 时抛错
 * - img.src 赋值同步抛出（懒加载 SDK 劫持 setter）时自动换 URL 类型重试
 * - 切片含内嵌资源（data: 图片/字体）时延时重绘，对齐库的 fixSvgXmlDecode
 */
async function renderSvgToCanvas(wrapper, width, height, scale) {
  let svgStr
  try {
    const svg = await domToForeignObjectSvg(wrapper, { width, height })
    svgStr = new XMLSerializer().serializeToString(svg)
    svgStr = svgStr.replace(SVG_INVALID_XML_CHARS, '')
  } catch (e) {
    logErr('SVG 构建/序列化 (stage=svg-build) ', e)
    throw e
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(width * scale)
  canvas.height = Math.floor(height * scale)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const sizeInfo = `svg=${(svgStr.length / 1024).toFixed(0)}KB`
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`
  let blobUrl = null
  const load = (url, kind) => new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'sync'
    img.loading = 'eager'
    const timer = setTimeout(() => reject(new Error(`SVG image load timeout (${kind}, ${sizeInfo})`)), 10000)
    img.onload = () => { clearTimeout(timer); resolve(img) }
    img.onerror = () => { clearTimeout(timer); reject(new Error(`SVG image decode failed (${kind}, ${sizeInfo})`)) }
    try {
      img.src = url
    } catch (e) {
      clearTimeout(timer)
      reject(new Error(`img.src 同步抛出 (${kind}, ${sizeInfo}): name=${e?.name ?? '-'} code=${String(e?.code ?? '-')} ${e?.message ?? e}`))
    }
  })

  let img = null
  let lastErr = null
  for (const kind of (isWebKit() ? ['blob', 'data'] : ['data', 'blob'])) {
    if (kind === 'blob' && !blobUrl) {
      blobUrl = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }))
    }
    try {
      img = await load(kind === 'blob' ? blobUrl : dataUrl, kind)
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!img) throw lastErr ?? new Error(`SVG image load failed (${sizeInfo})`)
  try {
    await img.decode().catch(() => {})
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    // WebKit 首绘可能空白：内嵌资源解码滞后于图像本体，延时重绘
    if (isWebKit() && /(?:src|href)="data:|url\(["']?data:/.test(svgStr)) {
      for (let i = 0; i < 2; i++) {
        await new Promise(r => setTimeout(r, 100))
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      }
    }
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
  }
  return canvas
}


/** iOS 单个 Canvas 的安全像素上限（约 4096 * 4096） */
export const IOS_MAX_CANVAS_PIXELS = 16777216
const SAFETY_RATIO = 0.85
/**
 * 单个切片 DOM 的最大高度。除 iOS 序列化体量约束外，还必须低于
 * GPU 光栅损坏带的首带位置（实测 ~205px，见下方说明）：部分 Chromium+GPU
 * 环境（本机 Intel UHD / RTX 3050，Chrome/Edge 有头模式实测）对较高的
 * SVG foreignObject 图像按 ~280px 瓦片光栅化，瓦片边界处 ~20px 内容带
 * 被整体位移，且损坏与内容复杂度、会话状态相关、无法用校准图预测。
 * 损坏带锚定在各图自身内容顶部 ~205px 起每 280px 一条，切片高度压到
 * 205px 之下即可让画布与损坏带永不相交，对所有环境免疫。
 */
const MAX_SLICE_HEIGHT = 200
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
export function createSlice(el, fromY, toY, totalHeight) {
  const rect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  // 切片盒子只覆盖「窗口 ∩ 元素真实范围」。
  // 若让归一化到窗口顶部的切片盒子铺满整个窗口，会带着子节点自身的
  // 不透明背景盖住窗口内位于子节点真实范围之外的兄弟内容（遮挡 bug）
  const visFrom = Math.max(fromY, 0)
  const visTo = Math.min(toY, totalHeight)
  const windowHeight = toY - fromY
  const sliceHeight = visTo - visFrom

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

  // 测量坐标是 border box 相对值；绝对定位 left/top 的 containing block 是
  // 切片的 padding box（原点在 border 内侧、padding 外侧），
  // 因此只补偿 border —— padding 已体现在测量坐标中
  const borderX = parseFloat(cs.borderLeftWidth)
  const borderY = fromY > 0 ? 0 : parseFloat(cs.borderTopWidth)
  const padLeft = parseFloat(cs.paddingLeft)
  const contentWidth = el.clientWidth - padLeft - parseFloat(cs.paddingRight)
  const preserveWs = cs.whiteSpace.startsWith('pre')

  // flowTop：当前流位置（原元素相对坐标）——inline run 所在匿名块的顶部由此推导，
  // 比 Range 碎片矩形并集精确（后者有 ±1px 墨迹盒误差）
  let flowTop = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
  let run = []
  const flushRun = () => {
    if (!run.length) return
    const nodes = run
    run = []
    // 纯空白组（且非 pre 排版）无视觉效果，直接丢弃
    if (!preserveWs && !nodes.some(n => n.nodeType !== Node.TEXT_NODE || /\S/.test(n.data))) return
    appendInlineRun(slice, nodes, rect, fromY, toY, visFrom, padLeft, borderY, contentWidth, flowTop)
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
    // 无论是否落在区间内，都要推进流位置（区间外的 block 也占位）
    flowTop = top + childRect.height + (parseFloat(getComputedStyle(node).marginBottom) || 0)
    if (top >= toY || top + childRect.height <= fromY) continue // 区间外：物理丢弃

    let child
    if (childRect.height > windowHeight && node.children.length) {
      // 比窗口还高的子节点：递归按孙子节点裁剪。
      // 递归产物内部已把自身「可见范围」归一化到其盒子顶部，
      // 外层按「子节点真实范围 ∩ 窗口」定位到 visFrom 基准
      child = createSlice(node, fromY - top, toY - top, childRect.height)
      child.style.left = `${childRect.left - rect.left - borderX}px`
      child.style.top = `${top + Math.max(fromY - top, 0) - visFrom - borderY}px`
    } else {
      child = node.cloneNode(true)
      child.style.cssText += `;position:absolute;` +
        `width:${childRect.width}px;height:${childRect.height}px;` +
        `margin:0;transform:none;box-sizing:border-box;`
      child.style.left = `${childRect.left - rect.left - borderX}px`
      child.style.top = `${top - visFrom - borderY}px`
      // nth-child / first-child 等位置选择器在切片内会按「剩余兄弟」重新计数
      // （如斑马纹翻转），把原节点已算好的背景色无条件烘焙进克隆
      // （透明也要烘焙：否则 nth 规则会给本应透明的行错误上色）
      child.style.backgroundColor = getComputedStyle(node).backgroundColor
      // 行被拆进独立切片后，表格列宽会按「剩余行」重新分配；
      // 固化每个 cell 的实测宽度，保证跨切片列对齐
      if (child.tagName === 'TR' || child.querySelector('tr')) {
        const srcCells = node.querySelectorAll('td,th')
        const dstCells = child.querySelectorAll('td,th')
        for (let k = 0; k < srcCells.length && k < dstCells.length; k++) {
          dstCells[k].style.width = `${srcCells[k].getBoundingClientRect().width}px`
        }
      }
    }
    slice.appendChild(child)
  }
  flushRun()

  return slice
}

function appendInlineRun(slice, run, elRect, fromY, toY, visFrom, left, borderY, contentWidth, blockTop) {
  // blockTop：run 所在匿名块的顶部（流位置推导，元素相对坐标）
  if (blockTop >= toY) return // 从窗口底部之后才开始：丢弃
  // 底部判交用 Range 碎片并集（仅判交，不用于定位，±1px 无害）
  const range = document.createRange()
  range.setStartBefore(run[0])
  range.setEndAfter(run[run.length - 1])
  if (range.getBoundingClientRect().bottom - elRect.top <= fromY) return // 整组在窗口上方：丢弃

  // 起点取内容区左缘、宽度取内容区宽度：组内文本以与原布局
  // 完全一致的可用宽度重新换行，行序与原排版逐行对齐
  const wrapper = document.createElement('div')
  wrapper.style.cssText = `position:absolute;` +
    `left:${left}px;` +
    `top:${blockTop - visFrom - borderY}px;` +
    `width:${contentWidth}px;` +
    `margin:0;transform:none;box-sizing:border-box;`
  for (const n of run) wrapper.appendChild(n.cloneNode(true))
  slice.appendChild(wrapper)
}

/**
 * 安全导出长图为图片文件（支持 iOS 高清不白屏）
 * @param {HTMLElement} sourceEl - 需要截图的原始 DOM 节点
 * @param {string} fileName - 导出的图片文件名
 * @returns {Promise<HTMLCanvasElement>} 最终合成画布
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

  // 2. 切片高度：每个切片的 DOM 面积（含跨界子节点）与切片 canvas 都落在安全区。
  //    MAX_SLICE_HEIGHT=200 同时低于 GPU 光栅损坏首带位置（~205px），见常量说明
  const sliceHeight = Math.max(1, Math.min(
    height,
    MAX_SLICE_HEIGHT,
    Math.floor((IOS_MAX_CANVAS_PIXELS * SAFETY_RATIO) / (Math.max(width, 1) * STRADDLE_FACTOR)),
  ))

  console.log(`[Screenshot] 原始尺寸: ${width}x${height}, 切片高度: ${sliceHeight}px, 缩放率: ${finalScale.toFixed(3)}`)

  const finalCanvas = document.createElement('canvas')
  finalCanvas.width = Math.round(width * finalScale)
  finalCanvas.height = Math.round(height * finalScale)
  const ctx = finalCanvas.getContext('2d', { willReadFrequently: true })

  const bg = getComputedStyle(sourceEl).backgroundColor
  if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height)
  }

  // [test hook] 测试钩子，生产可删
  globalThis.__TEST__?.onFinalCanvas?.(finalCanvas, { width, height, finalScale, sliceHeight })

  try {
    // 4. 合成：不使用 drawImage 把 chunk 拼贴到大画布——有头 GPU 模式下 Chrome
    //    对大画布忽略 willReadFrequently 提示，GPU 瓦片边界会产生 ~20px 内容
    //    位移（实测 8515px 画布在 245.3+280k 处稳定复现）。改用 ImageData 纯
    //    像素搬运：memcpy 不经过光栅化，与画布后端无关
    const finalData = ctx.getImageData(0, 0, finalCanvas.width, finalCanvas.height)
    const fbuf = finalData.data
    const fw = finalCanvas.width
    for (let top = 0; top < height; top += sliceHeight) {
      const bottom = Math.min(top + sliceHeight, height)

      // 3. 物理裁剪出该区间的「小 DOM」——每次序列化体量恒定在安全区内
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
        const chunkCanvas = await renderSvgToCanvas(wrapper, width, bottom - top, finalScale)
        const cdata = chunkCanvas.getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, chunkCanvas.width, chunkCanvas.height)
        const cbuf = cdata.data
        const cw = cdata.width, ch = cdata.height
        // 取整后的区间铺画，杜绝切片之间出现 1px 缝隙；≤1px 的拉伸用最近邻
        const yTop = Math.round(top * finalScale)
        const yBottom = Math.round(bottom * finalScale)
        const destH = yBottom - yTop
        for (let dy = 0; dy < destH; dy++) {
          const sy = ch === 1 ? 0 : Math.min(ch - 1, Math.floor(dy * ch / destH))
          const fRow = (yTop + dy) * fw * 4
          const cRow = sy * cw * 4
          if (cw === fw) {
            fbuf.set(cbuf.subarray(cRow, cRow + cw * 4), fRow)
          } else {
            for (let dx = 0; dx < fw; dx++) {
              const sx = Math.min(cw - 1, Math.floor(dx * cw / fw))
              const fo = fRow + dx * 4, co = cRow + sx * 4
              fbuf[fo] = cbuf[co]
              fbuf[fo + 1] = cbuf[co + 1]
              fbuf[fo + 2] = cbuf[co + 2]
              fbuf[fo + 3] = cbuf[co + 3]
            }
          }
        }
      } catch (e) {
        logErr(`切片 y=${top}-${bottom} 渲染`, e)
        throw e
      } finally {
        wrapper.remove()
      }
    }
    ctx.putImageData(finalData, 0, 0)

    // 5. 导出无损 Blob 并触发下载
    await new Promise((resolve, reject) => {
      finalCanvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Canvas 导出 Blob 失败'))
        // [test hook] 测试模式下跳过下载
        if (globalThis.__TEST__?.skipDownload) return resolve()
        const fileUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.download = fileName
        link.href = fileUrl
        link.click()
        setTimeout(() => URL.revokeObjectURL(fileUrl), 60000)
        resolve()
      }, 'image/png')
    })

    return finalCanvas
  } catch (error) {
    logErr('导出', error)
    alert('生成图片失败，请重试')
    throw error
  }
}
