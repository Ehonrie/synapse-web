"use client";
import { useState } from "react";
import { scValToNative } from "@stellar/stellar-sdk";
import { Badge } from "@/components/ui/Badge";
import { ActionButton } from "@/components/ui/ActionButton";
import { SorobanTip } from "@/components/ui/SorobanTip";
import { CopyButton } from "@/components/ui/CopyButton";
import { useToast } from "@/components/ui/Toast";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { useSoroban } from "@/lib/soroban/SorobanProvider";
import { invokeContract, simulateContractCall, stringArg } from "@/lib/soroban/contract";
import { AMBER, BG1, BG2, BORDER, DIM, MONO, STATUS_META } from "@/lib/constants";
import { formatAmount, shortId } from "@/lib/utils";
import { TxTimeline, type TxTimelineEvent } from "@/components/transactions/TxTimeline";
import type { Transaction, TxStatus } from "@/lib/types";
import { TxReceiptPrintView } from "./TxReceiptPrintView";

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

// A transaction pending beyond this many milliseconds is eligible for a fee-bump "speed up".
const STUCK_THRESHOLD_MS = Number(process.env.NEXT_PUBLIC_STUCK_TX_THRESHOLD_MS ?? 120_000);

// Optimistic lifecycle transitions: the status we expect the poller to observe
// once the submitted write action is confirmed on-chain.
const OPTIMISTIC_STATUS: Record<string, TxStatus> = {
  start_processing: "PROCESSING",
  complete_transaction: "COMPLETED",
  fail_transaction: "FAILED",
};

interface TxDetailModalProps {
  tx: Transaction;
  onClose: () => void;
}

/**
 * Derive the observed lifecycle events for a transaction. Uses the explicit
 * `events` array when present, otherwise falls back to the transaction's
 * created_at + current status so the timeline always renders something useful.
 */
function buildTimelineEvents(tx: Transaction): TxTimelineEvent[] {
  const raw = (tx as Transaction & { events?: TxTimelineEvent[] }).events;
  if (Array.isArray(raw) && raw.length > 0) return raw;
  return [
    { status: "PENDING", timestamp: tx.created_at },
    { status: tx.status, timestamp: tx.updated_at ?? tx.created_at },
  ];
}

