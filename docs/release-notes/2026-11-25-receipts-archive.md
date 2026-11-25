---
date: 2026-11-25
feature: Receipts archive — search, filters, cursor pagination, and independent key-set verification
scope: feat
packages: []
scenario-impact: none
---

# Receipts archive: search, filters, cursor pagination, and independent key-set verification

The receipts view is now a full archive browser.

**What changed for users.** The receipts page has a filter bar with free-text search, model, network, payer, payee, and time-range fields. Every filter is reflected in the URL so a filtered view can be shared and survives a reload; Back and Forward navigate filter history. Results are paginated with Newer / Older cursor buttons; a filter change resets to the first page. Empty filtered results name the active filters with a "Clear filters" action. The detail panel now shows which key set and keyId verified the receipt. A receipt whose signing key is not in the trusted set shows "Unknown signing key" rather than "Signature invalid". The panel also offers "Copy receipt JSON" and "Download" so the exact signed receipt can be verified outside the dashboard.

**Trust model fix.** Previously the receipt source supplied both the receipts and the keys that verified them. A compromised source could hand over forged receipts with a matching key and the pill would say "Signature valid". The seam now returns `keySet` as a separate object from `page`, so the two paths can be independently sourced. The stub sets `keySet.source` to `/.well-known/tollway-keys.json`; production will read from the service's published key endpoint (see #167, #225).

**Data seam.** `fetchReceipts(query)` now accepts `ReceiptQuery` (filters, cursor, limit) and returns `{ page: ReceiptsPage, keySet: KeySetInfo }`. The stub fixture covers at least 65 receipts across all three models (`x402`, `mpp-charge`, `mpp-channel`) and two assets (USDC, XLM). `useReceipts(query)` reloads when the query changes and only prepends live SSE events on the first page.

**Documentation.** `docs/dashboard-data-contracts.md` now documents the receipts seam, the full query shape, the pagination contract, and the trust model.

Closes #233.
