export interface TranscriptMeta {
  silenceMs?: number
  utteranceId?: string
  likelyEcho?: boolean
  capturedWhileBusy?: boolean
  voiceprint?: 'approved' | 'rejected' | 'unavailable'
}

export interface RealtimeCallbacks {
  onState(state: 'connecting' | 'listening' | 'speaking' | 'error', detail?: string): void
  onAudioInfo?(info: { capture: 'audio-worklet'; echoCancellation?: boolean }): void
  onSpeechStart?(meta?: TranscriptMeta): void
  onSpeechEnd?(meta?: TranscriptMeta): void
  onPartialTranscript?(text: string, meta?: TranscriptMeta): void
  onPlaybackProgress?(text: string): void
  onTranscript?(text: string, meta?: TranscriptMeta): Promise<void>
}
