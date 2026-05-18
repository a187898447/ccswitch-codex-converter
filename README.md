# CC Switch Universal Provider Converter

一个零配置的协议转换器，使任何兼容 OpenAI Chat Completions API 的模型提供商通过 CC Switch 在 Codex 中使用。

Codex → CC Switch → converter(:11888) → 任意 OpenAI 兼容 API

## 前置条件

- [Node.js](https://nodejs.org) >= 18
- [CC Switch](https://ccswitch.app) 已安装
- [OpenAI Codex](https://github.com/openai/codex) 已安装
- 目标提供商的 API key

## 支持的提供商

任何兼容 OpenAI `/v1/chat/completions` 接口的都能用：

| 提供商 | PROVIDER_BASE_URL |
|---|---|
| DeepSeek | `https://api.deepseek.com` |
| 豆包（字节） | `https://ark.cn-beijing.volces.com/api/v3` |
| 通义千问（阿里） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi / Moonshot | `https://api.moonshot.cn` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| SiliconFlow | `https://api.siliconflow.cn` |
| OpenRouter | `https://openrouter.ai/api` |
| Ollama（本地） | `http://localhost:11434` |
| vLLM（本地） | `http://localhost:8000` |

## 快速开始

### 1. 启动转换器

```bash
cd /path/to/converter
./start.sh
```

验证：
```bash
curl -s http://127.0.0.1:11888/health | python3 -m json.tool
```

### 2. 查询可用的模型名

```bash
# 以 DeepSeek 为例，替换为你的 BASE_URL 和 API key
curl -s https://api.deepseek.com/v1/models \
  -H "Authorization: Bearer <你的API key>"
```

记下模型名。

### 3. 配置 CC Switch

打开 CC Switch → 设置 → Providers → 添加通用提供商：

| 字段 | 值 |
|---|---|
| 名称 | 任意，如 `DeepSeek` |
| Base URL | `http://127.0.0.1:11888` |
| Wire API | `responses` |
| API Key | 你的提供商 API key |
| 模型 | 第 2 步查到的模型名 |

保存，然后在 CC Switch 主界面切换到这个提供商。

### 4. 验证

```bash
codex exec "hello" -s read-only
```

## 切换到其他提供商

只需修改 `.env` 文件中的 `PROVIDER_BASE_URL`，或直接在 CC Switch 中填入对应提供商的 API key：

```bash
# 豆包
PROVIDER_BASE_URL=https://ark.cn-beijing.volces.com/api/v3

# 通义千问
PROVIDER_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# Ollama 本地模型
PROVIDER_BASE_URL=http://localhost:11434
```

## 环境变量

所有环境变量均可选。

```bash
# 提供商 endpoint（不设置则默认 DeepSeek）
PROVIDER_BASE_URL=https://api.deepseek.com

# 强制指定 API key（不设置则透传 CC Switch 的 Authorization header）
PROVIDER_API_KEY=sk-xxx

# 模型名映射，格式 from:to,from:to
# 用于在 CC Switch 里继续使用 OpenAI 模型名
MODEL_MAP=gpt-5.5:deepseek-chat,gpt-5.1:deepseek-chat

# 监听地址
CONVERTER_PORT=11888
CONVERTER_HOST=127.0.0.1
```

在 `.env` 文件中配置：
```bash
cp .env.example .env && vi .env
```

## 开机自启（macOS）

```bash
cat > ~/Library/LaunchAgents/com.ccswitch.converter.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ccswitch.converter</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/converter/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/ccswitch-converter.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/ccswitch-converter.err</string>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/com.ccswitch.converter.plist
```

## 工作原理

```
┌───────┐     ┌──────────┐     ┌─────────────┐     ┌──────────────┐
│ Codex │ ──▶ │ CC Switch│ ──▶ │  converter  │ ──▶ │ 任意 OpenAI  │
│       │     │  (proxy) │     │ :11888      │     │ 兼容 API     │
└───────┘     └──────────┘     └─────────────┘     └──────────────┘
                                      │
                              透传 Authorization header
                              透传 model 名称
                              清洗不支持参数（logprobs、reasoning 等）
                              Responses API ↔ Chat Completions 格式互转
                              SSE 流式双向转发
```

- **格式转换**：OpenAI Responses API ↔ Chat Completions API
- **参数清洗**：自动移除提供商不支持的参数
- **流式支持**：SSE 透传
- **零依赖**：仅 Node.js 内置模块

## License

MIT
