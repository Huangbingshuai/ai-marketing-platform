from effect_template_mix.video import uniform_timestamps


def test_uniform_timestamps_are_bounded_and_capped_at_twelve() -> None:
    values = uniform_timestamps(6, 99)
    assert len(values) == 12
    assert values[0] == 0.25
    assert values[-1] == 5.75
    assert all(0 <= value < 6 for value in values)
