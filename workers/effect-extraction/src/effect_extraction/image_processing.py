from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

IMAGE_PREPROCESS_VERSION = "jpeg-lanczos-v2"


class ImageProcessingError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ProcessedImage:
    data_uri: str
    metadata: dict[str, int | str]


class ImageProcessor:
    def __init__(
        self,
        *,
        max_input_bytes: int,
        max_dimension: int,
        max_output_bytes: int,
    ) -> None:
        self._max_input_bytes = max_input_bytes
        self._max_dimension = max_dimension
        self._max_output_bytes = max_output_bytes

    def process(self, content: bytes) -> ProcessedImage:
        if len(content) > self._max_input_bytes:
            raise ImageProcessingError(
                f"image exceeds configured size limit ({len(content)} bytes)"
            )
        try:
            with Image.open(BytesIO(content)) as opened:
                opened.verify()
            with Image.open(BytesIO(content)) as opened:
                original_format = opened.format or "UNKNOWN"
                original_width, original_height = opened.size
                image = ImageOps.exif_transpose(opened).convert("RGB")
                image.thumbnail((self._max_dimension, self._max_dimension), Image.Resampling.LANCZOS)
                encoded = self._encode_bounded(image)
                processed_width, processed_height = image.size
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ImageProcessingError("invalid or unsafe image") from exc
        return ProcessedImage(
            data_uri="data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii"),
            metadata={
                "originalFormat": original_format,
                "originalWidth": original_width,
                "originalHeight": original_height,
                "processedFormat": "JPEG",
                "processedWidth": processed_width,
                "processedHeight": processed_height,
                "inputBytes": len(content),
                "processedBytes": len(encoded),
                "processedSha256": hashlib.sha256(encoded).hexdigest(),
                "preprocessVersion": IMAGE_PREPROCESS_VERSION,
            },
        )

    def _encode_bounded(self, image: Image.Image) -> bytes:
        quality = 88
        while True:
            output = BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True)
            value = output.getvalue()
            if len(value) <= self._max_output_bytes:
                return value
            if quality > 52:
                quality -= 8
                continue
            width, height = image.size
            if width <= 256 and height <= 256:
                raise ImageProcessingError("image cannot be reduced below output size limit")
            image.thumbnail(
                (max(256, int(width * 0.8)), max(256, int(height * 0.8))),
                Image.Resampling.LANCZOS,
            )
            quality = 76
