import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { bytesToBase64Url } from "@vegaforge/tollway-core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { headers, PAYER, signedReceipt } from "../test/fixtures";
import { PaymentPlayground } from "./payment-playground";

/**
 * The playground promises that pasted values never leave the page. Every
 * way a page can send a request on its own is replaced with a spy, and each
 * test asserts none was called.
 */
type NetworkSpies = { fetch: Mock; xhrOpen: Mock; beacon: Mock; webSocket: Mock };

let spies: NetworkSpies;
const originals = {
  fetch: globalThis.fetch,
  xhrOpen: XMLHttpRequest.prototype.open,
  beacon: navigator.sendBeacon,
  webSocket: globalThis.WebSocket,
};

beforeEach(() => {
  spies = { fetch: vi.fn(), xhrOpen: vi.fn(), beacon: vi.fn(), webSocket: vi.fn() };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: spies.fetch });
  XMLHttpRequest.prototype.open = spies.xhrOpen;
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: spies.beacon });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: spies.webSocket });
  window.history.replaceState(null, "", "/docs/playground");
});

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originals.fetch });
  XMLHttpRequest.prototype.open = originals.xhrOpen;
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: originals.beacon });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: originals.webSocket,
  });
});

function expectNoNetwork() {
  expect(spies.fetch).not.toHaveBeenCalled();
  expect(spies.xhrOpen).not.toHaveBeenCalled();
  expect(spies.beacon).not.toHaveBeenCalled();
  expect(spies.webSocket).not.toHaveBeenCalled();
}

function decode(header: string, value: string) {
  fireEvent.change(screen.getByLabelText("Header"), { target: { value: header } });
  fireEvent.change(screen.getByLabelText("Header value"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Decode header" }));
}

describe("PaymentPlayground decode and verify", () => {
  it("decodes and verifies a receipt without any network request", async () => {
    const { header, signer } = await signedReceipt();
    render(<PaymentPlayground />);

    decode("TOLLWAY-RECEIPT", header);
    expect(screen.getByText(/Tollway signed receipt, encoded as base64url/)).toBeTruthy();
    expect(screen.getByText("Validation passed.")).toBeTruthy();
    expect(screen.getByRole("table")).toHaveTextContent("receipt.amount");

    fireEvent.change(screen.getByLabelText("Public key or key set"), {
      target: { value: bytesToBase64Url(signer.publicKey) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    expect(await screen.findByText(`Signature valid for key ${signer.keyId}.`)).toBeTruthy();
    expectNoNetwork();
  });

  it("announces a failed verification", async () => {
    const { header } = await signedReceipt();
    const other = await signedReceipt();
    render(<PaymentPlayground />);
    decode("TOLLWAY-RECEIPT", header);
    fireEvent.change(screen.getByLabelText("Public key or key set"), {
      target: { value: bytesToBase64Url(other.signer.publicKey) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Signature not valid/);
    expectNoNetwork();
  });

  it("summarises a PAYMENT-SIGNATURE, decodes its transaction lazily and warns it is sensitive", async () => {
    render(<PaymentPlayground />);
    decode("PAYMENT-SIGNATURE", headers.x402Signature);
    expect(screen.getByText(/treat it as sensitive/)).toBeTruthy();
    const summary = screen.getByText("Signed payment summary").parentElement;
    if (!summary) throw new Error("summary not rendered");
    expect(within(summary).getByText("stellar:testnet")).toBeTruthy();
    expect(within(summary).getByText("10000")).toBeTruthy();
    expect(await within(summary).findByText(PAYER)).toBeTruthy();
    expectNoNetwork();
  });

  it("announces decoding errors and marks the input invalid", () => {
    render(<PaymentPlayground />);
    decode("PAYMENT-REQUIRED", "not*base64");
    expect(screen.getByRole("alert")).toHaveTextContent(/neither base64 nor base64url/);
    expect(screen.getByLabelText("Header value")).toHaveAttribute("aria-invalid", "true");

    decode("PAYMENT-REQUIRED", JSON.stringify({ x402Version: 2 }));
    expect(screen.getByRole("alert")).toHaveTextContent("Validation failed");
    expectNoNetwork();
  });
});

describe("PaymentPlayground encode", () => {
  it("builds both encodings and rejects a non-integer amount next to the field", () => {
    render(<PaymentPlayground />);
    fireEvent.click(screen.getByRole("tab", { name: "Encode" }));
    fireEvent.change(screen.getByLabelText("Pay to"), { target: { value: PAYER } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.001" } });
    fireEvent.click(screen.getByRole("button", { name: "Build challenge" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/integer string/);
    expect(screen.getByLabelText("Amount")).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("button", { name: "Build challenge" }));
    const x402 = screen.getByLabelText(/x402 V2/);
    const tollway = screen.getByLabelText(/Tollway gate today/);
    expect((x402 as HTMLTextAreaElement).value).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect((tollway as HTMLTextAreaElement).value).toMatch(/^[A-Za-z0-9_-]+$/);
    expectNoNetwork();
  });
});

describe("PaymentPlayground accessibility and sharing", () => {
  it("moves between tabs with the arrow keys", () => {
    render(<PaymentPlayground />);
    const decodeTab = screen.getByRole("tab", { name: "Decode" });
    expect(decodeTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(decodeTab, { key: "ArrowRight" });
    const encodeTab = screen.getByRole("tab", { name: "Encode" });
    expect(encodeTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(encodeTab);
    expect(screen.getByRole("tabpanel")).toBe(
      document.getElementById(encodeTab.getAttribute("aria-controls") ?? ""),
    );
  });

  it("writes share state to the fragment only when asked, and restores it", () => {
    render(<PaymentPlayground />);
    fireEvent.change(screen.getByLabelText("Header value"), {
      target: { value: headers.x402Required },
    });
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    expect(window.location.pathname).toBe("/docs/playground");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toMatch(/^#playground=/);
    cleanup();

    render(<PaymentPlayground />);
    expect(screen.getByText("Restored the playground from the link.")).toBeTruthy();
    expect(screen.getByText(/x402 PaymentRequired, encoded as base64/)).toBeTruthy();
    expectNoNetwork();
  });

  it("refuses to share a PAYMENT-SIGNATURE", () => {
    render(<PaymentPlayground />);
    fireEvent.change(screen.getByLabelText("Header"), { target: { value: "PAYMENT-SIGNATURE" } });
    fireEvent.change(screen.getByLabelText("Header value"), {
      target: { value: headers.x402Signature },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    expect(screen.getByRole("status")).toHaveTextContent(/cannot be put in a share link/);
    expect(window.location.hash).toBe("");
  });

  it("says so when a playground link cannot be read", async () => {
    window.history.replaceState(null, "", "/docs/playground#playground=%%%");
    render(<PaymentPlayground />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/could not be read/));
  });
});
