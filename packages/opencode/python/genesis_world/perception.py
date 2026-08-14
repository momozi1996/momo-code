"""
genesis_world.perception — CLIP-based semantic scene understanding.

Lazy-loads an openai/clip model via transformers (CPU-friendly, first
use downloads ~600 MB — set MOMO_CLIP_MODEL to override, or
HF_HUB_OFFLINE=1 to forbid downloads).

    from genesis_world import perception

    perception.label_image("/path/frame.png", ["a red cube", "a robot arm"])
    perception.label_camera("overhead", ["a red cube", "empty table"])

CPU inference is ~1s per call — use for LOW-FREQUENCY semantic
grounding, never in a tight control loop.
"""

import os

# Injected by the world server at init time.
WORLD = None

_CLIP = {"model": None, "processor": None}


def _load_clip():
    if _CLIP["model"] is not None:
        return _CLIP["model"], _CLIP["processor"]
    from transformers import CLIPModel, CLIPProcessor

    name = os.environ.get("MOMO_CLIP_MODEL", "openai/clip-vit-base-patch32")
    model = CLIPModel.from_pretrained(name)
    processor = CLIPProcessor.from_pretrained(name)
    model.eval()
    _CLIP["model"] = model
    _CLIP["processor"] = processor
    return model, processor


def label_image(image_path, candidate_labels, top_k=None):
    """
    Zero-shot classify an image against candidate text labels.
    Returns [{"label": str, "score": float}, ...] sorted by score desc.
    """
    import torch
    from PIL import Image

    if not candidate_labels:
        raise ValueError("candidate_labels must be a non-empty list")

    model, processor = _load_clip()
    image = Image.open(image_path).convert("RGB")
    inputs = processor(
        text=list(candidate_labels), images=image, return_tensors="pt", padding=True
    )
    with torch.no_grad():
        outputs = model(**inputs)
    probs = outputs.logits_per_image.softmax(dim=1)[0]

    ranked = sorted(
        (
            {"label": label, "score": round(float(probs[i]), 4)}
            for i, label in enumerate(candidate_labels)
        ),
        key=lambda x: -x["score"],
    )
    return ranked[:top_k] if top_k else ranked


def label_camera(camera_name, candidate_labels, top_k=None):
    """Snapshot a registered world camera and label the frame."""
    from genesis_world import sensors

    paths = sensors.snapshot(camera_name)
    return {
        "frame": paths["rgb"],
        "labels": label_image(paths["rgb"], candidate_labels, top_k=top_k),
    }
