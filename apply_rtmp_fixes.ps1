# Writes fixes to native-src (the REAL source a config plugin copies
# into android/ on every prebuild).

$path1 = "C:\Users\sprin\peakstream\native-src\rtmp\RtmpCameraPreviewView.kt"
$content1 = @'
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
private const val MAX_BITRATE = 10_000_000 // hard ceiling — 10 Mbps

object RtmpCameraHolder {
  var camera: RtmpCamera1? = null
  var previewWidth: Int = 1280
  var previewHeight: Int = 720
  var previewResolved: Boolean = false
  // RTMP is back-camera only — no facing switch, no per-lens FOV mismatch
  // to tune. Simpler and more predictable than supporting flip.
}

// Camera1 will silently substitute the closest supported size when you
// request one it doesn't have — WITHOUT throwing an exception. That's the
// real bug: we were requesting 1280x720 blindly, the hardware picked
// something else internally, and our try/catch never caught it because
// nothing failed — we just kept believing 1280x720 was in effect. This
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
 * constructor overload — Camera2 requires OpenGlView) + plain SurfaceView +
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
      Log.i("RtmpCameraPreview", "Device supports: ${sizes?.joinToString { "${it.width}x${it.height}" }} — picked ${w}x${h}")
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
        Log.w("RtmpCameraPreview", "Using facing-only fallback — actual device default resolution unknown, verify in logcat.")
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

'@
Set-Content -Path $path1 -Value $content1 -Encoding UTF8
Write-Host "Wrote native-src\rtmp\RtmpCameraPreviewView.kt" -ForegroundColor Green

$path2 = "C:\Users\sprin\peakstream\native-src\rtmp\RtmpPublisherModule.kt"
$content2 = @'
package com.peakstream.rtmp

import android.util.Log
import com.facebook.react.bridge.*
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

private const val MAX_BITRATE = 10_000_000 // hard ceiling — 10 Mbps

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

  // Exposes the resolution RtmpCameraPreviewView actually negotiated —
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

  // RTMP is back-camera only (no switchCamera) — one lens means one FOV
  // to reason about, and no per-lens resolution/zoom mismatch to chase.
}

'@
Set-Content -Path $path2 -Value $content2 -Encoding UTF8
Write-Host "Wrote native-src\rtmp\RtmpPublisherModule.kt" -ForegroundColor Green

