"""Jev qwen-image service: official Diffusers QwenImage21Pipeline (Qwen/Qwen-Image-2.1)
behind a loopback-only HTTP contract with deterministic seeds, bfloat16, CPU offload
and single-flight generation."""
import asyncio
import base64
import hashlib
import io
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager

import torch
from diffusers import QwenImage21Pipeline
from fastapi import FastAPI, HTTPException, status
from PIL import Image
from pydantic import BaseModel

MODEL_ID = "Qwen/Qwen-Image-2.1"
# Model snapshot pinned for reproducibility (HF model repo HEAD 2026-09-21).
MODEL_REVISION = "790c92633540aa0cb11d9abf19eb46d861714758"
DEFAULT_WIDTH = 512
DEFAULT_HEIGHT = 512
DEFAULT_STEPS = int(os.environ.get("QWEN_IMAGE_STEPS", "8"))
DEFAULT_SEED = 42
MAX_STEPS = 50
MAX_SIDE = 2048
MIN_SIDE = 64
OUTPUT_DIR = os.environ.get("QWEN_IMAGE_OUTPUT_DIR", "/output")
OFFLOAD_MODE = os.environ.get("QWEN_IMAGE_OFFLOAD", "model")  # valid: model | sequential | none
TRANSPARENT_PREFIX = "This is an RGBA image with transparency."
TRANSPARENT_SUFFIX = "The image has alpha channel and the background is transparent."

log = logging.getLogger("qwen-image")
logging.basicConfig(level=logging.INFO)

_state = {"status": "loading", "error": None, "offload": OFFLOAD_MODE, "device": "cpu"}
_pipe = None
_pipeline_lock = threading.Lock()  # single-flight: exactly one active generation
_busy = threading.Event()


def _load_pipeline():
    global _pipe
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _state["device"] = device
    pipe = QwenImage21Pipeline.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, torch_dtype=torch.bfloat16
    )
    if device == "cuda":
        if OFFLOAD_MODE == "model":
            pipe.enable_model_cpu_offload()
        elif OFFLOAD_MODE == "sequential":
            pipe.enable_sequential_cpu_offload()
        else:
            pipe = pipe.to("cuda")
    _pipe = pipe
    _state["status"] = "ok"
    log.info("pipeline ready: model=%s device=%s offload=%s", MODEL_ID, device, OFFLOAD_MODE)


@asynccontextmanager
async def lifespan(_app):
    def _run_load():
        try:
            _load_pipeline()
        except Exception as exc:  # noqa: BLE001 - any load failure must surface via /health
            _state["status"] = "error"
            _state["error"] = f"{type(exc).__name__}: {exc}"
            log.exception("pipeline load failed")
    threading.Thread(target=_run_load, daemon=True, name="model-load").start()
    yield


app = FastAPI(title="jev-cu-qwen image service", lifespan=lifespan)


class GenerateRequest(BaseModel):
    prompt: str = ""
    width: int | None = None
    height: int | None = None
    steps: int | None = None
    seed: int | None = None
    transparent: bool = False


class EditRequest(GenerateRequest):
    image_base64: str | None = None


def _normalize(request: GenerateRequest):
    if not request.prompt or not request.prompt.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="prompt: must be a non-empty string")

    def side(value, default):
        if value is None:
            return default
        if value < MIN_SIDE or value > MAX_SIDE:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"side: {value} out of range [{MIN_SIDE}, {MAX_SIDE}]")
        return max(MIN_SIDE, (value // 16) * 16)

    steps = DEFAULT_STEPS if request.steps is None else request.steps
    if steps < 1 or steps > MAX_STEPS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"steps: {steps} out of range [1, {MAX_STEPS}]")
    prompt = request.prompt.strip()
    if request.transparent:
        prompt = f"{TRANSPARENT_PREFIX} {prompt} {TRANSPARENT_SUFFIX}"
    return {
        "prompt": prompt,
        "width": side(request.width, DEFAULT_WIDTH),
        "height": side(request.height, DEFAULT_HEIGHT),
        "steps": steps,
        "seed": DEFAULT_SEED if request.seed is None else request.seed,
    }


def _decode_image(image_base64):
    if not image_base64:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="image: missing or not a decodable PNG/JPEG")
    try:
        raw = base64.b64decode(image_base64, validate=True)
        image = Image.open(io.BytesIO(raw))
        image.load()
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="image: missing or not a decodable PNG/JPEG")
    return image


async def _execute(request: GenerateRequest, edit_image=None):
    if _state["status"] == "loading":
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="model still loading")
    if _state["status"] == "error":
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"model failed to load: {_state['error']}")
    spec = _normalize(request)

    if edit_image is not None:
        if request.width is None:
            spec["width"] = max(MIN_SIDE, (edit_image.width // 16) * 16)
        if request.height is None:
            spec["height"] = max(MIN_SIDE, (edit_image.height // 16) * 16)

    if not _pipeline_lock.acquire(blocking=False):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="busy: another request is running")
    _busy.set()
    started = time.monotonic()
    try:
        def work():
            pipe = _pipe
            if pipe is None:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="model still loading")
            cuda = _state["device"] == "cuda"
            if cuda:
                torch.cuda.reset_peak_memory_stats()
            generator = torch.Generator(device=_state["device"]).manual_seed(spec["seed"])
            kwargs = {
                "prompt": spec["prompt"],
                "width": spec["width"],
                "height": spec["height"],
                "num_inference_steps": spec["steps"],
                "generator": generator,
            }
            if edit_image is not None:
                kwargs["image"] = edit_image
            image = pipe(**kwargs).images[0]
            peak_vram_gb = round(torch.cuda.max_memory_allocated() / 2**30, 2) if cuda else None
            return image, peak_vram_gb

        image, peak_vram_gb = await asyncio.to_thread(work)
    finally:
        _busy.clear()
        _pipeline_lock.release()

    image_id = uuid.uuid4().hex[:12]
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    log.info(
        "generation done: id=%s seed=%s %dx%d steps=%s mode=%s peak_vram_gb=%s",
        image_id, spec["seed"], image.width, image.height, spec["steps"], image.mode, peak_vram_gb,
    )
    png_bytes = buffer.getvalue()
    filename = f"{image_id}.png"
    try:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(os.path.join(OUTPUT_DIR, filename), "wb") as handle:
            handle.write(png_bytes)
    except OSError as exc:
        log.warning("output bind write failed: %s", exc)

    return {
        "id": image_id,
        "filename": filename,
        "width": image.width,
        "height": image.height,
        "mode": image.mode,
        "steps": spec["steps"],
        "seed": spec["seed"],
        "peak_vram_gb": peak_vram_gb,
        "sha256": hashlib.sha256(png_bytes).hexdigest(),
        "image_base64": base64.b64encode(png_bytes).decode("ascii"),
        "duration_ms": int((time.monotonic() - started) * 1000),
    }


@app.get("/health")
async def health():
    return {
        "status": _state["status"],
        "error": _state["error"],
        "model": MODEL_ID,
        "offload": _state["offload"],
        "device": _state["device"],
        "cuda_available": torch.cuda.is_available(),
        "busy": _busy.is_set(),
    }


@app.post("/generate")
async def generate(request: GenerateRequest):
    return await _execute(request)


@app.post("/edit")
async def edit(request: EditRequest):
    image = _decode_image(request.image_base64)
    return await _execute(request, edit_image=image)
