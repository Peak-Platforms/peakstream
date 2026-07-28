package com.peakstream.rtmp

import android.content.Context
import android.util.AttributeSet
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.video.CameraHelper
import com.pedro.library.rtmp.RtmpCamera1

private const val MIN_BITRATE = 1_500_000
private const val MAX_BITRATE = 10_000_000 // hard ceiling â€” 10 Mbps

object RtmpCameraHolder {
  var camera: RtmpCamera1? = null
  var previewWidth: Int = 1280
  var previewHeight: Int = 720
  var previewResolved: Boolean = false
  // RTMP is back-camera only â€” no facing switch, no per-lens FOV mismatch
  // to tune. Simpler and more predictable than supporting flip.
}

// Camera1 will silently substitute the closest supported size when you
// request one it doesn't have â€” WITHOUT throwing an exception. That's the
// real bug: we were requesting 1280x720 blindly, the hardware picked
// something else internally, and our try/catch never caught it because
// nothing failed â€” we just kept believing 1280x720 was in effect. This
// picks from the camera's own reported supported sizes so what we request
// is guaranteed to be what we get.
internal fun pickBestSize(sizes: List<android.hardware.Camera.Size>?): Pair<Int, Int> {
  if (sizes.isNullOrEmpty()) return 1280 to 720
  val target = 16.0 / 9.0
  val best = sizes.minByOrNull { size ->
    val aspect = size.width.toDouble() / size.height.toDouble()
    val aspectDiff = kotlin.math.abs(aspect - target)
    val sizeDiff = kotlin.math.abs(size.width - 1920) / 1920.0
    aspectDiff * 10 + sizeDiff // prioritize matching aspect ratio over exact size
  } ?: return 1280 to 720
  return best.width to best.height
}

/**
 * Confirmed-working combo: RtmpCamera1 (only Camera1 has a SurfaceView
 * constructor overload â€” Camera2 requires OpenGlView) + plain SurfaceView +
 * setZOrderOnTop (fixes the "invisible preview" SurfaceView z-order issue).
 * Distortion mitigation queries the device's actual supported preview sizes
 * (pickBestSize) rather than assuming a fixed resolution, since Camera1
 * silently substitutes an unsupported request without erroring.
 */
class RtmpCameraPreviewView(context: Context, attrs: AttributeSet? = null) :
  SurfaceView(context, attrs), SurfaceHolder.Callback {

  init {
    setZOrderOnTop(true)
    holder.addCallback(this)
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    if (RtmpCameraHolder.camera != null) return

    val camera = RtmpCamera1(this, object : ConnectChecker {
      override fun onConnectionStarted(url: String) {}
      override fun onConnectionSuccess() {}
      override fun onConnectionFailed(reason: String) {
        RtmpCameraHolder.camera?.stopStream()
      }
      override fun onNewBitrate(bitrate: Long) {
        val cam = RtmpCameraHolder.camera ?: return
        val current = cam.bitrate
        val next = if (bitrate < current) {
          (current * 0.85).toInt().coerceAtLeast(MIN_BITRATE)
        } else {
          (current * 1.1).toInt().coerceAtMost(MAX_BITRATE)
        }
        if (next != current) cam.setVideoBitrateOnFly(next)
      }
      override fun onDisconnect() {}
      override fun onAuthError() {}
      override fun onAuthSuccess() {}
    })
    RtmpCameraHolder.camera = camera

    try {
      val sizes = camera.resolutionsBack
      val (w, h) = pickBestSize(sizes)
      Log.i("RtmpCameraPreview", "Device supports: ${sizes?.joinToString { "${it.width}x${it.height}" }} â€” picked ${w}x${h}")
      camera.startPreview(CameraHelper.Facing.BACK, w, h)
      RtmpCameraHolder.previewWidth = w
      RtmpCameraHolder.previewHeight = h
      RtmpCameraHolder.previewResolved = true
    } catch (e: Exception) {
      Log.w("RtmpCameraPreview", "Resolution-list startPreview failed, trying facing-only: ${e.message}")
      try {
        camera.startPreview(CameraHelper.Facing.BACK)
        RtmpCameraHolder.previewWidth = 640
        RtmpCameraHolder.previewHeight = 480
        RtmpCameraHolder.previewResolved = true
        Log.w("RtmpCameraPreview", "Using facing-only fallback â€” actual device default resolution unknown, verify in logcat.")
      } catch (e2: Exception) {
        Log.e("RtmpCameraPreview", "startPreview failed entirely: ${e2.message}")
      }
    }
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    RtmpCameraHolder.camera?.let {
      if (it.isStreaming) it.stopStream()
      if (it.isOnPreview) it.stopPreview()
    }
    RtmpCameraHolder.camera = null
    RtmpCameraHolder.previewResolved = false
  }
}

