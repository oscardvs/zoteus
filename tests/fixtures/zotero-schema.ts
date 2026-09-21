import type { ZoteroSchema } from '../../src/schema/schema-service.js';

/**
 * A real slice of Zotero's global schema (https://api.zotero.org/schema, version 42),
 * trimmed to the item types the import tests exercise and carrying the `csl` block verbatim.
 *
 * Real rather than invented, because the thing under test IS the schema's own shape: that a
 * conference paper's container title has to travel through the base field `publicationTitle`
 * to land on `proceedingsTitle`, and that a thesis's publisher lands on `university`. A
 * hand-written stub would have quietly agreed with whatever the mapper did.
 */
export const SCHEMA_SLICE = {
  "version": 42,
  "itemTypes": [
    {
      "itemType": "book",
      "fields": [
        {
          "field": "title"
        },
        {
          "field": "abstractNote"
        },
        {
          "field": "series"
        },
        {
          "field": "seriesNumber"
        },
        {
          "field": "volume"
        },
        {
          "field": "numberOfVolumes"
        },
        {
          "field": "edition"
        },
        {
          "field": "date"
        },
        {
          "field": "publisher"
        },
        {
          "field": "place"
        },
        {
          "field": "originalDate"
        },
        {
          "field": "originalPublisher"
        },
        {
          "field": "originalPlace"
        },
        {
          "field": "format",
          "baseField": "medium"
        },
        {
          "field": "numPages"
        },
        {
          "field": "ISBN"
        },
        {
          "field": "DOI"
        },
        {
          "field": "citationKey"
        },
        {
          "field": "url"
        },
        {
          "field": "accessDate"
        },
        {
          "field": "ISSN"
        },
        {
          "field": "archive"
        },
        {
          "field": "archiveLocation"
        },
        {
          "field": "shortTitle"
        },
        {
          "field": "language"
        },
        {
          "field": "libraryCatalog"
        },
        {
          "field": "callNumber"
        },
        {
          "field": "rights"
        },
        {
          "field": "extra"
        }
      ],
      "creatorTypes": [
        {
          "creatorType": "author",
          "primary": true
        },
        {
          "creatorType": "contributor"
        },
        {
          "creatorType": "editor"
        },
        {
          "creatorType": "translator"
        },
        {
          "creatorType": "seriesEditor"
        }
      ]
    },
    {
      "itemType": "bookSection",
      "fields": [
        {
          "field": "title"
        },
        {
          "field": "abstractNote"
        },
        {
          "field": "bookTitle",
          "baseField": "publicationTitle"
        },
        {
          "field": "series"
        },
        {
          "field": "seriesNumber"
        },
        {
          "field": "volume"
        },
        {
          "field": "numberOfVolumes"
        },
        {
          "field": "edition"
        },
        {
          "field": "date"
        },
        {
          "field": "publisher"
        },
        {
          "field": "place"
        },
        {
          "field": "originalDate"
        },
        {
          "field": "originalPublisher"
        },
        {
          "field": "originalPlace"
        },
        {
          "field": "format",
          "baseField": "medium"
        },
        {
          "field": "pages"
        },
        {
          "field": "ISBN"
        },
        {
          "field": "DOI"
        },
        {
          "field": "citationKey"
        },
        {
          "field": "url"
        },
        {
          "field": "accessDate"
        },
        {
          "field": "ISSN"
        },
        {
          "field": "archive"
        },
        {
          "field": "archiveLocation"
        },
        {
          "field": "shortTitle"
        },
        {
          "field": "language"
        },
        {
          "field": "libraryCatalog"
        },
        {
          "field": "callNumber"
        },
        {
          "field": "rights"
        },
        {
          "field": "extra"
        }
      ],
      "creatorTypes": [
        {
          "creatorType": "author",
          "primary": true
        },
        {
          "creatorType": "contributor"
        },
        {
          "creatorType": "editor"
        },
        {
          "creatorType": "bookAuthor"
        },
        {
          "creatorType": "translator"
        },
        {
          "creatorType": "seriesEditor"
        }
      ]
    },
    {
      "itemType": "conferencePaper",
      "fields": [
        {
          "field": "title"
        },
        {
          "field": "abstractNote"
        },
        {
          "field": "proceedingsTitle",
          "baseField": "publicationTitle"
        },
        {
          "field": "conferenceName"
        },
        {
          "field": "publisher"
        },
        {
          "field": "place"
        },
        {
          "field": "date"
        },
        {
          "field": "eventPlace"
        },
        {
          "field": "volume"
        },
        {
          "field": "issue"
        },
        {
          "field": "numberOfVolumes"
        },
        {
          "field": "pages"
        },
        {
          "field": "series"
        },
        {
          "field": "seriesNumber"
        },
        {
          "field": "DOI"
        },
        {
          "field": "ISBN"
        },
        {
          "field": "citationKey"
        },
        {
          "field": "url"
        },
        {
          "field": "accessDate"
        },
        {
          "field": "ISSN"
        },
        {
          "field": "archive"
        },
        {
          "field": "archiveLocation"
        },
        {
          "field": "shortTitle"
        },
        {
          "field": "language"
        },
        {
          "field": "libraryCatalog"
        },
        {
          "field": "callNumber"
        },
        {
          "field": "rights"
        },
        {
          "field": "extra"
        }
      ],
      "creatorTypes": [
        {
          "creatorType": "author",
          "primary": true
        },
        {
          "creatorType": "contributor"
        },
        {
          "creatorType": "editor"
        },
        {
          "creatorType": "translator"
        },
        {
          "creatorType": "seriesEditor"
        }
      ]
    },
    {
      "itemType": "document",
      "fields": [
        {
          "field": "title"
        },
        {
          "field": "abstractNote"
        },
        {
          "field": "type"
        },
        {
          "field": "date"
        },
        {
          "field": "publisher"
        },
        {
          "field": "place"
        },
        {
          "field": "DOI"
        },
        {
          "field": "citationKey"
        },
        {
          "field": "url"
        },
        {
          "field": "accessDate"
        },
        {
          "field": "archive"
        },
        {
          "field": "archiveLocation"
        },
        {
          "field": "shortTitle"
        },
        {
          "field": "language"
        },
        {
          "field": "libraryCatalog"
        },
        {
          "field": "callNumber"
        },
        {
          "field": "rights"
        },
        {
          "field": "extra"
        }
      ],
      "creatorTypes": [
        {
          "creatorType": "author",
          "primary": true
        },
        {
          "creatorType": "contributor"
        },
        {
          "creatorType": "editor"
        },
        {
          "creatorType": "translator"
        },
        {
          "creatorType": "reviewedAuthor"
        }
      ]
    },
    {
      "itemType": "journalArticle",
      "fields": [
        {
          "field": "title"
        },
        {
          "field": "abstractNote"
        },
        {
          "field": "publicationTitle"
        },
        {
          "field": "publisher"
        },
        {
          "field": "place"
        },
        {
          "field": "date"
        },
        {
          "field": "volume"
        },
        {
          "field": "issue"
        },
        {
          "field": "section"
        },
        {
          "field": "partNumber"
        },
        {
          "field": "partTitle"
        },
        {
          "field": "pages"
        },
        {
          "field": "series"
        },
        {
          "field": "seriesTitle"
        },
        {
          "field": "seriesText"
        },
        {
          "field": "journalAbbreviation"
        },
        {
          "field": "DOI"
        },
        {
          "field": "citationKey"
        },
        {
          "field": "url"
        },
        {
          "field": "accessDate"
        },
        {
          "field": "PMID"
        },
        {
          "field": "PMCID"
        },
        {
          "field": "ISSN"
        },
        {
          "field": "archive"
        },
        {
          "field": "archiveLocation"
        },
        {
          "field": "shortTitle"
        },
        {
          "field": "language"
        },
        {
          "field": "libraryCatalog"
        },
        {
          "field": "callNumber"
        },
        {
          "field": "rights"
        },
        {
          "field": "extra"
        }
      ],
      "creatorTypes": [
        {
          "creatorType": "author",
          "primary": true
        },
        {
          "creatorType": "contributor"
        },
        {
          "creatorType": "editor"
        },
        {
          "creatorType": "translator"
        },
        {
          "creatorType": "reviewedAuthor"
        }
      ]
    },
    {
      "itemType": "preprint",
      "fields": [
        {
          "field": "title"
        },
        {
          "field": "abstractNote"
        },
        {
          "field": "genre",
          "baseField": "type"
        },
        {
          "field": "repository",
          "baseField": "publisher"
        },
        {
          "field": "archiveID",
          "baseField": "number"
        },
        {
          "field": "place"
        },
        {
          "field": "date"
        },
        {
          "field": "series"
        },
        {
          "field": "seriesNumber"
        },
        {
          "field": "DOI"
        },
        {
          "field": "citationKey"
        },
        {
          "field": "url"
        },
        {
          "field": "accessDate"
        },
        {
          "field": "archive"
        },
        {
          "field": "archiveLocation"
        },
        {
          "field": "shortTitle"
        },
        {
          "field": "language"
        },
        {
          "field": "libraryCatalog"
        },
        {
          "field": "callNumber"
        },
        {
          "field": "rights"
        },
        {
          "field": "extra"
        }
      ],
      "creatorTypes": [
        {
          "creatorType": "author",
          "primary": true
        },
        {
          "creatorType": "contributor"
        },
        {
          "creatorType": "editor"
        },
        {
          "creatorType": "translator"
        },
        {
          "creatorType": "reviewedAuthor"
        }
      ]
    },
    {
      "itemType": "standard",
      "fields": [
        {
          "field": "title"
        },
        {
          "field": "abstractNote"
        },
        {
          "field": "organization",
          "baseField": "authority"
        },
        {
          "field": "committee"
        },
        {
          "field": "type"
        },
        {
          "field": "number"
        },
        {
          "field": "versionNumber"
        },
        {
          "field": "edition"
        },
        {
          "field": "status"
        },
        {
          "field": "date"
        },
        {
          "field": "publisher"
        },
        {
          "field": "place"
        },
        {
          "field": "partNumber"
        },
        {
          "field": "partTitle"
        },
        {
          "field": "ISBN"
        },
        {
          "field": "DOI"
        },
        {
          "field": "citationKey"
        },
        {
          "field": "url"
        },
        {
          "field": "accessDate"
        },
        {
          "field": "archive"
        },
        {
          "field": "archiveLocation"
        },
        {
          "field": "shortTitle"
        },
        {
          "field": "numPages"
        },
        {
          "field": "language"
        },
        {
          "field": "libraryCatalog"
        },
        {
          "field": "callNumber"
        },
        {
          "field": "rights"
        },
        {
          "field": "extra"
        }
      ],
      "creatorTypes": [
        {
          "creatorType": "author",
          "primary": true
        },
        {
          "creatorType": "editor"
        },
        {
          "creatorType": "contributor"
        }
      ]
    },
    {
      "itemType": "thesis",
      "fields": [
        {
          "field": "title"
        },
        {
          "field": "abstractNote"
        },
        {
          "field": "thesisType",
          "baseField": "type"
        },
        {
          "field": "university",
          "baseField": "publisher"
        },
        {
          "field": "place"
        },
        {
          "field": "date"
        },
        {
          "field": "series"
        },
        {
          "field": "seriesNumber"
        },
        {
          "field": "numPages"
        },
        {
          "field": "DOI"
        },
        {
          "field": "ISBN"
        },
        {
          "field": "citationKey"
        },
        {
          "field": "url"
        },
        {
          "field": "accessDate"
        },
        {
          "field": "ISSN"
        },
        {
          "field": "archive"
        },
        {
          "field": "archiveLocation"
        },
        {
          "field": "shortTitle"
        },
        {
          "field": "language"
        },
        {
          "field": "libraryCatalog"
        },
        {
          "field": "callNumber"
        },
        {
          "field": "rights"
        },
        {
          "field": "extra"
        }
      ],
      "creatorTypes": [
        {
          "creatorType": "author",
          "primary": true
        },
        {
          "creatorType": "contributor"
        }
      ]
    }
  ],
  "csl": {
    "types": {
      "article": [
        "preprint"
      ],
      "article-journal": [
        "journalArticle"
      ],
      "article-magazine": [
        "magazineArticle"
      ],
      "article-newspaper": [
        "newspaperArticle"
      ],
      "bill": [
        "bill"
      ],
      "book": [
        "book"
      ],
      "broadcast": [
        "podcast",
        "tvBroadcast",
        "radioBroadcast"
      ],
      "chapter": [
        "bookSection"
      ],
      "dataset": [
        "dataset"
      ],
      "document": [
        "document",
        "attachment",
        "note"
      ],
      "entry-dictionary": [
        "dictionaryEntry"
      ],
      "entry-encyclopedia": [
        "encyclopediaArticle"
      ],
      "graphic": [
        "artwork"
      ],
      "hearing": [
        "hearing"
      ],
      "interview": [
        "interview"
      ],
      "legal_case": [
        "case"
      ],
      "legislation": [
        "statute"
      ],
      "manuscript": [
        "manuscript"
      ],
      "map": [
        "map"
      ],
      "motion_picture": [
        "film",
        "videoRecording"
      ],
      "paper-conference": [
        "conferencePaper"
      ],
      "patent": [
        "patent"
      ],
      "personal_communication": [
        "letter",
        "email",
        "instantMessage"
      ],
      "post": [
        "forumPost"
      ],
      "post-weblog": [
        "blogPost"
      ],
      "report": [
        "report"
      ],
      "software": [
        "computerProgram"
      ],
      "song": [
        "audioRecording"
      ],
      "speech": [
        "presentation"
      ],
      "standard": [
        "standard"
      ],
      "thesis": [
        "thesis"
      ],
      "webpage": [
        "webpage"
      ]
    },
    "fields": {
      "text": {
        "abstract": [
          "abstractNote"
        ],
        "archive": [
          "archive"
        ],
        "archive_location": [
          "archiveLocation"
        ],
        "authority": [
          "authority"
        ],
        "call-number": [
          "callNumber",
          "applicationNumber"
        ],
        "chapter-number": [
          "session"
        ],
        "citation-key": [
          "citationKey"
        ],
        "collection-number": [
          "seriesNumber"
        ],
        "collection-title": [
          "seriesTitle",
          "series"
        ],
        "container-title": [
          "publicationTitle",
          "reporter",
          "code"
        ],
        "dimensions": [
          "artworkSize",
          "runningTime"
        ],
        "DOI": [
          "DOI"
        ],
        "edition": [
          "edition"
        ],
        "event-place": [
          "eventPlace"
        ],
        "event-title": [
          "meetingName",
          "conferenceName"
        ],
        "genre": [
          "type",
          "programmingLanguage"
        ],
        "ISBN": [
          "ISBN"
        ],
        "ISSN": [
          "ISSN"
        ],
        "issue": [
          "issue",
          "priorityNumbers"
        ],
        "journalAbbreviation": [
          "journalAbbreviation"
        ],
        "language": [
          "language"
        ],
        "license": [
          "rights"
        ],
        "medium": [
          "medium",
          "system"
        ],
        "note": [
          "extra"
        ],
        "number": [
          "number"
        ],
        "number-of-pages": [
          "numPages"
        ],
        "number-of-volumes": [
          "numberOfVolumes"
        ],
        "original-publisher": [
          "originalPublisher"
        ],
        "original-publisher-place": [
          "originalPlace"
        ],
        "part-number": [
          "partNumber"
        ],
        "part-title": [
          "partTitle"
        ],
        "page": [
          "pages"
        ],
        "PMID": [
          "PMID"
        ],
        "PMCID": [
          "PMCID"
        ],
        "publisher": [
          "publisher"
        ],
        "publisher-place": [
          "place"
        ],
        "references": [
          "history",
          "references"
        ],
        "scale": [
          "scale"
        ],
        "section": [
          "section",
          "committee"
        ],
        "shortTitle": [
          "shortTitle"
        ],
        "source": [
          "libraryCatalog"
        ],
        "status": [
          "status"
        ],
        "title": [
          "title"
        ],
        "title-short": [
          "shortTitle"
        ],
        "URL": [
          "url"
        ],
        "version": [
          "versionNumber"
        ],
        "volume": [
          "volume",
          "codeNumber"
        ]
      },
      "date": {
        "accessed": "accessDate",
        "issued": "date",
        "submitted": "filingDate",
        "original-date": "originalDate"
      }
    },
    "names": {
      "author": "author",
      "bookAuthor": "container-author",
      "chair": "chair",
      "castMember": "performer",
      "composer": "composer",
      "contributor": "contributor",
      "creator": "author",
      "director": "director",
      "editor": "editor",
      "executiveProducer": "executive-producer",
      "guest": "guest",
      "host": "host",
      "interviewer": "interviewer",
      "narrator": "narrator",
      "originalCreator": "original-author",
      "organizer": "organizer",
      "podcaster": "host",
      "producer": "producer",
      "recipient": "recipient",
      "reviewedAuthor": "reviewed-author",
      "seriesCreator": "series-creator",
      "seriesEditor": "collection-editor",
      "scriptwriter": "script-writer",
      "translator": "translator"
    }
  }
} as unknown as ZoteroSchema;
