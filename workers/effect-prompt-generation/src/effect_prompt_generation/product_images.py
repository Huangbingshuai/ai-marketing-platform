from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError


class ProductImageProcessingError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class PreparedProductImage:
    data_uri: str


class ProductImageProcessor:
    """Validate and bound trusted product-image bytes before an Ark request."""

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

    def process(self, content: bytes) -> PreparedProductImage:
        if len(content) > self._max_input_bytes:
            raise ProductImageProcessingError("商品参考图超过允许的文件大小")
        try:
            with Image.open(BytesIO(content)) as opened:
                opened.verify()
            with Image.open(BytesIO(content)) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
                image.thumbnail(
                    (self._max_dimension, self._max_dimension),
                    Image.Resampling.LANCZOS,
                )
                encoded = self._encode_bounded(image)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ProductImageProcessingError("商品参考图无效或不安全") from exc
        return PreparedProductImage(
            data_uri="data:image/jpeg;base64,"
            + base64.b64encode(encoded).decode("ascii"),
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
                raise ProductImageProcessingError("商品参考图无法压缩到安全大小")
            image.thumbnail(
                (max(256, int(width * 0.8)), max(256, int(height * 0.8))),
                Image.Resampling.LANCZOS,
            )
            quality = 76
