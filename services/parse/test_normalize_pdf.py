"""Tests for the /normalize-pdf endpoint (oss-377).

The parse service imports docling/fastapi at module load, so these are skipped
in environments without those heavy deps (e.g. the playbook CLI CI) and run in
the parse service's own test image.

The fixture is a 20-page PDF with the classic owner-password encryption (empty
user password, Standard handler R=2) and an object-stream page tree — the
real-world class pdf-lib cannot read (it skips decryption, so the compressed
object streams never inflate). pypdfium2 decrypts it transparently; the
endpoint re-saves it with FPDF_REMOVE_SECURITY into a plain PDF. Each page
carries a "Fixture page N" text object so content fidelity is asserted, not
just structure. See the generation recipe in
api/src/parse/encrypted-pdf.fixture.ts.
"""

import base64
import io
import sys
from pathlib import Path

import pytest

pytest.importorskip("docling")
pytest.importorskip("fastapi")
pytest.importorskip("sse_starlette")
pytest.importorskip("httpx")

import pypdfium2 as pdfium  # noqa: E402
import pypdfium2.raw as pdfium_c  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
import main  # noqa: E402

ENCRYPTED_OBJSTM_PDF_B64 = (
    "JVBERi0xLjUKJb/3ov4KMSAwIG9iago8PCAvUGFnZXMgMyAwIFIgL1R5cGUgL0NhdGFsb2cgPj4KZW5kb2JqCjIg"
    "MCBvYmoKPDwgL1R5cGUgL09ialN0bSAvTGVuZ3RoIDM0NSAvRmlsdGVyIC9GbGF0ZURlY29kZSAvTiAyMiAvRmly"
    "c3QgMTU4ID4+CnN0cmVhbQqQ76QwMMYtIyfSOEAe3j3WpgvH95FT9FIiSGm6MAoRO7kJBlmvztGgp0/pw36ppiMJ"
    "LhaLwmCKqZyknH5ih75lsM3mujgeAJnzCuAwKh+7r/cSsqAnlWsdxC1ECubLIQPCeKn8p6OQGc9rsZh127qgrzK0"
    "LBSn6rjgXcXIsT6/UOCNLfB416UG+PEREWI7jiFbcnEAwI/F90NYVetpBdb3sTCG9N1TRtrrYJN2EtnMEUoCQKP3"
    "sNoV3S4GjSduVd+IyLR92R8egf1DkWdv6GOKsS2ML4U1euec09nXFwGEuyePLTSKQl0LPt6iGRmVOOVYgyife2CJ"
    "5Msi9ihN/LYEE/Q6KtS++avDTPnRLNvH3xLvIZGnOf8T/gXTx/xhzYn+V98m+VQUSiOKfa5K9FIAuj07HyCXI6up"
    "KesVkfg1UcPBREDbdS9nh23AVV2WGCZcQ8P5Y4oG50gKZW5kc3RyZWFtCmVuZG9iagoyNSAwIG9iago8PCAvTGVu"
    "Z3RoIDUxIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQp1n7SsbJ96Gotsh+XwBYKcKBiEq7MI4iwd4zxG"
    "ogsVx3oHCwwMkmdy36FEjDEABf5jkqoKZW5kc3RyZWFtCmVuZG9iagoyNiAwIG9iago8PCAvTGVuZ3RoIDUxIC9G"
    "aWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQpW/kSSqQp+305zvwg04YJNKMpLq6CXCj74W7HlIG/Od9cwvXDC"
    "D5MybpKtq2okG30EDX4KZW5kc3RyZWFtCmVuZG9iagoyNyAwIG9iago8PCAvTGVuZ3RoIDUxIC9GaWx0ZXIgL0Zs"
    "YXRlRGVjb2RlID4+CnN0cmVhbQqV+ejJ+MkM/hbYSvhu1ecbdsQmt85ozSko0JjjAupZEbwHmNu4I441fh6Fj44G"
    "Tre7fSEKZW5kc3RyZWFtCmVuZG9iagoyOCAwIG9iago8PCAvTGVuZ3RoIDUxIC9GaWx0ZXIgL0ZsYXRlRGVjb2Rl"
    "ID4+CnN0cmVhbQq5I65187L7UKfp3nXkIefc+XWIkj7hmLp8DO1JN/esXbE5J3Ek2zwQbUusqDmeZI+QyWIKZW5k"
    "c3RyZWFtCmVuZG9iagoyOSAwIG9iago8PCAvTGVuZ3RoIDUxIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVh"
    "bQrofoIzMBOmQUQDw+hNsLNuOZTX7m+efgjUkEV7Z6itzdFxbwwlhHj2JTQa1jQsqMO9MH8KZW5kc3RyZWFtCmVu"
    "ZG9iagozMCAwIG9iago8PCAvTGVuZ3RoIDUxIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQobmgI8kWTP"
    "OPgk8tRLxsKp9f1F2cfEOWDKXxFke6PK04iwt5RvknC/GazbpxV/6CL2rc8KZW5kc3RyZWFtCmVuZG9iagozMSAw"
    "IG9iago8PCAvTGVuZ3RoIDUxIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQqUrRoMw3l3tmtlsW/Fsln6"
    "urmPZrRzNutkKdDMBUneWTU7tKxDcxNcOOjnQZ6cYfNRWaUKZW5kc3RyZWFtCmVuZG9iagozMiAwIG9iago8PCAv"
    "TGVuZ3RoIDUxIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQp71oic74/RiRs+WBoAHfMEj6FtSGYB9U+o"
    "1f4IIekT1YzYB90XxELEMSXdQDWNenjz66wKZW5kc3RyZWFtCmVuZG9iagozMyAwIG9iago8PCAvTGVuZ3RoIDUx"
    "IC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQrfb755Ty7bR+NDPW56j/GwBb5bNIAhe8yvKaM3nslXCT6z"
    "KfxwqUla52d+zMPAAdU+ZHgKZW5kc3RyZWFtCmVuZG9iagozNCAwIG9iago8PCAvTGVuZ3RoIDUyIC9GaWx0ZXIg"
    "L0ZsYXRlRGVjb2RlID4+CnN0cmVhbQo5jVUk9HGhAmkZX8Tcowv5jMmMx8XFmGiY3z7ja5XlooQl2EpkgeKjul2o"
    "Qt6s5J9jDyyQCmVuZHN0cmVhbQplbmRvYmoKMzUgMCBvYmoKPDwgL0xlbmd0aCA1MiAvRmlsdGVyIC9GbGF0ZURl"
    "Y29kZSA+PgpzdHJlYW0KCY0slrnOmwvWQiohN/kcqVsL/9bX/8/7gxdceDCOoWcPQCNH5Blv0es61woPHAgoLnzN"
    "CAplbmRzdHJlYW0KZW5kb2JqCjM2IDAgb2JqCjw8IC9MZW5ndGggNTEgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4K"
    "c3RyZWFtCpWN1W4Sks/ibtYpELuor8seGYT8Mm7akIhYKMvjj/7d65eegk0lnqaQXnXt9mhRre+QVwplbmRzdHJl"
    "YW0KZW5kb2JqCjM3IDAgb2JqCjw8IC9MZW5ndGggNTIgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4Kc3RyZWFtCgzR"
    "S5w9yXTybmh3olKxVZjV9cnVc4Mb5uw1Ve9nlt1qQ0aZh3YGcKDJJ7dZi+6vISAuE+cKZW5kc3RyZWFtCmVuZG9i"
    "agozOCAwIG9iago8PCAvTGVuZ3RoIDUyIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQqjwc2oYFMnsC68"
    "B6ZIHMTU8qwlclb6YLmdVMv8emi9Yfq7h4Ojs+31zvAVO+4y1c+kfSpQCmVuZHN0cmVhbQplbmRvYmoKMzkgMCBv"
    "YmoKPDwgL0xlbmd0aCA1MiAvRmlsdGVyIC9GbGF0ZURlY29kZSA+PgpzdHJlYW0Ko9WoxBzEqoSp6Qq2fsx3wXxC"
    "loMZF7H72X9IfmVgxTD/oo69VQbuOZsPFRdf3qouT4nG2QplbmRzdHJlYW0KZW5kb2JqCjQwIDAgb2JqCjw8IC9M"
    "ZW5ndGggNTIgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4Kc3RyZWFtCtP5VpUjC9lT9l/Vni1HrsAQuYgrhps33PB8"
    "hruEqEz8CQWI6tuVKcq5BsidcGbURBySVZUKZW5kc3RyZWFtCmVuZG9iago0MSAwIG9iago8PCAvTGVuZ3RoIDUy"
    "IC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQo7ocKL5DFnUk3hOp8ugreGsAsN7GWH5kUCI/P6K2pVuZSo"
    "XG4pINUVrcYHCzNXhr/wEHMuCmVuZHN0cmVhbQplbmRvYmoKNDIgMCBvYmoKPDwgL0xlbmd0aCA1MiAvRmlsdGVy"
    "IC9GbGF0ZURlY29kZSA+PgpzdHJlYW0KbJQV8eNxZOKjWXKhWzV1B1IqJpYUGy64mxFX5/a737IxXx8HuuOmU9Hh"
    "KUx10rq+1LfxXwplbmRzdHJlYW0KZW5kb2JqCjQzIDAgb2JqCjw8IC9MZW5ndGggNTIgL0ZpbHRlciAvRmxhdGVE"
    "ZWNvZGUgPj4Kc3RyZWFtCt94QcLfc61I9pn2zCqTGhKD0V4BmKjv9QbkON8X9FhfTh7KRoq+Lo1/SWufUrewSjOo"
    "guUKZW5kc3RyZWFtCmVuZG9iago0NCAwIG9iago8PCAvTGVuZ3RoIDUyIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+"
    "CnN0cmVhbQpvIxv/H9QiXt17zmPtFE53JlpLtLoGTL/vHy2AutPvP0Ke1tS+16fohsOj/PiQ5JGm3jPOCmVuZHN0"
    "cmVhbQplbmRvYmoKNDUgMCBvYmoKPDwgL0ZpbHRlciAvU3RhbmRhcmQgL0xlbmd0aCA0MCAvTyA8ZDAxNTdhYWQ1"
    "YmI2MDNhOGQwMWZkNGVlZDRiNjdmMWNiMmIyNDgzNTM3MWZmN2M3NDUwZDQwZTM3MGZhZDYxND4gL1AgLTEyIC9S"
    "IDIgL1UgPGYwNzkxYzEzOGViMjYxMjIwMzIzMmFhNWEzYzNmM2UwMzg4MzEwMjc3NmRmZDdmNzcxYTZhYzA1OGYw"
    "MDM5ZTQ+IC9WIDEgPj4KZW5kb2JqCjQ2IDAgb2JqCjw8IC9UeXBlIC9YUmVmIC9MZW5ndGggNTUgL0ZpbHRlciAv"
    "RmxhdGVEZWNvZGUgL0RlY29kZVBhcm1zIDw8IC9Db2x1bW5zIDQgL1ByZWRpY3RvciAxMiA+PiAvVyBbIDEgMiAx"
    "IF0gL1Jvb3QgMSAwIFIgL1NpemUgNDcgL0lEIFs8YjI3YmMzNDM0NTQ3YWQwYzAzODhjMDUwOGI4NDZiZmE+PGIy"
    "N2JjMzQzNDU0N2FkMGMwMzg4YzA1MDhiODQ2YmZhPl0gL0VuY3J5cHQgNDUgMCBSID4+CnN0cmVhbQp4nGNiAAIm"
    "RgZ+BiYGBkMQ6xCIxcBIF+I/07/XQFY1A5RgJIJVA2LVwMVqUMVwsi4wAABhsw7iCmVuZHN0cmVhbQplbmRvYmoK"
    "c3RhcnR4cmVmCjMxOTAKJSVFT0YK"
)

