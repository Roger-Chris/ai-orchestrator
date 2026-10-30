import { router } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, Text } from "react-native";
import { Button, ErrorText, Field, Muted } from "../components/ui";
import { Api } from "../lib/api";
import { useColors } from "../lib/theme";

type Contact = { chatId: string; name: string; phone?: string };

/** Someone to give tasks to, picked from your WhatsApp chats so their replies keep the tasks up to date. */
export default function WorkAdd() {
  const c = useColors();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Contact[]>([]);
  const [picked, setPicked] = useState<Contact>();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (picked) return;
    const t = setTimeout(() => void Api.workContacts(q).then(setFound, (e) => setError((e as Error).message)), 250);
    return () => clearTimeout(t);
  }, [q, picked]);

  const save = async () => {
    setBusy(true);
    try {
      const p = await Api.addWorkPerson({ name: name.trim(), chatId: picked?.chatId || undefined, role: role.trim() || undefined });
      router.replace(`/work/${p.id}` as never);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
        {!picked ? (
          <>
            <Field label="Find them in WhatsApp" placeholder="Name or number" value={q} onChangeText={setQ} autoFocus />
            {found.map((ct) => (
              <Pressable
                key={ct.chatId}
                onPress={() => (setPicked(ct), setName(ct.name))}
                style={({ pressed }) => ({ paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.border, opacity: pressed ? 0.6 : 1 })}
              >
                <Text style={{ color: c.text, fontSize: 16 }}>{ct.name}</Text>
                <Muted small>{ct.phone ? `+${ct.phone}` : "WhatsApp chat"}</Muted>
              </Pressable>
            ))}
            {!found.length && q.length > 1 && <Muted>No WhatsApp chat matches. You can still add them without one.</Muted>}
            <Button title="Add without WhatsApp" onPress={() => (setPicked({ chatId: "", name: q.trim() }), setName(q.trim()))} />
            <ErrorText text={error} />
          </>
        ) : (
          <>
            <Muted>{picked.chatId ? `Linked to your WhatsApp chat${picked.phone ? ` with +${picked.phone}` : ""}: their replies update their tasks.` : "Not linked to WhatsApp: you update their tasks yourself."}</Muted>
            <Field label="Name" value={name} onChangeText={setName} />
            <Field label="Role (optional)" placeholder="intern, plumber, teammate…" value={role} onChangeText={setRole} />
            <ErrorText text={error} />
            <Button kind="primary" title="Add" busy={busy} disabled={!name.trim()} onPress={() => void save()} />
            <Button title="Pick someone else" onPress={() => setPicked(undefined)} />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
