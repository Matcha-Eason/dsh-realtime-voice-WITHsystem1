# Security boundaries

- Provider keys are resolved on the Harness Host. `.env.local` is a local development credential file and is excluded from Git and the package. Keys must not enter browser storage, plugin settings, logs, screenshots, or reports.
- HTTP and WebSocket bridges accept loopback, same-origin requests. Upstream endpoint selection is allowlisted.
- While voice mode is enabled, microphone audio goes to the selected ASR service. The Token Plan HTTP adapter sends growing preview windows and final utterances; audio stays in memory rather than being recorded to disk.
- The decision provider receives the transcript, conversation activity flags, and recent visible assistant text. The main model receives the native DSH conversation. TTS receives visible answer text, excluding reasoning and tool payloads.
- All spoken text comes from the current main model. Decision responses are restricted to actions and revisions. The plugin does not bypass Harness tool approval or authorization policies.
- Optional Tencent voiceprint support is off by default. When explicitly enabled, utterance PCM is sent to Tencent for enrollment or verification; only the opaque provider identifier is persisted. Voiceprint is an interference signal, not identity authentication. The current minimal settings UI does not expose enrollment management.
- Local development uses an isolated DSH profile under `.local/`. Do not publish that directory, credential files, private transcripts, or local authorization URLs.

Report vulnerabilities privately to the repository maintainer. Include a redacted reproduction and affected commit; never include a live API key or private recording. This development fork does not promise a release support schedule.
