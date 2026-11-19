---
date: 2026-11-18
feature: Publish a tested threat model for payment and receipt abuse paths
scope: docs
packages: [@vegaforge/tollway-server, @vegaforge/tollway-core]
scenario-impact: none
---

# Threat model and abuse tests

Added a threat model documenting Tollway's assets, trust boundaries, payment flows, attacker capabilities, and the current status of key abuse paths. Added case-linked tests for replay, cross-offer binding, concurrent settlement, receipt tampering, untrusted receipt keys, malformed headers, and a CI test that cross-checks defended cases.
