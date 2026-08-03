from pathlib import Path


INTEGRATION_ROOT = Path(__file__).parents[1] / "custom_components" / "home_status"
TEXT_SUFFIXES = {".html", ".js", ".json", ".md", ".py", ".yaml", ".yml"}
MOJIBAKE_MARKERS = ("â", "Ã", "Â", "�")


def test_integration_source_contains_no_common_mojibake():
    offenders = []
    for path in INTEGRATION_ROOT.rglob("*"):
        if not path.is_file() or path.suffix.casefold() not in TEXT_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8")
        markers = sorted({marker for marker in MOJIBAKE_MARKERS if marker in text})
        if markers:
            offenders.append(f"{path.relative_to(INTEGRATION_ROOT)}: {''.join(markers)}")

    assert offenders == [], "Mojibake found in integration source:\n" + "\n".join(offenders)
