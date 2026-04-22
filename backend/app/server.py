import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import orjson
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .stt import VoskSTT


def _now_ms() -> float:
    return time.perf_counter() * 1000.0


def _json_dumps(obj: Any) -> str:
    return orjson.dumps(obj).decode("utf-8")


@dataclass
class Trace:
    ws: WebSocket
    request_id: str

    async def emit(self, stage: str, detail: str, extra: Optional[Dict[str, Any]] = None) -> None:
        payload: Dict[str, Any] = {"type": "trace", "request_id": self.request_id, "stage": stage, "detail": detail}
        if extra:
            payload.update(extra)
        await self.ws.send_text(_json_dumps(payload))


DOCTOR_SLOTS: Dict[str, List[str]] = {
    "cardiologist": ["10:00 AM", "11:30 AM", "2:00 PM", "4:00 PM"],
    "dermatologist": ["9:30 AM", "12:00 PM", "3:00 PM"],
    "neurologist": ["10:30 AM", "1:00 PM", "5:00 PM"],
}

# Simple in-memory store for demo behavior.
APPOINTMENTS: Dict[str, Dict[str, str]] = {}


def _pick_doctor(text: str) -> Optional[str]:
    t = text.lower()
    for doctor in DOCTOR_SLOTS:
        if doctor in t:
            return doctor
    return None


def _pick_slot(text: str, doctor: str) -> Optional[str]:
    t = text.lower().replace(".", "").replace("  ", " ")
    for slot in DOCTOR_SLOTS.get(doctor, []):
        if slot.lower().replace(".", "") in t:
            return slot
    return None


def _intent(text: str) -> str:
    t = text.lower()
    if any(k in t for k in ["cancel", "remove", "drop"]):
        return "cancel"
    if any(k in t for k in ["reschedule", "move", "change"]):
        return "reschedule"
    if any(k in t for k in ["availability", "available", "slots", "free"]):
        return "availability"
    if any(k in t for k in ["book", "appointment", "schedule"]):
        return "book"
    return "unknown"


def _handle_appointment(text: str, patient_id: str) -> str:
    action = _intent(text)
    existing = APPOINTMENTS.get(patient_id)
    doctor = _pick_doctor(text) or (existing.get("doctor") if existing else None)

    if action == "cancel":
        if not existing:
            return "You do not have any active appointment to cancel."
        APPOINTMENTS.pop(patient_id, None)
        return f"Done. Your appointment with {existing['doctor']} at {existing['slot']} is cancelled."

    if action == "availability":
        if not doctor:
            return "Which doctor would you like? I can check cardiologist, dermatologist, or neurologist."
        slots = ", ".join(DOCTOR_SLOTS.get(doctor, []))
        return f"Available slots for {doctor} are: {slots}."

    if action == "book":
        if not doctor:
            return "Sure. Which doctor do you want to book: cardiologist, dermatologist, or neurologist?"
        slot = _pick_slot(text, doctor)
        if not slot:
            options = ", ".join(DOCTOR_SLOTS[doctor])
            return f"Please choose a slot for {doctor}. Available slots are: {options}."
        APPOINTMENTS[patient_id] = {"doctor": doctor, "slot": slot}
        return f"Booked. Your appointment with {doctor} is confirmed for {slot}."

    if action == "reschedule":
        if not existing:
            return "You do not have an appointment yet. Say book appointment first."
        doctor = doctor or existing["doctor"]
        slot = _pick_slot(text, doctor)
        if not slot:
            options = ", ".join(DOCTOR_SLOTS[doctor])
            return f"Tell me the new slot for {doctor}. Available options: {options}."
        APPOINTMENTS[patient_id] = {"doctor": doctor, "slot": slot}
        return f"Rescheduled. Your appointment with {doctor} is now at {slot}."

    return (
        "I can help with booking, rescheduling, cancellation, and availability. "
        "For example: book cardiologist at 2:00 PM."
    )


def create_app() -> FastAPI:
    load_dotenv()

    app = FastAPI(title="2Care Voice Agent Backend", version="0.1.0")
    stt = VoskSTT(model_path=os.getenv("VOSK_MODEL_PATH", os.path.join(os.path.dirname(__file__), "..", "models", "vosk")))

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.post("/stt")
    async def stt_endpoint(audio: UploadFile = File(...)) -> Dict[str, Any]:
        t0 = _now_ms()
        wav_bytes = await audio.read()
        try:
            text = stt.transcribe_wav(wav_bytes)
        except Exception as e:
            return {"ok": False, "error": str(e), "latency_ms": max(0.0, _now_ms() - t0)}
        return {"ok": True, "text": text, "latency_ms": max(0.0, _now_ms() - t0)}

    @app.get("/stt/status")
    async def stt_status() -> Dict[str, Any]:
        return {
            "ok": True,
            "provider": "vosk",
            "model_path": stt.model_path,
            "model_ready": stt.is_ready(),
        }

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        try:
            while True:
                raw = await ws.receive_text()
                t_recv = _now_ms()

                request_id = f"req_{uuid.uuid4().hex[:10]}"
                trace = Trace(ws=ws, request_id=request_id)

                try:
                    msg = orjson.loads(raw)
                except Exception:
                    await ws.send_text(_json_dumps({"type": "error", "message": "Invalid JSON"}))
                    continue

                if msg.get("type") != "user_utterance":
                    await ws.send_text(_json_dumps({"type": "error", "message": "Unknown message type"}))
                    continue

                text = (msg.get("text") or "").strip()
                patient_id = (msg.get("patient_id") or "").strip() or "patient_001"
                session_id = (msg.get("session_id") or "").strip() or f"sess_{uuid.uuid4().hex[:8]}"
                t_speech_end_ms = msg.get("t_speech_end_ms")

                await trace.emit("ingress", f"received {len(text)} chars", {"patient_id": patient_id, "session_id": session_id})
                if t_speech_end_ms is not None:
                    try:
                        delta = max(0.0, t_recv - float(t_speech_end_ms))
                        await trace.emit("latency", f"speech_end→server_recv {delta:.0f} ms")
                    except Exception:
                        pass

                if not text:
                    reply = "I didn't catch that. Please say that again."
                else:
                    reply = _handle_appointment(text, patient_id)

                t_reply = _now_ms()
                await trace.emit("egress", f"server_think {max(0.0, t_reply - t_recv):.0f} ms")

                await ws.send_text(
                    _json_dumps(
                        {
                            "type": "agent_message",
                            "request_id": request_id,
                            "text": reply,
                            "tts_lang": None,
                        }
                    )
                )
        except WebSocketDisconnect:
            return

    return app


def run() -> None:
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(create_app(), host=host, port=port, reload=False)

