type Event = Record<string, unknown>;
/** Owns VAD, provisional windows, final priority and cancellation for batch ASR. */
export declare class WindowedAsr {
    private readonly recognize;
    private readonly emit;
    private readonly previewMs;
    private readonly abort;
    private configured;
    private closed;
    private silenceSamples;
    private preRoll;
    private onsetSamples;
    private quietSamples;
    private current;
    private pending;
    private inFlight?;
    constructor(recognize: (pcm: Buffer, signal: AbortSignal) => Promise<string>, emit: (event: Event) => void, previewMs?: number);
    client(event: Event): void;
    close(): void;
    private enqueue;
    private drain;
    private fail;
}
export {};
