import { useState } from "react";
import { Text, View } from "react-native";
import { Api, type RunRecord, type StepRecord } from "../lib/api";
import { Markdown } from "../lib/markdown";
import { LABEL, providerColor, useColors } from "../lib/theme";
import { Button, Card, Chip, Dot, ErrorText, Field, Row, statusColor } from "./ui";

const STATUS: Record<StepRecord["status"], string> = {
  pending: "waiting to start",
  running: "working",
  waiting: "has a question",
  review: "paused for you",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

/** One agent's step: what it is doing, and what you can do about it right now. */
export function StepCard({ run, step, live, onChange }: { run: RunRecord; step: StepRecord; live?: string; onChange: () => void }) {
  const c = useColors();
  const [mode, setMode] = useState<"" | "edit" | "redo">("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showOut, setShowOut] = useState(false);
  const finished = ["done", "failed", "cancelled"].includes(run.status);
  const attention = step.status === "waiting" || step.status === "review";

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setMode("");
      setText("");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const edit = () => {
    setMode("edit");
    setText(step.output ?? "");
  };

  return (
    <Card attention={attention}>
      <Row style={{ flexWrap: "nowrap" }}>
        <Dot color={statusColor(c, step.status)} />
        <Text style={{ color: c.text, fontWeight: "700", flex: 1 }} numberOfLines={2}>
          {step.title}
        </Text>
      </Row>
      <Row>
        {step.provider && <Chip text={`${LABEL[step.provider] ?? step.provider}${step.node ? ` @ ${step.node}` : ""}`} color={providerColor(c, step.provider)} />}
        <Chip text={STATUS[step.status]} />
        {step.edited && <Chip text="edited by you" />}
      </Row>

      {step.answers?.map((qa, i) => (
        <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: c.accent, paddingLeft: 8 }}>
          <Text style={{ color: c.text, fontSize: 14 }}>Asked: {qa.question}</Text>
          <Text style={{ color: c.text, fontSize: 14, fontWeight: "600" }}>You: {qa.answer}</Text>
        </View>
      ))}

      {step.status === "running" && !!live && (
        <Text style={{ color: c.muted, fontFamily: "monospace", fontSize: 12 }} numberOfLines={12}>
          {live.slice(-1500)}
        </Text>
      )}

      {step.status === "waiting" && !!step.question && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: c.text, fontWeight: "700", fontSize: 16 }}>{step.question}</Text>
          <Field value={text} onChangeText={setText} placeholder="Your answer" multiline style={{ minHeight: 80 }} />
          <Row>
            <Button kind="primary" title="Answer" busy={busy} disabled={!text.trim()} onPress={() => act(() => Api.answer(run.id, step.id, text.trim()))} />
          </Row>
        </View>
      )}

      {(step.status === "review" || step.status === "done") &&
        !!step.output &&
        mode !== "edit" &&
        (step.status === "review" || showOut ? (
          <Markdown text={step.output} />
        ) : (
          <Text style={{ color: c.accent, paddingVertical: 4 }} onPress={() => setShowOut(true)}>
            Show answer
          </Text>
        ))}

      {(step.status === "failed" || step.status === "skipped") && !!step.error && <ErrorText text={step.error} />}

      {mode === "edit" && (
        <View style={{ gap: 8 }}>
          <Field value={text} onChangeText={setText} multiline style={{ minHeight: 200, fontFamily: "monospace", fontSize: 14 }} />
          <Text style={{ color: c.muted, fontSize: 13 }}>
            Your version replaces the agent's answer here and for steps that haven't started. It's also saved as a correction for similar tasks.
          </Text>
          <Row>
            <Button
              kind="primary"
              title={step.status === "review" ? "Save & continue" : "Save edit"}
              busy={busy}
              disabled={!text.trim()}
              onPress={() => act(() => (step.status === "review" ? Api.review(run.id, step.id, { action: "edit", output: text }) : Api.edit(run.id, step.id, text)))}
            />
            <Button title="Cancel" onPress={() => setMode("")} />
          </Row>
        </View>
      )}

      {mode === "redo" && (
        <View style={{ gap: 8 }}>
          <Field value={text} onChangeText={setText} placeholder="What should it do differently?" multiline style={{ minHeight: 70 }} autoFocus />
          <Row>
            <Button kind="primary" title="Redo" busy={busy} disabled={!text.trim()} onPress={() => act(() => Api.review(run.id, step.id, { action: "redo", instructions: text.trim() }))} />
            <Button title="Cancel" onPress={() => setMode("")} />
          </Row>
        </View>
      )}

      {!mode && (
        <Row>
          {step.status === "review" && (
            <>
              <Button kind="primary" title="Continue" busy={busy} onPress={() => act(() => Api.review(run.id, step.id, { action: "continue" }))} />
              <Button title="Edit" onPress={edit} />
              <Button title="Redo…" onPress={() => setMode("redo")} />
            </>
          )}
          {["running", "waiting", "review"].includes(step.status) && !finished && <Button kind="danger" title="Stop" busy={busy} onPress={() => act(() => Api.stop(run.id, step.id))} />}
          {step.status === "done" && !!step.output && (
            <>
              <Button small title="Edit answer" onPress={edit} />
              <Button small title="👍" onPress={() => act(() => Api.rate(run.id, step.id, 1))} />
              <Button small title="👎" onPress={() => act(() => Api.rate(run.id, step.id, -1))} />
            </>
          )}
        </Row>
      )}
      <ErrorText text={error} />
    </Card>
  );
}
