import { useEffect, useState, useSyncExternalStore } from 'react'
import type { VoiceController } from './controller.ts'
import { loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'

const styles = {
  button: { width: 32, height: 32, border: 0, borderRadius: 999, cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-label-secondary)', background: 'transparent' },
  active: { color: '#fff', background: '#2563eb' },
  dock: { margin: '0 auto 4px', maxWidth: 760, padding: '8px 12px', borderRadius: '10px 10px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-specific-tip)' },
  card: { padding: '14px 16px' },
  row: { display: 'grid', gridTemplateColumns: '170px 1fr', gap: 12, alignItems: 'center', marginTop: 10 },
  input: { minWidth: 0, padding: '7px 9px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, background: 'var(--dsw-alias-bg-base)', color: 'inherit' },
} as const

export function MicButton({ controller }: { controller: VoiceController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const active = snapshot.state !== 'idle'
  return <button type="button" aria-label={active ? '停止实时语音' : '开始实时语音'} aria-pressed={active}
    title={active ? '停止实时语音' : '开始实时语音'} style={{ ...styles.button, ...(active ? styles.active : {}) }}
    onClick={() => { void controller.toggle() }}>
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z" /></svg>
  </button>
}

interface NativeInputProps {
  input: { readonly draft: string; readonly draftRev: number; readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' }
  inputActions: { setDraft(text: string): void; submit(): void }
}

export function VoiceStatus({ controller, input, inputActions }: { controller: VoiceController } & NativeInputProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => controller.bindDraft({
    getDraft: () => input.draft, getDraftRev: () => input.draftRev, getPhase: () => input.phase,
    setDraft: text => inputActions.setDraft(text), submit: () => inputActions.submit(),
  }), [controller, input.draft, input.draftRev, input.phase, inputActions])
  if (snapshot.state === 'idle') return null
  const labels = { connecting: '正在连接', listening: '正在聆听', speaking: '正在说话', working: '主模型正在处理', error: '语音不可用' }
  return <div role={snapshot.state === 'error' ? 'alert' : 'status'} style={styles.dock}>
    <div>{labels[snapshot.state]}{snapshot.playback === 'paused' ? ' · 播放已暂停' : ''}{snapshot.detail ? `：${snapshot.detail}` : ''}</div>
    {snapshot.latency && <details style={{ marginTop: 4 }}><summary>上轮说完至首音频 {(snapshot.latency.totalMs / 1000).toFixed(2)} 秒</summary>
      <div>{snapshot.latency.stages.map(stage => `${stage.name} ${stage.ms} ms`).join(' · ')}</div>
      <div>以 ASR 断句和音频到达时间估算，不含设备实际出声延迟。{snapshot.audioInfo?.echoCancellation === true ? '浏览器回声消除已启用。' : snapshot.audioInfo?.echoCancellation === false ? '浏览器未启用回声消除，建议使用耳机。' : ''}</div>
    </details>}
    {snapshot.transcript && <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', opacity: .8 }}>{snapshot.transcript}</div>}
  </div>
}

export function SettingsCard() {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, loadPrefs)
  const [advanced, setAdvanced] = useState(false)
  return <div style={styles.card}>
    <strong>实时语音与轮次判断</strong>
    <p>使用当前会话的主模型回答。说完自动发送，你可以随时开口打断。</p>
    <Field label="语音服务"><select style={styles.input} value={prefs.speechService} onChange={e => updatePrefs({ speechService: e.currentTarget.value === 'dashscope' ? 'dashscope' : 'token-plan' })}>
      <option value="token-plan">百炼 Token Plan</option><option value="dashscope">百炼按量服务</option>
    </select></Field>
    <Field label="语音识别"><select style={styles.input} value={prefs.asrEngine} onChange={e => updatePrefs({ asrEngine: e.currentTarget.value === 'local-sensevoice' ? 'local-sensevoice' : 'cloud' })}>
      <option value="cloud">云端 ASR</option><option value="local-sensevoice">本地 SenseVoice</option>
    </select></Field>
    {prefs.asrEngine === 'local-sensevoice' && <p style={{ opacity: .7 }}>需在运行 DSH 的电脑上准备模型。切换后重新开启麦克风。</p>}
    <Field label="语音自动发送"><input type="checkbox" checked={prefs.voiceDraftAutoSend} onChange={e => updatePrefs({ voiceDraftAutoSend: e.currentTarget.checked })} /></Field>
    <Field label="语义轮次判断"><input type="checkbox" checked={prefs.decisionEnabled} onChange={e => updatePrefs({ decisionEnabled: e.currentTarget.checked })} /></Field>
    <Field label="允许主动澄清"><input type="checkbox" checked={prefs.proactiveEnabled} disabled={!prefs.decisionEnabled} onChange={e => updatePrefs({ proactiveEnabled: e.currentTarget.checked })} /></Field>
    <Field label="TTS 音色"><input style={styles.input} value={prefs.qwenTtsVoice} onChange={e => updatePrefs({ qwenTtsVoice: e.currentTarget.value })} /></Field>
    <button type="button" aria-expanded={advanced} style={{ ...styles.input, marginTop: 14, cursor: 'pointer' }} onClick={() => setAdvanced(!advanced)}>高级设置</button>
    {advanced && <>
      {prefs.speechService === 'dashscope' && <>
        <Field label="Workspace ID"><input style={styles.input} value={prefs.qwenWorkspaceId} onChange={e => updatePrefs({ qwenWorkspaceId: e.currentTarget.value })} /></Field>
        <Field label="区域"><select style={styles.input} value={prefs.qwenRegion} onChange={e => updatePrefs({ qwenRegion: e.currentTarget.value === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing' })}><option value="cn-beijing">北京</option><option value="ap-southeast-1">新加坡</option></select></Field>
      </>}
      {prefs.asrEngine === 'cloud' && <Field label="ASR 模型"><input style={styles.input} value={prefs.qwenAsrModel} onChange={e => updatePrefs({ qwenAsrModel: e.currentTarget.value })} /></Field>}
      <Field label="TTS 模型"><input style={styles.input} value={prefs.qwenTtsModel} onChange={e => updatePrefs({ qwenTtsModel: e.currentTarget.value })} /></Field>
      <Field label="决策模型"><input style={styles.input} value={prefs.decisionModel} onChange={e => updatePrefs({ decisionModel: e.currentTarget.value })} /></Field>
      <Field label="决策超时（毫秒）"><input style={styles.input} type="number" min={250} max={10000} step={250} value={prefs.decisionTimeoutMs} onChange={e => updatePrefs({ decisionTimeoutMs: e.currentTarget.valueAsNumber })} /></Field>
      <Field label="续说等待（毫秒）"><input style={styles.input} type="number" min={100} max={5000} step={100} value={prefs.qwenMergeMs} onChange={e => updatePrefs({ qwenMergeMs: e.currentTarget.valueAsNumber })} /></Field>
      <Field label="尾静音（毫秒）"><input style={styles.input} type="number" min={200} max={6000} step={100} value={prefs.qwenSilenceMs} onChange={e => updatePrefs({ qwenSilenceMs: e.currentTarget.valueAsNumber })} /></Field>
      {prefs.asrEngine === 'cloud' && prefs.speechService === 'dashscope' && <Field label="人声阈值"><input style={styles.input} type="number" min={-1} max={1} step={.05} value={prefs.qwenVadThreshold} onChange={e => updatePrefs({ qwenVadThreshold: e.currentTarget.valueAsNumber })} /></Field>}
      <Field label="敏感指令手动发送"><input type="checkbox" checked={prefs.voiceDraftSensitiveDeny} onChange={e => updatePrefs({ voiceDraftSensitiveDeny: e.currentTarget.checked })} /></Field>
      <p style={{ opacity: .7 }}>Token Plan 凭据由 Harness Host 的 BAILIAN_TOKEN_PLAN_API_KEY 提供；主模型在会话的模型选择器中配置。</p>
    </>}
  </div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={styles.row}><span>{label}</span>{children}</label>
}
