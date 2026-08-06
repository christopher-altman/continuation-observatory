from scripts.plot_window_dilution import extract_dilution, render_overlay


def test_extract_dilution_accepts_experiment_bundle_shape():
    dilution = {
        "schema_version": "window-dilution.v1",
        "model_id": "model-a",
        "rows": [],
    }
    assert extract_dilution({"results": {"window_dilution": dilution}}) is dilution


def test_render_overlay_writes_png_and_pdf(tmp_path):
    analysis = {
        "schema_version": "window-dilution.v1",
        "model_id": "model-a",
        "slope_gap_per_relevant_fraction": 0.5,
        "intercept": 0.1,
        "rows": [
            {
                "relevant_char_fraction": 0.2,
                "gap": 0.2,
                "gap_se": 0.01,
            },
            {
                "relevant_char_fraction": 0.8,
                "gap": 0.5,
                "gap_se": 0.02,
            },
        ],
    }
    png_path, pdf_path = render_overlay([analysis], tmp_path / "overlay")
    assert png_path.is_file()
    assert pdf_path.is_file()
