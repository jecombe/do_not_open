import { useState } from "react";
import { api } from "../api";

export function Login({ onIn }: { onIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onIn();
    } catch (err) {
      setError(err instanceof Error && err.message.startsWith("Trop") ? err.message : "Mot de passe incorrect.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="stencil">DO NOT OPEN</div>
        <p>Espace équipe</p>
        <label>
          Mot de passe
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <button disabled={busy || !password}>{busy ? "…" : "Entrer"}</button>
      </form>
    </div>
  );
}
