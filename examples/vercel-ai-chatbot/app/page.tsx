"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import type { GovernMessageMetadata } from "../lib/govern";
import { newId } from "../lib/id";

type ChatMessage = UIMessage<{ govern?: GovernMessageMetadata }>;

interface ReviewOutcome {
  state: "released" | "rejected";
  content: string | null;
}

function textOf(message: ChatMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export default function Page() {
  const chatId = useMemo(() => newId(), []);
  const [disclosure, setDisclosure] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [reviews, setReviews] = useState<Record<string, ReviewOutcome>>({});
  const [reviewing, setReviewing] = useState<string | null>(null);

  const { messages, sendMessage, status } = useChat<ChatMessage>({
    id: chatId,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  // Session start: record the AI-identity disclosure once per conversation,
  // then show exactly the text that was recorded.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId }) })
      .then((r) => r.json())
      .then((data: { text: string }) => {
        if (!cancelled) setDisclosure(data.text);
      })
      .catch(() => {
        if (!cancelled) setDisclosure("You are chatting with an AI assistant.");
      });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || status !== "ready") return;
    setInput("");
    void sendMessage({ text });
  };

  const review = async (decisionId: string, action: "release" | "reject") => {
    setReviewing(decisionId);
    try {
      const response = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisionId, action }),
      });
      const data = (await response.json()) as { reviewState: string; releasedContent: string | null };
      setReviews((current) => ({
        ...current,
        [decisionId]: { state: data.reviewState === "released" ? "released" : "rejected", content: data.releasedContent },
      }));
    } finally {
      setReviewing(null);
    }
  };

  const last = messages[messages.length - 1];
  const waiting =
    status === "submitted" || (status === "streaming" && (!last || last.role !== "assistant" || textOf(last).length === 0));

  return (
    <main>
      <h1>Care companion, governed</h1>
      <p className="subtitle">
        Every reply passes through the AnyBio Govern gate before it reaches this page. Patient audience, <code>web_chat</code>{" "}
        channel, buffer and release.
      </p>

      <div className="disclosure">
        <strong>Disclosure shown at session start.</strong>{" "}
        {disclosure ?? "Recording the disclosure for this conversation..."}
      </div>

      <div className="thread">
        {messages.map((message) => {
          const govern = message.role === "assistant" ? message.metadata?.govern : undefined;
          const outcome = govern?.decisionId ? reviews[govern.decisionId] : undefined;
          return (
            <div key={message.id} className={`turn ${message.role}`}>
              <div className="who">{message.role === "user" ? "You" : "Assistant"}</div>
              <div className="bubble">{textOf(message)}</div>
              {govern && (
                <div className={`badge ${govern.held ? "held" : "allowed"}`}>
                  {govern.held ? (govern.degraded ? "held: gate unreachable" : `held for review (${govern.decision})`) : "allowed"}
                  {govern.decisionId && <code>{govern.decisionId.slice(0, 8)}</code>}
                  {govern.reasons.length > 0 && <span>{govern.reasons.join(", ")}</span>}
                </div>
              )}
              {govern?.held && govern.decisionId && !outcome && (
                <div className="review">
                  <span>The original is in the review queue. Stand in for the reviewer (mock only):</span>
                  <button type="button" disabled={reviewing === govern.decisionId} onClick={() => void review(govern.decisionId!, "release")}>
                    Release
                  </button>
                  <button type="button" disabled={reviewing === govern.decisionId} onClick={() => void review(govern.decisionId!, "reject")}>
                    Reject
                  </button>
                </div>
              )}
              {outcome?.state === "released" && (
                <div className="released">
                  <strong>Released by a reviewer.</strong> Delivered now: {outcome.content ?? "(no content returned)"}
                </div>
              )}
              {outcome?.state === "rejected" && (
                <div className="rejected">
                  <strong>Rejected by a reviewer.</strong> Nothing further is sent for this turn.
                </div>
              )}
            </div>
          );
        })}
        {waiting && <div className="typing">Assistant is typing</div>}
      </div>

      <form className="composer" onSubmit={submit}>
        <div className="inner">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask something"
            aria-label="Message"
            disabled={status !== "ready"}
          />
          <button type="submit" disabled={status !== "ready" || input.trim().length === 0}>
            Send
          </button>
        </div>
        <div className="hint">
          Try: <code>Does this program cure high blood pressure?</code> to watch the gate hold a reply, or{" "}
          <code>I logged my reading</code> for one it allows.
        </div>
      </form>
    </main>
  );
}
