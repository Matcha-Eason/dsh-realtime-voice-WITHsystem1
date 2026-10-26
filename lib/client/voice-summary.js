/** Streams the main model's visible prose; code and markup never become speech. */
export class VoiceSummaryStream {
    emit;
    input = '';
    sentence = '';
    fence = '';
    comment = false;
    received = false;
    finished = false;
    constructor(emit) {
        this.emit = emit;
    }
    push(delta) {
        if (this.finished || delta === '')
            return;
        this.received = true;
        this.input += delta;
        this.drain(false);
    }
    finish(finalText) {
        if (this.finished)
            return;
        if (!this.received)
            this.input = finalText;
        this.drain(true);
        this.flush();
        this.finished = true;
    }
    drain(final) {
        while (this.input !== '') {
            if (this.fence !== '') {
                const end = this.input.indexOf('\n');
                if (end < 0 && !final)
                    return;
                const line = end < 0 ? this.input : this.input.slice(0, end);
                this.input = end < 0 ? '' : this.input.slice(end + 1);
                const marker = line.trim();
                if (marker.length >= this.fence.length && [...marker].every(char => char === this.fence[0]))
                    this.fence = '';
                continue;
            }
            if (this.comment) {
                const end = this.input.indexOf('-->');
                if (end < 0) {
                    this.input = final ? '' : this.input.slice(-2);
                    return;
                }
                this.input = this.input.slice(end + 3);
                this.comment = false;
                continue;
            }
            if (!final && ['<', '<!', '<!-', '!', '`', '``', '~', '~~'].includes(this.input))
                return;
            if (this.input.startsWith('<!--')) {
                this.input = this.input.slice(4);
                this.comment = true;
                continue;
            }
            const fence = /^(`{3,}|~{3,})/.exec(this.input);
            if (fence !== null) {
                const end = this.input.indexOf('\n');
                if (end < 0) {
                    if (final)
                        this.input = '';
                    return;
                }
                this.flush();
                this.fence = fence[0];
                this.input = this.input.slice(end + 1);
                continue;
            }
            // Hold a protected span until complete: punctuation inside a URL, tag or
            // inline code must not split it and leak its Markdown into an audio chunk.
            if (/^<\/?[a-z]/iu.test(this.input)) {
                const end = this.input.indexOf('>');
                if (end < 0) {
                    if (final)
                        this.input = '';
                    return;
                }
                this.input = this.input.slice(end + 1);
                continue;
            }
            if (this.input.startsWith('`')) {
                const marker = this.input.startsWith('``') ? '``' : '`';
                const end = this.input.indexOf(marker, marker.length);
                if (end < 0 && !final)
                    return;
                this.accept(this.input.slice(marker.length, end < 0 ? undefined : end));
                this.input = end < 0 ? '' : this.input.slice(end + marker.length);
                continue;
            }
            if (/^!?\[/u.test(this.input)) {
                const start = this.input.startsWith('!') ? 2 : 1;
                const labelEnd = this.input.indexOf(']', start);
                if (labelEnd < 0 || (labelEnd === this.input.length - 1 && !final)) {
                    if (!final)
                        return;
                }
                else if (this.input[labelEnd + 1] === '(') {
                    let depth = 1;
                    let end = labelEnd + 2;
                    for (; end < this.input.length && depth > 0; end++) {
                        if (this.input[end] === '(')
                            depth++;
                        if (this.input[end] === ')')
                            depth--;
                    }
                    if (depth > 0 && !final)
                        return;
                    this.accept(this.input.slice(start, labelEnd));
                    this.input = depth > 0 ? '' : this.input.slice(end);
                    continue;
                }
            }
            const next = /[`<\[!~\n]/u.exec(this.input.slice(1));
            const length = next === null ? this.input.length : next.index + 1;
            if (this.input[0] === '\n') {
                this.flush();
                this.input = this.input.slice(1);
            }
            else {
                this.accept(this.input.slice(0, length));
                this.input = this.input.slice(length);
            }
        }
    }
    accept(text) {
        this.sentence += text;
        // English periods need following whitespace so a streamed decimal such as
        // "3." + "14" is not prematurely spoken as a complete sentence.
        let boundary = /[。！？!?；;]+[”’」』】）)]*|\.(?=\s)/u.exec(this.sentence);
        while (boundary !== null) {
            const end = boundary.index + boundary[0].length;
            const complete = this.sentence.slice(0, end);
            this.sentence = this.sentence.slice(end);
            this.speak(complete);
            boundary = /[。！？!?；;]+[”’」』】）)]*|\.(?=\s)/u.exec(this.sentence);
        }
    }
    flush() {
        this.speak(this.sentence);
        this.sentence = '';
    }
    speak(text) {
        const clean = text
            .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)、]\s*)/u, '')
            .replace(/\*+/gu, '')
            .replace(/(?<!\w)_{1,2}|_{1,2}(?!\w)/gu, '')
            .replace(/[\[\]`~]/gu, '')
            .replace(/\s+/gu, ' ')
            .trim();
        if (clean !== '')
            this.emit(clean);
    }
}
export function extractVoiceSummary(text) {
    const spoken = [];
    new VoiceSummaryStream(sentence => spoken.push(sentence)).finish(text);
    return spoken.join(' ');
}