export function TxDetailModal({ tx, onClose }: TxDetailModalProps) {
  const [showFailPrompt, setShowFailPrompt] = useState(false);
  const [failReason, setFailReason] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // Optimistic overlay: locally-pending status shown immediately on submission,
  // reconciled with the poller-observed tx.status once it catches up.
  const [optimisticStatus, setOptimisticStatus] = useState<TxStatus | null>(null);
  const [optimisticError, setOptimisticError] = useState<string | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [estimatedFee, setEstimatedFee] = useState<string | null>(null);
  const [feeBumpHash, setFeeBumpHash] = useState<string | null>(null);
  const { address, connect } = useWallet();
  const { contractId } = useSoroban();
  const { toast } = useToast();

  // Reconcile: once the poller-observed status matches the optimistic target,
  // drop the overlay so the confirmed state takes over.
  const reconciled = optimisticStatus !== null && tx.status === optimisticStatus;
  const displayStatus = reconciled ? tx.status : optimisticStatus ?? tx.status;
  const m = STATUS_META[displayStatus];

  const isStuck =
    tx.status === "PENDING" && Date.now() - new Date(tx.created_at).getTime() > STUCK_THRESHOLD_MS;

  async function runTxCall(method: string, extraArgs: string[] = []) {
    if (!contractId) {
      toast("No contract ID is currently selected or configured", "error");
      return;
    }
    if (!address) {
      toast("Connect a wallet before submitting transactions", "error");
      await connect();
      return;
    }
    const optimistic = OPTIMISTIC_STATUS[method];
    setPendingAction(method);
    setOptimisticError(null);
    if (optimistic) setOptimisticStatus(optimistic);
    try {
      const args = [stringArg(tx.id), ...extraArgs.map(stringArg)];
      // Estimate the network fee from the simulation's resource usage before signing.
      const preview = await simulateContractCall(RPC_URL, contractId, address, method, args);
      setEstimatedFee(preview.estimatedFee);
      const result = await invokeContract(RPC_URL, contractId, address, method, args);
      if (result.status === "SUCCESS") {
        toast(`${method}() succeeded · tx ${shortId(result.hash)}`, "success");
      } else {
        // Submission failed/reverted: roll back the optimistic overlay.
        setOptimisticStatus(null);
        setOptimisticError(`${method}() failed on-chain`);
        toast(`${method}() failed · tx ${shortId(result.hash)}`, "error");
      }
    } catch (err) {
      // Submission threw: roll back the optimistic overlay with a clear error.
      setOptimisticStatus(null);
      setOptimisticError(err instanceof Error ? err.message : `${method}() failed`);
      toast(err instanceof Error ? err.message : `${method}() failed`, "error");
    } finally {
      setPendingAction(null);
    }
  }

  async function runIsDuplicate() {
    if (!contractId) {
      toast("No contract ID is currently selected or configured", "error");
      return;
    }
    if (!address) {
      toast("Connect a wallet to run this read-only check", "error");
      await connect();
      return;
    }
    setPendingAction("is_duplicate");
    try {
      const simulated = await simulateContractCall(RPC_URL, contractId, address, "is_duplicate", [
        stringArg(tx.id),
      ]);
      setEstimatedFee(simulated.estimatedFee);
      const isDuplicate = simulated.result ? scValToNative(simulated.result.retval) : undefined;
      toast(`is_duplicate(${shortId(tx.id)}) → ${JSON.stringify(isDuplicate)}`, "info");
    } catch (err) {
      toast(err instanceof Error ? err.message : "is_duplicate() failed", "error");
    } finally {
      setPendingAction(null);
    }
  }

  async function runSpeedUp() {
    if (!CONTRACT_ID) {
      toast("NEXT_PUBLIC_CONTRACT_ID is not configured", "error");
      return;
    }
    if (!address) {
      toast("Connect a wallet to sign the fee-bump transaction", "error");
      await connect();
      return;
    }
    setPendingAction("speed_up");
    try {
      const bumped = await invokeContract(RPC_URL, CONTRACT_ID, address, "speed_up", [
        stringArg(tx.id),
      ]);
      setFeeBumpHash(bumped.hash);
      toast(`Fee-bump submitted · tx ${shortId(bumped.hash)}`, "success");
    } catch (err) {
      // A transaction that confirms in the interim is not a bug: surface it as info, not an error.
      const message = err instanceof Error ? err.message : "speed_up() failed";
      if (/already (confirmed|succeeded)|not found|no longer pending/i.test(message)) {
        toast(`Transaction ${shortId(tx.id)} already confirmed — no fee-bump needed`, "info");
      } else {
        toast(message, "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  const fields: [string, string][] = [
    ["id", tx.id],
    ["asset", tx.asset],
    ["amount", `${formatAmount(tx.amount)} USDC`],
    ["from", tx.from],
    ["to", tx.to],
    ["memo", tx.memo],
    ["callback_url", tx.callback_url],
    ["retries", String(tx.retries)],
    ["created_at", new Date(tx.created_at).toISOString()],
    ["status", displayStatus],
  ];

  const timelineEvents = buildTimelineEvents(tx);
  const inProgress = tx.status !== "COMPLETED" && tx.status !== "FAILED";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.8)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-fade-in"
        style={{
          background: BG1,
          border: `1px solid ${m.color}44`,
          width: 560,
          maxHeight: "82vh",
          overflowY: "auto",
          padding: 24,
          position: "relative",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <span
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: AMBER,
              letterSpacing: "0.1em",
            }}
          >
            TX DETAIL
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Badge status={displayStatus} />
            {optimisticStatus !== null && !reconciled && (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 9,
                  color: AMBER,
                  letterSpacing: "0.08em",
                }}
              >
                PENDING CONFIRMATION
              </span>
            )}
            <button
              onClick={() => setShowReceipt(true)}
              aria-label="Print receipt"
              title="Print receipt"
              style={{
                background: "none",
                border: `1px solid ${BORDER}`,
                color: DIM,
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 9,
                letterSpacing: "0.08em",
                padding: "3px 8px",
              }}
            >
              RECEIPT
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                color: DIM,
                cursor: "pointer",
                fontSize: 18,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {optimisticError && (
          <div
            role="alert"
            style={{
              marginBottom: 12,
              padding: "8px 10px",
              background: BG2,
              border: `1px solid ${STATUS_META.FAILED.color}55`,
              color: STATUS_META.FAILED.color,
              fontFamily: MONO,
              fontSize: 10,
            }}
          >
            ⚠ {optimisticError} — reverted to confirmed state
          </div>
        )}

        {/* Fields */}
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
          <tbody>
            {fields.map(([k, v]) => (
              <tr key={k} style={{ borderBottom: `1px solid ${BORDER}` }}>
                <td
                  style={{
                    padding: "6px 0",
                    fontSize: 10,
                    color: DIM,
                    fontFamily: MONO,
                    width: "28%",
                    verticalAlign: "top",
                  }}
                >
                  {k}
                </td>
                <td
                  style={{
                    padding: "6px 0 6px 8px",
                    fontSize: 10,
                    color: "#ddd",
                    fontFamily: MONO,
                    wordBreak: "break-word",
                    overflowWrap: "anywhere",
                  }}
                >
                  {v}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {showReceipt && (
          <TxReceiptPrintView
            tx={tx}
            displayStatus={displayStatus}
            onClose={() => setShowReceipt(false)}
          />
        )}

        {/* Estimated network fee from simulation preview */}
        {estimatedFee && (
          <div
            style={{
              marginBottom: 12,
              padding: "8px 12px",
              background: BG2,
              border: `1px solid ${BORDER}`,
              borderRadius: 4,
              fontFamily: MONO,
              fontSize: 10,
              color: DIM,
            }}
          >
            ESTIMATED NETWORK FEE: <span style={{ color: AMBER }}>{estimatedFee}</span>
          </div>
        )}

        {/* Speed up (fee-bump) for stuck transactions */}
        {isStuck && (
          <div
            style={{
              marginBottom: 12,
              padding: 16,
              background: BG2,
              border: `1px solid ${AMBER}33`,
              borderRadius: 4,
            }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: AMBER,
                fontWeight: 600,
                letterSpacing: "0.06em",
                marginBottom: 8,
              }}
            >
              TRANSACTION PENDING UNUSUALLY LONG
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: DIM, marginBottom: 12 }}>
              Submit a fee-bump transaction to speed this up. This requires a new signature.
            </div>
            <ActionButton
              label={pendingAction === "speed_up" ? "Submitting…" : "Speed up"}
              disabled={pendingAction === "speed_up"}
              onClick={runSpeedUp}
            />
            {feeBumpHash && (
              <div style={{ fontFamily: MONO, fontSize: 10, color: DIM, marginTop: 8 }}>
                Fee-bump tx: {shortId(feeBumpHash)}
              </div>
            )}
          </div>
        )}

        {/* Lifecycle timeline */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: AMBER,
              letterSpacing: "0.08em",
              marginBottom: 10,
            }}
          >
            LIFECYCLE TIMELINE
          </div>
          <TxTimeline events={timelineEvents} inProgress={inProgress} />
        </div>

        {/* Action buttons */}
        {showFailPrompt ? (
          <div
            style={{
              marginBottom: 12,
              padding: 16,
              background: BG2,
              border: `1px solid ${STATUS_META.FAILED.color}33`,
              borderRadius: 4,
            }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: STATUS_META.FAILED.color,
                fontWeight: 600,
                letterSpacing: "0.06em",
                marginBottom: 8,
              }}
            >
              FAIL TRANSACTION REASON
            </div>
            <textarea
              value={failReason}
              onChange={(e) => setFailReason(e.target.value)}
              placeholder="Enter failure reason..."
              style={{
                width: "100%",
                height: 72,
                background: BG1,
                border: `1px solid ${BORDER}`,
                color: "#fff",
                fontFamily: MONO,
                fontSize: 11,
                padding: "8px 10px",
                resize: "none",
                outline: "none",
                marginBottom: 12,
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                disabled={!failReason.trim() || pendingAction === "fail_transaction"}
                onClick={async () => {
                  const reason = failReason.trim();
                  setShowFailPrompt(false);
                  setFailReason("");
                  await runTxCall("fail_transaction", [reason]);
                }}
                style={{
                  background: STATUS_META.FAILED.color,
                  border: "none",
                  color: "#000",
                  fontFamily: MONO,
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "8px 14px",
                  cursor: failReason.trim() ? "pointer" : "not-allowed",
                  opacity: failReason.trim() ? 1 : 0.5,
                }}
              >
                CONFIRM FAIL
              </button>
              <button
                onClick={() => {
                  setShowFailPrompt(false);
                  setFailReason("");
                }}
                style={{
                  background: "none",
                  border: `1px solid ${BORDER}`,
                  color: DIM,
                  fontFamily: MONO,
                  fontSize: 10,
                  padding: "8px 14px",
                  cursor: "pointer",
                }}
              >
                CANCEL
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <ActionButton
              label="PROCESS"
              pending={pendingAction === "process_transaction"}
              onClick={() => runTxCall("process_transaction")}
            />
            <ActionButton
              label="COMPLETE"
              pending={pendingAction === "complete_transaction"}
              onClick={() => runTxCall("complete_transaction")}
            />
            <ActionButton
              label="FAIL"
              pending={pendingAction === "fail_transaction"}
              onClick={() => setShowFailPrompt(true)}
            />
            <ActionButton
              label={pendingAction === "is_duplicate" ? "Checking…" : "Check Duplicate"}
              disabled={pendingAction === "is_duplicate"}
              onClick={runIsDuplicate}
            />
            <ActionButton
              label="Fail Transaction"
              disabled={pendingAction === "fail_transaction"}
              onClick={() => setShowFailPrompt(true)}
            />
          </div>
        )}

        <SorobanTip />
      </div>
    </div>
  );
}

      </div>
    </div>
  );
}
