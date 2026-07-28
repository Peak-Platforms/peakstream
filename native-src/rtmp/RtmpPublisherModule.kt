package com.peakstream.rtmp

import android.util.Log
import com.facebook.react.bridge.*
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

private const val MAX_BITRATE = 10_000_000 // hard ceiling â€” 10 Mbps

class RtmpPublisherModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var lastRecordingPath: String? = null

  override fun getName() = "RtmpPublisher"

  @ReactMethod
  fun startStream(rtmpUrl: String, record: Boolean, promise: Promise) {
    try {
      val camera = RtmpCameraHolder.camera
        ?: throw IllegalStateException("Camera preview not mounted yet")
      if (!camera.isStreaming) {
        val prepared = camera.prepareVideo(1280, 720, MAX_BITRATE) && camera.prepareAudio()
        if (!prepared) {
          promise.reject("PREPARE_FAILED", "Could not prepare encoder")
          return
        }
        camera.startStream(rtmpUrl)
        if (record) {
          val dir = reactContext.getExternalFilesDir(null)
          val name = "PeakStream_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}.mp4"
          val file = File(dir, name)
          camera.startRecord(file.absolutePath)
          lastRecordingPath = file.absolutePath
        }
      }
      promise.resolve(true)
    } catch (e: Exception) {
      Log.e("RtmpPublisher", "startStream failed", e)
      promise.reject("START_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun stopStream(promise: Promise) {
    try {
      val camera = RtmpCameraHolder.camera
      if (camera?.isRecording == true) camera.stopRecord()
      camera?.stopStream()
      val result = Arguments.createMap()
      result.putString("recordingPath", lastRecordingPath)
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("STOP_FAILED", e.message, e)
    }
  }

  // Exposes the resolution RtmpCameraPreviewView actually negotiated â€”
  // queried from the camera's own supported-sizes list, not assumed.
  // `resolved: false` means startPreview() hasn't completed yet; JS should
  // keep polling rather than trusting these as real numbers.
  @ReactMethod
  fun getPreviewResolution(promise: Promise) {
    val map = Arguments.createMap()
    map.putInt("width", RtmpCameraHolder.previewWidth)
    map.putInt("height", RtmpCameraHolder.previewHeight)
    map.putBoolean("resolved", RtmpCameraHolder.previewResolved)
    promise.resolve(map)
  }

  // RTMP is back-camera only (no switchCamera) â€” one lens means one FOV
  // to reason about, and no per-lens resolution/zoom mismatch to chase.
}

