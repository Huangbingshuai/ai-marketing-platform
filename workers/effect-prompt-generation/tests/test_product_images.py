from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image

from effect_prompt_generation.product_images import (
    ProductImageProcessingError,
    ProductImageProcessor,
)


def _png_bytes(size: tuple[int, int] = (1600, 900)) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, color=(126, 132, 140)).save(output, format="PNG")
    return output.getvalue()


def test_product_image_processor_verifies_bounds_and_emits_jpeg_data_uri() -> None:
    processor = ProductImageProcessor(
        max_input_bytes=2_000_000,
        max_dimension=640,
        max_output_bytes=500_000,
    )

    processed = processor.process(_png_bytes())

    assert processed.data_uri.startswith("data:image/jpeg;base64,")


def test_product_image_processor_rejects_invalid_content() -> None:
    processor = ProductImageProcessor(
        max_input_bytes=1024,
        max_dimension=640,
        max_output_bytes=500_000,
    )

    with pytest.raises(ProductImageProcessingError, match="无效或不安全"):
        processor.process(b"not-an-image")
