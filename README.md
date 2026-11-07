# dsh-plugin-rapidspeech

DeepSeek Harness（`dsh`）语音输入的本地 ASR Provider 插件。录音结束后，音频经 Host 侧 Provider 调用本机 [RapidSpeech.cpp](https://github.com/RapidAI/RapidSpeech.cpp) 的 `rs-server`（OpenAI 兼容 HTTP 接口）完成离线转写，并把文本插入编辑框草稿——**音频不出本机**。

实现依据 `DeepSeek_Harness_RapidSpeech_ASR_Plugin.md`。当前适配 **Linux x64**；Windows 规划见文末。

```text
Browser microphone / Voice Input UI
  -> base64 PCM16 WAV via authenticated Remote
  -> Host speech-to-text service
  -> dsh-plugin-rapidspeech (SpeechProvider)
  -> HTTP 127.0.0.1:<port> /v1/audio/transcriptions
  -> RapidSpeech.cpp rs-server + local GGUF model
  -> { text } -> Transcript -> input draft (not auto-send)
```

## 安装

### 一键安装（推荐：managed 模式，自动下载）

```bash
dsh plugin --profile rapidspeech add github:yoletPig/dsh-plugin-rapidspeech
dsh --profile rapidspeech
```

首次点击麦克风旁的"安装"时，插件会（经用户确认后）下载两样东西到 `~/.dsh/rapidspeech/` 缓存：

1. **rs-server 二进制**：来自本仓库 [Releases](https://github.com/yoletPig/dsh-plugin-rapidspeech/releases)（CI 自动构建的 `rapidspeech-linux-x64.tar.gz`，二进制 + .so 平铺在压缩包根目录）
2. **模型 GGUF**：默认 `xasr-q8_0`（178 MB，ModelScope）；准备 UI 会列出该模型的所有官方镜像供选择，SHA-256 固定校验

### 模型选择

内置目录（`src/models.ts`，均为 RapidAI 官方发布，逐字校验过直链与哈希）：

| modelId | 大小 | 语言 | 下载源 |
| --- | --- | --- | --- |
| `xasr-q8_0`（默认） | 178 MB | auto/zh/en | ModelScope |
| `sense-voice-small-q4_k` | 182 MB | auto/zh/en/yue/ja/ko | HuggingFace、hf-mirror、ModelScope |
| `funasr-nano-q4_k_m` | 692 MB | auto/zh/en | HuggingFace、ModelScope |

切换：profile 覆盖里设 `modelId`；或 `modelDownloadUrl` 指向任意直链；或 `modelPath` 直接用本地文件（三者按此优先级生效）。X-ASR 官方仅发布在 ModelScope，故 HF 源对它不可选（UI 只列可用源，选错会被显式拒绝、不回退）。

之后完全离线运行；空闲 5 分钟自动回收进程，下次使用自动唤醒（约 2 秒）。

### 从本地 checkout 安装（开发）

```bash
npm install && npm run build && npm test   # 33 个单测
dsh plugin --profile rapidspeech add /path/to/dsh-plugin-rapidspeech
dsh --profile rapidspeech                  # Web UI（默认 http://127.0.0.1:3080）
```

### 使用自备的 rs-server / 模型（external 模式）

```bash
./scripts/start-rs-server.sh    # 手动启动识别服务（127.0.0.1:8080）
```

并在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: rapidspeech-asr
  name: "dsh-plugin-rapidspeech"
  config:
    managementMode: external
    endpoint: 'http://127.0.0.1:8080'
```

Bundle 的 `cordis.patch.yml` 会插入完整语音输入组合：`speech-to-text` 服务（默认 Provider 指向本插件）、本 Provider、`api-speech-to-text` 与麦克风 UI（`ui-voice-input`）。这些官方组件由 dsh 安装本体提供，插件包本身只带 Provider 逻辑。

## 构建自己的原生二进制

仓库带 CI（`.github/workflows/build-native.yml`）：推送 `v*` tag 或手动触发，即从上游 RapidSpeech.cpp 构建 rs-server、连同 .so 打包为 `rapidspeech-linux-x64.tar.gz` 并上传 Release。`binaryDownloadUrl` 指向 `releases/latest/download/...`，发新版只需打 tag。

## 配置（cordis.patch.yml / profile 层可覆盖）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `providerId` | `rapidspeech-local` | 注册 id，UI 按它选择 Provider |
| `displayName` | `RapidSpeech (local)` | Provider 列表展示名 |
| `managementMode` | `managed` | `managed` 插件托管（自动下载/拉起/回收）；`external` 连接已有 rs-server |
| `dataRoot` | `dshHomePath('rapidspeech')` | managed 缓存目录（bin/ 与 models/） |
| `binaryDownloadUrl` | 本仓库 Releases latest | rs-server 平台压缩包；`serverBinaryPath` 设置后忽略 |
| `binaryDownloadSha256` | 无（跳过校验） | 下载压缩包的 SHA-256 |
| `modelId` | `xasr-q8_0` | 内置目录模型（见上表）；`modelDownloadUrl` 设置后忽略 |
| `modelSha256` | 无（目录模型自带固定值） | 手动模型时的完整性校验 |
| `endpoint` | `http://127.0.0.1:8080` | `external` 模式地址；仅允许 loopback 或 `allowedHosts` 白名单 |
| `serverBinaryPath` / `modelPath` | 无 | 显式指定自备文件（绝对路径），跳过下载 |
| `serverLibraryPath` | 二进制所在目录 | 动态库目录（注入 `LD_LIBRARY_PATH`） |
| `model` | `rapidspeech-asr` | multipart `model` 字段 |
| `languages` | `['auto','zh','en']` | Provider 声明支持的语言提示 |
| `stripControlTokens` | `true` | 剥离 SenseVoice 的 `<\|…\|>` 控制标签 |
| `requestTimeoutMs` | `120000` | 单次转写超时 |
| `maxAudioBytes` | 32 MiB | 超限录音在发送前被拒绝 |
| `allowedHosts` | `[]` | 非本地 endpoint 的显式白名单 |
| `prepareTimeoutMs` | `120000` | managed：校验+启动+健康检查总预算 |
| `downloadTimeoutMs` | `1800000` | managed：单资产下载预算 |
| `graceMs` | `1000` | managed：进程终止宽限期 |
| `idleTimeoutMs` | `300000` | managed：空闲回收时间；`0` 保持运行到卸载 |
| `maxLogBytes` | 64 KiB | managed：子进程 stdout/stderr 诊断尾部 |

### managed 模式：插件自动托管 rs-server（V2，推荐）

在 profile 的 `cordis.patch.yml` 覆盖 Provider 行后，插件会**自动拉起/停止自己的 rs-server**——无需手动启动，OS 分配空闲端口，dsh 退出时一并终止：

```yaml
- id: rapidspeech-asr
  name: "dsh-plugin-rapidspeech"
  config:
    managementMode: managed
    serverBinaryPath: /home/yyl/RapidSpeech.cpp/build/rs-server
    modelPath: /home/yyl/RapidSpeech.cpp/gguf_models/xasr-q8_0.gguf
    serverLibraryPath: /home/yyl/RapidSpeech.cpp/build   # 动态链接的 so 目录；静态构建可省略
```

行为：**激活即自动准备**（校验可执行权限/模型文件/可选 SHA-256 → spawn 到 OS 分配的空闲端口 → `/health` 轮询，约 2 秒后就绪，Provider 名册直接显示可用）→ 空闲 `idleTimeoutMs` 后自动回收并显示 standby（仍可直接录音，下次转写自动唤醒）→ 崩溃自动恢复。取消/卸载先等在途转写收敛，再 SIGTERM→宽限→杀进程；外部手动启动的 rs-server 一律不碰。

## 配置（cordis.patch.yml / profile 层可覆盖）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `providerId` | `rapidspeech-local` | 注册 id，UI 按它选择 Provider |
| `displayName` | `RapidSpeech (local)` | Provider 列表展示名 |
| `managementMode` | `external` | `external` 连接已有 rs-server；`managed` 由插件 spawn 并独占 |
| `endpoint` | `http://127.0.0.1:8080` | `external` 模式的 rs-server 地址；仅允许 loopback 或 `allowedHosts` 白名单 |
| `serverBinaryPath` | 无 | `managed` 必填，绝对路径 |
| `modelPath` | 无 | `managed` 必填，绝对路径 |
| `serverLibraryPath` | 二进制所在目录 | 动态库目录（注入 `LD_LIBRARY_PATH`） |
| `modelSha256` | 无（跳过校验） | 64 位十六进制；不匹配则 prepare 失败 |
| `extraServerArgs` | `[]` | 追加到 rs-server 命令行的参数（argv 数组，无 shell 拼接） |
| `model` | `rapidspeech-asr` | multipart `model` 字段（与 rs-server 约定保留） |
| `languages` | `['auto','zh','en']` | Provider 声明支持的语言提示；`auto` 依赖模型自行检测 |
| `requestTimeoutMs` | `120000` | 单次转写超时 |
| `maxAudioBytes` | 32 MiB | 超限录音在发送前被拒绝 |
| `allowedHosts` | `[]` | 非本地 endpoint 的显式白名单 |
| `prepareTimeoutMs` | `120000` | managed：校验+启动+健康检查的总预算 |
| `graceMs` | `1000` | managed：进程终止宽限期 |
| `idleTimeoutMs` | `300000` | managed：空闲回收时间；`0` 表示保持运行直到卸载 |
| `maxLogBytes` | 64 KiB | managed：保留的子进程 stdout/stderr 诊断尾部 |

覆盖示例（profile 的 `cordis.patch.yml`，注意整行 config 会被替换）：

```yaml
- insert:
    - id: rapidspeech-asr
      name: dsh-plugin-rapidspeech
      config:
        endpoint: 'http://127.0.0.1:9090'
        requestTimeoutMs: 300000
```

## 行为契约

- `transcribe(input, signal)` 收完整 WAV；按 RIFF chunk 解析时长（不假设 44 字节头），`audioSeconds` 来自 data chunk / byteRate，`inferenceSeconds` 为请求墙钟时间。
- `AbortSignal` 同时接入取消与 `requestTimeoutMs`；fetch 前先检查已中止信号，避免 undici 在已关闭流上产生未处理 rejection（会击穿 dsh 宿主进程）。
- 取消/超时只中断网络请求，不假定 C++ 推理已停止（rs-server 侧队列继续）。
- 空 data chunk 的录音短路返回 `{ text: '', audioSeconds: 0, inferenceSeconds: 0 }`，不发请求。
- Provider 卸载时经 `speechToText.register` 的 disposer 等待在途任务收敛，不留悬挂 Promise。

## 验收

### Host 侧集成探针（自动化）

```bash
# external 模式：rs-server 需先运行
PROBE_WAV=/path/to/sample.wav \
dsh --profile rapidspeech \
    --patch tests/integration/probe.patch.yml --no-open

# managed 模式：插件自行拉起 rs-server（用 tests/integration/managed.patch.yml 里的路径）
PROBE_WAV=/path/to/sample.wav \
dsh --profile rapidspeech \
    --patch tests/integration/managed.patch.yml --no-open
```

探针在真实 dsh 组合内执行 `ctx.speechToText.resolve()` + `transcribe()`，期望输出：

```text
[probe] resolved provider: rapidspeech-local language: auto
[probe] preparation before: {"phase":"unprepared"}     # managed 模式
[probe] TRANSCRIPT: {"text":"…","audioSeconds":3.9009…,"inferenceSeconds":0.26…}
[probe] preparation after: {"phase":"ready"}
[probe] RESULT: PASS
```

2026-11-07 实测（xasr-q8_0.gguf，3.9s 中文样本）：external 与 managed 两种模式均 PASS，audioSeconds 与 WAV 实际时长一致；managed 实例退出后无孤儿进程，外部手动启动的 rs-server 不受影响。

### 浏览器 UI（手动）

1. 打开 dsh Web UI（启动日志给出带 token 的地址）。
2. 输入框旁出现麦克风按钮 → 点击开始录音 → 说话 → 停止。
3. 转写文本应插入编辑框草稿（**不会**自动发送）。
4. 按 Esc / 切换会话应丢弃录音；Provider 列表可选 RapidSpeech。

## 与官方 voice-input-bundle 并存

本 Bundle 与 `@deepseek-ai/dsh-experimental-voice-input-bundle`（SenseVoice）可共存：两者都注册 Provider，UI 中可切换。注意"后装者的层覆盖同名行"——若 voice-input-bundle 在本插件之后安装，`speech-to-text` 的 `defaultProvider` 会回到 `sensevoice-local`，可在 profile 的 `cordis.patch.yml` 里改回。

## WSL2 环境注意事项（Windows 浏览器访问）

- **必须用带 token 的完整地址**。`http://127.0.0.1:3080` 裸访问返回 401，会被误认为"访问不了"。启动日志打印的完整地址形如：

  ```text
  dsh web: http://127.0.0.1:3080/?token=<token>
  ```

  在自己的 WSL 终端里前台运行 `dsh --profile rapidspeech`（不带 `--no-open`），WSL 会尝试直接打开 Windows 默认浏览器；若没有自动打开，手动复制该完整地址。

- NAT 模式下 Windows→WSL 的 localhost 转发默认开启，实测可用；但它**在 Windows 睡眠/唤醒后可能失效**。此时改绑 WSL 网卡地址：

  ```bash
  IP=$(hostname -I | awk '{print $1}')
  dsh --profile rapidspeech --host "$IP" --trusted-host "$IP:3080" --no-open
  # 浏览器打开 http://<WSL-IP>:3080/?token=<见启动日志>
  ```

  注意 WSL 重启后 `hostname -I` 的 IP 会变化；该地址仅 Windows 宿主机可达（NAT 内网），不暴露到局域网，且仍有 token 保护。

- 语音识别路径不受浏览器访问方式影响：麦克风音频经 Web UI → dsh Host（WSL 内）→ `127.0.0.1:8080` rs-server，全程不出本机。
- 若浏览器装了强制代理的扩展（如 SwitchyOmega 全局模式），把 `127.0.0.1` / `localhost` 加入直连列表；实测 Windows 系统代理（含 Clash 类工具）默认不拦 localhost。

## 故障排查

- **麦克风提示"尚未就绪"/点击跳转设置页，但设置页显示"已就绪"**：识别服务的**用户选择**指向了不存在或被禁用的 Provider（典型场景：在插件页面启用过官方 voice-input-bundle（SenseVoice）→ 它把默认 Provider 覆盖为 `sensevoice-local` → 之后禁用 SenseVoice，选择值残留）。修复：在语音设置里把识别服务选回 RapidSpeech (local)，或在 profile 的 `cordis.patch.yml` 末尾加一行覆盖（profile 层晚于所有 bundle 层生效）：

  ```yaml
  - id: speech-to-text
    name: "@deepseek-ai/dsh-experimental-speech-to-text"
    config:
      defaultProvider: rapidspeech-local
  ```

  用探针核对 Host 实际下发的目录数据：`dsh --profile rapidspeech --patch tests/integration/catalog-probe.patch.yml`，确认 `selection.providerId` 与 roster 一致且 `preparation.phase` 为 `ready`。
- **转写报 `ASR HTTP …` / 连接失败**：确认 rs-server 已启动且端口一致（`curl --noproxy '*' http://127.0.0.1:8080/health`；managed 模式端口自动分配，无需关心）。
- **代理干扰**：dsh 的代理策略对 loopback 永远直连，插件无需配置；手动 curl 测试需 `--noproxy '*'`。
- **profile 启动报 Provider 不支持语言**：`speech-to-text` 的 `language` 配置必须是 Provider `languages` 之一（默认 `auto`）。
- **`rs-server: error while loading shared libraries`**：用 `scripts/start-rs-server.sh`（设置 `LD_LIBRARY_PATH` 指向 build 目录）。

## 设计文档对照

| 设计文档条目 | 状态 |
| --- | --- |
| §5 项目结构（provider/client/config/wav/lifecycle） | ✅ `src/` 全部就位（+download/text） |
| §6.1 SpeechProvider 行为契约 | ✅ 含 RIFF 解析、FormData、AbortSignal、卸载收敛 |
| §6.3 V1 配置项 | ✅ 全部，含 V2 的 `modelPath/serverBinaryPath` |
| §8 Harness 联调策略 | ✅ M0（HTTP 验证）+ M1（Provider + 服务级转写）+ 用户浏览器验收 |
| §9.1 V2 生命周期 | ✅ Linux x64：状态机映射 SpeechPreparation（unprepared/downloading/checking/loading/ready/standby/failed/cancelled）、spawn(argv) 无 shell、SHA-256 校验、空闲回收、SIGTERM→宽限→终止、外部进程不碰；下载经用户确认 |
| §9.2 平台发布矩阵 | ◐ Linux x64：CI 构建 + Release 资产 + HF 模型下载就绪；Windows x64 待原生包（CI 矩阵加一个 job 即可） |
| §10 测试 | ✅ 单测 41 项；模型目录/下载源/生命周期/格式边界/安全/取消均有覆盖 |

## Windows 适配规划（V2）

- 本插件代码不含平台分支：Node 层跨平台，主要工作是 rs-server 的 Windows 构建（MSVC，设计文档 §7）与 V2 的 `lifecycle.ts` 进程托管（按 `process.platform` 选择二进制、Windows 子进程树终止）。
- 打包时把 `rs-server.exe` + 模型下载策略放进 `native/`（设计文档 §5 的 `native/win32-x64`）。
- 需注意 MSVC runtime、路径空格、杀毒误报（§9.2）。

## 许可

MIT
