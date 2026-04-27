"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Send, Trash2, Sparkles, FileText } from "lucide-react";
import { api } from "@/lib/api";
import { parseAgentResponse } from "./agent-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  yaml?: string | null;
  explanation?: string;
  doc_type?: string | null;
  created_at?: string;
}

interface AgentPanelProps {
  schemaSlug: string;
  tenantSlug: string;
  currentYaml: string;
  selectedDocId: string | null;
  onYamlUpdate: (yaml: string) => void;
  onRunExtraction: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentPanel({
  schemaSlug,
  tenantSlug,
  currentYaml,
  selectedDocId,
  onYamlUpdate,
  onRunExtraction,
}: AgentPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [docType, setDocType] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load conversation history on mount
  useEffect(() => {
    let cancelled = false;
    api.get<{ messages: Array<{ id: string; role: string; content: string; created_at: string }>; has_more: boolean }>(
      `/api/schemas/${schemaSlug}/agent/history?limit=50`,
    )
      .then((resp) => {
        if (cancelled) return;
        const parsed = resp.messages.map((m): ChatMessage => {
          if (m.role === "assistant") {
            const { yaml, explanation, doc_type } = parseAgentResponse(m.content);
            return { id: m.id, role: "assistant", content: m.content, yaml, explanation, doc_type, created_at: m.created_at };
          }
          return { id: m.id, role: "user", content: m.content, created_at: m.created_at };
        });
        setMessages(parsed);
        // Extract doc_type from history
        const lastDocType = parsed.findLast((m) => m.doc_type)?.doc_type;
        if (lastDocType) setDocType(lastDocType);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => { cancelled = true; };
  }, [schemaSlug]);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  // Focus input on mount
  useEffect(() => {
    if (loaded) inputRef.current?.focus();
  }, [loaded]);

  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || thinking) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setThinking(true);

    try {
      const resp = await api.post<{ yaml: string; explanation: string; doc_type: string | null }>(
        `/api/schemas/${schemaSlug}/agent`,
        {
          message: msg,
          yaml: currentYaml,
          corpus_entry_id: selectedDocId ?? undefined,
        },
      );

      const yamlChanged = resp.yaml && resp.yaml !== currentYaml;
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: resp.explanation,
        yaml: yamlChanged ? resp.yaml : null,
        explanation: resp.explanation,
        doc_type: resp.doc_type,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      if (resp.doc_type && !docType) setDocType(resp.doc_type);

      if (yamlChanged) {
        onYamlUpdate(resp.yaml!);
        // Auto-save draft to DB so it survives refresh
        api.patch(`/api/schemas/${schemaSlug}`, { draft_yaml: resp.yaml }).catch(() => {});
        // Auto-run extraction after YAML update
        if (selectedDocId) {
          setTimeout(() => onRunExtraction(), 500);
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Failed to reach the schema builder. Check your model endpoint configuration."}`,
          explanation: "Error occurred",
        },
      ]);
    } finally {
      setThinking(false);
    }
  }, [input, thinking, currentYaml, selectedDocId, schemaSlug, docType, onYamlUpdate, onRunExtraction]);

  const handleClearHistory = async () => {
    try {
      await api.delete(`/api/schemas/${schemaSlug}/agent/history`);
      setMessages([]);
      setDocType(null);
    } catch {}
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatDocType = (dt: string) =>
    dt.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-vermillion-2" />
          <span className="font-mono text-[11px] font-medium text-ink-2">Schema Builder</span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClearHistory}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-mono text-ink-4 hover:text-vermillion-2 hover:bg-vermillion-3/30 transition-colors"
            title="Clear conversation"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
        {messages.length === 0 && !thinking && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-8">
            <Sparkles className="w-6 h-6 text-ink-4/40" />
            <div className="space-y-1.5">
              <p className="text-[12px] text-ink-3 font-medium">Schema Builder</p>
              <p className="text-[11px] text-ink-4 max-w-[240px] leading-relaxed">
                {selectedDocId
                  ? "Describe what you want to extract from this document, or type \"analyze this document\" to get started."
                  : "Select a document first, then describe what you want to extract."}
              </p>
            </div>
            {selectedDocId && (
              <div className="flex flex-wrap gap-1.5 max-w-[280px] justify-center">
                {["Analyze this document", "What fields should I extract?", "Create a basic schema"].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}
                    className="px-2 py-1 rounded-sm border border-border text-[10px] font-mono text-ink-3 hover:bg-cream-2 hover:text-ink transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={msg.id ?? i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-sm px-3 py-2 text-[12px] leading-relaxed ${
                msg.role === "user"
                  ? "bg-ink text-cream rounded-br-none"
                  : "bg-cream-2 text-ink-2 rounded-bl-none"
              }`}
            >
              {msg.role === "assistant" ? (
                <div className="space-y-2">
                  {msg.doc_type && (
                    <div className="flex items-center gap-1">
                      <FileText className="w-3 h-3 text-vermillion-2" />
                      <span className="font-mono text-[10px] text-vermillion-2 font-medium">
                        {formatDocType(msg.doc_type)}
                      </span>
                    </div>
                  )}
                  <p className="whitespace-pre-wrap">{msg.explanation ?? msg.content}</p>
                  {msg.yaml && (
                    <div className="flex items-center gap-1 mt-1 pt-1 border-t border-border/50">
                      <span className="font-mono text-[9px] text-green font-medium uppercase">Schema updated</span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {thinking && (
          <div className="flex justify-start">
            <div className="bg-cream-2 text-ink-4 rounded-sm rounded-bl-none px-3 py-2">
              <div className="flex items-center gap-1.5">
                <div className="flex gap-0.5">
                  <span className="w-1.5 h-1.5 bg-ink-4/40 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 bg-ink-4/40 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 bg-ink-4/40 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
                <span className="font-mono text-[10px]">Thinking...</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border p-2 shrink-0">
        <div className="flex items-end gap-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={selectedDocId ? "Add a field, modify the schema..." : "Select a document to get started"}
            disabled={thinking}
            rows={1}
            className="flex-1 resize-none rounded-sm border border-border bg-transparent px-2.5 py-1.5 text-[12px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4 disabled:opacity-50 min-h-[32px] max-h-[120px]"
            style={{ height: "auto", overflow: "hidden" }}
            onInput={(e) => {
              const t = e.target as HTMLTextAreaElement;
              t.style.height = "auto";
              t.style.height = Math.min(t.scrollHeight, 120) + "px";
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || thinking}
            className="shrink-0 w-[32px] h-[32px] flex items-center justify-center rounded-sm bg-ink text-cream hover:bg-ink-2 disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
