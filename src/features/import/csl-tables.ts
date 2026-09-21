/**
 * A frozen copy of the `csl` block of Zotero's global schema (https://api.zotero.org/schema,
 * version 42, fetched 2026-09-14).
 *
 * The live schema is what the mapper uses: it is fetched and cached by SchemaService, it
 * carries the per-item-type field lists that decide which of several candidate fields a CSL
 * variable can actually land on, and it stays current on its own. This copy exists for the
 * one case that would otherwise take a working feature away: a machine with no network. A
 * local BibTeX file imported into a running Zotero desktop app needs nothing off the
 * internet, so it should not fail because api.zotero.org is unreachable.
 *
 * Mapping from here is strictly worse than mapping from the live schema, and the tool says
 * so in its result (`mapping: "snapshot"`): with no item-type field lists, the first
 * candidate for each CSL variable is taken instead of the one that is valid for the type, so
 * a conference paper's container title lands in Extra rather than in `proceedingsTitle`.
 *
 * Regenerate with: curl -s https://api.zotero.org/schema | jq .csl
 */

export const SNAPSHOT_TYPES: Record<string, string[]> = {
  article: ['preprint'],
  'article-journal': ['journalArticle'],
  'article-magazine': ['magazineArticle'],
  'article-newspaper': ['newspaperArticle'],
  bill: ['bill'],
  book: ['book'],
  broadcast: ['podcast', 'tvBroadcast', 'radioBroadcast'],
  chapter: ['bookSection'],
  dataset: ['dataset'],
  document: ['document', 'attachment', 'note'],
  'entry-dictionary': ['dictionaryEntry'],
  'entry-encyclopedia': ['encyclopediaArticle'],
  graphic: ['artwork'],
  hearing: ['hearing'],
  interview: ['interview'],
  legal_case: ['case'],
  legislation: ['statute'],
  manuscript: ['manuscript'],
  map: ['map'],
  motion_picture: ['film', 'videoRecording'],
  'paper-conference': ['conferencePaper'],
  patent: ['patent'],
  personal_communication: ['letter', 'email', 'instantMessage'],
  post: ['forumPost'],
  'post-weblog': ['blogPost'],
  report: ['report'],
  software: ['computerProgram'],
  song: ['audioRecording'],
  speech: ['presentation'],
  standard: ['standard'],
  thesis: ['thesis'],
  webpage: ['webpage'],
};

export const SNAPSHOT_TEXT_FIELDS: Record<string, string[]> = {
  abstract: ['abstractNote'],
  archive: ['archive'],
  archive_location: ['archiveLocation'],
  authority: ['authority'],
  'call-number': ['callNumber', 'applicationNumber'],
  'chapter-number': ['session'],
  'citation-key': ['citationKey'],
  'collection-number': ['seriesNumber'],
  'collection-title': ['seriesTitle', 'series'],
  'container-title': ['publicationTitle', 'reporter', 'code'],
  dimensions: ['artworkSize', 'runningTime'],
  DOI: ['DOI'],
  edition: ['edition'],
  'event-place': ['eventPlace'],
  'event-title': ['meetingName', 'conferenceName'],
  genre: ['type', 'programmingLanguage'],
  ISBN: ['ISBN'],
  ISSN: ['ISSN'],
  issue: ['issue', 'priorityNumbers'],
  journalAbbreviation: ['journalAbbreviation'],
  language: ['language'],
  license: ['rights'],
  medium: ['medium', 'system'],
  note: ['extra'],
  number: ['number'],
  'number-of-pages': ['numPages'],
  'number-of-volumes': ['numberOfVolumes'],
  'original-publisher': ['originalPublisher'],
  'original-publisher-place': ['originalPlace'],
  'part-number': ['partNumber'],
  'part-title': ['partTitle'],
  page: ['pages'],
  PMID: ['PMID'],
  PMCID: ['PMCID'],
  publisher: ['publisher'],
  'publisher-place': ['place'],
  references: ['history', 'references'],
  scale: ['scale'],
  section: ['section', 'committee'],
  shortTitle: ['shortTitle'],
  source: ['libraryCatalog'],
  status: ['status'],
  title: ['title'],
  'title-short': ['shortTitle'],
  URL: ['url'],
  version: ['versionNumber'],
  volume: ['volume', 'codeNumber'],
};

export const SNAPSHOT_DATE_FIELDS: Record<string, string> = {
  accessed: 'accessDate',
  issued: 'date',
  submitted: 'filingDate',
  'original-date': 'originalDate',
};

export const SNAPSHOT_NAMES: Record<string, string> = {
  author: 'author',
  bookAuthor: 'container-author',
  chair: 'chair',
  castMember: 'performer',
  composer: 'composer',
  contributor: 'contributor',
  creator: 'author',
  director: 'director',
  editor: 'editor',
  executiveProducer: 'executive-producer',
  guest: 'guest',
  host: 'host',
  interviewer: 'interviewer',
  narrator: 'narrator',
  originalCreator: 'original-author',
  organizer: 'organizer',
  podcaster: 'host',
  producer: 'producer',
  recipient: 'recipient',
  reviewedAuthor: 'reviewed-author',
  seriesCreator: 'series-creator',
  seriesEditor: 'collection-editor',
  scriptwriter: 'script-writer',
  translator: 'translator',
};
