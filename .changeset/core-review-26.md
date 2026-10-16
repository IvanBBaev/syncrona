---
"syncrona": patch
---

- An instance profile that names its own instance (`SN_INSTANCE_<P>`) no longer borrows the unprofiled `SN_BEARER_TOKEN`: the token belongs to `SN_INSTANCE`, and inferring bearer auth from it sent it to the profile's instance instead of the profile's own credentials.
