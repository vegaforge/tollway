// Preamble for README.md code snippets. Declares the names the snippets
// rely on without importing them, so each snippet type-checks in isolation.
// The types come from the workspace packages that snippets import directly.
import type { Application } from "express";

declare const app: Application;
declare const servicePublicKey: Uint8Array;
declare const offer: import("@vegaforge/tollway-core").PaymentOffer;
