/** Streams the main model's visible prose; code and markup never become speech. */
export declare class VoiceSummaryStream {
    private readonly emit;
    private input;
    private sentence;
    private fence;
    private comment;
    private received;
    private finished;
    constructor(emit: (sentence: string) => void);
    push(delta: string): void;
    finish(finalText: string): void;
    private drain;
    private accept;
    private flush;
    private speak;
}
export declare function extractVoiceSummary(text: string): string;
