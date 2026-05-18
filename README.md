# CC Switch × DeepSeek Codex Converter

一个零配置的协议转换器，使 DeepSeek 模型通过 CC Switch 在 OpenAI Codex 中使用。

Codex 请求 → CC Switch 代理 → 本转换器 → DeepSeek API

## 前置条件

- [Node.js](https://nodejs.org) >= 18
- [CC Switch](https://ccswitch.app) 已安装
- [OpenAI Codex](https://github.com/openai/codex) 已安装
- DeepSeek API key（[platform.deepseek.com](https://platform.deepseek.com) 获取）

## 快速开始

### 1. 启动转换器

```bash
cd /path/to/converter
./start.sh
```

输出：
```
[ccswitch-deepseek-converter] http://127.0.0.1:11888
  DeepSeek API:  https://api.deepseek.com
  Auth mode:     passthrough
  Model mapping: passthrough
```

验证：
```bash
curl -s http://127.0.0.1:11888/health | python3 -m json.tool
```

### 2. 查询 DeepSeek 可用模型

```bash
curl -s https://api.deepseek.com/v1/models \
  -H "Authorization: Bearer <你的DeepSeek API key>"
```

记下你想要使用的模型名。

### 3. 配置 CC Switch

打开 CC Switch → 设置 → Providers → 添加通用提供商：

| 字段 | 值 |
|---|---|
| 名称 | `DeepSeek` |
| Base URL | `http://127.0.0.1:11888` |
| Wire API | `responses` |
| API Key | 你的 DeepSeek API key |
| 模型 | 第 2 步查到的模型名 |

保存后，在 CC Switch 主界面切换到 DeepSeek 提供商。

### 4. 验证

```bash
codex exec "hello" -s read-only
```

## 环境变量

所有环境变量均可选，转换器默认透传 CC Switch 的配置。

```bash
# 可选：强制指定 API key（不配置则透传 CC Switch 的 Authorization header）
DEEPSEEK_API_KEY=sk-xxx

# 可选：自建或第三方 DeepSeek 兼容端点
DEEPSEEK_BASE_URL=https://your-endpoint.com

# 可选：模型名映射，格式 from:to,from:to
# 用于在 CC Switch 里继续使用 OpenAI 模型名
MODEL_MAP=gpt-5.5:deepseek-chat,gpt-5.1:deepseek-chat

# 可选：监听地址
CONVERTER_PORT=11888
CONVERTER_HOST=127.0.0.1
```

放在 `.env` 文件中：
```bash
cp .env.example .env
# 编辑 .env
```

## 开机自启（macOS）

```bash
cat > ~/Library/LaunchAgents/com.deepseek.converter.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.deepseek.converter</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/converter/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/deepseek-converter.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/deepseek-converter.err</string>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/com.deepseek.converter.plist
```

## 工作原理

```
┌───────┐     ┌──────────┐     ┌─────────────┐     ┌──────────┐
│ Codex │ ──▶ │ CC Switch│ ──▶ │  converter  │ ──▶ │ DeepSeek │
│       │     │  (proxy) │     │ :11888      │     │ API      │
└───────┘     └──────────┘     └─────────────┘     └──────────┘
                                      │
                              透传 Authorization header
                              透传 model 名称
                              清洗不支持参数
                              Responses API ↔ Chat Completions 转换
```

转换器负责：
- **格式转换**：OpenAI Responses API 与 DeepSeek Chat Completions API 互转
- **参数清洗**：移除 DeepSeek 不支持的参数（logprobs、reasoning 等）
- **流式支持**：SSE 双向透传和格式适配
- **零依赖**：仅使用 Node.js 内置模块

## License

MIT
