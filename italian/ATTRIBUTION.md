# Learning material and attribution

Vocabulary, course summaries, sentences and workbook exercises are adapted from the four PDFs supplied by the app owner. Original PDFs are not included. Every imported vocabulary row retains its source filename, page and course day. Duplicate Italian entries across the two lists are merged. Course summaries and practice sentences are edited adaptations; missing accents in the source booklet were restored in these authored examples. Workbook exercise 27 was corrected to match the prompt's present reporting verb. The vocabulary importer corrects the source labels for entries explicitly marked as adverbs, phrases or interjections.

## Conjugation data — CC BY-SA 3.0

`data/verbs-*.json` and `data/verb-index.json` are adapted from [Ian Hamlin's verb-data](https://github.com/ian-hamlin/verb-data), originally sourced from [English Wiktionary](https://en.wiktionary.org/). These adapted data files are distributed under the [Creative Commons Attribution-ShareAlike 3.0 Unported license](https://creativecommons.org/licenses/by-sa/3.0/). This notice applies independently of the repository's code license.

Modifications: compact representation; primary forms selected before comma-separated alternatives when unqualified; empty entries omitted; definitions limited to the first three; dictionary partitioned by initial letter; a course-verb subset bundled for offline use. Compound tenses are generated at runtime from the recorded auxiliary and participle. Gender agreement is selectable. Both auxiliary variants are shown where the dictionary records them; their contextual choice is not inferred. Historical and regional data may remain and the linked Wiktionary entry is provided for checking.

## Translation

Translation uses the documented [MyMemory GET API](https://mymemory.translated.net/doc/spec.php). Anonymous usage is limited to [5,000 characters per day](https://mymemory.translated.net/doc/usagelimits.php); the request limit is 500 UTF-8 bytes. The interface checks length before sending, handles network/quota errors, and retains successful translations for offline review. Unknown-word lookups consume the same allowance. No API key is embedded or required. Translation text is sent to MyMemory; the app uses no analytics. Generated card meanings are labeled where machine translated. Low-confidence shared-memory sentence matches are presented as alternatives and require a selection before learning; uncertain isolated-word matches are not added automatically.

The sentence guide is a local pattern matcher and dictionary lookup, not a dependency parser or an AI tutor. Ambiguous or unknown words are labeled, and unsupported analyses are not presented as certain. New rule lessons are drawn from an authored bank linked to workbook topics. It cannot invent reliable new grammatical explanations for arbitrary uncovered structures.

## PDF import engine

Mozilla PDF.js 5.6.205, legacy browser build, is vendored under `vendor/` with its Apache-2.0 license (`vendor/PDFJS-LICENSE`). The library and worker are unmodified copies of the distributed minified files. Uploaded PDFs are processed locally; their bytes are not sent to a service.

## Lesson classification

The 31 substantive booklet chapters remain in `lessons.json`. Twelve overview, study-advice and phrasebook sections are retained in `references.json` without lesson credit. Complete booklet text accompanies each chapter/reference, preserving source spelling; edited summaries and conjugations remain available for corrected spellings. The supplementary lessons in `supplements.json` are newly authored teaching material, explicitly labelled as additions rather than booklet excerpts or workbook lessons. Their structured explanations include contrasts, examples, practice and checks; relevant published reference links are retained within individual supplements.
