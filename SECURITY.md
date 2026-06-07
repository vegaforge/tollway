# Security Policy

## Supported versions

Tollway is pre-1.0. Only the latest released version receives security fixes.

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Report them privately via GitHub Security Advisories: [Report a vulnerability](https://github.com/vegaforge/tollway/security/advisories/new). If you cannot use GitHub, email emmanuelomemgboji@gmail.com with the subject line `TOLLWAY SECURITY`.

Include as much of the following as you can:

- The affected package and version
- A description of the issue and its impact
- Steps to reproduce or a proof of concept
- Whether the issue touches payment settlement, receipts, policy enforcement, or reconciliation

You should receive an acknowledgement within 72 hours. We will keep you informed as we triage, develop a fix, and coordinate disclosure. Please give us a reasonable window to ship a fix before public disclosure.

## Scope notes

Tollway is non-custodial by design: x402 settles directly to the `PAY_TO` address, MPP channel funds live in the channel contract, and Tollway never holds funds. Reports that demonstrate a path by which Tollway could cause double charges, receipt forgery, policy bypass, or silent reconciliation drift are in scope and treated as high severity. See the [security model in the design document](docs/design.md#security-model).
