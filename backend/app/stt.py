import io
import json
import os
import wave
from dataclasses import dataclass
from typing import Optional, Tuple

from vosk import KaldiRecognizer, Model


def _read_wav_info_and_pcm(wav_bytes: bytes) -> Tuple[int, int, bytes]:
    """
    Returns (sample_rate, channels, pcm16le_bytes).
    Raises ValueError if not a PCM WAV.
    """
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        comptype = wf.getcomptype()
        if comptype != "NONE":
            raise ValueError("WAV must be uncompressed PCM")
        if sampwidth != 2:
            raise ValueError("WAV must be 16-bit PCM")
        pcm = wf.readframes(wf.getnframes())
        return framerate, channels, pcm


@dataclass
class VoskSTT:
    model_path: str
    _model: Optional[Model] = None

    def _ensure_model(self) -> None:
        if self._model is None:
            if not self.is_ready():
                raise FileNotFoundError(
                    f"Vosk model not found at {self.model_path}. "
                    f"Download a model (see README) and set VOSK_MODEL_PATH."
                )
            self._model = Model(self.model_path)

    def is_ready(self) -> bool:
        if not os.path.isdir(self.model_path):
            return False
        required_dirs = ("am", "conf")
        return all(os.path.isdir(os.path.join(self.model_path, d)) for d in required_dirs)

    def transcribe_wav(self, wav_bytes: bytes) -> str:
        self._ensure_model()
        sr, channels, pcm = _read_wav_info_and_pcm(wav_bytes)
        if channels != 1:
            raise ValueError("WAV must be mono (1 channel)")
        if sr not in (8000, 16000, 32000, 44100, 48000):
            # Vosk can handle other rates but we standardize on 16k in the client.
            pass

        rec = KaldiRecognizer(self._model, sr)
        rec.SetWords(False)
        rec.AcceptWaveform(pcm)
        result = json.loads(rec.FinalResult() or "{}")
        return (result.get("text") or "").strip()

