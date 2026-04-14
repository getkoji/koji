"""Document integrity check — fail-fast intake validation.

Runs before a document ever reaches the parse service or the LLM. Catches
garbage inputs (wrong file type, corrupted headers, empty files, oversized
files, too-many-pages documents) up front so the user gets a useful error
instead of an obscure docling traceback or a surprise bill.

All checks are pure Python and cost nothing. Size and page limits are
schema-declared and optional; header/extension validation is always on.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


class IntegrityError(ValueError):
    """Raised when a document fails an intake integrity check.

    Carries a human-readable reason that is safe to surface directly to the
    user. The server maps this to HTTP 400.
    """


# ── Known types ─────────────────────────────────────────────────────
# Map canonical short name → (extensions, magic byte prefixes).
# Magic prefixes are checked against the first bytes of the file. An empty
# prefix list means "don't magic-check" (plain-text formats with no header).

_KNOWN_TYPES: dict[str, tuple[tuple[str, ...], tuple[bytes, ...]]] = {
    "pdf": ((".pdf",), (b"%PDF-",)),
    "docx": ((".docx",), (b"PK\x03\x04",)),
    "xlsx": ((".xlsx",), (b"PK\x03\x04",)),
    "pptx": ((".pptx",), (b"PK\x03\x04",)),
    "png": ((".png",), (b"\x89PNG\r\n\x1a\n",)),
    "jpg": ((".jpg", ".jpeg"), (b"\xff\xd8\xff",)),
    "tiff": ((".tif", ".tiff"), (b"II*\x00", b"MM\x00*")),
    "html": ((".html", ".htm"), ()),
    "md": ((".md", ".markdown"), ()),
    "txt": ((".txt",), ()),
}

_EXT_TO_TYPE: dict[str, str] = {ext: name for name, (exts, _) in _KNOWN_TYPES.items() for ext in exts}


@dataclass(frozen=True)
class IntakeLimits:
    """Limits declared by a schema's `intake:` block."""

    max_size_mb: float | None = None
    max_pages: int | None = None
    allowed_types: tuple[str, ...] | None = None

    @classmethod
    def from_schema(cls, schema_def: dict | None) -> IntakeLimits:
        if not schema_def:
            return cls()
        raw = schema_def.get("intake") or {}
        if not isinstance(raw, dict):
            return cls()

        max_size = raw.get("max_size_mb")
        if not isinstance(max_size, (int, float)) or max_size <= 0:
            max_size = None

        max_pages = raw.get("max_pages")
        if not isinstance(max_pages, int) or max_pages <= 0:
            max_pages = None

        allowed = raw.get("allowed_types")
        if isinstance(allowed, list) and allowed:
            allowed_tuple: tuple[str, ...] | None = tuple(str(t).lower() for t in allowed)
        else:
            allowed_tuple = None

        return cls(max_size_mb=max_size, max_pages=max_pages, allowed_types=allowed_tuple)


def _extension_type(filename: str | None) -> tuple[str | None, str]:
    """Return (canonical-type, extension) for a filename. Both may be None/''.

    Canonical type is `None` when the extension isn't in the supported set.
    """
    if not filename:
        return None, ""
    ext = Path(filename).suffix.lower()
    return _EXT_TO_TYPE.get(ext), ext


def check_bytes(
    content: bytes,
    filename: str | None,
    limits: IntakeLimits | None = None,
) -> None:
    """Validate raw file bytes before parsing.

    Raises `IntegrityError` with a user-facing message on failure. Always
    runs extension + magic-byte validation; size and allowed-type checks
    only fire when the schema declared limits.
    """
    if content is None or len(content) == 0:
        raise IntegrityError("File is empty (0 bytes).")

    ext_type, ext = _extension_type(filename)

    if ext_type is None:
        if not ext:
            raise IntegrityError("File has no extension — cannot determine document type.")
        raise IntegrityError(f"Unsupported file type '{ext}'. Supported: {', '.join(sorted(_EXT_TO_TYPE))}.")

    if limits and limits.allowed_types and ext_type not in limits.allowed_types:
        allowed = ", ".join(limits.allowed_types)
        raise IntegrityError(f"File type '{ext_type}' is not allowed by this schema. Allowed: {allowed}.")

    if limits and limits.max_size_mb is not None:
        size_mb = len(content) / (1024 * 1024)
        if size_mb > limits.max_size_mb:
            raise IntegrityError(f"File is {size_mb:.1f} MB, exceeds schema limit of {limits.max_size_mb} MB.")

    _, prefixes = _KNOWN_TYPES[ext_type]
    if prefixes and not any(content.startswith(p) for p in prefixes):
        raise IntegrityError(
            f"File extension is '{ext}' but the file's header does not match "
            f"a valid {ext_type.upper()}. The file may be corrupted or "
            f"mislabeled."
        )


def check_parsed(
    page_count: int | None,
    limits: IntakeLimits | None = None,
) -> None:
    """Validate post-parse output before extraction.

    Ensures the parser produced at least one page and, when the schema
    declares a `max_pages` limit, that the document is within it.
    """
    pages = page_count or 0
    if pages < 1:
        raise IntegrityError("Parser produced zero pages — the file is unreadable or corrupted.")

    if limits and limits.max_pages is not None and pages > limits.max_pages:
        raise IntegrityError(f"Document has {pages} pages, exceeds schema limit of {limits.max_pages}.")
