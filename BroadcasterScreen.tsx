/**
 * BroadcasterScreen.tsx  —  PeakStream  (WebRTC-only Encoder)
 *
 * WebRTC/WHIP publish only. RTMP support (native RootEncoder module,
 * server-IP field, protocol toggle, local recording) has been removed —
 * that capability now lives in StreamPal Broadcaster.
 *
 * Nothing below in the WebRTC code path has been changed from the
 * dual-protocol version — only RTMP-specific code was removed.
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
  PermissionsAndroid,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {RTCPeerConnection, RTCView, mediaDevices} from 'react-native-webrtc';

// ── DEFAULTS ─────────────────────────────────────────────────────────────
const DEFAULT_STREAM_KEY = 'fancast-1';
const WEBRTC_HOST = 'peak.streampal.fun:8444'; // TLS cert — do not change
const STORAGE_KEY = 'peakstream_config';

// ── BRAND COLORS ─────────────────────────────────────────────────────────
const RED = '#dc2626';
const BG = '#0a0a0a';
const BG2 = '#111111';
const BORDER = 'rgba(220,38,38,0.15)';

interface Config {
  streamKey: string;
}

const DEFAULT_CONFIG: Config = {
  streamKey: DEFAULT_STREAM_KEY,
};

function buildStreamUrl(cfg: Config): string {
  const key = cfg.streamKey.trim() || DEFAULT_STREAM_KEY;
  return `https://${WEBRTC_HOST}/${key}/whip`;
}

export default function BroadcasterScreen() {
  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState('');
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [localStream, setLocalStream] = useState<any>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<any>(null);
  const whipResourceUrlRef = useRef<string | null>(null);

  // Start/stop the WebRTC camera preview — always mounted (once permissions
  // are granted) so the operator can frame the shot before going live.
  // UNCHANGED from the dual-protocol version.
  useEffect(() => {
    let cancelled = false;
    if (permissionsGranted && !showSettings) {
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
    };
  }, [permissionsGranted, showSettings, facing]);

  const flipCamera = useCallback(() => {
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

  // ── WebRTC/WHIP path — UNCHANGED from the dual-protocol version ──────────
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
      await goLiveWebrtc();
      setLive(true);
      setStatus('Live - WEBRTC');
    } catch (err: any) {
      setStatus(`Start failed: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [goLiveWebrtc]);

  const stopLive = useCallback(async () => {
    // Update UI immediately — don't wait on teardown, which can block
    // for tens of seconds inside RTCPeerConnection.close() regardless
    // of how fast the server-side session actually closes.
    setLive(false);
    setStatus('Stopped');
    stopLiveWebrtc().catch(() => {}); // fire-and-forget, don't block UI
  }, [stopLiveWebrtc]);

  useEffect(() => () => { stopLive(); }, [stopLive]);

  if (showSettings) return <SettingsScreen cfg={cfg} onSave={saveConfig} />;

  return (
    <View style={styles.container}>
      {localStream && (
        <RTCView
          key={localStream.toURL()}
          streamURL={localStream.toURL()}
          style={styles.fullScreenPreview}
          objectFit="cover"
          mirror={false}
          zOrder={2}
        />
      )}
      {!localStream && (
        <View style={[styles.fullScreenPreview, styles.previewPlaceholder]}>
          <Text style={{color: '#555', fontSize: 12}}>Starting camera preview...</Text>
        </View>
      )}

      {!!localStream && (
        <Pressable style={styles.flipBtn} onPress={flipCamera}>
          <Text style={styles.flipBtnText}>Flip</Text>
        </Pressable>
      )}

      <View style={styles.overlayTop}>
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
          {cfg.streamKey || DEFAULT_STREAM_KEY} - WEBRTC
        </Text>
      </View>

      <View style={styles.overlayBottom}>
        {!live ? (
          <Pressable style={styles.btn} onPress={goLive} disabled={busy}>
            <Text style={styles.btnText}>{busy ? 'Starting...' : 'GO LIVE'}</Text>
          </Pressable>
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
    </View>
  );
}

function SettingsScreen({cfg, onSave}: {cfg: Config; onSave: (c: Config) => void}) {
  const [local, setLocal] = useState<Config>({...cfg});

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

        <Text style={settings.label}>WEBRTC SERVER</Text>
        <View style={settings.readOnly}>
          <Text style={settings.readOnlyText}>{WEBRTC_HOST}</Text>
        </View>

        <Text style={settings.label}>STREAM KEY</Text>
        <TextInput style={settings.input} value={local.streamKey}
          onChangeText={(v) => setLocal(prev => ({...prev, streamKey: v}))}
          placeholder="e.g. camera1"
          placeholderTextColor="#555" autoCapitalize="none" autoCorrect={false} />

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
  container: {flex:1, backgroundColor:BG},
  fullScreenPreview: {...StyleSheet.absoluteFillObject, backgroundColor:'#000'},
  previewPlaceholder: {alignItems:'center', justifyContent:'center'},
  flipBtn: {position:'absolute', top:56, right:20, backgroundColor:'rgba(0,0,0,0.6)', paddingVertical:6, paddingHorizontal:14, borderRadius:16, borderWidth:1, borderColor:RED, zIndex:2},
  flipBtnText: {color:'#fff', fontSize:12, fontWeight:'600'},
  overlayTop: {position:'absolute', top:0, left:0, right:0, alignItems:'center', paddingTop:48, paddingBottom:20, paddingHorizontal:20, gap:8, backgroundColor:'rgba(10,10,10,0.55)'},
  overlayBottom: {position:'absolute', bottom:0, left:0, right:0, alignItems:'center', paddingTop:20, paddingBottom:36, paddingHorizontal:20, gap:8, backgroundColor:'rgba(10,10,10,0.55)'},
  header: {flexDirection:'row', alignItems:'baseline'},
  titlePeak: {fontSize:32, fontWeight:'900', color:'#ffffff'},
  titleStream: {fontSize:32, fontWeight:'900', color:'#ffffff'},
  subtitle: {fontSize:10, color:'#aaa', letterSpacing:2, textTransform:'uppercase', marginTop:-6},
  statusPill: {backgroundColor:'rgba(17,17,17,0.85)', borderWidth:1, borderColor:BORDER, borderRadius:20, paddingVertical:6, paddingHorizontal:16, marginTop:8},
  statusPillLive: {borderColor:RED, backgroundColor:'rgba(220,38,38,0.15)'},
  statusText: {fontSize:13, color:'#999', textAlign:'center'},
  statusTextLive: {color:RED, fontWeight:'700'},
  keyLabel: {fontSize:11, color:'#888', fontFamily:'monospace'},
  btn: {backgroundColor:RED, paddingVertical:16, paddingHorizontal:40, borderRadius:8, minWidth:240, alignItems:'center'},
  btnStop: {backgroundColor:'rgba(26,26,26,0.9)', borderWidth:2, borderColor:RED},
  btnText: {color:'#fff', fontSize:16, fontWeight:'800', letterSpacing:1},
  settingsLink: {marginTop:4},
  settingsLinkText: {color:'#aaa', fontSize:13},
});

const settings = StyleSheet.create({
  container: {padding:28, gap:8, backgroundColor:BG, flexGrow:1},
  headerRow: {flexDirection:'row', alignItems:'baseline', justifyContent:'center', marginBottom:2},
  titlePeak: {fontSize:28, fontWeight:'900', color:'#ffffff'},
  titleStream: {fontSize:28, fontWeight:'900', color:'#ffffff'},
  subtitle: {fontSize:10, color:'#555', letterSpacing:2, textTransform:'uppercase', textAlign:'center', marginBottom:20},
  section: {fontSize:11, fontWeight:'700', color:RED, letterSpacing:1.5, textTransform:'uppercase', marginTop:16, marginBottom:4},
  label: {fontSize:10, fontWeight:'600', color:'#555', letterSpacing:1, textTransform:'uppercase', marginTop:12, marginBottom:4},
  input: {backgroundColor:BG2, borderWidth:1, borderColor:'rgba(220,38,38,0.2)', borderRadius:8, padding:14, fontSize:15, color:'#f1f5f9'},
  readOnly: {backgroundColor:BG2, borderWidth:1, borderColor:'rgba(220,38,38,0.2)', borderRadius:8, padding:14},
  readOnlyText: {fontSize:15, color:'#555'},
  urlPreview: {fontSize:10, color:'#333', fontFamily:'monospace', marginTop:8, marginBottom:4},
  saveBtn: {backgroundColor:RED, paddingVertical:16, borderRadius:8, alignItems:'center', marginTop:24},
  saveBtnText: {color:'#fff', fontSize:16, fontWeight:'800', letterSpacing:1},
  footer: {fontSize:10, color:'#222', textAlign:'center', letterSpacing:1, textTransform:'uppercase', marginTop:24},
});

