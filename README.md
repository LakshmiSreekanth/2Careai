## 2Care.ai — Real-Time Multilingual Voice AI Agent (Python + HTML/CSS/JS)

This repository contains a **real-time voice appointment agent** that supports **English, Hindi, and Tamil**, with:

- **Inbound** conversational booking / rescheduling / cancellation
- **Outbound** reminder / follow-up campaigns (simulated call initiation via the web client)
- **Contextual memory**
  - **Session memory**: conversation state & pending confirmations (TTL)
  - **Persistent memory**: patient preferences (language), history summaries
- **Scheduling + conflict logic**: prevents double-booking, past-time selections, and unavailable doctors
- **Latency instrumentation**: measures and logs **speech-end → first-audio-start** and server stage timings

### Quickstart

1) Start Redis (optional but recommended):

```bash
docker compose up -d redis
```

2) Start the backend:

```bash
cd backend
python -m venv .venv
. .venv/Scripts/activate
pip install -r requirements.txt
python -m app
```

3) Open the web client:

- Open `http://localhost:5173` in a browser (served by `python -m http.server 5173` from `web/`).
- Click **Connect**, then **Start** and speak.

### Voice STT (works in Cursor preview)

This demo uses **server-side STT** via **Vosk** so it does not depend on browser SpeechRecognition.

1) Download a Vosk model (recommended multilingual small):
- Create a folder: `backend/models/vosk`
- Download and extract a model into it (the folder must contain `am`, `conf`, etc.)

2) Set:

```env
VOSK_MODEL_PATH=backend/models/vosk
```

If you don’t have a model yet, you can still test the agent via **typed input**.

### Configuration

Create `backend/.env` (do not commit) and set at least one LLM provider:

```env
# Option A: OpenAI
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini

# Option B: Ollama (local)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1

# Memory (optional)
REDIS_URL=redis://localhost:6379/0
```

### Render Deploy (Backend)

Use these settings on Render:

- Language: `Python 3`
- Build Command: `pip install -r backend/requirements.txt`
- Start Command: `uvicorn backend.app.server:create_app --host 0.0.0.0 --port $PORT --factory`

This repo includes `runtime.txt` to pin Python to a compatible version for dependencies.

### Docs

- `docs/architecture.mmd`: architecture diagram source (Mermaid)
- `docs/latency.md`: latency measurement notes and how to reproduce

