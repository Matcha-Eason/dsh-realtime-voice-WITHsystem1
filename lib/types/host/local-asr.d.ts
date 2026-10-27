export declare const DEFAULT_ASR_MODEL_DIR: string;
/** One Host-owned model. Native async loading/decoding never blocks DSH's event loop. */
export declare class LocalSenseVoice {
    private readonly directory;
    private model?;
    constructor(directory?: string);
    prepare(): Promise<void>;
    recognize: (pcm: Buffer, signal: AbortSignal) => Promise<string>;
}
