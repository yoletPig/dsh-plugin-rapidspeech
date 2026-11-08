# Changelog

All notable changes to dsh-plugin-rapidspeech are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions are the git tags.

## v0.4.0

The ASR model becomes switchable from the web UI: the plugin page gains a model picker,
and changing the model no longer touches the patch YAML or restarts the profile — the
provider hot-swaps in place.

### Added

- Browser half (`./client`) registering the row's config page into the plugin manager
  (`plugins.row.config`, key `dsh-plugin-rapidspeech#rapidspeech-asr`): catalog model
  cards (languages, size, SHA-256 prefix) plus a custom GGUF absolute-path field; writes
  go through the settings service into the profile patch. Bundled by esbuild into the
  dsh ModuleLoader factory format (`scripts/build-client.mjs`).
- Volatile model-selection config (`modelId`, `modelPath`, `modelDownloadUrl`,
  `modelSha256`): the Loader commits edits into the running row without unmounting it,
  and `apply` rebuilds the provider and managed server over a serialized restart chain
  (previous teardown completes before the replacement registers; unload racing a queued
  swap is safe). Cached models swap within seconds; uncached catalog models fall into
  the existing preparation/consent flow.
- `dataRoot` now defaults to the dsh home cache (`dshHomePath('rapidspeech')`), so
  deployments whose patch layer replaces the row's whole config stay catalog-switchable.
- Model cache keyed per file name, so several catalog models coexist in one cache and
  switching back to a prepared model is instant.

### Verified

- 50 tests, including hot-swap ordering (unregister before re-register, unrelated
  volatile updates ignored, unload against a queued swap) and volatile cell snapshotting.
- Live profile: the web module graph serves the browser half, and the managed provider
  auto-prepares with the rebuilt code.

## v0.3.2

Portable Windows packaging and clearer startup failures.

### Added

- Startup-failure diagnostics surface the managed server's child exit code (including
  `0xC…` access-violation / illegal-instruction codes on Windows) next to the stderr tail.
- Windows binaries build with `GGML_NATIVE=OFF`, trading host-native tuning for a
  portable AVX2 baseline that runs on any x64 CPU.

### Fixed

- npm publish guard runs inside the shell so the workflow's exit code is checked.

## v0.3.1

First npm-published release; 0.3.0 had to be published manually after npm E403 rejected
the tag-triggered publish.

### Fixed

- The publish workflow reads `NPM_TOKEN` from the secrets context and drops the
  nonexistent `npm pack --pack-filename` flag.

## v0.3.0

Windows support, v2 cache-update detection, and the npm/release pipeline.

### Added

- Windows: CI win32-x64 job builds `rs-server.exe` with MSVC static CRT (no vcruntime
  dependency) into `rapidspeech-win32-x64.tar.gz`; platform-aware default binary URL and
  executable naming; no `LD_LIBRARY_PATH` handling on win32.
- Cache-update detection: downloads record the asset ETag, and preparation HEADs the URL
  to treat a changed tag as a stale cache — upgrades route through the preparation UI's
  consent step instead of silent re-downloads. `filesReady()` is async (one HEAD probe at
  activation); model staleness keeps keying on the pinned SHA-256.
- npm publishing metadata, market index, and a publish workflow; the installable plugin
  tarball is attached to releases, with curated release notes from this file.
- MIT license and third-party license notices.

### Fixed

- Linux idle reclamation also fires right after prepare, so a prepared but never-used
  server is still reclaimed.
- Download writer error listeners are removed after each backpressure wait.

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
