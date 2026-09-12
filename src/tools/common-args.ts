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
    .optional()
    .describe(
      'Numeric id of the library to address, e.g. 5234875 for a group (zotero_groups lists the ids you can reach). ' +
        'Omit to use the configured default library; an id given without library_type is read as a group id.',
    ),
};
