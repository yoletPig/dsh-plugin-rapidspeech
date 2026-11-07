# DeepSeek Harness × RapidSpeech.cpp — 本地语音识别插件技术方案

> Windows / Linux · 独立插件 · 离线 ASR · 分阶段交付

方案版本：V1.0    调研日期：2026-11-07    状态：方案设计（非已实现产品）

## 执行摘要

结论：建议以 DeepSeek Harness 的 SpeechProvider 接口作为主扩展点，使用 TypeScript 实现独立 ASR Provider，调用 RapidSpeech.cpp 提供的本地 rs-server HTTP API。V1 先完成“录音结束→转写→插入编辑框”；V2 再加入进程自动托管、模型准备与 Windows/Linux 分发；实时流式识别独立列为后续项目。

是否必须克隆 Harness：不必须。普通外部插件可以在独立仓库开发、构建和加载。建议为源码阅读/兼容性验证单独克隆 Harness，但不推荐一开始 Fork 核心仓库。RapidSpeech.cpp 若需自行编译原生二进制，则需获取其源码及子模块。

## 1. 目标、范围和非目标

### 1.1 目标

- 支持 Windows x64 和 Linux x64，优先 CPU 路径，GPU 作为可选构建；

- 复用 Harness 的语音输入交互和文字草稿机制；

- 音频、模型推理和中间结果保持在用户本机（前端与 Host 分离部署时须重新评估“本地”边界）；

- Provider 可与其他识别引擎并存，并可选择/切换；

- 实现取消、健康检查、超时、日志和基础错误恢复。

### 1.2 首版不包含

实时字幕、连续监听/唤醒词、系统级输入法、自动发送 Agent 消息、TTS、跨机器远程转写、隐式上传音频。

## 2. 已核实的上游扩展能力

Harness 官方 voice-input 设计包含 Service Definition、SenseVoice Provider、Remote consumer 与可选 Voice Input Bundle。SpeechProvider.transcribe(input, signal) 接收整段 WAV 与 AbortSignal，并返回 text、audioSeconds、inferenceSeconds；当前接口不是增量文本流。浏览器负责麦克风和未发送草稿，Host 完成识别后通过现有输入动作将文本插入编辑框。

| 组件/接口 | 职责 | 插件动作 |
| --- | --- | --- |
| speech-to-text / SpeechProvider | 识别引擎注册与路由 | 实现并注册自定义 Provider |
| speech-to-text-sensevoice | 官方本地 Provider 参考 | 借鉴生命周期、取消、准备逻辑 |
| api-speech-to-text | 浏览器与 Host 之间传输 | V1 直接复用 |
| client-ui-voice-input | 录音、停止、文本插入 | V1 直接复用 |
| voice-input-bundle | 组合语音子系统 | 需确认启用，追加注册 Provider |

## 3. 端到端架构

```text
Browser microphone / Voice Input UI
  -> base64 PCM16 WAV via authenticated Remote
  -> Host speech-to-text service
  -> dsh-plugin-rapidspeech (SpeechProvider)
  -> HTTP 127.0.0.1:<port> /v1/audio/transcriptions
  -> RapidSpeech.cpp rs-server + local GGUF model
  -> { text } -> Transcript -> input draft (not auto-send)
```

主要边界：插件运行在 Host 侧；端口只绑定 loopback；RapidSpeech 模型和可执行文件放在用户可管理目录；识别失败时返回错误，不自动切换到云端 Provider。

## 4. 技术方案选型

| 接入方式 | 优点 | 问题 | 结论 |
| --- | --- | --- | --- |
| 本地 HTTP rs-server | 模型常驻；TS/C++ 解耦；跨平台简单 | 子进程与端口管理 | V1 推荐 |
| 逐次 CLI rs-asr-offline | 验证快；调试简单 | 可能重复加载模型；并发难管 | 仅辅助验证 |
| C API / N-API | 可减少 HTTP 层 | ABI、构建矩阵、崩溃隔离成本 | 性能瓶颈明确后再考虑 |
| WebSocket 流式 | 适合实时 partial/final | Harness 原生输入接口需扩展 | V3 独立实施 |

## 5. 推荐插件项目结构

```text
dsh-plugin-rapidspeech/
  package.json
  cordis.patch.yml       # 具体语法以固定版 Harness 官方示例为准
  src/
    index.ts             # Cordis 插件注册
    provider.ts          # SpeechProvider 实现
    client.ts            # HTTP 请求与响应校验
    config.ts            # endpoint / timeout / language 映射
    wav.ts               # WAV 头和音频时长解析
    lifecycle.ts         # V2: 进程启动、健康检查、退出
  native/                # V2: win32-x64 / linux-x64 分发包
  tests/                 # 单测及集成测试
  README.md
```

