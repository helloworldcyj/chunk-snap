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
 * - WebKit 必须使用 data: URL：blob: + foreignObject 会污染 canvas，导致像素读取报 SecurityError
 * - 非 WebKit 仍保留 blob: 兜底：规避超长 data: URL 的加载限制，也避免
 *   宿主 App 劫持 img.src 的拦截器解析大 data: URL 时抛错
 * - img.src 赋值同步抛出（懒加载 SDK 劫持 setter）时自动换 URL 类型重试
 * - 切片含内嵌资源（data: 图片/字体）时延时重绘，对齐库的 fixSvgXmlDecode
 * opts.font: 透传给库的 font 选项（cssText 可替换/跳过自动字体内嵌）
 * opts.diag: 每次导出共享的诊断标记（超大 payload 只警告一次）
 */
async function renderSvgToCanvas(wrapper, width, height, scale, opts = {}) {
  let svgStr
  try {
    const svg = await domToForeignObjectSvg(wrapper, { width, height, ...(opts.font ? { font: opts.font } : {}) })
    svgStr = new XMLSerializer().serializeToString(svg)
    svgStr = svgStr.replace(SVG_INVALID_XML_CHARS, '')
  } catch (e) {
    logErr('SVG 构建/序列化 (stage=svg-build) ', e)
    throw e
  }

  // 内嵌资源体量诊断：整套中文字体 base64 可达数十 MB 且每个切片都背一份，
  // 或切片混入窗口外整树内容（节点数异常多即实锤）。超阈值时分类字体/图片/
  // 标记，并把结果带进 sizeInfo —— 失败报错与警告日志都能直接看到来源
  let payloadInfo = ''
  if (svgStr.length > 1048576) {
    const sumData = (s) => {
      let t = 0
      const re = /data:[^"')\s]{100,}/g
      let m
      while ((m = re.exec(s))) t += m[0].length
      return t
    }
    const total = sumData(svgStr)
    const markupBytes = svgStr.length - total
    if (total > 3 * 1048576 || markupBytes > 3 * 1048576) {
      const styleBlocks = svgStr.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []
      const fontBytes = styleBlocks.reduce((acc, blk) => acc + sumData(blk), 0)
      const imgBytes = total - fontBytes
      const elemCount = wrapper.querySelectorAll('*').length
      payloadInfo = `, 内嵌:字体≈${(fontBytes / 1048576).toFixed(0)}MB 图片≈${(imgBytes / 1048576).toFixed(0)}MB 标记≈${(markupBytes / 1048576).toFixed(0)}MB/${elemCount}节点`
      if (opts.diag && !opts.diag.warned) {
        opts.diag.warned = true
        console.warn(`[Screenshot] 切片 SVG 超大（${(svgStr.length / 1048576).toFixed(0)}MB）${payloadInfo} —— ` +
          `字体大用 {skipFonts:true}；图片/标记大说明切片混入了窗口外内容（节点数异常多即整树被克隆），请反馈页面结构`)
      }
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(width * scale)
  canvas.height = Math.floor(height * scale)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const sizeInfo = `svg=${(svgStr.length / 1024).toFixed(0)}KB${payloadInfo}`
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
  for (const kind of (isWebKit() ? ['data'] : ['data', 'blob'])) {
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


/** iOS 单个 Canvas 的安全像素上限（约 4096 * 4096，老设备经验线） */
export const IOS_MAX_CANVAS_PIXELS = 16777216
const SAFETY_RATIO = 0.85

/**
 * 探测本机画布能否真正容纳 w×h：超限画布在 iOS 上不抛错而是静默空白，
 * 必须「写入 + 读回」验证后备存储真实存在；合成阶段还需 w×h×4 字节的
 * ImageData 缓冲，一并验证。结果按尺寸页面级缓存，避免重复大分配
 */
const canvasBudgetCache = new Map()
export function canvasHolds(w, h) {
  const key = w + 'x' + h
  if (canvasBudgetCache.has(key)) return canvasBudgetCache.get(key)
  let ok = false
  try {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const x = c.getContext('2d')
    x.fillStyle = '#f00'
    x.fillRect(0, 0, 2, 2)
    ok = x.getImageData(0, 0, 1, 1).data[0] === 255 && !!x.createImageData(w, h)
  } catch (e) {
    ok = false
  }
  canvasBudgetCache.set(key, ok)
  return ok
}
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
 * inline 元素内部是否混入 block 级后代（触发匿名块排版，如 <span> 包整张
 * <table>）。只沿 inline 主干下探：inline-block/inline-table 等独立排版盒
 * 是叶子（由 oversized 规则另行放行），display:contents 视为透明继续下探
 */
function hasBlockInsideInline(node) {
  for (const child of node.children) {
    const d = getComputedStyle(child).display
    if (d === 'none') continue
    if (d === 'contents' || d === 'inline') {
      if (hasBlockInsideInline(child)) return true
      continue
    }
    if (d.startsWith('inline')) continue // 独立排版盒：叶子
    return true // block 级后代：匿名块
  }
  return false
}

/**
 * visibility:hidden 的子树里是否有子孙显式翻回 visible（visibility 可继承
 * 可覆盖）。只查内联样式，class/样式表覆盖属已知盲区。有则不能按
 * 「不可见」剥空/丢弃
 */
function hasVisibleOverride(el) {
  const candidates = el.querySelectorAll('[style*="visibility"]')
  for (const d of candidates) {
    if (getComputedStyle(d).visibility === 'visible') return true
  }
  return false
}

/**
 * 裁掉克隆子树里「窗口外且可安全删除」或「不可见」的节点。切片只按子节点
 * 盒子几何裁剪，三类大子树会被整树克隆进单个切片，payload 可达数十 MB：
 * 1. 完全在窗口外（含横向）且 abs/fixed 定位、或处于裁剪上下文
 *    （overflow hidden/clip 祖先）内——这两类节点的删除不会重排可见内容
 * 2. 普通流内、完全在窗口「下方」的子树（定高 overflow:visible 包裹器里的
 *    超长内容）——block 流纵向独立堆叠，删除不移动上方可见兄弟；
 *    flex/grid/table/多列布局的删除会重排剩余子项，保守跳过。
 *    已知盲区：负 margin 把后续兄弟拉回窗口、子树内 abs 后代伸回窗口
 * 3. visibility:hidden 的大子树（表格组件的测量克隆 / 隐藏面板）——与窗口
 *    相交时永远躲过几何裁剪。hidden 不画任何像素，剥空内容、保留盒子
 *    尺寸即可像素零损失；子孙显式翻回 visible 的除外
 * cloneEl.children 与 origChildren（元素级）一一对应，倒序删除
 */
function pruneHiddenClone(cloneEl, origChildren, winFrom, winTo, elRect, clipped) {
  const cChildren = cloneEl.children
  // flowSafe 必须取「原始」父节点：克隆子树未挂载，getComputedStyle 拿到的是空值
  const origParent = origChildren.length ? origChildren[0].parentNode : cloneEl
  const pcs = getComputedStyle(origParent)
  const flowSafe = pcs.columnCount === 'auto' && !/flex|grid|table/.test(pcs.display)
  for (let i = cChildren.length - 1; i >= 0; i--) {
    const o = origChildren[i]
    const c = cChildren[i]
    if (!o) continue
    const r = o.getBoundingClientRect()
    const outside = (r.bottom - elRect.top <= winFrom) ||
      (r.top - elRect.top >= winTo) ||
      (r.right - elRect.left <= 0) ||
      (r.left - elRect.left >= elRect.width)
    const cs = getComputedStyle(o)
    if (outside && (clipped || /absolute|fixed/.test(cs.position))) {
      c.remove()
      continue
    }
    // 普通流内、完全在窗口下方的子树：block 流中删除不影响上方可见内容
    if (flowSafe && outside && !/absolute|fixed/.test(cs.position) &&
        r.top - elRect.top >= winTo) {
      c.remove()
      continue
    }
    // visibility:hidden 大子树：剥空内容保留盒子（流内占位不能动），像素零损失
    if (cs.visibility === 'hidden' && !hasVisibleOverride(o) &&
        o.querySelectorAll('*').length > 50) {
      while (c.firstChild) c.removeChild(c.firstChild)
      c.style.boxSizing = 'border-box'
      c.style.height = `${r.height}px`
      c.style.minHeight = 'auto'
      c.style.maxHeight = 'none'
      if (cs.display.startsWith('inline')) c.style.width = `${r.width}px`
      continue
    }
    // 窗口内但高于窗口的嵌套 <table>（单元格里的子表格 / 行展开明细）：
    // 整表保留会把全表塞进单个切片（payload 爆炸类缺口）。行级手术：
    // 窗口上方用定高占位行、窗口下方整行丢弃、保留行冻结列宽、表高钉死
    // （后续流内容不位移）。已知盲区：rowspan 跨手术边界、嵌套表内 sticky 表头
    if (o.tagName === 'TABLE' && o.rows && o.rows.length > 1 &&
        r.height > winTo - winFrom &&
        r.top - elRect.top < winTo && r.bottom - elRect.top > winFrom) {
      const tFrom = winFrom - (r.top - elRect.top)
      const tTo = winTo - (r.top - elRect.top)
      const kept = new Set()
      let aboveH = 0, maxCells = 1, any = false
      Array.from(o.rows).forEach((row, i) => {
        const rr = row.getBoundingClientRect()
        const rt = rr.top - r.top
        if (row.cells.length > maxCells) maxCells = row.cells.length
        if (rt + rr.height <= tFrom) aboveH += rr.height
        else if (rt < tTo) { kept.add(i); any = true }
      })
      if (any && kept.size < o.rows.length) {
        // 表高不能用 height 钉死：表格 height 超过内容高时，盈余会按
        // 「表高分配算法」均摊给各行——行被拉高、内容垂直居中漂移。
        // 改用定高 holder 包裹：盒子占位保住（后续流内容不位移），
        // 行高保持自然
        const holder = c.ownerDocument.createElement('div')
        holder.style.cssText = `height:${r.height}px;box-sizing:border-box;`
        c.parentNode.replaceChild(holder, c)
        holder.appendChild(c)
        const cRows = Array.from(c.rows)
        for (let i2 = 0; i2 < cRows.length; i2++) {
          if (!kept.has(i2)) { cRows[i2].remove(); continue }
          const src = o.rows[i2]
          for (let k = 0; k < src.cells.length && k < cRows[i2].cells.length; k++) {
            cRows[i2].cells[k].style.width = `${src.cells[k].getBoundingClientRect().width}px`
            cRows[i2].cells[k].style.boxSizing = 'border-box'
          }
        }
        if (aboveH > 0.5) {
          const sp = document.createElement('tr')
          sp.style.height = `${aboveH}px`
          const td = document.createElement('td')
          td.colSpan = maxCells
          td.style.cssText = 'border:0;padding:0;background:transparent;'
          sp.appendChild(td)
          const firstRow = c.rows[0]
          const grp = firstRow ? firstRow.parentNode : c
          grp.insertBefore(sp, firstRow || null)
        }
        continue
      }
    }
    const childClipped = clipped || /hidden|clip/.test(`${cs.overflow} ${cs.overflowX} ${cs.overflowY}`)
    if (c.children.length && o.children.length) {
      pruneHiddenClone(c, o.children, winFrom, winTo, elRect, childClipped)
    }
  }
}

/**
 * 表级切片：高于窗口的表格整体保真裁剪。
 * 行级 abspos 克隆会丢失 border-collapse 共享边框（网格线加倍、行高 +1~2px
 * 漂移）；行级 in-flow 又会因「只剩部分行」按剩余内容重排——列宽/换行/行高
 * 全变。这里保留真实 table 上下文：table-layout:fixed + colgroup 按原表
 * cell 边界固化列宽（collapse 下 cell 自身宽度重复计数共享边框，直接冻结
 * 会把末列挤窄），窗口内行 in-flow 堆叠并钉死实测行高，窗口外的行整行丢弃
 * ——与原布局逐像素一致，payload 只含窗口内行。
 * 已知盲区：rowspan 从窗口上方伸进窗口的单元格会缺失（丢行方案的固有限制）
 */
function createTableSlice(table, winFrom, winTo) {
  const rect = table.getBoundingClientRect()
  const slice = table.cloneNode(false)
  slice.removeAttribute('id')
  slice.style.cssText += `;position:absolute;left:0;top:0;width:${rect.width}px;` +
    `margin:0;transform:none;box-sizing:border-box;table-layout:fixed;`

  // 列宽推导（带缓存：同一次导出内页面静止，按行数校验失效）
  let colWidths = table.__liColWidths
  const rowCount = table.querySelectorAll('tr').length
  if (!colWidths || colWidths.n !== rowCount) {
    // 取 cell 数最多的行做基准（colspan 行的边界是合并的，粒度不够）
    let refRow = null, maxCells = 0
    for (const r of table.querySelectorAll('tr')) {
      const n = r.querySelectorAll('td,th').length
      if (n > maxCells) { maxCells = n; refRow = r }
    }
    if (!refRow) return null
    // Chrome 的 collapse cell rect 精确无缝平铺：cell 实测宽 = 列槽宽。
    // 不要从「表左缘」推第 0 列（外边框 0.5px 会折进去，全表网格 +0.5px
    // 漂移 → 文字 AA 全差）；末列同理用自身右缘，不用表右缘
    const cells = refRow.querySelectorAll('td,th')
    const widths = []
    for (let k = 0; k < cells.length; k++) {
      widths.push(cells[k].getBoundingClientRect().width)
    }
    colWidths = { n: rowCount, widths }
    table.__liColWidths = colWidths
  }
  const colg = document.createElement('colgroup')
  for (const w of colWidths.widths) {
    const col = document.createElement('col')
    col.style.width = `${w}px`
    colg.appendChild(col)
  }
  slice.appendChild(colg)

  // caption 在表顶部，与窗口相交时保留（渲染在网格上方，需最先挂载）
  const cap = table.querySelector('caption')
  if (cap) {
    const cr = cap.getBoundingClientRect()
    const cTop = cr.top - rect.top
    if (cTop < winTo && cTop + cr.height > winFrom) {
      const cc = cap.cloneNode(true)
      cc.style.cssText += `;position:static;margin:0;transform:none;`
      slice.insertBefore(cc, colg)
    }
  }

  let firstTop = null
  const keepRow = (row, natTop) => {
    const rr = row.getBoundingClientRect()
    // natTop：sticky 行的 rect 是吸顶/吸底后的位置，与流内位置脱钩，传入自然位
    const rTop = natTop !== undefined ? natTop : rr.top - rect.top
    if (rTop >= winTo || rTop + rr.height <= winFrom) return
    if (getComputedStyle(row).visibility === 'hidden' && !hasVisibleOverride(row)) return
    const rc = row.cloneNode(true)
    // nth-child 斑马纹按剩余兄弟重新计数 → 烘焙原行背景色（透明也烘焙）
    rc.style.backgroundColor = getComputedStyle(row).backgroundColor
    // 行高钉死：in-flow 累积位置与原布局逐像素一致（分数值原样保留）
    rc.style.height = `${rr.height}px`
    // 行内隐藏大子树 / abs 窗口外内容裁剪（与通用路径一致的兜底）
    pruneHiddenClone(rc, row.children, winFrom, winTo, rect, false)
    return { rc, rTop }
  }

  // sticky 表头/表脚：rect 是吸顶/吸底后的位置，直接按 rect 判交会让表头重复
  // 出现在错误的窗口、把 body 行挤位。用首/末 body 行的流内位置反推自然范围
  // （sticky 占流内空间，body 行 rect 即自然延续）；SVG 渲染无滚动，sticky 呈
  // 自然位，切片与参考图两侧一致。sticky 的 body 行无法反推，属已知盲区
  const bodyRows = []
  for (const tb of Array.from(table.tBodies || [])) {
    for (const r of Array.from(tb.rows)) bodyRows.push(r)
  }
  const firstBodyTop = bodyRows.length ? bodyRows[0].getBoundingClientRect().top - rect.top : null
  const lastBodyBottom = bodyRows.length
    ? bodyRows[bodyRows.length - 1].getBoundingClientRect().bottom - rect.top
    : null

  // 行按原分组结构 in-flow 堆叠；裸行（无 tbody 的 JS 构建 DOM）归并进匿名行组
  let bareGroup = null
  for (const g of Array.from(table.children)) {
    if (g.tagName === 'COLGROUP' || g.tagName === 'CAPTION') continue
    const gd = getComputedStyle(g).display
    if (/^(TBODY|THEAD|TFOOT)$/.test(g.tagName) || /^table-(row|header|footer)-group$/.test(gd)) {
      const gc = g.cloneNode(false)
      gc.removeAttribute('id')
      const isHead = g.tagName === 'THEAD' || gd === 'table-header-group'
      const isFoot = g.tagName === 'TFOOT' || gd === 'table-footer-group'
      // sticky 表头/表脚组：按自然范围判交（组内行随组整体吸附，行间偏移即自然偏移）
      if ((isHead || isFoot) && g.rows && g.rows.length &&
          getComputedStyle(g.rows[0]).position === 'sticky') {
        const gh = g.getBoundingClientRect().height
        const gRectTop = g.getBoundingClientRect().top
        const base = isHead
          ? (firstBodyTop !== null ? firstBodyTop - gh : null)
          : (lastBodyBottom !== null ? lastBodyBottom : null)
        if (base !== null) {
          for (const row of Array.from(g.children)) {
            if (row.tagName !== 'TR' && getComputedStyle(row).display !== 'table-row') continue
            const off = row.getBoundingClientRect().top - gRectTop
            const kept = keepRow(row, base + off)
            if (kept) { gc.appendChild(kept.rc); if (firstTop === null) firstTop = kept.rTop }
          }
          if (gc.children.length) slice.appendChild(gc)
          continue
        }
      }
      for (const row of Array.from(g.children)) {
        const kept = keepRow(row)
        if (kept) { gc.appendChild(kept.rc); if (firstTop === null) firstTop = kept.rTop }
      }
      if (gc.children.length) slice.appendChild(gc)
    } else if (g.tagName === 'TR' || gd === 'table-row') {
      if (!bareGroup) { bareGroup = document.createElement('tbody'); slice.appendChild(bareGroup) }
      const kept = keepRow(g)
      if (kept) { bareGroup.appendChild(kept.rc); if (firstTop === null) firstTop = kept.rTop }
    }
  }
  if (firstTop === null) return null
  // 首行在切片表内的流内偏移 g（collapse 外边框内缩 / caption / thead 组合决定，
  // 无法解析求值）：探针挂载实测一次。__flowTop = firstTop - g 使调用方把切片表
  // 定位到「首行落在原位」处，切片表顶部的多余部分由父切片裁掉
  let g = 0
  const doc = table.ownerDocument
  const probe = doc.createElement('div')
  probe.style.cssText = `position:absolute;left:-99999px;top:0;width:${rect.width}px;`
  probe.appendChild(slice)
  ;(doc.body || table.parentNode).appendChild(probe)
  try {
    if (slice.rows && slice.rows.length) {
      g = slice.rows[0].getBoundingClientRect().top - slice.getBoundingClientRect().top
    }
  } finally {
    probe.remove()
  }
  slice.__flowTop = firstTop - g
  return slice
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
  // inline 元素（被路由进 block 递归的 span 等）clientWidth 为 0，
  // 用碎片矩形并集宽度推导内容区宽度
  const contentWidth = cs.display === 'inline'
    ? rect.width - borderX - padLeft - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth)
    : el.clientWidth - padLeft - parseFloat(cs.paddingRight)
  const preserveWs = cs.whiteSpace.startsWith('pre')

  // 背景随盒高重绘修正：切片盒只有窗口高，渐变/背景图会按窗口高重新铺排
  // （原图按全高）。把背景挪到「原尺寸内衬层」上、由切片盒裁剪——任何
  // background-size/position 语义（cover/contain/百分比/多背景）都逐像素还原。
  // background-attachment:fixed 仍视口相对，属已知盲区
  if (cs.backgroundImage !== 'none') {
    const bgLayer = document.createElement('div')
    bgLayer.style.cssText = `position:absolute;left:0;` +
      `top:${parseFloat(cs.borderTopWidth) - borderY - visFrom}px;` +
      `width:${el.clientWidth}px;height:${el.clientHeight}px;` +
      `background-color:${cs.backgroundColor};background-image:${cs.backgroundImage};` +
      `background-repeat:${cs.backgroundRepeat};background-position:${cs.backgroundPosition};` +
      `background-size:${cs.backgroundSize};background-origin:${cs.backgroundOrigin};` +
      `background-clip:${cs.backgroundClip};`
    slice.appendChild(bgLayer) // 首个子节点：绝对定位兄弟按 DOM 序绘制，垫底
    // 盒身背景清空（内联覆盖 class）：背景只在原尺寸内衬层上画一次
    slice.style.backgroundImage = 'none'
    slice.style.backgroundColor = 'transparent'
  }

  // 行组（tbody/thead/tfoot）：行克隆按原顺序 in-flow 堆叠进真实表格上下文。
  // abspos 独立行会丢失 border-collapse 的共享边框——每行自画全边框导致
  // 网格线加倍、行高 +1~2px 漂移，rowspan 跨行结构也会断；in-flow 让
  // 浏览器按原布局重新求解。外层 box 维持「内容归一化到窗口顶」的通用契约
  if (el.nodeType === Node.ELEMENT_NODE &&
      (/^table-(row|header|footer)-group$/.test(cs.display) ||
        el.tagName === 'TBODY' || el.tagName === 'THEAD' || el.tagName === 'TFOOT')) {
    const box = document.createElement('div')
    box.style.cssText = `position:absolute;left:0;top:0;` +
      `width:${rect.width}px;height:${sliceHeight}px;` +
      `margin:0;overflow:hidden;transform:none;box-sizing:border-box;`
    const group = el.cloneNode(false)
    group.removeAttribute('id')
    group.style.cssText += `;position:absolute;left:0;top:0;width:${rect.width}px;` +
      `margin:0;transform:none;box-sizing:border-box;`
    // 裸行组切片内没有 table 祖先，边框合并/间距是继承属性——显式补上，
    // 否则 in-flow 求解退化为 separate（网格线加倍）
    group.style.borderCollapse = cs.borderCollapse
    group.style.borderSpacing = cs.borderSpacing
    let firstTop = null
    for (const row of Array.from(el.children)) {
      const rr = row.getBoundingClientRect()
      const rTop = rr.top - rect.top
      if (rTop >= visTo || rTop + rr.height <= visFrom) continue
      if (getComputedStyle(row).visibility === 'hidden' && !hasVisibleOverride(row)) continue
      const rc = row.cloneNode(true)
      // nth-child 斑马纹按剩余兄弟重新计数 → 烘焙原行背景色（透明也烘焙）
      rc.style.backgroundColor = getComputedStyle(row).backgroundColor
      // 列宽固化：切片只含部分行，auto 表格布局会按剩余行重分配列宽；
      // 实测宽是 border-box，显式声明避免 content-box 页面每格 +2px
      const srcCells = row.querySelectorAll('td,th')
      const dstCells = rc.querySelectorAll('td,th')
      for (let k = 0; k < srcCells.length && k < dstCells.length; k++) {
        dstCells[k].style.width = `${srcCells[k].getBoundingClientRect().width}px`
        dstCells[k].style.boxSizing = 'border-box'
      }
      // 行内隐藏大子树 / abs 窗口外内容裁剪（与通用路径一致的兜底）
      pruneHiddenClone(rc, row.children, visFrom, visTo, rect, false)
      group.appendChild(rc)
      if (firstTop === null) firstTop = rTop
    }
    if (firstTop !== null) {
      group.style.top = `${firstTop - visFrom}px`
      box.appendChild(group)
    }
    return box
  }

  // flowTop：当前流位置（原元素相对坐标）——inline run 所在匿名块的顶部由此推导，
  // 比 Range 碎片矩形并集精确（后者有 ±1px 墨迹盒误差）
  let flowTop = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
  let run = []
  let olStartSet = false
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

    // inline 级元素中，inline-block/inline-table/inline-flex 是独立排版盒：
    // 若高于窗口（如固定列表格的测量容器、inline-block 包整页内容），
    // 走 run 路径会整树克隆进单个切片 —— 放行给下方 block 递归裁剪路径。
    // 同理：inline 元素内部混入 block 级后代（匿名块，如 <span> 包整张
    // <table>）时 run 路径无法裁剪 block 子树，一并放行。普通 inline
    // （含纯文本）不受影响，保持 run 重排
    const oversizedInlineBox = isInlineLevel(node) && node.nodeType === Node.ELEMENT_NODE &&
      getComputedStyle(node).display !== 'inline' &&
      node.getBoundingClientRect().height > windowHeight
    const inlineHasBlock = isInlineLevel(node) && node.nodeType === Node.ELEMENT_NODE &&
      getComputedStyle(node).display === 'inline' && hasBlockInsideInline(node)
    if (isInlineLevel(node) && !oversizedInlineBox && !inlineHasBlock) {
      run.push(node)
      continue
    }
    flushRun()

    const childRect = node.getBoundingClientRect()
    const top = childRect.top - rect.top
    // 无论是否落在区间内，都要推进流位置（区间外的 block 也占位）
    flowTop = top + childRect.height + (parseFloat(getComputedStyle(node).marginBottom) || 0)
    if (top >= toY || top + childRect.height <= fromY) continue // 区间外：物理丢弃

    // visibility:hidden 的子树（测量克隆 / 隐藏面板）与窗口相交时躲过上面的
    // 几何丢弃。切片内 block 子节点全部绝对定位、不占流位置，hidden 又不画
    // 任何像素 —— 直接整棵丢弃；子孙显式翻回 visible 的按普通内容处理
    if (node.nodeType === Node.ELEMENT_NODE &&
        getComputedStyle(node).visibility === 'hidden' && !hasVisibleOverride(node)) continue

    // ol 序号跨切片续接：切片只含部分 li，默认序号会从 1 重排；把首个保留 li
    // 的原序号写入 start（CSS counter() 自定义计数不支持，reversed 降序不支持，
    // 均属已知盲区）
    if (!olStartSet && el.tagName === 'OL' && node.tagName === 'LI') {
      let idx = 0
      for (const n of el.children) { if (n === node) break; if (n.tagName === 'LI') idx++ }
      slice.start = (el.start || 1) + idx
      olStartSet = true
    }

    let child
    // 表格子节点高于窗口：走表级切片（真实 table 上下文 + colgroup 列宽固化
    // + 行高钉死），不走通用递归——通用路径的行级克隆会破坏 collapse 边框
    const nodeDisplay = getComputedStyle(node).display
    if (childRect.height > windowHeight &&
        (node.tagName === 'TABLE' || nodeDisplay === 'table' || nodeDisplay === 'inline-table')) {
      child = createTableSlice(node, fromY - top, toY - top)
      if (child) {
        child.style.left = `${childRect.left - rect.left - borderX}px`
        child.style.top = `${top + child.__flowTop - visFrom - borderY}px`
        slice.appendChild(child)
      }
      continue
    }
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
      // 固化每个 cell 的实测宽度，保证跨切片列对齐（border-box 显式声明，
      // 实测宽含边框，content-box 页面不声明会每格 +2px）
      if (child.tagName === 'TR' || child.querySelector('tr')) {
        const srcCells = node.querySelectorAll('td,th')
        const dstCells = child.querySelectorAll('td,th')
        for (let k = 0; k < srcCells.length && k < dstCells.length; k++) {
          dstCells[k].style.width = `${srcCells[k].getBoundingClientRect().width}px`
          dstCells[k].style.boxSizing = 'border-box'
        }
      }
      // 整组克隆的行组（矮于窗口的 tbody/thead）：行虽保持 in-flow，但切片
      // 里没有 table 祖先，补上边框合并/间距，避免 collapse 退化为 separate
      if (child.tagName === 'TBODY' || child.tagName === 'THEAD' || child.tagName === 'TFOOT') {
        const ncs = getComputedStyle(node)
        child.style.borderCollapse = ncs.borderCollapse
        child.style.borderSpacing = ncs.borderSpacing
      }
      // 小盒子大内容兜底：盒子不高于窗口，但内部可能藏着轮播隐藏帧 /
      // overflow 折叠内容 / fixed 挂件 —— 不裁剪会把整个子树塞进切片。
      // 种子标记取盒子自身的 overflow：裁剪上下文从盒子的直接子级开始生效
      const csNode = getComputedStyle(node)
      pruneHiddenClone(child, node.children, visFrom, visTo, rect,
        /hidden|clip/.test(`${csNode.overflow} ${csNode.overflowX} ${csNode.overflowY}`))
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
  // inline run 里同样可能藏 abs 定位的大子树（Range 并集矩形会把它整组保进来）
  pruneHiddenClone(wrapper, run.filter(n => n.nodeType === Node.ELEMENT_NODE), fromY, toY, elRect, false)
  slice.appendChild(wrapper)
}

/**
 * 安全导出长图为图片文件（支持 iOS 高清不白屏）
 * @param {HTMLElement} sourceEl - 需要截图的原始 DOM 节点
 * @param {string} fileName - 导出的图片文件名
 * @param {{skipFonts?: boolean, font?: {cssText?: string}}} [options]
 *   - skipFonts: 跳过自动字体内嵌（改用系统字体）。整套中文字体 base64 可达
 *     数十 MB 且每个切片都背一份，iOS 会因 data: URL 过大加载失败
 *   - font: 透传库的 font 选项；font.cssText 可传入预先子集化好的
 *     @font-face CSS，兼顾字体保真与体量
 * @returns {Promise<HTMLCanvasElement>} 最终合成画布
 */
export async function safeExportLongImage(sourceEl, fileName = 'screenshot.png', options = {}) {
  const width = sourceEl.offsetWidth
  const height = sourceEl.offsetHeight
  if (!width || !height) throw new Error('[Screenshot] 目标节点尺寸为 0，无法截图')

  // 字体内嵌控制：显式 font 优先；skipFonts 用无害注释占位走库的 cssText 分支
  // （embedWebFont 检测到 font.cssText 即跳过全部自动内嵌）
  const fontOpt = options.font
    ? options.font
    : (options.skipFonts ? { cssText: '/* long-image: skipFonts */' } : undefined)
  const diag = { warned: false }

  // 1. 整体缩放率：优先原尺寸导出；仅当本机画布容纳不下时才降级到保守上限。
  //    16.7MP 是老设备（2~3GB RAM）的经验线；现代设备（iOS 18 实测）内存
  //    充裕可容纳 21MP+，固定降级会白白损失分辨率
  let finalScale = 1
  let probeNote = ''
  const totalPixels = width * height
  if (totalPixels > IOS_MAX_CANVAS_PIXELS) {
    if (globalThis.__TEST__?.forceConservative) {
      // [test hook] 测试可强制走保守降级路径，验证缩放机制
      finalScale = Math.min(1, Math.sqrt((IOS_MAX_CANVAS_PIXELS * SAFETY_RATIO) / totalPixels))
    } else if (canvasHolds(width, height)) {
      probeNote = ', 画布探测:原尺寸可用'
    } else {
      finalScale = Math.min(1, Math.sqrt((IOS_MAX_CANVAS_PIXELS * SAFETY_RATIO) / totalPixels))
      probeNote = ', 画布探测:本机容纳不下,已降级'
    }
  }

  // 2. 切片高度：每个切片的 DOM 面积（含跨界子节点）与切片 canvas 都落在安全区。
  //    MAX_SLICE_HEIGHT=200 同时低于 GPU 光栅损坏首带位置（~205px），见常量说明
  const sliceHeight = Math.max(1, Math.min(
    height,
    MAX_SLICE_HEIGHT,
    Math.floor((IOS_MAX_CANVAS_PIXELS * SAFETY_RATIO) / (Math.max(width, 1) * STRADDLE_FACTOR)),
  ))

  console.log(`[Screenshot] 原始尺寸: ${width}x${height}, 切片高度: ${sliceHeight}px, 缩放率: ${finalScale.toFixed(3)}${probeNote}`)

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
        const chunkCanvas = await renderSvgToCanvas(wrapper, width, bottom - top, finalScale, { font: fontOpt, diag })
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
