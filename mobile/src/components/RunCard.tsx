import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Api, FINISHED, type RunRecord } from "../lib/api";
import { followRun } from "../lib/events";
import { Markdown } from "../lib/markdown";
import { LABEL, providerColor, useColors } from "../lib/theme";
import { StepCard } from "./StepCard";
import { Button, Card, Chip, Dot, ErrorText, Field, Muted, Row, statusColor } from "./ui";

const RUN_STATUS: Record<string, string> = {
  queued: "starting",
  planning: "planning",
  running: "working",
  waiting: "needs you",
  awaiting_approval: "design needs your decision",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** Keeps a run up to date while it works: text streams in, anything else refetches the record. */
function useLiveRun(initial: RunRecord) {
  const [run, setRun] = useState(initial);
  const [live, setLive] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => Api.run(initial.id).then(setRun).catch(() => {}), 150);
  }, [initial.id]);

  useEffect(() => setRun(initial), [initial]);
  useEffect(() => {
    if (FINISHED.includes(initial.status)) return;
    return followRun(initial.id, (ev) => {
      if (ev.type === "step.delta" && ev.stepId) {
        const text = (ev.data as { text: string }).text;
        setLive((l) => ({ ...l, [ev.stepId!]: ((l[ev.stepId!] ?? "") + text).slice(-4000) }));
      } else {
        if (ev.type === "step.started" && ev.stepId) setLive((l) => ({ ...l, [ev.stepId!]: "" }));
        refresh();
      }
    });
  }, [initial.id, initial.status, refresh]);

  return { run, live, refresh };
}

export function RunCard({ initial, onSettled }: { initial: RunRecord; onSettled?: () => void }) {
  const c = useColors();
  const { run, live, refresh } = useLiveRun(initial);
  const finished = FINISHED.includes(run.status);
  const needsYou = run.status === "waiting" || run.status === "awaiting_approval";
  const [open, setOpen] = useState(!finished);

  useEffect(() => {
    if (needsYou) setOpen(true);
  }, [needsYou]);
  useEffect(() => {
    if (finished) onSettled?.();
  }, [finished, onSettled]);

  const models = [...new Set(run.steps.map((s) => s.provider).filter(Boolean))].map((p) => LABEL[p!] ?? p).join(", ");

  return (
    <Card attention={needsYou}>
      <Row style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minHeight: 36 }}>
          <Dot color={statusColor(c, run.status)} />
          <Text style={{ color: c.text, fontWeight: "700", flexShrink: 1 }}>
            {RUN_STATUS[run.status] ?? run.status}
            {run.steps.length > 0 ? ` · ${run.steps.length} step${run.steps.length > 1 ? "s" : ""}` : ""}
            {models ? ` · ${models}` : ""} {open ? "▾" : "▸"}
          </Text>
        </Pressable>
        {!finished && <Button small title="Cancel" onPress={() => Api.cancel(run.id).then(refresh)} />}
      </Row>

      {open && (
        <View style={{ gap: 8 }}>
          {run.steps.map((s) => (
            <StepCard key={s.id} run={run} step={s} live={live[s.id]} onChange={refresh} />
          ))}
          {!run.steps.length && !finished && <Muted small>Planning who does what…</Muted>}
        </View>
      )}

      {run.status === "awaiting_approval" && <DesignDecision run={run} onDone={refresh} />}
      {run.steps.some((s) => s.branch?.pushed) && <Branches run={run} onChange={refresh} />}

      {!!run.result && (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 }}>
          <Markdown text={run.result} />
          <Row>
            <Button small title="Copy" onPress={() => Clipboard.setStringAsync(run.result ?? "")} />
          </Row>
        </View>
      )}
      {run.status === "failed" && <ErrorText text={run.error} />}
    </Card>
  );
}

function DesignDecision({ run, onDone }: { run: RunRecord; onDone: () => void }) {
  const c = useColors();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const verdict = (out?: string) => out?.match(/VERDICT:\s*(APPROVE WITH CHANGES|APPROVE|REWORK)/i)?.[1] ?? "reviewed";
  const reviews = (run.design?.reviewStepIds ?? []).map((id) => run.steps.find((s) => s.id === id)).filter((s) => !!s);
  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Text style={{ fontWeight: "700", fontSize: 16, color: c.text }}>The design is ready for your decision</Text>
      <Muted small>
        Round {run.design?.round}. Reviews: {reviews.map((r) => `${LABEL[r.provider ?? ""] ?? r.provider}: ${r.status === "done" ? verdict(r.output) : "failed"}`).join(" · ") || "none"}
      </Muted>
      <Field value={text} onChangeText={setText} placeholder="Which findings to address, or what to change" multiline style={{ minHeight: 70 }} />
      <Row>
        <Button kind="primary" title="Approve & build" busy={busy} onPress={() => go(() => Api.approve(run.id, text))} />
        <Button title="Send back" disabled={busy || !text.trim()} onPress={() => go(() => Api.revise(run.id, text))} />
      </Row>
      <ErrorText text={error} />
    </Card>
  );
}

function Branches({ run, onChange }: { run: RunRecord; onChange: () => void }) {
  const c = useColors();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const finished = FINISHED.includes(run.status);
  return (
    <Card>
      <Text style={{ fontWeight: "700", fontSize: 16, color: c.text }}>Branches to review</Text>
      <Muted small>Merging happens in the run's folder on the hub, into the branch checked out there. A conflict stops the merge and changes nothing.</Muted>
      {run.steps
        .filter((s) => s.branch?.pushed)
        .map((s) => {
          const b = s.branch!;
          return (
            <View key={s.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
              <Text style={{ color: c.text, fontWeight: "600" }}>{s.title}</Text>
              <Row>
                <Chip text={`${LABEL[s.provider ?? ""] ?? s.provider} @ ${b.node}`} color={providerColor(c, s.provider)} />
                <Chip text={`${b.changedFiles.length} file(s)`} />
                <Chip text={!b.tests ? "tests not run" : b.tests.ok ? "tests passed" : "tests failed"} color={b.tests ? (b.tests.ok ? c.ok : c.err) : undefined} />
              </Row>
              <Text style={{ color: c.muted, fontFamily: "monospace", fontSize: 12 }}>{b.name}</Text>
              <Text style={{ color: c.muted, fontFamily: "monospace", fontSize: 12 }} numberOfLines={8}>
                {b.diffStat}
              </Text>
              <Row>
                <Button
                  kind="primary"
                  small
                  title={b.merged ? "Merged" : "Merge"}
                  busy={busy === s.id}
                  disabled={!finished || !!b.merged}
                  onPress={async () => {
                    setBusy(s.id);
                    setError("");
                    try {
                      await Api.merge(run.id, s.id);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy("");
                      onChange();
                    }
                  }}
                />
                {!!b.mergeError && <ErrorText text={b.mergeError} />}
              </Row>
            </View>
          );
        })}
      <ErrorText text={error} />
    </Card>
  );
}
