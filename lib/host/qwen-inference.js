import { WindowedAsr } from "./windowed-asr.js";
import { randomUUID } from 'node:crypto';
export const TOKEN_PLAN_ASR_ENDPOINT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
/** Token Plan HTTP transport; windowing and local recognition share one scheduler. */
export class QwenHttpAsr extends WindowedAsr {
    constructor(model, key, emit, request = fetch) {
        super(async (pcm, signal) => {
            const wav = Buffer.alloc(44 + pcm.length);
            wav.write('RIFF', 0);
            wav.writeUInt32LE(wav.length - 8, 4);
            wav.write('WAVEfmt ', 8);
            wav.writeUInt32LE(16, 16);
            wav.writeUInt16LE(1, 20);
            wav.writeUInt16LE(1, 22);
            wav.writeUInt32LE(16000, 24);
            wav.writeUInt32LE(32000, 28);
            wav.writeUInt16LE(2, 32);
            wav.writeUInt16LE(16, 34);
            wav.write('data', 36);
            wav.writeUInt32LE(pcm.length, 40);
            pcm.copy(wav, 44);
            const response = await request(TOKEN_PLAN_ASR_ENDPOINT, {
                method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' },
                body: JSON.stringify({
                    model: model,
                    input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } }] }] },
                    parameters: { format: 'wav', sample_rate: '16000' },
                }),
            });
            const result = await response.json();
            // Live Token Plan returns exactly HTTP 400 + {} for audio with no speech.
            // Keep that narrow compatibility case separate from invalid requests.
            const noSpeech = response.status === 400 && result !== null && typeof result === 'object'
                && !Array.isArray(result) && Object.keys(result).length === 0;
            if (!response.ok && !noSpeech)
                throw new Error('ASR request rejected');
            const transcript = noSpeech ? '' : typeof result?.output?.text === 'string' ? result.output.text : result?.text;
            if (typeof transcript !== 'string')
                throw new Error('Invalid ASR result');
            return transcript;
        }, emit);
    }
}
/** Converts the browser's TTS buffer events to Qwen-Audio's task protocol.
 * Each committed chunk owns one task; only the caller's text is synthesized.
 * https://help.aliyun.com/zh/model-studio/qwen-audio-tts-client-events
 */
export class QwenInferenceTts {
    model;
    send;
    emit;
    voice = 'longanlingxin';
    configured = false;
    text = '';
    task;
    constructor(model, send, emit) {
        this.model = model;
        this.send = send;
        this.emit = emit;
    }
    open() { this.emit({ type: 'session.created' }); }
    client(event) {
        if (event.type === 'session.finish') {
            if (this.task?.started)
                this.send({
                    header: { action: 'finish-task', task_id: this.task.id, streaming: 'duplex' },
                    payload: { input: { directive: 'cancel' } },
                });
            this.task = undefined;
            this.text = '';
            return;
        }
        if (event.type === 'session.update') {
            const session = event.session;
            if (!session || session.response_format !== 'pcm' || session.sample_rate !== 24000
                || session.mode !== 'commit' || typeof session.voice !== 'string'
                || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(session.voice) || this.task) {
                this.fail('Invalid Qwen TTS session settings');
                return;
            }
            this.voice = session.voice;
            this.configured = true;
            this.emit({ type: 'session.updated' });
            return;
        }
        if (!this.configured)
            return this.fail('Qwen TTS session is not configured');
        if (event.type === 'input_text_buffer.append') {
            if (typeof event.text !== 'string' || this.text.length + event.text.length > 20_000 || this.task) {
                return this.fail('Invalid Qwen TTS text buffer');
            }
            this.text += event.text;
            return;
        }
        if (event.type !== 'input_text_buffer.commit')
            return;
        if (this.task || !this.text.trim())
            return this.fail('Qwen TTS has no committable text');
        this.task = { id: randomUUID(), text: this.text, started: false };
        this.text = '';
        this.send({
            header: { action: 'run-task', task_id: this.task.id, streaming: 'duplex' },
            payload: {
                task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: this.model,
                parameters: { text_type: 'PlainText', voice: this.voice, format: 'pcm', sample_rate: 24000, enable_ssml: false },
                input: {},
            },
        });
    }
    upstream(data, binary) {
        if (binary) {
            if (this.task?.started)
                this.emit({ type: 'response.audio.delta', delta: data.toString('base64') });
            return;
        }
        let event;
        try {
            event = JSON.parse(data.toString());
        }
        catch {
            return this.fail('Qwen TTS returned an invalid event');
        }
        if (!this.task || event?.header?.task_id !== this.task.id)
            return;
        if (event.header.event === 'task-started' && !this.task.started) {
            this.task.started = true;
            this.send({
                header: { action: 'continue-task', task_id: this.task.id, streaming: 'duplex' },
                payload: { input: { text: this.task.text } },
            });
            this.send({ header: { action: 'finish-task', task_id: this.task.id, streaming: 'duplex' }, payload: { input: {} } });
        }
        else if (event.header.event === 'task-finished') {
            this.task = undefined;
            this.emit({ type: 'response.done' });
        }
        else if (event.header.event === 'task-failed') {
            this.task = undefined;
            this.fail('Qwen TTS synthesis failed');
        }
    }
    fail(message) { this.emit({ type: 'error', error: { message } }); }
}
