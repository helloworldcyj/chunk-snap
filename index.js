import { domToCanvas } from 'modern-screenshot'

/**
 * 安全导出长图为图片文件（支持 iOS 高清不白屏）
 * @param {HTMLElement} sourceEl - 需要截图的原始 DOM 节点
 * @param {string} fileName - 导出的图片文件名，默认为 'screenshot.png'
 */
export async function safeExportLongImage(sourceEl, fileName = 'screenshot.png') {
  // 1. 深度克隆节点用于离屏排版，避免直接操作页面影响用户视觉
  const cloneEl = sourceEl.cloneNode(true)
  cloneEl.style.position = 'absolute'
  cloneEl.style.top = '-9999px'
  cloneEl.style.left = '-9999px'
  // 确保克隆节点的宽度和原始节点保持一致，防止自适应布局变形
  cloneEl.style.width = `${sourceEl.offsetWidth}px` 
  document.body.appendChild(cloneEl)

  // 获取原始物理高宽
  const originalWidth = cloneEl.offsetWidth
  const originalHeight = cloneEl.offsetHeight

  // 2. iOS 安全红线定义
  // iOS 设备的单个 Canvas 内存硬限制通常为 16,777,216 像素 (4096 * 4096)
  const MAX_CANVAS_PIXELS = 16777216 
  // 每一块切片的原始高度（2000px 配合 3000px 宽，面积为 6M，绝对不会触发 foreignObject 限制）
  const SAFE_CHUNK_HEIGHT = 2000     

  // 3. 动态计算最高允许的比例，以绕过最终大 Canvas 的 iOS 限制
  let finalScale = 1.0
  const totalPixels = originalWidth * originalHeight
  
  if (totalPixels > MAX_CANVAS_PIXELS) {
    // 留出 15% 的安全余量，倒推极限 scale
    finalScale = Math.sqrt((MAX_CANVAS_PIXELS * 0.85) / totalPixels)
    // 确保 scale 不会大于 1
    finalScale = Math.min(finalScale, 1.0) 
  }

  console.log(`[Screenshot] 原始尺寸: ${originalWidth}x${originalHeight}, 触发 iOS 安全控制，动态缩放率: ${finalScale.toFixed(2)}`)

  try {
    // 4. 创建最终拼接的“大画布”，其尺寸已被 finalScale 压减至安全范围
    const finalCanvas = document.createElement('canvas')
    finalCanvas.width = originalWidth * finalScale
    finalCanvas.height = originalHeight * finalScale
    const ctx = finalCanvas.getContext('2d')

    // 5. 分步循环切片，并在单次 modern-screenshot 执行中注入 scale
    for (let top = 0; top < originalHeight; top += SAFE_CHUNK_HEIGHT) {
      const chunkHeight = Math.min(SAFE_CHUNK_HEIGHT, originalHeight - top)

      // 单个切片在安全尺寸内，iOS 允许正常渲染
      const chunkCanvas = await domToCanvas(cloneEl, {
        width: originalWidth,
        height: chunkHeight,
        scale: finalScale, // 【核心突破点】在 foreignObject 报错前缩小位图
        style: {
          transform: `translateY(-${top}px)`,
          transformOrigin: 'top left'
        }
      })

      // 将已经缩小的高清切片，精准画到大画布的对应缩放坐标上
      ctx.drawImage(
        chunkCanvas, 
        0, 
        top * finalScale
      )
    }

    // 6. 抛弃 Base64，直接导出无损 Blob 并触发原生下载文件
    finalCanvas.toBlob((blob) => {
      if (!blob) {
        throw new Error('Canvas 导出 Blob 失败')
      }
      const fileUrl = URL.createObjectURL(blob)
      
      const link = document.createElement('a')
      link.download = fileName
      link.href = fileUrl
      link.click()

      // 延迟释放 URL，避免下载未触发前被回收
      setTimeout(() => URL.revokeObjectURL(fileUrl), 60000)
    }, 'image/png')

  } catch (error) {
    console.error('[Screenshot] 导出失败:', error)
    alert('生成图片失败，请重试')
  } finally {
    // 7. 销毁克隆的临时 DOM 节点，防止内存泄漏
    document.body.removeChild(cloneEl)
  }
}
