"""Document tools for the extraction agent."""

from __future__ import annotations

import re


class DocumentTools:
    """Tools the LLM can call to search and read the document."""

    def __init__(self, markdown: str):
        self.markdown = markdown
        self.sections = self._parse_sections()

    def _parse_sections(self) -> list[dict]:
        """Split markdown into sections by headers."""
        sections = []
        current_title = "Document Start"
        current_lines: list[str] = []

        for line in self.markdown.split("\n"):
            if line.startswith("#"):
                if current_lines:
                    sections.append({
                        "title": current_title,
                        "content": "\n".join(current_lines).strip(),
                    })
                current_title = line.lstrip("#").strip()
                current_lines = []
            else:
                current_lines.append(line)

        if current_lines:
            sections.append({
                "title": current_title,
                "content": "\n".join(current_lines).strip(),
            })

        return sections

    def list_sections(self) -> str:
        """Return a numbered list of document sections."""
        if not self.sections:
            return "No sections found."
        lines = []
        for i, sec in enumerate(self.sections):
            preview = sec["content"][:100].replace("\n", " ")
            lines.append(f"{i}: {sec['title']} — {preview}...")
        return "\n".join(lines)

    def read_section(self, section_index: int) -> str:
        """Read the full content of a section by index."""
        if section_index < 0 or section_index >= len(self.sections):
            return f"Invalid section index. Valid range: 0-{len(self.sections) - 1}"
        sec = self.sections[section_index]
        return f"## {sec['title']}\n\n{sec['content']}"

    def grep(self, pattern: str) -> str:
        """Search the document for a pattern. Returns matching lines with context."""
        results = []
        lines = self.markdown.split("\n")
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error:
            # Fall back to literal search if regex is invalid
            regex = re.compile(re.escape(pattern), re.IGNORECASE)

        for i, line in enumerate(lines):
            if regex.search(line):
                # Include 2 lines of context before and after
                start = max(0, i - 2)
                end = min(len(lines), i + 3)
                context = "\n".join(lines[start:end])
                results.append(f"[line {i + 1}]\n{context}")

        if not results:
            return f"No matches found for '{pattern}'."
        # Limit results to avoid overwhelming context
        if len(results) > 10:
            results = results[:10]
            results.append(f"... and more matches (showing first 10)")
        return "\n\n---\n\n".join(results)

    def read_range(self, start_line: int, end_line: int) -> str:
        """Read a range of lines from the document."""
        lines = self.markdown.split("\n")
        start = max(0, start_line - 1)  # 1-indexed input
        end = min(len(lines), end_line)
        if start >= end:
            return "Invalid range."
        return "\n".join(lines[start:end])

    # Tool definitions for ollama's tool calling format
    @staticmethod
    def tool_definitions() -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "list_sections",
                    "description": "List all sections/headers in the document with a short preview of each. Use this first to understand the document structure.",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "required": [],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_section",
                    "description": "Read the full content of a specific section by its index number. Use after list_sections to read promising sections.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "section_index": {
                                "type": "integer",
                                "description": "The section index from list_sections.",
                            },
                        },
                        "required": ["section_index"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "grep",
                    "description": "Search the document for a text pattern (case-insensitive). Returns matching lines with surrounding context. Use to find specific values like policy numbers, names, dates.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "pattern": {
                                "type": "string",
                                "description": "The search pattern (text or regex).",
                            },
                        },
                        "required": ["pattern"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_range",
                    "description": "Read a specific range of lines from the document. Use when you found something via grep and need more context.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "start_line": {
                                "type": "integer",
                                "description": "Starting line number (1-indexed).",
                            },
                            "end_line": {
                                "type": "integer",
                                "description": "Ending line number (inclusive).",
                            },
                        },
                        "required": ["start_line", "end_line"],
                    },
                },
            },
        ]

    def call_tool(self, name: str, arguments: dict) -> str:
        """Dispatch a tool call by name."""
        if name == "list_sections":
            return self.list_sections()
        elif name == "read_section":
            return self.read_section(arguments.get("section_index", 0))
        elif name == "grep":
            return self.grep(arguments.get("pattern", ""))
        elif name == "read_range":
            return self.read_range(
                arguments.get("start_line", 1),
                arguments.get("end_line", 10),
            )
        else:
            return f"Unknown tool: {name}"
