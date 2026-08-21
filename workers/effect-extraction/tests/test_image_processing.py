from io import BytesIO

from PIL import Image

from effect_extraction.image_processing import ImageProcessor


def test_image_processor_bounds_dimensions_and_returns_data_uri() -> None:
    source = BytesIO()
    Image.new("RGBA", (3200, 1600), (255, 0, 0, 128)).save(source, format="PNG")
    processed = ImageProcessor(
        max_input_bytes=10 * 1024 * 1024,
        max_dimension=1024,
        max_output_bytes=512 * 1024,
    ).process(source.getvalue())
    assert processed.data_uri.startswith("data:image/jpeg;base64,")
    assert processed.metadata["processedWidth"] == 1024
    assert processed.metadata["processedHeight"] == 512
    assert int(processed.metadata["processedBytes"]) <= 512 * 1024
