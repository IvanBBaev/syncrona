---
"syncrona": patch
---

- An instance profile that names its own instance (`SN_INSTANCE_<P>`) no longer borrows the unprofiled `SN_BEARER_TOKEN`: the token belongs to `SN_INSTANCE`, and inferring bearer auth from it sent it to the profile's instance instead of the profile's own credentials.
- `syncrona login --auth-method bearer-token` (or `access-token`, any spelling `SN_AUTH_METHOD` accepts for bearer) now explains that a bearer token is environment-only, instead of rejecting it as an unknown method.