ENCRYPTED_OBJSTM_PDF = base64.b64decode("".join(ENCRYPTED_OBJSTM_PDF_B64))


class TestNormalizePdf:
    def setup_method(self):
        self.client = TestClient(main.app)

    def test_normalizes_encrypted_objstm_pdf(self):
        # Sanity: the fixture really is live-encrypted (R=2 Standard handler).
        src = pdfium.PdfDocument(ENCRYPTED_OBJSTM_PDF)
        assert pdfium_c.FPDF_GetSecurityHandlerRevision(src.raw) == 2

        resp = self.client.post(
            "/normalize-pdf",
            files={"file": ("enc.pdf", ENCRYPTED_OBJSTM_PDF, "application/pdf")},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["pages"] == 20

        out = base64.b64decode(body["pdf_base64"])
        assert body["byte_size"] == len(out)
        assert out.startswith(b"%PDF")

        doc = pdfium.PdfDocument(out)
        assert len(doc) == 20
        # Security must be REMOVED, not merely restructured. A plain re-save
        # keeps encryption live: pdf-lib then slices "successfully" but copies
        # ciphertext content streams verbatim → blank pages downstream.
        assert pdfium_c.FPDF_GetSecurityHandlerRevision(doc.raw) == -1
        # Content fidelity: the decrypted text survives the re-save.
        assert doc[0].get_textpage().get_text_bounded() == "Fixture page 1"
        assert doc[19].get_textpage().get_text_bounded() == "Fixture page 20"

    def test_roundtrips_a_plain_pdf(self):
        plain = pdfium.PdfDocument.new()
        plain.new_page(612, 792)
        buf = io.BytesIO()
        plain.save(buf)
        resp = self.client.post(
            "/normalize-pdf",
            files={"file": ("plain.pdf", buf.getvalue(), "application/pdf")},
        )
        assert resp.status_code == 200
        assert resp.json()["pages"] == 1

    def test_unreadable_input_is_422(self):
        resp = self.client.post(
            "/normalize-pdf",
            files={"file": ("junk.pdf", b"not a pdf at all", "application/pdf")},
        )
        assert resp.status_code == 422
        assert "normalize failed" in resp.json()["error"]
