# Turn Zotero annotations into a cited literature note

Your reading history includes your own questions and disagreements. Zoteus can index child notes and PDF annotations under their parent items. These are included by default when the index is built; [check coverage first](./search-readiness.md).

## Find your own words

> Search my selected Zotero library for my notes and annotations about "[topic]". Separate my comments from highlighted author text. Include the parent paper and item key for each hit. Show any missing annotation coverage.

To see every highlight on one paper or one collection at once, rather than search hits, ask for the digest:

> List my annotations on [paper or collection], grouped per paper, with page labels and my comments. Only the yellow and red ones.

That is `zotero_annotation_digest`, which only reads. To keep the list in Zotero as a note whose highlights still open the PDF at the right spot, ask to save it; `zotero_save_annotation_digest` writes it from the annotations themselves, so no quotation is retyped. See [Notes and annotation digests](./notes.md).

## Check the original passage

> For each relevant objection or decision, retrieve the surrounding passage from the original paper. Include its quotation and page locator. Keep my interpretation separate from the author's claim. Label anything supported only by an abstract or note.

Use [the first-passage checklist](./first-research-task.md) to verify the results. A highlight proves what you selected, not that your later interpretation is correct.

## Draft a cited note

> Draft a literature note with the research question, what these sources say, where I agree or disagree, and unresolved questions. Attach a quotation and locator to factual claims. End with formatted references. Show the draft and intended Zotero parent item or collection before saving anything.

Expected structure, not a generated research finding:

- Research question
- Author's claim, source quotation and locator
- My comment or objection, clearly attributed to me
- Synthesis, with evidence gaps and uncertainty
- References from the selected library

After reviewing it, ask the assistant to save the approved text as a Zotero note. `zotero_create_note` takes the draft as Markdown and turns each `[@ITEMKEY, p. 12]` into a real Zotero citation, so the references in the note open their papers and become live fields when the note is added to Word; `zotero_append_to_note` adds to a note you already keep. Cloud writes need the appropriate key or OAuth permissions; group writes also require permission to edit that group. Refresh the index with `action:"update"` if the new note does not appear in indexed search.

[Connect a client](./getting-started.md) · [Research prompts](https://zoteus.com/docs/prompts/) · [Citations and bibliography styles](./citations.md)