## 6. 核心接口设计

### 6.1 SpeechProvider 行为契约

- 注册唯一 Provider ID，声明 display name、location=host-local 和受支持语言提示；

- transcribe 输入为已编码完整 WAV；不可假设永远存在 44 字节固定文件头，需解析 RIFF/WAVE chunk；

- 使用 FormData 发送 file=recording.wav、model=rapidspeech-asr；

- 将服务端 {text:string} 转成 Transcript，audioSeconds 从 WAV 实际数据和参数计算；

- 将 AbortSignal 传入 fetch，处理超时；不以“取消网络请求”假定 C++ 推理已经停止；

- 卸载 Provider 时等待当前任务收敛，确保不留悬挂进程与未处理 Promise。

### 6.2 HTTP 客户端伪代码（示意，非直接可编译发布版）

```typescript
async function transcribe(input, signal) {
  const form = new FormData();
  form.append("file", new Blob([input.audio], {type:"audio/wav"}), "clip.wav");
  form.append("model", "rapidspeech-asr");
  const res = await fetch("http://127.0.0.1:8080/v1/audio/transcriptions",
    { method:"POST", body:form, signal });
  if (!res.ok) throw new Error(`ASR HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.text !== "string") throw new Error("Invalid ASR response");
  return { text:body.text, audioSeconds: parseWavDuration(input.audio),
           inferenceSeconds: elapsedSeconds() };
}
```

重要：上面的 package 名称、注册签名、Bundle YAML 与配置字段需要在锁定的 Harness commit 上做 TypeScript 编译验证；技术方案不是已测试插件源码。

### 6.3 V1 配置项

| 名称 | 默认值 / 原则 | 说明 |
| --- | --- | --- |
| endpoint | http://127.0.0.1:8080 | 仅允许本地服务或显式白名单 |
| requestTimeoutMs | 120000（示例） | 超时与取消策略可配置 |
| providerId | rapidspeech-local | 保持稳定、避免冲突 |
| language | auto（先行验证） | 按实际所选 GGUF 模型能力映射 |
| modelPath | 无（由外部 rs-server 管理） | V2 引入 |
| serverBinaryPath | 无（V1 外部手启） | V2 引入 |

## 7. RapidSpeech.cpp 编译与本地验证

RapidSpeech.cpp 官方 README 给出了克隆、子模块同步、CMake 编译以及 rs-server OpenAI 兼容转写接口。以下为已确认的基本命令，模型文件名请替换为实际下载的 GGUF。

```bash
git clone https://github.com/RapidAI/RapidSpeech.cpp
cd RapidSpeech.cpp
git submodule sync && git submodule update --init --recursive
# Linux:
cmake -B build -DRS_STATIC_EXE=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
# Windows (PowerShell, VS2022 x64):
cmake -B build -G "Visual Studio 17 2022" -A x64 -DRS_STATIC_EXE=ON
cmake --build build --config Release --parallel
```

```bash
./build/rs-server --asr-model /path/to/model.gguf --port 8080
curl http://127.0.0.1:8080/v1/audio/transcriptions \
  -F file=@audio.wav -F model=rapidspeech-asr
```

请先用 CLI / HTTP 识别样本 WAV 成功，再开发 DSH 端。具体模型如 X-ASR（偏流式）与 FunASR-Nano / SenseVoice（离线）应在中文识别准确率、延迟、CPU/RAM 占用上做横向评估。

## 8. Harness 安装与插件联调策略

1. 选定并固定 Harness 的 release/tag 或 commit，记录 Node、pnpm、OS 和插件 API 版本。

1. 启用官方 Voice Input Bundle，确认在未安装自定义 Provider 时麦克风 UI 正常。

1. 单独开发 dsh-plugin-rapidspeech，按当前版本官方外部插件安装/Bundle 规范打包。

1. 连接已运行的 rs-server，确认可在 Provider 列表中选中 RapidSpeech 并完成录音转写。

1. 验证切换会话、取消、编辑框被更新、页面隐藏时的行为；不要自动提交 Agent 消息。

源码阅读可直接查看官方仓库；如果需要断点调试内部类型与配置，克隆 Harness 用于本地工作区更稳妥，但仍应保留独立插件项目，避免核心 Fork。

## 9. V2：Windows / Linux 一键安装与进程管理

### 9.1 生命周期

```text
UNCONFIGURED -> VALIDATING_FILES -> STARTING -> HEALTHY
    HEALTHY -> TRANSCRIBING -> HEALTHY
    * -> FAILED (diagnostics and retry)
    HEALTHY/FAILED -> STOPPING -> STOPPED
