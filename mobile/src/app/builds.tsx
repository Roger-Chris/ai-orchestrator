import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, Switch, Text, View } from "react-native";
import { Button, Card, Chip, ErrorText, Field, Muted, Row } from "../components/ui";
import { Api, type Build } from "../lib/api";
import { type Colors, LABEL, useColors } from "../lib/theme";

/**
 * Builds (Jarvis phase 2): apps made on command. Each build codes on its own branch, runs tests and
 * gets a second model's review; you open the preview here, then Merge. Nothing reaches the app's
 * main branch without that tap.
 */

const STATUS: Record<Build["status"], string> = { running: "building", ready: "ready to check", failed: "failed", merged: "merged", cancelled: "cancelled", done: "done" };
const statusColor = (c: Colors, s: Build["status"]) => ({ running: c.accent, ready: c.warn, failed: c.err, merged: c.ok, cancelled: c.muted, done: c.ok })[s];

export default function Builds() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [builds, setBuilds] = useState<Build[]>();
  const [open, setOpen] = useState<string | undefined>(id);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  const [form, setForm] = useState<{ name: string; spec: string; repo: string; agent: "claude" | "codex"; cont: boolean }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBuilds(await Api.builds());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));
  useEffect(() => setOpen(id), [id]);
  // A running build or a preview being made: look again every 15 s while the screen is open.
  useEffect(() => {
    if (!builds?.some((b) => b.status === "running" || b.preview?.status === "building")) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [builds, load]);

  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
      setConfirm(undefined);
    }
  };

  const start = () =>
    form &&
    act("start", async () => {
      const b = await Api.startBuild({ name: form.name.trim(), spec: form.spec.trim(), repo: form.repo.trim() || undefined, agent: form.agent, continue: form.cont });
      setForm(undefined);
      setOpen(b.id);
    });

  const h2 = { color: c.text, fontSize: 17, fontWeight: "700" as const };
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {!form ? (
        <Row>
          <Button kind="primary" title="New build" onPress={() => setForm({ name: "", spec: "", repo: "", agent: "claude", cont: false })} />
          <Muted small>Or ask the assistant: "build me…", "continue the … app".</Muted>
        </Row>
      ) : (
        <Card>
          <Text style={h2}>New build</Text>
          <Field label="App name" value={form.name} onChangeText={(name) => setForm({ ...form, name })} placeholder="Expense tracker" />
          <Field label="What to build or change" value={form.spec} onChangeText={(spec) => setForm({ ...form, spec })} multiline style={{ minHeight: 110 }} placeholder="A web page to log expenses by category, with a monthly total" />
          <Row>
            <Switch value={form.cont} onValueChange={(cont) => setForm({ ...form, cont })} trackColor={{ true: c.accent, false: c.border }} />
            <Text style={{ color: c.text }}>Continue the last build of this app</Text>
          </Row>
          {!form.cont && <Field label="Folder on the hub (a git clone with a remote)" value={form.repo} onChangeText={(repo) => setForm({ ...form, repo })} autoCapitalize="none" placeholder="/home/roger/Desktop/expenses" />}
          <Row>
            <Muted small>Codes with</Muted>
            {(["claude", "codex"] as const).map((a) => (
              <Pressable key={a} onPress={() => setForm({ ...form, agent: a })} style={{ borderWidth: 1, borderRadius: 999, borderColor: form.agent === a ? c.accent : c.border, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: form.agent === a ? c.accent : c.text }}>{LABEL[a]}</Text>
              </Pressable>
            ))}
            <Muted small>the other one reviews</Muted>
          </Row>
          <Row>
            <Button kind="primary" title="Start" busy={busy === "start"} disabled={!form.name.trim() || !form.spec.trim() || (!form.cont && !form.repo.trim())} onPress={() => void start()} />
            <Button title="Cancel" onPress={() => setForm(undefined)} />
          </Row>
        </Card>
      )}

      {builds?.map((b) => (
        <Card key={b.id} attention={b.status === "ready"}>
          <Pressable onPress={() => setOpen(open === b.id ? undefined : b.id)} style={{ gap: 4 }}>
            <Row>
              <Text style={{ color: c.text, fontSize: 16, fontWeight: "600", flex: 1 }} numberOfLines={1}>{b.name}</Text>
              <Chip text={STATUS[b.status]} color={statusColor(c, b.status)} />
            </Row>
            <Muted small>{`${new Date(b.createdAt).toLocaleString()} · ${LABEL[b.agent] ?? b.agent} codes, ${LABEL[b.reviewer] ?? b.reviewer} reviews${b.continuedFrom ? " · continues an earlier build" : ""}`}</Muted>
          </Pressable>
          {open === b.id && (
            <View style={{ gap: 8 }}>
              <Text style={{ color: c.text }}>{b.spec}</Text>
              <Muted small>{b.repo}</Muted>
              {b.branches.map((br) => (
                <Text key={br.name} style={{ color: c.text, fontSize: 13 }}>
                  {`${br.name} · ${br.files} file(s) · tests ${br.tests}${br.merged ? " · merged" : ""}`}
                </Text>
              ))}
              {!!b.error && <ErrorText text={b.error} />}
              {b.notes?.map((n) => (
                <Text key={n} style={{ color: c.warn, fontSize: 13 }}>{`Did not run: ${n}`}</Text>
              ))}
              {!!b.mergeError && <ErrorText text={b.mergeError} />}
              {!!b.summary && <Muted small>{b.summary.slice(0, 1200)}</Muted>}
              {b.preview?.status === "building" && <Muted small>Making the preview…</Muted>}
              {b.preview?.status === "failed" && <ErrorText text={`Preview: ${b.preview.error}`} />}
              {b.preview?.status === "ready" && b.branches.length > 0 && (b.preview.audit ? <Muted small>{`Audit report:\n${b.preview.audit.slice(0, 1500)}`}</Muted> : <Text style={{ color: c.warn, fontSize: 13 }}>No audit report was written.</Text>)}
              <Row>
                {b.preview?.files?.map((f) => <Button key={f.name} kind="primary" small title={`Open ${f.name}`} onPress={() => void Linking.openURL(Api.hubUrl(f.url))} />)}
                {b.preview?.web && <Button kind="primary" small title="Open preview" onPress={() => void Linking.openURL(Api.hubUrl(b.preview!.web!))} />}
                {b.preview?.apk && <Button kind="primary" small title="Install APK" onPress={() => void Linking.openURL(Api.hubUrl(b.preview!.apk!))} />}
                {b.branches.length > 0 && b.status !== "merged" && b.preview?.status !== "building" && (
                  <Button small title={b.preview ? "Make preview again" : "Make preview"} busy={busy === `p${b.id}`} onPress={() => void act(`p${b.id}`, () => Api.previewBuild(b.id))} />
                )}
              </Row>
              <Row>
                {b.status === "ready" &&
                  (confirm === b.id ? (
                    <>
                      <Button kind="primary" small title="Yes, merge" busy={busy === `m${b.id}`} onPress={() => void act(`m${b.id}`, () => Api.mergeBuild(b.id))} />
                      <Button small title="Not yet" onPress={() => setConfirm(undefined)} />
                    </>
                  ) : (
                    <Button kind="primary" small title="Merge" onPress={() => setConfirm(b.id)} />
                  ))}
                {b.status === "running" && <Button kind="danger" small title="Stop" busy={busy === `c${b.id}`} onPress={() => void act(`c${b.id}`, () => Api.cancelBuild(b.id))} />}
              </Row>
              {confirm === b.id && <Muted small>{`Merges ${b.branches.filter((x) => !x.merged).length} branch(es) into the branch checked out in ${b.repo}. Conflicts stop the merge without changing anything.`}</Muted>}
            </View>
          )}
        </Card>
      ))}
      {builds && !builds.length && <Muted>No builds yet.</Muted>}
    </ScrollView>
  );
}
