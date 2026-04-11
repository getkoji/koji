"""Smoke test — verifies the test infrastructure works."""

from tests.conftest import MockProvider, make_chunk, make_field_route


def test_mock_provider_is_importable():
    provider = MockProvider(responses=['{"ok": true}'])
    assert provider.responses == ['{"ok": true}']


def test_make_chunk():
    chunk = make_chunk(index=3, title="Declarations", category="declarations")
    assert chunk.index == 3
    assert chunk.category == "declarations"


def test_make_field_route():
    route = make_field_route(field_name="policy_number", source="hint")
    assert route.field_name == "policy_number"
    assert route.source == "hint"


async def test_mock_provider_generate():
    provider = MockProvider(responses=['{"x": 1}', '{"y": 2}'])
    r1 = await provider.generate("prompt 1")
    r2 = await provider.generate("prompt 2")
    assert r1 == '{"x": 1}'
    assert r2 == '{"y": 2}'
    assert len(provider.calls) == 2


async def test_mock_provider_exhausted():
    provider = MockProvider(responses=['{"x": 1}'])
    await provider.generate("first")
    r = await provider.generate("second")
    assert r == "{}"