$path3 = "C:\Users\sprin\peakstream\BroadcasterScreen.tsx"
$content3 = @'
/**
 * BroadcasterScreen.tsx  —  PeakStream  (Android/Tablet Encoder)
 *
 * Dual protocol, real on-device encoding (unlike PeakStream POV, which
 * delegates encoding to Mentra glasses firmware):
 *   rtmp://...   → native RtmpPublisher module (RootEncoder), true VBR, 10Mbps cap, optional local recording
 *   https://...  → react-native-webrtc WHIP publish
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  NativeModules,
  PermissionsAndroid,
  Dimensions,
  requireNativeComponent,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {RTCPeerConnection, RTCView, mediaDevices} from 'react-native-webrtc';

const {RtmpPublisher} = NativeModules;
const RtmpCameraPreview = requireNativeComponent('RtmpCameraPreview');

// ── DEFAULTS ────────────────────────────────────────────────────────────────
const DEFAULT_SERVER_IP = '157.245.208.49';
const DEFAULT_STREAM_KEY = 'fancast-1';
const WEBRTC_HOST = 'peak.streampal.fun:8444'; // TLS cert — do not change
const STORAGE_KEY = 'peakstream_config';

// ── PREVIEW SIZING ───────────────────────────────────────────────────────
// SurfaceView (RTMP path) stretches its buffer to fill whatever container
// size it's given — it has no built-in aspect-ratio awareness like RTCView's
// objectFit does. So the container must match the camera's ACTUAL negotiated
// resolution. 16:9 was a hardcoded guess; if native falls back to a
// facing-only default (often 4:3), that guess is wrong and the stretch
// persists. We now ask the native module for the real resolution.
const SCREEN_WIDTH = Dimensions.get('window').width - 56; // minus container padding (28 * 2)
const DEFAULT_PREVIEW_HEIGHT = Math.round((SCREEN_WIDTH * 9) / 16); // fallback until native reports in

// ── BRAND COLORS (ported from PeakStream POV) ───────────────────────────────
const RED = '#dc2626';
const RED_DARK = '#991b1b';
const BG = '#0a0a0a';
const BG2 = '#111111';
const BORDER = 'rgba(220,38,38,0.15)';

interface Config {
  serverIp: string;
  streamKey: string;
  protocol: 'rtmp' | 'webrtc';
}

const DEFAULT_CONFIG: Config = {
  serverIp: DEFAULT_SERVER_IP,
  streamKey: DEFAULT_STREAM_KEY,
  protocol: 'rtmp',
};

function buildStreamUrl(cfg: Config): string {
  const key = cfg.streamKey.trim() || DEFAULT_STREAM_KEY;
  if (cfg.protocol === 'webrtc') {
    return `https://${WEBRTC_HOST}/${key}/whip`;
  }
  const ip = cfg.serverIp.trim() || DEFAULT_SERVER_IP;
  return `rtmp://${ip}:1935/live/${key}`;
}

export default function BroadcasterScreen() {
  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState('');
  const [recordLocally, setRecordLocally] = useState(false);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [localStream, setLocalStream] = useState<any>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [previewHeight, setPreviewHeight] = useState(DEFAULT_PREVIEW_HEIGHT);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<any>(null);
  const whipResourceUrlRef = useRef<string | null>(null);

  // Start/stop the WebRTC camera preview whenever the protocol is 'webrtc',
  // independent of live status — mirrors the RTMP SurfaceView, which is
  // always mounted so the operator can frame the shot before going live.
  useEffect(() => {
    let cancelled = false;
    if (cfg.protocol === 'webrtc' && permissionsGranted && !showSettings) {
      mediaDevices
        .getUserMedia({
          audio: true,
          video: {width: 1280, height: 720, frameRate: 30, facingMode: facing},
        })
        .then((stream: any) => {
          if (cancelled) {
            stream.getTracks().forEach((t: any) => t.stop());
            return;
          }
          // Replace the outgoing track live if we're already streaming,
          // so flipping camera mid-broadcast doesn't require a restart.
          if (pcRef.current && localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((t: any) => t.stop());
            const videoTrack = stream.getVideoTracks()[0];
            const sender = pcRef.current
              .getSenders()
              .find((s: any) => s.track && s.track.kind === 'video');
            sender?.replaceTrack(videoTrack);
          } else {
            localStreamRef.current?.getTracks().forEach((t: any) => t.stop());
          }
          localStreamRef.current = stream;
          setLocalStream(stream);
        })
        .catch((err: any) => setStatus(`Camera error: ${err?.message ?? err}`));
    }
    return () => {
      cancelled = true;
      if (cfg.protocol !== 'webrtc') {
        localStreamRef.current?.getTracks().forEach((t: any) => t.stop());
        localStreamRef.current = null;
        setLocalStream(null);
      }
    };
  }, [cfg.protocol, permissionsGranted, showSettings, facing]);

  const flipCamera = useCallback(() => {
    // RTMP is back-camera only — flip only applies to WebRTC mode.
    setFacing(prev => (prev === 'environment' ? 'user' : 'environment'));
  }, []);

  useEffect(() => {
    PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ]).then(result => {
      const granted =
        result[PermissionsAndroid.PERMISSIONS.CAMERA] === 'granted' &&
        result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted';
      setPermissionsGranted(granted);
      if (!granted) setStatus('Camera/mic permission required');
    });
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => {
        if (raw) {
          const saved = JSON.parse(raw) as Partial<Config>;
          setCfg(prev => ({...prev, ...saved}));
          setShowSettings(!saved.streamKey);
        } else {
          setShowSettings(true);
        }
      })
      .catch(() => setShowSettings(true));
  }, []);

  const saveConfig = useCallback(async (newCfg: Config) => {
    setCfg(newCfg);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newCfg));
    setShowSettings(false);
    setStatus('Settings saved');
  }, []);

  // ── RTMP path — native module, real VBR up to 10 Mbps, optional recording ──
  const goLiveRtmp = useCallback(async () => {
    await RtmpPublisher.startStream(buildStreamUrl(cfg), recordLocally);
  }, [cfg, recordLocally]);

  const stopLiveRtmp = useCallback(async () => {
    const result = await RtmpPublisher.stopStream();
    if (result?.recordingPath) {
      setStatus(`Saved: ${result.recordingPath}`);
    }
  }, []);

  const goLiveWebrtc = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) throw new Error('Camera preview not ready yet');

    const pc = new RTCPeerConnection({iceServers: []});
    pcRef.current = pc;
    stream.getTracks().forEach((track: any) => pc.addTrack(track, stream));

    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);

    const res = await fetch(buildStreamUrl(cfg), {
      method: 'POST',
      headers: {'Content-Type': 'application/sdp'},
      body: offer.sdp,
    });
    // WHIP servers return a Location header pointing at this session's
    // resource — DELETE it on stop for a clean server-side teardown
    // instead of relying on ICE timeout (which caused the 60s stop lag).
    const location = res.headers.get('Location');
    if (location) {
      whipResourceUrlRef.current = location.startsWith('http')
        ? location
        : new URL(location, buildStreamUrl(cfg)).toString();
    }
    const answerSdp = await res.text();
    await pc.setRemoteDescription({type: 'answer', sdp: answerSdp});
  }, [cfg]);

  const stopLiveWebrtc = useCallback(async () => {
    // Only close the publish connection — leave the local preview
    // (camera + mic tracks) running so the operator can frame the
    // next shot without waiting for permissions/camera to reinit.
    pcRef.current?.close();
    pcRef.current = null;

    if (whipResourceUrlRef.current) {
      fetch(whipResourceUrlRef.current, {method: 'DELETE'}).catch(() => {});
      whipResourceUrlRef.current = null;
    }
  }, []);

  const goLive = useCallback(async () => {
    try {
      setBusy(true);
      if (cfg.protocol === 'rtmp') await goLiveRtmp();
      else await goLiveWebrtc();
      setLive(true);
      setStatus(`Live - ${cfg.protocol.toUpperCase()}`);
    } catch (err: any) {
      setStatus(`Start failed: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [cfg, goLiveRtmp, goLiveWebrtc]);

  const stopLive = useCallback(async () => {
    // Update UI immediately — don't wait on teardown, which can block
    // for tens of seconds inside RTCPeerConnection.close() regardless
    // of how fast the server-side session actually closes.
    setLive(false);
    if (!recordLocally) setStatus('Stopped');

    try {
      if (cfg.protocol === 'rtmp') {
        await stopLiveRtmp();
      } else {
        // Fire-and-forget: don't block the UI on pc.close()
        stopLiveWebrtc().catch(() => {});
      }
    } catch {}
  }, [cfg.protocol, stopLiveRtmp, stopLiveWebrtc, recordLocally]);

  useEffect(() => () => { stopLive(); }, [stopLive]);

  // Once the RTMP preview mounts, ask native for the resolution it actually
  // negotiated (may differ from the 1280x720 request if it fell back), and
  // resize the container to match — fixes stretch for real instead of
  // guessing 16:9.
  useEffect(() => {
    if (cfg.protocol !== 'rtmp' || !permissionsGranted) return;
    let cancelled = false;
    let attempts = 0;

    const poll = async () => {
      if (cancelled) return;
      try {
        const {width, height, resolved} = await RtmpPublisher.getPreviewResolution();
        if (!cancelled && resolved && width && height) {
          setPreviewHeight(Math.round((SCREEN_WIDTH * height) / width));
          return; // native confirmed real negotiated values, stop polling
        }
      } catch {}
      attempts += 1;
      if (attempts < 15) setTimeout(poll, 200); // camera init is async, retry briefly
    };
    poll();

    return () => { cancelled = true; };
  }, [cfg.protocol, permissionsGranted]);

  if (showSettings) return <SettingsScreen cfg={cfg} onSave={saveConfig} />;

  return (
    <View style={styles.container}>
      {cfg.protocol === 'rtmp' && permissionsGranted && (
        <RtmpCameraPreview style={[styles.cameraPreview, {height: previewHeight}]} />
      )}
      {cfg.protocol === 'rtmp' && !permissionsGranted && (
        <View style={[styles.cameraPreview, {height: previewHeight, alignItems: 'center', justifyContent: 'center'}]}>
          <Text style={{color: '#555', fontSize: 12}}>Waiting for camera permission...</Text>
        </View>
      )}
      {cfg.protocol === 'webrtc' && localStream && (
        <RTCView
          streamURL={localStream.toURL()}
          style={[styles.cameraPreview, {height: previewHeight}]}
          objectFit="cover"
          mirror={false}
        />
      )}
      {cfg.protocol === 'webrtc' && !localStream && (
        <View style={[styles.cameraPreview, {height: previewHeight, alignItems: 'center', justifyContent: 'center'}]}>
          <Text style={{color: '#555', fontSize: 12}}>Starting camera preview...</Text>
        </View>
      )}

      {cfg.protocol === 'webrtc' && !!localStream && (
        <Pressable style={styles.flipBtn} onPress={flipCamera}>
          <Text style={styles.flipBtnText}>Flip</Text>
        </Pressable>
      )}

      <View style={styles.header}>
        <Text style={styles.titlePeak}>PEAK</Text>
        <Text style={styles.titleStream}>STREAM</Text>
      </View>
      <Text style={styles.subtitle}>A PEAK PLATFORMS PRODUCT</Text>

      <View style={[styles.statusPill, live && styles.statusPillLive]}>
        <Text style={[styles.statusText, live && styles.statusTextLive]}>
          {status || 'Ready'}
        </Text>
      </View>

      <Text style={styles.keyLabel}>
        {cfg.streamKey || DEFAULT_STREAM_KEY} - {cfg.protocol.toUpperCase()}
        {cfg.protocol === 'rtmp' ? ' - VBR up to 10Mbps' : ''}
      </Text>

      {!live ? (
        <>
          <View style={styles.toggleRow}>
            {(['rtmp', 'webrtc'] as const).map(p => (
              <Pressable key={p}
                style={[styles.toggle, cfg.protocol === p && styles.toggleActive]}
                onPress={() => setCfg(prev => ({...prev, protocol: p}))}>
                <Text style={[styles.toggleText, cfg.protocol === p && styles.toggleTextActive]}>
                  {p.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>

          {cfg.protocol === 'rtmp' && (
            <Pressable
              style={[styles.toggle, recordLocally && styles.toggleActive]}
              onPress={() => setRecordLocally(v => !v)}>
              <Text style={[styles.toggleText, recordLocally && styles.toggleTextActive]}>
                {recordLocally ? 'RECORD LOCALLY: ON' : 'RECORD LOCALLY: OFF'}
              </Text>
            </Pressable>
          )}

          <Pressable style={styles.btn} onPress={goLive} disabled={busy}>
            <Text style={styles.btnText}>{busy ? 'Starting...' : 'GO LIVE'}</Text>
          </Pressable>
        </>
      ) : (
        <Pressable style={[styles.btn, styles.btnStop]} onPress={stopLive}>
          <Text style={styles.btnText}>STOP</Text>
        </Pressable>
      )}

      {busy && <ActivityIndicator style={{marginTop: 16}} color={RED} />}

      {!live && (
        <Pressable style={styles.settingsLink} onPress={() => setShowSettings(true)}>
          <Text style={styles.settingsLinkText}>Settings</Text>
        </Pressable>
      )}
    </View>
  );
}

function SettingsScreen({cfg, onSave}: {cfg: Config; onSave: (c: Config) => void}) {
  const [local, setLocal] = useState<Config>({...cfg});
  const set = (key: keyof Config) => (val: string) => setLocal(prev => ({...prev, [key]: val}));

  return (
    <KeyboardAvoidingView style={{flex: 1, backgroundColor: BG}}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={settings.container}>
        <View style={settings.headerRow}>
          <Text style={settings.titlePeak}>PEAK</Text>
          <Text style={settings.titleStream}>STREAM</Text>
        </View>
        <Text style={settings.subtitle}>A PEAK PLATFORMS PRODUCT</Text>

        <Text style={settings.section}>Operator Setup</Text>

        {local.protocol === 'rtmp' ? (
          <>
            <Text style={settings.label}>RTMP SERVER IP</Text>
            <TextInput style={settings.input} value={local.serverIp}
              onChangeText={set('serverIp')} placeholder={DEFAULT_SERVER_IP}
              placeholderTextColor="#555" autoCapitalize="none" keyboardType="numeric" />
          </>
        ) : (
          <>
            <Text style={settings.label}>WEBRTC SERVER</Text>
            <View style={settings.readOnly}>
              <Text style={settings.readOnlyText}>{WEBRTC_HOST}</Text>
            </View>
          </>
        )}

        <Text style={settings.label}>STREAM KEY</Text>
        <TextInput style={settings.input} value={local.streamKey}
          onChangeText={set('streamKey')} placeholder="e.g. camera1"
          placeholderTextColor="#555" autoCapitalize="none" autoCorrect={false} />

        <Text style={settings.label}>DEFAULT PROTOCOL</Text>
        <View style={settings.toggleRow}>
          {(['rtmp', 'webrtc'] as const).map(p => (
            <Pressable key={p}
              style={[settings.toggle, local.protocol === p && settings.toggleActive]}
              onPress={() => setLocal(prev => ({...prev, protocol: p}))}>
              <Text style={[settings.toggleText, local.protocol === p && settings.toggleTextActive]}>
                {p.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>

        {local.protocol === 'rtmp' && (
          <Text style={settings.hint}>VBR active - floor 1.5Mbps, ceiling 10Mbps, adjusts to network conditions.</Text>
        )}

        <Text style={settings.urlPreview}>-&gt; {buildStreamUrl(local)}</Text>

        <Pressable style={settings.saveBtn} onPress={() => onSave(local)}>
          <Text style={settings.saveBtnText}>SAVE & CONTINUE</Text>
        </Pressable>

        <Text style={settings.footer}>Peak Platforms - XSEN - PeakStream</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {flex:1, alignItems:'center', justifyContent:'center', padding:28, gap:16, backgroundColor:BG},
  cameraPreview: {width:'100%', backgroundColor:'#000', borderRadius:8, zIndex:1, elevation:1},
  flipBtn: {alignSelf:'flex-end', marginTop:-8, backgroundColor:'rgba(0,0,0,0.6)', paddingVertical:6, paddingHorizontal:14, borderRadius:16, borderWidth:1, borderColor:RED},
  flipBtnText: {color:'#fff', fontSize:12, fontWeight:'600'},
  header: {flexDirection:'row', alignItems:'baseline'},
  titlePeak: {fontSize:36, fontWeight:'900', color:'#ffffff'},
  titleStream: {fontSize:36, fontWeight:'900', color:'#ffffff'},
  subtitle: {fontSize:10, color:'#555', letterSpacing:2, textTransform:'uppercase', marginTop:-8},
  statusPill: {backgroundColor:BG2, borderWidth:1, borderColor:BORDER, borderRadius:20, paddingVertical:6, paddingHorizontal:16},
  statusPillLive: {borderColor:RED, backgroundColor:'rgba(220,38,38,0.1)'},
  statusText: {fontSize:13, color:'#555', textAlign:'center'},
  statusTextLive: {color:RED, fontWeight:'700'},
  keyLabel: {fontSize:11, color:'#333', fontFamily:'monospace'},
  btn: {backgroundColor:RED, paddingVertical:16, paddingHorizontal:40, borderRadius:8, minWidth:240, alignItems:'center'},
  btnStop: {backgroundColor:'#1a1a1a', borderWidth:2, borderColor:RED},
  btnText: {color:'#fff', fontSize:16, fontWeight:'800', letterSpacing:1},
  toggleRow: {flexDirection:'row', gap:8},
  toggle: {paddingVertical:8, paddingHorizontal:24, borderRadius:6, borderWidth:1, borderColor:RED},
  toggleActive: {backgroundColor:RED},
  toggleText: {color:RED, fontWeight:'700'},
  toggleTextActive: {color:'#fff'},
  settingsLink: {marginTop:8},
  settingsLinkText: {color:'#333', fontSize:13},
});

const settings = StyleSheet.create({
  container: {padding:28, gap:8, backgroundColor:BG, flexGrow:1},
  headerRow: {flexDirection:'row', alignItems:'baseline', justifyContent:'center', marginBottom:2},
  titlePeak: {fontSize:28, fontWeight:'900', color:'#ffffff'},
  titleStream: {fontSize:28, fontWeight:'900', color:'#ffffff'},
  subtitle: {fontSize:10, color:'#555', letterSpacing:2, textTransform:'uppercase', textAlign:'center', marginBottom:20},
  section: {fontSize:11, fontWeight:'700', color:RED, letterSpacing:1.5, textTransform:'uppercase', marginTop:16, marginBottom:4},
  hint: {fontSize:11, color:'#444', lineHeight:16, marginTop:8},
  label: {fontSize:10, fontWeight:'600', color:'#555', letterSpacing:1, textTransform:'uppercase', marginTop:12, marginBottom:4},
  input: {backgroundColor:BG2, borderWidth:1, borderColor:'rgba(220,38,38,0.2)', borderRadius:8, padding:14, fontSize:15, color:'#f1f5f9'},
  readOnly: {backgroundColor:BG2, borderWidth:1, borderColor:'rgba(220,38,38,0.2)', borderRadius:8, padding:14},
  readOnlyText: {fontSize:15, color:'#555'},
  toggleRow: {flexDirection:'row', gap:8, marginTop:4},
  toggle: {flex:1, paddingVertical:10, borderRadius:6, borderWidth:1, borderColor:RED, alignItems:'center'},
  toggleActive: {backgroundColor:RED},
  toggleText: {color:RED, fontWeight:'700'},
  toggleTextActive: {color:'#fff'},
  urlPreview: {fontSize:10, color:'#333', fontFamily:'monospace', marginTop:8, marginBottom:4},
  saveBtn: {backgroundColor:RED, paddingVertical:16, borderRadius:8, alignItems:'center', marginTop:24},
  saveBtnText: {color:'#fff', fontSize:16, fontWeight:'800', letterSpacing:1},
  footer: {fontSize:10, color:'#222', textAlign:'center', letterSpacing:1, textTransform:'uppercase', marginTop:24},
});


'@
Set-Content -Path $path3 -Value $content3 -Encoding UTF8
Write-Host "Wrote BroadcasterScreen.tsx" -ForegroundColor Green

Write-Host ""
$check = Select-String -Path $path3 -Pattern "GO LIVE" -SimpleMatch
if ($check) { Write-Host "CONFIRMED: glyph cleanup present" -ForegroundColor Green }
else { Write-Host "WARNING: expected change NOT found after write" -ForegroundColor Red }

Write-Host ""
Write-Host "Next: npx expo prebuild -p android"
Write-Host "Then: eas build --platform android --profile development"

