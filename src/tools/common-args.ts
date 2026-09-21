import { z } from 'zod';

/**
 * `library_type` and `library_id`, described once instead of in the twenty-odd tool files
 * that take them.
 *
 * Every one of those files spelled the pair out again with no `.describe()` at all, so the
 * two arguments most likely to send a write into the wrong library were the two the
 * advertised schema said nothing about. The wording follows `optionalLibrary()`: an id
 * alone is read as a group, and `library_type:"group"` alone is refused rather than
 * quietly served from the personal library (#74).
 */
export const libraryArgs = {
  library_type: z
    .enum(['user', 'group'])
    .optional()
    .describe(
      'Which library to address: "user" (a personal library) or "group" (a shared group library). ' +
        'Omit to use the library this server is configured for. "group" on its own is refused: pass library_id with it.',
    ),
  library_id: z
    .number()
    .int()
    // Positive, so that a negative or zero id is refused by the schema for every
    // library-addressable tool rather than by each one separately. A library id is a Zotero
    // account or group number and is never either; the index registry derives a FILE NAME
    // from one, so a value that is not a real id has no business travelling further.
    .positive()
    .optional()
    .describe(
      'Numeric id of the library to address, e.g. 5234875 for a group (zotero_groups lists the ids you can reach). ' +
        'Omit to use the configured default library; an id given without library_type is read as a group id.',
    ),
};
