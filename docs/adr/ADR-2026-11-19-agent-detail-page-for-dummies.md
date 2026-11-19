# ADR for Dummies: Agent detail page data seam and budget rendering

- **Status:** Accepted 2026-11-19
- **Date:** 2026-11-19
- **Technical ADR:** [ADR-2026-11-19-agent-detail-page](ADR-2026-11-19-agent-detail-page.md)

## The idea

Give each agent its own page. It shows what the agent spent over time, which models it used, which services it paid, how much of its budget is gone, and why policy stopped it recently. For now the numbers come from a fixed example so the page can be built and tested before the real data service is ready.

## What people see

1. An operator opens the Agents page and clicks an agent name.
2. The agent page shows a chart per asset. The operator can switch between hourly and daily buckets and pick a range. Only payments that actually settled count as spend.
3. A budget panel shows the daily and total limits, how much has been used in money and as a percentage, and each service cap with its usage. The daily window is labelled as a UTC day, the same day boundary the policy engine uses.
4. If the agent has no policy, the page says so plainly instead of drawing an empty bar.
5. A list of recent policy stops shows the rule that fired and why, with a link to the anomalies page filtered to this agent.
6. The Agents table no longer adds up spending from different assets into one misleading total.

## Important limitation

The example data is fixed, not live. A policy budget today is a single number without an asset attached, so the page cannot know for certain which asset that number is measured in. It will show the number the policy declares and say that the unit is ambiguous until the budgets work is finished. The page also cannot tell which policy belongs to which agent from the policy alone, so the example data includes an explicit agent-to-payer address list.

## What changes

- A new data module, a hook, and a page under the Agents section.
- Agent table rows become links to the new page.
- The dashboard data contract document gains the new contract.
- Tests for the empty, no-policy, multi-asset, and full/over-budget states, and for the arithmetic and time bucketing.

## What does not change

- No payment logic, no policy enforcement, and no service code.
- No asset is assumed and no budget unit is guessed.
- No new dependency, build configuration, or CI workflow.
- The service API and the policy schema are untouched; future work fills in the real data behind the same seam.
