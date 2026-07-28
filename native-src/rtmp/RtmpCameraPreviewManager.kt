package com.peakstream.rtmp

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

class RtmpCameraPreviewManager : SimpleViewManager<RtmpCameraPreviewView>() {
  override fun getName() = "RtmpCameraPreview"

  override fun createViewInstance(reactContext: ThemedReactContext): RtmpCameraPreviewView {
    return RtmpCameraPreviewView(reactContext)
  }
}
