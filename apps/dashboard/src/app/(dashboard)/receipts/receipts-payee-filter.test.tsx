import { render, screen } from "@testing-library/react";
import {
  buildReceipt,
  Ed25519Signer,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const useReceiptsMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-receipts", () => ({
  useReceipts: useReceiptsMock,
}));

import { ReceiptsView } from "./receipts-view";

let signer: Ed25519Signer;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("filter-key");
});

afterEach(() => {
  useReceiptsMock.mockReset();
});

async function receiptTo(id: string, payee: string): Promise<SignedReceipt> {
  const body = buildReceipt({
    id,
    issuedAt: "2026-06-29T12:00:00.000Z",
    payer: "GPAYER",
    payee,
    amount: "10000",
    asset: "USDC:GA5Z",
    resource: "/quotes/latest",
    model: "x402",
    settlement: { kind: "transaction", txHash: "abc123" },
    network: "testnet",
  });
  return signReceipt(body, signer);
}

describe("ReceiptsView with a payee filter", () => {
  it("shows only the receipts paid to that counterparty, and says which it is", async () => {
    const rows = [
      await receiptTo("rcpt-stripe", "GPAYEE-STRIPE"),
      await receiptTo("rcpt-openai", "GPAYEE-OPENAI"),
    ];
    useReceiptsMock.mockReturnValue({
      status: "ready",
      rows,
      trustedKeys: { [signer.keyId]: signer.publicKey },
    });

    render(<ReceiptsView payee="GPAYEE-STRIPE" />);

    expect(screen.getByTestId("receipt-row-rcpt-stripe")).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-row-rcpt-openai")).not.toBeInTheDocument();
    expect(screen.getByTestId("receipts-payee-filter")).toHaveTextContent("GPAYEE-STRIPE");
    expect(screen.getByRole("link", { name: "Show all receipts" })).toHaveAttribute(
      "href",
      "/receipts",
    );
  });

  it("says so when no receipt was paid to the counterparty", async () => {
    useReceiptsMock.mockReturnValue({
      status: "ready",
      rows: [await receiptTo("rcpt-openai", "GPAYEE-OPENAI")],
      trustedKeys: { [signer.keyId]: signer.publicKey },
    });

    render(<ReceiptsView payee="GPAYEE-NOBODY" />);

    expect(screen.getByText("No receipts were paid to this counterparty.")).toBeInTheDocument();
  });
});
