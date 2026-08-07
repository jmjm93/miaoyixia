// How the dictionary is bucketed, in one place.
//
// Every candidate word generated for a single hover starts with the same character -- we only
// ever extend forward from the cursor -- so bucketing by the head character means one hover
// touches exactly one shard. Each shard is a few dozen KB, which keeps the MV3 service
// worker's cold-start cost negligible: it never parses the whole 16 MB dictionary to translate
// one word.
//
// This module is the single definition, imported by the build script, the runtime lookup and
// the gloss layer alike. It used to be copied into each with a "must match" comment, which is
// exactly the kind of invariant that holds right up until it doesn't -- a changed SHARD_COUNT
// in one copy produces silently empty lookups rather than an error.

export const SHARD_COUNT = 128;

/** Which shard holds words beginning with `char`. */
export function shardFor(char) {
  return char.codePointAt(0) % SHARD_COUNT;
}
