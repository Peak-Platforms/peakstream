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

// ── VIDEO QUALITY ─────────────────────────────────────────────────────────
const MAX_BITRATE = 10_000_000; // 10 Mbps hard ceiling (RTMP path only — real VBR)
const MAX_BITRATE_WEBRTC = 25_000_000; // 25 Mbps VBR ceiling, 1080p60 (WebRTC path)
const WEBRTC_FPS = 60;
const WEBRTC_WIDTH = 1920;
const WEBRTC_HEIGHT = 1080;

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
  const [webrtcBitrateKbps, setWebrtcBitrateKbps] = useState(0);
  const [webrtcFps, setWebrtcFps] = useState(0);
  const [webrtcStreamUrl, setWebrtcStreamUrl] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<any>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastBytesSentRef = useRef(0);
  const lastStatsTimeRef = useRef(0);

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

  // ── WebRTC path — react-native-webrtc, WHIP publish, VBR 1080p60 ≤25Mbps ──
  const startBitrateMonitor = useCallback((pc: RTCPeerConnection, videoTrackId: string) => {
    lastBytesSentRef.current = 0;
    lastStatsTimeRef.current = Date.now();
    statsIntervalRef.current = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        stats.forEach((report: any) => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            const now = Date.now();
            const dt = (now - lastStatsTimeRef.current) / 1000;
            const dBytes = report.bytesSent - lastBytesSentRef.current;
            const kbps = dt > 0 ? Math.round((dBytes * 8) / dt / 1000) : 0;
            lastBytesSentRef.current = report.bytesSent;
            lastStatsTimeRef.current = now;
            setWebrtcBitrateKbps(kbps);
            if (report.framesPerSecond) setWebrtcFps(Math.round(report.framesPerSecond));
          }
        });
      } catch {}
    }, 2000);
  }, []);

  const stopBitrateMonitor = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    setWebrtcBitrateKbps(0);
    setWebrtcFps(0);
  }, []);

  const goLiveWebrtc = useCallback(async () => {
    let stream;
    try {
      // 'ideal' lets the device pick its closest supported mode instead of
      // throwing OverconstrainedError if exact 1080p60 isn't available.
      stream = await mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: {ideal: WEBRTC_WIDTH},
          height: {ideal: WEBRTC_HEIGHT},
          frameRate: {ideal: WEBRTC_FPS},
        },
      });
    } catch (e) {
      // Hard fallback to a conservative mode if the device rejects the above.
      stream = await mediaDevices.getUserMedia({
        audio: true,
        video: {width: 1280, height: 720, frameRate: 30},
      });
    }
    localStreamRef.current = stream;
    setWebrtcStreamUrl(stream.toURL());

    const pc = new RTCPeerConnection({iceServers: []});
    pcRef.current = pc;

    let videoSender: any = null;
    stream.getTracks().forEach((track: any) => {
      const sender = pc.addTrack(track, stream);
      if (track.kind === 'video') videoSender = sender;
    });

    // VBR: WebRTC's encoder is variable-bitrate by default within these bounds —
    // no separate mode flag needed (unlike RootEncoder/RTMP's MAX_BITRATE path).
    // Wrapped defensively: some react-native-webrtc versions/devices don't
    // support setParameters on encodings — that must not crash the stream.
    if (videoSender) {
      try {
        const params = videoSender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = MAX_BITRATE_WEBRTC;
        params.encodings[0].maxFramerate = WEBRTC_FPS;
        params.degradationPreference = 'maintain-framerate';
        await videoSender.setParameters(params);
      } catch (e) {
        // Non-fatal — stream continues at whatever bitrate/fps the device defaults to.
      }
    }

    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);

    const res = await fetch(buildStreamUrl(cfg), {
      method: 'POST',
      headers: {'Content-Type': 'application/sdp'},
      body: offer.sdp,
    });
    const answerSdp = await res.text();
    await pc.setRemoteDescription({type: 'answer', sdp: answerSdp});

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) startBitrateMonitor(pc, videoTrack.id);
  }, [cfg, startBitrateMonitor]);

  const stopLiveWebrtc = useCallback(async () => {
    stopBitrateMonitor();
    setWebrtcStreamUrl(null);
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t: any) => t.stop());
    localStreamRef.current = null;
  }, [stopBitrateMonitor]);

  const goLive = useCallback(async () => {
    try {
      setBusy(true);
      if (cfg.protocol === 'rtmp') await goLiveRtmp();
      else await goLiveWebrtc();
      setLive(true);
      setStatus(`Live · ${cfg.protocol.toUpperCase()}`);
    } catch (err: any) {
      setStatus(`Start failed: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [cfg, goLiveRtmp, goLiveWebrtc]);

  const stopLive = useCallback(async () => {
    try {
      if (cfg.protocol === 'rtmp') await stopLiveRtmp();
      else await stopLiveWebrtc();
    } catch {}
    setLive(false);
    if (!recordLocally) setStatus('Stopped');
  }, [cfg.protocol, stopLiveRtmp, stopLiveWebrtc, recordLocally]);

  useEffect(() => () => { stopLive(); }, [stopLive]);

  if (showSettings) return <SettingsScreen cfg={cfg} onSave={saveConfig} />;

  return (
    <View style={styles.container}>
      {cfg.protocol === 'rtmp' && (
        <RtmpCameraPreview style={styles.cameraPreview} />
      )}
      {cfg.protocol === 'webrtc' && webrtcStreamUrl && (
        <RTCView streamURL={webrtcStreamUrl} style={styles.cameraPreview} objectFit="cover" />
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
        {cfg.streamKey || DEFAULT_STREAM_KEY} · {cfg.protocol.toUpperCase()}
        {cfg.protocol === 'rtmp' ? ' · VBR ≤10Mbps' : ' · VBR ≤25Mbps 1080p60'}
      </Text>

      {live && cfg.protocol === 'webrtc' && (
        <View style={styles.bitrateBadge}>
          <Text style={styles.bitrateBadgeText}>
            {webrtcBitrateKbps >= 1000
              ? `${(webrtcBitrateKbps / 1000).toFixed(1)} Mbps`
              : `${webrtcBitrateKbps} Kbps`}
            {webrtcFps ? ` · ${webrtcFps}fps` : ''}
          </Text>
        </View>
      )}

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
                {recordLocally ? '● RECORD LOCALLY: ON' : 'RECORD LOCALLY: OFF'}
              </Text>
            </Pressable>
          )}

          <Pressable style={styles.btn} onPress={goLive} disabled={busy}>
            <Text style={styles.btnText}>{busy ? 'Starting…' : '● GO LIVE'}</Text>
          </Pressable>
        </>
      ) : (
        <Pressable style={[styles.btn, styles.btnStop]} onPress={stopLive}>
          <Text style={styles.btnText}>⬛ STOP</Text>
        </Pressable>
      )}

      {busy && <ActivityIndicator style={{marginTop: 16}} color={RED} />}

      {!live && (
        <Pressable style={styles.settingsLink} onPress={() => setShowSettings(true)}>
          <Text style={styles.settingsLinkText}>⚙ Settings</Text>
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
          <Text style={settings.hint}>VBR active — floor 1.5Mbps, ceiling 10Mbps, adjusts to network conditions.</Text>
        )}
        {local.protocol === 'webrtc' && (
          <Text style={settings.hint}>VBR active — 1080p60, ceiling 25Mbps, adjusts to network conditions. Requires a strong connection.</Text>
        )}

        <Text style={settings.urlPreview}>→ {buildStreamUrl(local)}</Text>

        <Pressable style={settings.saveBtn} onPress={() => onSave(local)}>
          <Text style={settings.saveBtnText}>SAVE & CONTINUE</Text>
        </Pressable>

        <Text style={settings.footer}>Peak Platforms · XSEN · PeakStream</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {flex:1, alignItems:'center', justifyContent:'center', padding:28, gap:16, backgroundColor:BG},
  cameraPreview: {width:'100%', height:240, backgroundColor:'#000', borderRadius:8},
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
  bitrateBadge: {position:'absolute', top:16, right:16, backgroundColor:'rgba(0,0,0,0.6)', paddingHorizontal:10, paddingVertical:4, borderRadius:12},
  bitrateBadgeText: {color:'#f1f5f9', fontSize:12, fontFamily:'monospace', fontWeight:'600'},
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

