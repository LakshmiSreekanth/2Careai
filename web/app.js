const el = (id) => document.getElementById(id);
const logEl = el("log");
const wsStatus = el("wsStatus");
const sttStatus = el("sttStatus");
const connectBtn = el("connectBtn");
const disconnectBtn = el("disconnectBtn");
const startBtn = el("startBtn");
const stopBtn = el("stopBtn");
const sendBtn = el("sendBtn");
const textInput = el("textInput");
const wsUrlInput = el("wsUrl");
const sttModeInput = el("sttMode");
const patientIdInput = el("patientId");
const sessionIdInput = el("sessionId");
const latClientEl = el("latClient");
const latAudioEl = el("latAudio");

let ws = null;
let lastSpeechEndMs = null;
let lastServerReplyMs = null;
let recording = false;
let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let pcmChunks = [];
let sttUrl = "http://127.0.0.1:8000/stt";
let browserRecognition = null;
let browserListening = false;
let backendSttReady = null;
const sttStatusUrl = "http://127.0.0.1:8000/stt/status";

function nowMs() {
  return performance.now();
}

function appendLog(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setWsStatus(online) {
  wsStatus.textContent = online ? "Connected" : "Disconnected";
  wsStatus.classList.toggle("pill--online", online);
  wsStatus.classList.toggle("pill--offline", !online);
  connectBtn.disabled = online;
  disconnectBtn.disabled = !online;
  startBtn.disabled = !online;
  sendBtn.disabled = !online;
  stopBtn.disabled = true;
}

function setSttStatus(kind, text) {
  if (!sttStatus) return;
  sttStatus.textContent = text;
  sttStatus.classList.remove("pill--warn", "pill--error", "pill--ok");
  if (kind === "ok") sttStatus.classList.add("pill--ok");
  else if (kind === "error") sttStatus.classList.add("pill--error");
  else sttStatus.classList.add("pill--warn");
}

function getOrCreateSessionId() {
  let v = sessionIdInput.value.trim();
  if (!v) {
    v = `sess_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    sessionIdInput.value = v;
  }
  return v;
}

function speak(text, langHint) {
  const utter = new SpeechSynthesisUtterance(text);
  if (langHint) utter.lang = langHint;

  utter.onstart = () => {
    if (lastSpeechEndMs != null) {
      const audioLat = Math.max(0, nowMs() - lastSpeechEndMs);
      latAudioEl.textContent = `${audioLat.toFixed(0)} ms`;
    }
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
}

function hasBrowserSTT() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function createBrowserRecognition() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "en-IN";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  return rec;
}

async function refreshSttStatus() {
  backendSttReady = null;
  setSttStatus("warn", "STT: checking...");
  try {
    const resp = await fetch(sttStatusUrl, { method: "GET" });
    const data = await resp.json();
    backendSttReady = Boolean(data?.ok && data?.model_ready);
    if (!backendSttReady) {
      setSttStatus("error", "STT: backend model missing");
      appendLog("Backend STT model not ready. Install Vosk model under backend/models/vosk.");
    } else {
      setSttStatus("ok", "STT: backend ready");
    }
  } catch {
    backendSttReady = false;
    setSttStatus("error", "STT: backend unreachable");
    appendLog("Could not check backend STT status.");
  }
}

function shouldTryBrowserStt() {
  const mode = sttModeInput?.value || "auto";
  if (mode === "backend") return false;
  return hasBrowserSTT();
}

function shouldTryBackendStt() {
  const mode = sttModeInput?.value || "auto";
  if (mode === "browser") return false;
  return backendSttReady !== false;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return buffer;
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / Math.max(1, count);
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function encodeWav(int16Samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = 1 * bytesPerSample;
  const buffer = new ArrayBuffer(44 + int16Samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + int16Samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true); // AudioFormat=PCM
  view.setUint16(22, 1, true); // NumChannels=1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, int16Samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < int16Samples.length; i++, offset += 2) {
    view.setInt16(offset, int16Samples[i], true);
  }
  return new Blob([view], { type: "audio/wav" });
}

async function startRecording() {
  if (recording) return;

  if (shouldTryBrowserStt()) {
    browserRecognition = createBrowserRecognition();
    if (!browserRecognition) {
      appendLog("Browser speech recognition initialization failed.");
      return;
    }

    browserRecognition.onstart = () => {
      browserListening = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      appendLog("Listening (browser STT)...");
    };

    browserRecognition.onresult = (event) => {
      const text = (event.results?.[0]?.[0]?.transcript || "").trim();
      lastSpeechEndMs = nowMs();
      appendLog(`You: ${text || "(no speech detected)"}`);
      sendUtterance(text, { t_speech_end_ms: lastSpeechEndMs });
    };

    browserRecognition.onerror = (event) => {
      appendLog(`Browser STT error: ${event.error || "unknown"}`);
    };

    browserRecognition.onend = () => {
      browserListening = false;
      stopBtn.disabled = true;
      startBtn.disabled = !ws;
    };

    try {
      browserRecognition.start();
      return;
    } catch (e) {
      appendLog("Could not start browser STT, switching to backend STT.");
    }
  }

  if (!shouldTryBackendStt()) {
    appendLog("No usable STT path. Choose Browser mode in Chrome/Edge or install Vosk model.");
    return;
  }

  pcmChunks = [];
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    appendLog("Microphone permission denied or unavailable.");
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

  processorNode.onaudioprocess = (evt) => {
    const input = evt.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioCtx.destination);

  recording = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  appendLog("Listening...");
}

async function stopRecordingAndTranscribe() {
  if (browserListening && browserRecognition) {
    try {
      browserRecognition.stop();
    } catch {}
    return;
  }

  if (!recording) return;
  recording = false;
  stopBtn.disabled = true;
  startBtn.disabled = !ws;

  try { processorNode.disconnect(); } catch {}
  try { sourceNode.disconnect(); } catch {}
  try { mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { await audioCtx.close(); } catch {}

  // Merge PCM
  const totalLen = pcmChunks.reduce((a, c) => a + c.length, 0);
  const merged = new Float32Array(totalLen);
  let off = 0;
  for (const c of pcmChunks) {
    merged.set(c, off);
    off += c.length;
  }

  // Downsample to 16k mono
  const inputRate = (audioCtx && audioCtx.sampleRate) ? audioCtx.sampleRate : 48000;
  const down = downsampleBuffer(merged, inputRate, 16000);
  const int16 = floatTo16BitPCM(down);
  const wavBlob = encodeWav(int16, 16000);

  lastSpeechEndMs = nowMs();

  appendLog("Transcribing...");
  const form = new FormData();
  form.append("audio", wavBlob, "utterance.wav");
  let resp = null;
  try {
    resp = await fetch(sttUrl, { method: "POST", body: form });
  } catch (e) {
    appendLog("STT backend request failed. Is the backend running?");
    return;
  }
  const data = await resp.json().catch(() => null);
  if (!data || !data.ok) {
    appendLog(`STT backend error: ${data?.error || "unknown"}`);
    appendLog("Tip: you need a Vosk model folder and set VOSK_MODEL_PATH (see README).");
    return;
  }
  const text = (data.text || "").trim();
  appendLog(`You: ${text || "(no speech detected)"}`);
  sendUtterance(text, { t_speech_end_ms: lastSpeechEndMs });
}

function sendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function sendUtterance(text, { t_speech_end_ms } = {}) {
  const patient_id = patientIdInput.value.trim() || "patient_001";
  const session_id = getOrCreateSessionId();
  sendJson({
    type: "user_utterance",
    patient_id,
    session_id,
    text,
    t_speech_end_ms: t_speech_end_ms ?? null
  });
}

connectBtn.addEventListener("click", () => {
  const url = wsUrlInput.value.trim();
  ws = new WebSocket(url);

  ws.onopen = () => {
    setWsStatus(true);
    appendLog(`WS connected: ${url}`);
    refreshSttStatus();
  };
  ws.onclose = () => {
    appendLog("WS closed");
    setWsStatus(false);
    ws = null;
  };
  ws.onerror = () => {
    appendLog("WS error (if you used localhost, try ws://127.0.0.1:8000/ws)");
  };
  ws.onmessage = (msg) => {
    const t = nowMs();
    let data = null;
    try {
      data = JSON.parse(msg.data);
    } catch {
      appendLog(`Server: ${msg.data}`);
      return;
    }

    if (data.type === "agent_message") {
      appendLog(`Agent: ${data.text}`);
      lastServerReplyMs = t;
      if (lastSpeechEndMs != null) {
        const lat = Math.max(0, lastServerReplyMs - lastSpeechEndMs);
        latClientEl.textContent = `${lat.toFixed(0)} ms`;
      }
      speak(data.text, data.tts_lang || null);
    } else if (data.type === "trace") {
      appendLog(`trace/${data.stage}: ${data.detail}`);
    } else if (data.type === "error") {
      appendLog(`error: ${data.message}`);
    } else {
      appendLog(`server: ${msg.data}`);
    }
  };
});

disconnectBtn.addEventListener("click", () => {
  if (ws) ws.close();
});

startBtn.addEventListener("click", () => {
  startRecording();
});

stopBtn.addEventListener("click", () => {
  stopRecordingAndTranscribe();
});

sendBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (!text) return;
  lastSpeechEndMs = nowMs();
  appendLog(`You: ${text}`);
  sendUtterance(text, { t_speech_end_ms: lastSpeechEndMs });
  textInput.value = "";
});

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

setWsStatus(false);
setSttStatus("warn", "STT: connect to check");
if (!hasBrowserSTT()) {
  appendLog("Browser STT not available in this browser runtime.");
}

