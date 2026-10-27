import { HarnessBridge } from './harness-delegate.ts';
import { type VoicePrefs } from './prefs.ts';
import type { RealtimeCallbacks } from './realtime.ts';
import type { TurnPhase } from './turn-coordinator.ts';
import { type TurnDecision, type TurnDecisionState } from '../turn-decision.ts';
export type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'working' | 'error';
export interface VoiceSnapshot {
    state: VoiceState;
    detail: string;
    provider: 'qwen';
    userSpeaking: boolean;
    mainBusy: boolean;
    playback: 'idle' | 'playing' | 'paused';
    transcript: string;
    latency?: {
        totalMs: number;
        stages: Array<{
            name: string;
            ms: number;
        }>;
    };
    audioInfo?: {
        capture: 'audio-worklet';
        echoCancellation?: boolean;
    };
}
export interface VoiceConnection {
    connect(): Promise<void>;
    disconnect(): void;
    speak?(text: string): Promise<void>;
    waitForSpeechIdle?(): Promise<void>;
    pauseSpeech?(): void;
    resumeSpeech?(): void;
    cancelSpeech?(): void;
    setInputPhase?(phase: TurnPhase): void;
}
export type VoiceConnectionFactory = (prefs: VoicePrefs, callbacks: RealtimeCallbacks) => VoiceConnection;
export interface VoiceDraftTarget {
    getDraft(): string;
    getDraftRev?(): number;
    getPhase?(): 'plain' | 'adjudicating' | 'claimed' | 'submitting';
    setDraft(text: string): void;
    submit?(): void;
}
export type DecideTurn = (state: TurnDecisionState, signal: AbortSignal) => Promise<TurnDecision>;
/** Owns turn decisions and draft ownership; capture, generation and playback may overlap. */
export declare class VoiceController {
    readonly sessionId: string;
    private readonly bridge;
    private readonly createConnection;
    private readonly decide;
    private connection?;
    private epoch;
    private readonly listeners;
    private snapshot;
    private stopObserving?;
    private contextTimer?;
    private draft?;
    private boundDraft;
    private draftRev?;
    private writingDraft;
    private ownsDraft;
    private finals;
    private partial;
    private stablePartial;
    private partialId?;
    private consumedPrefix?;
    private readonly finalIds;
    private readonly pendingFinals;
    private revision;
    private speechActive;
    private speechEndedAt?;
    private output?;
    private heardText;
    private interrupted;
    private playback;
    private nativePending;
    private submitTimer?;
    private decisionTimer?;
    private decisionAbort?;
    private decisionDirty;
    private interjection?;
    private lastInterjectionAt;
    private trace;
    private latency?;
    private audioInfo?;
    private voiceprint;
    constructor(sessionId: string, bridge: HarnessBridge, createConnection?: VoiceConnectionFactory, decide?: DecideTurn);
    subscribe: (listener: () => void) => (() => void);
    getSnapshot: () => VoiceSnapshot;
    bindDraft(target: VoiceDraftTarget): () => void;
    toggle(): Promise<void>;
    stop(): void;
    dispose(): void;
    private receivePartial;
    private receiveFinal;
    private transcript;
    private unconsumed;
    private stageDraft;
    private invalidateDecision;
    private scheduleDecision;
    private evaluateTurn;
    private draftIsOwned;
    private submitDraft;
    private startInterjection;
    private cancelUnheardInterjection;
    private clearInterjectionContext;
    private beginOutput;
    private createSpeechStream;
    private drainOutput;
    private finishOutput;
    private releaseOutput;
    private muteOutput;
    private resumeOutput;
    private discardOwnedInput;
    private cancelTask;
    private isMainBusy;
    private clearSubmitTimer;
    private publish;
}
