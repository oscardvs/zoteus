---
name: evidence-table
description: Compare several sources in the user's Zotero library on one research question, write a cited literature review, or audit a draft's citations, backed by passages retrieved from the PDFs. Use when the user asks to compare studies, synthesize what their papers say about a topic, build an evidence or literature table, or check whether their citations support their claims.
---

# Compare sources, review a topic, or audit citations from the Zotero library

These steps use the Zoteus tools, named `zotero_*`. The rule that holds throughout: every quotation and page comes from a `zotero_get_fulltext` call made in this conversation. A table built from search snippets looks the same as a real one and cannot be cited.

## Evidence table

1. **Choose the studies.** Default to at most 5 unless the user asks for more; each costs one full-text call.
   - Given item keys: call `zotero_get_item` on each for the title, creators and date, and search for nothing else.
   - Given a collection: resolve its name to a key with `zotero_list_collections`, then call `zotero_search_items` with `collectionKey` and `top:true` so child notes and attachments do not become rows. `zotero_semantic_search` cannot be scoped to a collection.
   - Otherwise: `zotero_semantic_search` with `q` set to the question, falling back to `zotero_search_items` with `top:true` when meaning search is unavailable.
2. **Retrieve one passage per study.** Call `zotero_get_fulltext` with the item key and `query` set to the question, one item at a time. Take the quotation verbatim from `passages[0].text`. Use `page` when it is present and `pageApprox` otherwise, and keep that distinction in the table. When neither is present, leave the locator empty and say so.
3. **Classify coverage from what the tools returned.** Use `passage` when a passage came back, `abstract-only` when only `zotero_get_item` returned an `abstractNote`, and `unavailable` when neither did.
4. **Judge support.** The finding and the support rating are your judgement, so word them as judgement. Rate support as `supported`, `contradicted`, `uncertain` or `unverified`. A row with no retrieved passage is `unverified`, never blank and never `supported`.
5. **Render with the tool.** Pass the question and one row per study to `zotero_evidence_table` with `format` set to `"markdown"` or `"csv"`. Do not type the table out yourself: the tool counts the coverage summary from the rows and names any row that contradicts its own evidence. Repeat its warnings as given. Fix the row or leave the gap visible, and never edit a quotation to silence a warning. Pass `save_path` only if the user asked for a file.
6. **Add the references** for the same item keys with `zotero_bibliography`.
7. **Ask before saving anything into the library.**

## Literature review

Find the relevant items as in step 1. Retrieve passages for the key papers as in step 2 before making factual claims. Synthesize the themes, agreements, contradictions and gaps. Label each claim as passage-supported, abstract-only or unverified, and end with a bibliography from `zotero_bibliography` or `zotero_format_bibliography`. A summary built only from abstracts must say so.

## Citation audit

For each work a draft cites:

1. Check that it exists with `zotero_search_items`, or `zotero_scholar` with `action:"lookup"` and the DOI when it is not in the library.
2. Retrieve the passage behind the claim with `zotero_get_fulltext`.
3. Report the quotation, the locator, the coverage and a support rating.

Flag cited works missing from the library. Use `zotero_scholar` with `action:"references"` or `action:"citations"` to point to relevant work the draft leaves out. `zotero_scholar` with `action:"notices"` reports retractions, corrections and expressions of concern filed against a DOI: pass those on as records with their source, not as a verdict. That a work exists in Zotero is never evidence that the draft's claim about it is right.
