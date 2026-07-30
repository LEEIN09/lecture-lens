"""Persistent PP-OCRv5 worker for Lecture Lens.

The process accepts one JSON object per stdin line and emits protocol messages
prefixed with ``LECTURE_LENS_JSON:`` so Paddle's own logs cannot corrupt IPC.
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import sys
import traceback

import cv2
import numpy as np


PREFIX = "LECTURE_LENS_JSON:"


def emit(payload: dict) -> None:
    sys.stdout.write(PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_engine():
    from paddleocr import PaddleOCR

    return PaddleOCR(
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="korean_PP-OCRv5_mobile_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=os.environ.get("LECTURE_LENS_OCR_DEVICE", "cpu"),
        enable_mkldnn=False,
        # Editor text is usually only a few pixels high inside a Zoom frame.
        # Avoid the general-document default that can shrink a small crop.
        text_det_limit_side_len=640,
        text_det_limit_type="min",
        text_det_box_thresh=0.3,
        text_det_unclip_ratio=1.8,
    )


def decode_image(data_url: str) -> np.ndarray:
    marker = "base64,"
    if marker not in data_url:
        raise ValueError("PNG data URL이 아닙니다.")
    encoded = data_url.split(marker, 1)[1]
    buffer = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("캡처 이미지를 열 수 없습니다.")
    return image


def extract_blocks(result) -> list[dict]:
    payload = result.json
    values = payload.get("res", payload)
    texts = values.get("rec_texts", [])
    scores = values.get("rec_scores", [])
    boxes = values.get("rec_boxes", [])
    blocks = []
    for text, score, box in zip(texts, scores, boxes):
        blocks.append(
            {
                "text": str(text),
                "score": float(score),
                "box": [float(value) for value in box],
            }
        )
    return blocks


def main() -> None:
    # Paddle prints status messages during initialization. Keep stdout reserved
    # for our line protocol and forward diagnostic noise to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        engine = load_engine()
    emit({"type": "ready"})

    for raw_line in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            image = decode_image(request["dataUrl"])
            with contextlib.redirect_stdout(sys.stderr):
                results = list(engine.predict(image))
            blocks = extract_blocks(results[0]) if results else []
            emit({"type": "result", "id": request_id, "blocks": blocks})
        except Exception as error:  # Keep the worker alive after a bad frame.
            traceback.print_exc(file=sys.stderr)
            emit(
                {
                    "type": "error",
                    "id": request_id,
                    "message": str(error) or error.__class__.__name__,
                }
            )


if __name__ == "__main__":
    main()
