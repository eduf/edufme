// Opt-in de notificações push — usado só em /notificacoes/.
// CSP do site exige JS externo ('self'); nada de inline.

const VAPID_PUBLIC_KEY = "BGNTDFbj-KIAtBigCnoq4jQHrJwQoA_WDOT7sLT77QZ_hOsdyPAwwHjj7w-hEEMxhgRAjVpPqHW4K7MW4sCSse4";

const btn = document.getElementById("push-toggle");
const status = document.getElementById("push-status");

function setStatus(text) {
  status.textContent = text;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function getSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function refreshUI() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    btn.hidden = true;
    setStatus("Seu navegador não suporta notificações push.");
    return;
  }
  if (Notification.permission === "denied") {
    btn.hidden = true;
    setStatus("Permissão negada. Para reativar, mude a permissão de notificações deste site nas configurações do navegador.");
    return;
  }
  const sub = await getSubscription();
  btn.hidden = false;
  if (sub) {
    btn.textContent = "Desativar notificações";
    setStatus("Notificações ativadas neste navegador.");
  } else {
    btn.textContent = "Ativar notificações";
    setStatus("Notificações desativadas.");
  }
}

async function subscribe() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    await refreshUI();
    return;
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });
  let res;
  try {
    res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub.toJSON())
    });
  } catch (e) {
    await sub.unsubscribe();
    throw new Error("Sem conexão com o servidor.");
  }
  if (!res.ok) {
    await sub.unsubscribe();
    throw new Error("Falha ao registrar no servidor.");
  }
}

async function unsubscribe() {
  const sub = await getSubscription();
  if (!sub) return;
  try {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint })
    });
  } catch (e) {
    // Ignora: endpoint órfão é limpo no servidor via 410 depois.
  }
  await sub.unsubscribe();
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  try {
    const sub = await getSubscription();
    if (sub) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  } catch (err) {
    setStatus("Algo deu errado: " + err.message);
  } finally {
    btn.disabled = false;
    await refreshUI();
  }
});

refreshUI().catch(() => setStatus("Não foi possível verificar o estado das notificações."));
