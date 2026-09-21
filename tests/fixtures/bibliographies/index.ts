import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The bibliography fixtures, as files on disk rather than as strings in a test.
 *
 * They are files because two of the things under test are about files: the `path` argument
 * and its confinement on a shared server. A string constant would test neither.
 */

export const BIBTEX_FIXTURE_PATH = fileURLToPath(new URL('./awkward.bib', import.meta.url));
export const RIS_FIXTURE_PATH = fileURLToPath(new URL('./awkward.ris', import.meta.url));

export const BIBTEX_FIXTURE = readFileSync(BIBTEX_FIXTURE_PATH, 'utf8');
export const RIS_FIXTURE = readFileSync(RIS_FIXTURE_PATH, 'utf8');

/** A small CSL-JSON payload, including the two date shapes and a literal name. */
export const CSLJSON_FIXTURE = JSON.stringify([
  {
    id: 'hoare1978',
    type: 'article-journal',
    title: 'Communicating Sequential Processes',
    'container-title': 'Communications of the ACM',
    volume: '21',
    issue: '8',
    page: '666-677',
    DOI: '10.1145/359576.359585',
    issued: { 'date-parts': [[1978, 8]] },
    author: [{ family: 'Hoare', given: 'C. A. R.' }],
    keyword: 'concurrency, processes',
  },
  {
    id: 'iso8601',
    type: 'standard',
    title: 'Date and Time Format',
    author: [{ literal: 'International Organization for Standardization' }],
    issued: { raw: '2019' },
    publisher: 'ISO',
  },
]);
