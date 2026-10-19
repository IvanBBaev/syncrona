---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `Now.attach()` in `Record()` data: the image is written as a `sys_attachment` record with its `sys_attachment_doc` chunks inside the record's file, with the SDK 4.13.6 layout, ids and path checks. The chunks are gzipped with node:zlib and a zero timestamp, so builds are reproducible; their bytes and ids differ from the SDK's time-stamped fflate stream, while the attachment ids, hashes and file contents match.
