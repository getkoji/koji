"""Tests for services/extract/classify.py — keyword classification and filtering.

Tests supply their own keyword rules and relevant categories — the module
itself holds no document-type defaults (see docs/schemas on how schemas
declare categories).
"""

from __future__ import annotations

from services.extract.classify import (
    classify_by_keywords,
    filter_relevant,
)

# Fixture: rules a user might declare in an insurance-policy schema's
# `categories.keywords` block. These are test data, not engine defaults.
INSURANCE_RULES = [
    (["declaration", "dec page", "named insured", "policy period"], "declarations"),
    (["schedule of", "coverage schedule", "limits of"], "schedule_of_coverages"),
    (["endorsement", "amendment", "rider"], "endorsement"),
    (["conditions", "general conditions", "policy conditions"], "conditions"),
    (["definitions", "defined terms", "as used in"], "definitions"),
    (["exclusion", "does not apply", "we will not"], "exclusions"),
    (["table of contents", "index"], "table_of_contents"),
]
INSURANCE_RELEVANT = {"declarations", "schedule_of_coverages", "endorsement"}


# ── classify_by_keywords ─────────────────────────────────────────────


class TestClassifyByKeywords:
    def test_declarations_by_title(self):
        chunk = {"title": "Declarations Page", "content": "Some content"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "declarations"

    def test_declarations_by_named_insured_title(self):
        chunk = {"title": "Named Insured", "content": "Acme Corp"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "declarations"

    def test_declarations_by_policy_period_title(self):
        chunk = {"title": "Policy Period", "content": "01/01/2025 to 01/01/2026"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "declarations"

    def test_endorsement_by_title(self):
        chunk = {"title": "Endorsement 1", "content": "modifies something"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "endorsement"

    def test_rider_by_title(self):
        chunk = {"title": "Rider A", "content": "additional coverage"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "endorsement"

    def test_conditions_by_title(self):
        chunk = {"title": "General Conditions", "content": "stuff"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "conditions"

    def test_definitions_by_title(self):
        chunk = {"title": "Definitions", "content": "terms"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "definitions"

    def test_exclusions_by_title(self):
        chunk = {"title": "Exclusions", "content": "not covered"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "exclusions"

    def test_schedule_by_title(self):
        chunk = {"title": "Schedule of Coverages", "content": "table"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "schedule_of_coverages"

    def test_table_of_contents_by_title(self):
        chunk = {"title": "Table of Contents", "content": "page 1"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "table_of_contents"

    def test_content_match_two_keywords(self):
        chunk = {"title": "Section X", "content": "declaration and named insured info"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "declarations"

    def test_no_match_returns_none(self):
        chunk = {"title": "Random Section", "content": "Nothing special here at all"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) is None

    def test_ambiguous_title_no_keyword(self):
        chunk = {"title": "Additional Information", "content": "Some extra details"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) is None

    def test_single_content_keyword_not_enough(self):
        chunk = {"title": "Other", "content": "This is about an amendment"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) is None

    def test_case_insensitive_title(self):
        chunk = {"title": "DECLARATIONS", "content": "content"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "declarations"

    def test_partial_keyword_in_title(self):
        chunk = {"title": "Policy Conditions Apply", "content": "stuff"}
        assert classify_by_keywords(chunk, INSURANCE_RULES) == "conditions"

    def test_empty_rules_returns_none(self):
        chunk = {"title": "Declarations", "content": "content"}
        assert classify_by_keywords(chunk, []) is None

    def test_domain_agnostic_rules(self):
        # Same mechanism works for any domain the schema author wants.
        recipe_rules = [
            (["ingredients", "you will need"], "ingredients"),
            (["directions", "instructions", "method"], "directions"),
        ]
        assert classify_by_keywords({"title": "Ingredients", "content": ""}, recipe_rules) == "ingredients"
        assert classify_by_keywords({"title": "Method", "content": ""}, recipe_rules) == "directions"
        assert classify_by_keywords({"title": "Nutrition", "content": ""}, recipe_rules) is None


# ── filter_relevant ───────────────────────────────────────────────────


class TestFilterRelevant:
    def test_filters_to_relevant_categories(self):
        chunks = [
            {"title": "Dec", "content": "c", "category": "declarations"},
            {"title": "Exc", "content": "c", "category": "exclusions"},
            {"title": "Sch", "content": "c", "category": "schedule_of_coverages"},
            {"title": "End", "content": "c", "category": "endorsement"},
            {"title": "Def", "content": "c", "category": "definitions"},
            {"title": "Oth", "content": "c", "category": "other"},
        ]
        filtered = filter_relevant(chunks, INSURANCE_RELEVANT)
        categories = {c["category"] for c in filtered}
        assert categories == {"declarations", "schedule_of_coverages", "endorsement"}
        assert len(filtered) == 3

    def test_custom_relevant_set(self):
        chunks = [
            {"title": "A", "content": "c", "category": "definitions"},
            {"title": "B", "content": "c", "category": "other"},
        ]
        filtered = filter_relevant(chunks, {"definitions"})
        assert len(filtered) == 1
        assert filtered[0]["category"] == "definitions"

    def test_empty_input(self):
        assert filter_relevant([], INSURANCE_RELEVANT) == []

    def test_no_relevant_chunks(self):
        chunks = [
            {"title": "A", "content": "c", "category": "other"},
            {"title": "B", "content": "c", "category": "definitions"},
        ]
        assert filter_relevant(chunks, INSURANCE_RELEVANT) == []

    def test_empty_relevant_set_returns_empty(self):
        chunks = [{"title": "A", "content": "c", "category": "declarations"}]
        assert filter_relevant(chunks, set()) == []
