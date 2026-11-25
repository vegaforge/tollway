import { render, screen } from "@testing-library/react";
import {
  buildReceipt,
  Ed25519Signer,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock next/navigation before component import.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/receipts",
  useRouter: () => ({ push: vi.fn() }),
}));

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

function readyState(rows: SignedReceipt[]) {
  return {
    status: "ready" as const,
    page: { rows, nextCursor: null },
    keySet: {
      source: "/.well-known/tollway-keys.json",
      keys: { [signer.keyId]: signer.publicKey },
    },
  };
}

describe("ReceiptsView with a payee filter", () => {
  it("shows only the receipts paid to that counterparty, and says which it is", async () => {
    // The payee prop is now passed from the page; useReceipts already has
    // the filtered rows because the query contains the payee.
    const rows = [await receiptTo("rcpt-stripe", "GPAYEE-STRIPE")];
    useReceiptsMock.mockReturnValue(readyState(rows));

    render(<ReceiptsView payee="GPAYEE-STRIPE" />);

    expect(screen.getByTestId("receipt-row-rcpt-stripe")).toBeInTheDocument();
    expect(screen.getByTestId("receipts-payee-filter")).toHaveTextContent("GPAYEE-STRIPE");
    expect(screen.getByRole("link", { name: "Show all receipts" })).toHaveAttribute(
      "href",
      "/receipts",
    );
  });

  it("says so when no receipt was paid to the counterparty", async () => {
    useReceiptsMock.mockReturnValue(readyState([]));

    render(<ReceiptsView payee="GPAYEE-NOBODY" />);

    // With a payee prop and no rows the view shows the filtered EmptyState.
    expect(screen.getByTestId("receipts-empty-filtered")).toBeInTheDocument();
    expect(screen.getByText(/no receipts match these filters/i)).toBeInTheDocument();
  });
});
