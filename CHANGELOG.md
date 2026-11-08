# Changelog

All notable changes to dsh-plugin-rapidspeech are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions are the git tags.

## v0.2.0

First tagged release of the managed deployment stack.

### Added

- SpeechProvider bridging `ctx.speechToText` to a local RapidSpeech.cpp `rs-server`
  (OpenAI-compatible `/v1/audio/transcriptions`); transcripts land in the draft editor, never auto-sent.
- Managed lifecycle: consent-gated downloads (rs-server from GitHub Releases, model from
  ModelScope/HuggingFace with pinned SHA-256), OS-assigned loopback port, health polling,
  idle reclamation (5 min default), SIGTERM → grace → kill teardown; externally started
  rs-servers are never owned or killed.
- Model catalog with per-origin mirrors: `xasr-q8_0` (ModelScope, default),
  `sense-voice-small-q4_k` (HF / hf-mirror / ModelScope), `funasr-nano-q4_k_m` (HF / ModelScope);
  the preparation UI offers the mirrors of the chosen model and rejects unavailable ones without fallback.
- External mode: connect to an already-running rs-server at `endpoint` (loopback or explicit allowlist).
- SenseVoice control-token stripping (`<|…|>`), RIFF chunk-walking WAV duration parsing
  (no fixed 44-byte header assumption), abort-safe bounded fetch.
- CI (`build-native.yml`): builds the self-contained static rs-server from upstream
  RapidSpeech.cpp (submodules included), packages `rapidspeech-linux-x64.tar.gz` with the
  upstream license, smoke-tests it, and attaches it to the GitHub Release.

### Verified

- Real-network first-user flow: fresh profile → consent → binary + 178 MB model downloaded →
  server ready in ~35 s → Chinese sample transcribed correctly.
- 41 unit/integration tests including real child-process lifecycle and download/extract/verify flows.

## v0.1.0

Initial external-mode provider (connect to an already-running rs-server), developed and
verified locally against the DeepSeek Harness 0.2.2-rc.1 voice-input stack.