```

- 按 process.platform / process.arch 选择二进制，未支持平台显示明确错误；

- 启动前校验文件存在、执行权限、模型校验和，建议记录 SHA-256；

- 使用 spawn(argv 数组) 而不是拼接 Shell 字符串；设置端口冲突检测与健康检查；

- 只有插件启动的进程才由插件杀掉；外部运行的 rs-server 只能断开连接；

- 管理 Windows 子进程树、Linux SIGTERM→超时 SIGKILL 和异常退出；

- 模型采用用户授权的离线导入/下载，避免无提示的高流量下载；

- 根据 GPU/CPU 后端配置多平台构建；静态链接不等于完全无系统级运行依赖。

### 9.2 平台发布矩阵

| 目标 | 最小交付 | 注意事项 |
| --- | --- | --- |
| Windows x64 | rs-server.exe + 模型/下载策略 | MSVC runtime、DLL、杀毒误报、路径空格 |
| Linux x64 | rs-server + 模型/下载策略 | 可执行权限、glibc、CPU 指令集兼容 |
| Windows/Linux ARM64 | 不纳入 V1 | 如需支持，另建 CI 编译验证 |
| CUDA/Vulkan | 可选扩展包 | GPU 驱动与硬件依赖须单测 |

## 10. 测试与验收

| 类别 | 最小测试用例 | 通过条件 |
| --- | --- | --- |
| 基础识别 | 普通话 5s / 30s WAV、静音、噪声 | 正确返回文本/空字符串，无崩溃 |
| 格式边界 | 空音频、非 PCM、非法 WAV、超长录音 | 明确拒绝，错误可追踪 |
| 稳定性 | 连续 50 次、并发请求与超时 | 无僵尸进程、资源泄漏可控 |
| UI 行为 | 停止录音、取消、切换 Session | 只插入当前有效草稿，不误发送 |
| 跨平台 | Windows 11 / Ubuntu LTS x64 | 从安装到转写的完整冒烟测试 |
| 断网 | 已经准备好模型后关闭网络 | 音频不出本地、仍可识别 |
| 安全 | 端口绑定、任意路径、进程参数 | 默认 loopback、参数无命令注入 |

建议记录端到端延迟、纯推理耗时、首次加载耗时、峰值 RSS、CER/WER。验收阈值需通过目标设备基线测试设定，不应在无测量前承诺数值。

## 11. 风险、决策与排期

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Harness experimental API 变化 | 插件无法加载/类型不兼容 | 锁定版本，建 CI 兼容性测试 |
| 录音编码或 WAV 假设 | 时长错误/识别失败 | 按照 RIFF chunk 解析并验证格式 |
| 模型选择不匹配 | 准确率/延迟差 | 中文场景选型基准测试 |
| 进程取消不彻底 | CPU 占用、资源泄漏 | 队列上限与子进程生命周期管理 |
| 二进制与系统依赖 | 用户安装失败 | 平台构建矩阵+干净机器验收 |
| 模型与组件授权 | 分发合规问题 | 逐项核对软件及模型许可证 |

### 建议交付里程碑

M0：独立 RapidSpeech ASR HTTP 验证；M1：Harness SpeechProvider + 官方语音 UI 联调；M2：配置、错误处理及取消；M3：Windows/Linux 原生包、模型准备和进程托管；M4（可选）：流式识别探索。建议 M1 作为首个可展示交付点。

## 12. 关键参考资料与核实说明

• DeepSeek Harness 主仓库
  https://github.com/deepseek-ai/deepseek-harness

• Harness 语音输入设计
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/voice-input.md

• SpeechProvider 类型
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/speech-to-text/src/types.ts

• 官方 SenseVoice Provider
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/speech-to-text-sensevoice/src/index.ts

• RapidSpeech.cpp 源码与编译文档
  https://github.com/RapidAI/RapidSpeech.cpp

• RapidSpeech 服务器使用指南
  https://github.com/RapidAI/RapidSpeech.cpp/tree/main/examples/server

• RapidSpeech GGUF 模型
  https://huggingface.co/RapidAI/RapidSpeech

资料核实时间：2026-11-07。已确认 Provider 的完整录音识别语义、SpeechInput / Transcript 字段及 RapidSpeech 的 rs-server 编译和转写端点；尚未实际在本环境完成 Windows/Linux 原生构建和第三方插件安装编译验证。
