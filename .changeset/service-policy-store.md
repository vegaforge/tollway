---
"@vegaforge/tollway-service": minor
"@vegaforge/tollway-client": minor
---

Complete the tenant-scoped policy store in `@vegaforge/tollway-service`: `PUT /v1/agents/{agentId}/policy` now takes the policy document as its body, validates it with core's `parsePolicy` (`422 invalid-policy` with issue paths), and guards every change after the first with `If-Match` (`412 precondition-failed`). Adds `GET .../policy/versions/{version}`, `DELETE .../policy` (retirement tombstone), `304` on a matching `If-None-Match`, `policy.created` audit entries, `PolicyStore.getVersion` and `policyEtag`. Removes `putPolicyBodySchema` and the `{ policy, expectedVersion }` request body. Adds `fetchPolicy` to `@vegaforge/tollway-client`, which validates the response, caches it per API key and revalidates with `If-None-Match`.
