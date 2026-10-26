import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
export type TextResetReason = 'tool' | 'retry';
export type DelegateResult = {
    ok: true;
    text: string;
} | {
    ok: false;
    cancelled?: boolean;
    error: string;
};
export interface SessionTurnCallbacks {
    onTurnStart(turn: string): void;
    onTextDelta(turn: string, delta: string): void;
    onTextReset?(turn: string, reason: TextResetReason): void;
    onTurnEnd(turn: string, result: DelegateResult): void;
}
export interface VoiceContext {
    heardText?: string;
    interrupted?: boolean;
    interject?: boolean;
}
export type VoiceContextSetter = (sessionId: string, active: boolean, signal?: AbortSignal, context?: VoiceContext) => Promise<void>;
declare module '@deepseek-ai/dsh-api-session-controller/client' {
    interface SessionReferenceSourceMap {
        /** The voice transport observes this exact Session generation. */
        realtimeVoice: unknown;
    }
}
/** Owns voice observation and addressed cancellation over the native Session API. */
export declare class HarnessBridge {
    private readonly sessions;
    private readonly promptTimeoutMs;
    private readonly setVoiceContext;
    private readonly voices;
    private readonly lifetime;
    constructor(sessions: Pick<ISessions, 'retain' | 'binding'>, promptTimeoutMs?: number, setVoiceContext?: VoiceContextSetter);
    isBusy(sessionId: string): boolean;
    setVoiceMode(sessionId: string, active: boolean, signal?: AbortSignal, context?: VoiceContext): Promise<void>;
    observeSession(sessionId: string, callbacks: SessionTurnCallbacks): () => void;
    delegate(sessionId: string, task: string, signal?: AbortSignal): Promise<DelegateResult>;
    cancel(sessionId: string): Promise<boolean>;
    dispose(): void;
    private retain;
    private cancelOwned;
    private handleEvent;
    private resetText;
    private finish;
    private releaseUnused;
}
export declare function extractAssistantText(message: unknown): string;
