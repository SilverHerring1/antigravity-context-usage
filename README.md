# Context & Usage (`context-usage`)

An auxiliary-pane telemetry dashboard plugin for **Antigravity IDE** that visualizes live context window occupancy, semantic prompt breakdown, compaction checkpoints, subagent fleets, and daily token usage trends.

## Features

- **Home & Context Inspector (`主页` / `上下文`)**: Live prompt token occupancy, cache hit ratio, observed compaction calibration (`200K` / `1M` / measured compaction line), 6-segment semantic composition bar (tool calls & results, system/rules, thinking, user messages, assistant responses, remaining budget), interactive `Total` / `Delta` turn trajectory chart, and 3-line step brief.
- **Usage Trends & Heatmap (`趋势`)**: Quick `DAY` / `MONTH` / `TOTAL` period switcher, 24-week monochromatic activity heatmap, API calls & token trend charts, and per-session distribution.
- **Fleet & Tools (`编队与工具`)**: Subagent hierarchy tree, top tool call bars, and file read/write activity filter.
- **#070708 Dark & Pure White Themes**: Native `#070708` dark (matching Antigravity IDE) and `#ffffff` light high-contrast themes synchronized with `color-scheme` and a persistent manual theme toggle (`localStorage`), bundled with offline `InterVariable` and `Maple Mono` webfonts (`woff2`).
- **Local-Only Telemetry**: Reads `~/.gemini/<app>/brain/` session transcripts and metadata in read-only mode. No data leaves your machine.

## Directory Structure

```text
context-usage/
├── plugin.json
├── README.md
├── assets/
│   └── logo.svg
└── sidecars/
    └── usage_panel/
        ├── package.json
        ├── sidecar.json
        ├── main.mjs
        ├── lib/
        │   └── usage.mjs
        └── public/
            ├── index.html
            ├── styles.css
            ├── app.js
            ├── avatar.jpg
            └── fonts/
                ├── InterVariable.woff2
                └── MapleMono-Regular.woff2
```

## Installation (Antigravity Plugin)

Copy the `context-usage` folder to Antigravity's plugin directory and enable it in the Plugins Manager:

- **Windows**: `C:\Users\<username>\.gemini\config\plugins\context-usage`
- **macOS / Linux**: `~/.gemini/config/plugins/context-usage`

## Standalone Local Preview

Run the sidecar directly in standalone HTTP mode (Node.js 18+ required, zero external npm dependencies):

```powershell
node sidecars/usage_panel/main.mjs --standalone --port 18421
```

Open `http://127.0.0.1:18421/` in your browser. Optionally pass `ANTIGRAVITY_CONVERSATION_ID=<conversation-uuid>` to pin a specific active conversation.
