---
"@syncrona/mirror": patch
---

Compare record directories case-insensitively before authorising a deletion. A full sweep that writes a live record as `Foo` while a deleted record's stale entry names `foo` no longer removes the live record's directory on APFS or NTFS. The same applies to a tombstone whose path another shard entry claims under a case-variant name.
