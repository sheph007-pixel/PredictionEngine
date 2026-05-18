// Server-state sync layer.
//
// Strategy: stale-while-revalidate.
//   1. App boots from localStorage instantly (no spinner, instant render).
//   2. In parallel, hydrate from /api/workspace.
//   3. If server returned newer data, replace state. Otherwise push local
//      to server so the device that booted wins.
//   4. Every state change → debounced PUT to server (write-through).
//
// Falls back to localStorage-only when DATABASE_URL is missing on the server
// (GET returns 503; we just keep using local).

const SYNC_DEBOUNCE_MS = 600;

export async function fetchWorkspace() {
  try {
    const res = await fetch('/api/workspace');
    if (res.status === 503) return { available: false };
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    return { available: true, ...data };
  } catch (err) {
    console.warn('fetchWorkspace failed:', err.message);
    return { available: false };
  }
}

export async function pushWorkspace(patch) {
  try {
    const res = await fetch('/api/workspace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.status === 503) return false;
    return res.ok;
  } catch (err) {
    console.warn('pushWorkspace failed:', err.message);
    return false;
  }
}

// Bulk replace. Only called on the initial-seed bootstrap path when the
// server is empty. Everyday writes go through patchBuyer/deleteBuyer.
export async function pushBuyers(buyers) {
  try {
    const res = await fetch('/api/buyers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyers }),
    });
    if (res.status === 503) return false;
    return res.ok;
  } catch (err) {
    console.warn('pushBuyers failed:', err.message);
    return false;
  }
}

// Upsert a single buyer. Server merges noteLog by union so stale clients
// can't drop notes they never saw.
export async function patchBuyer(buyer) {
  if (!buyer?.id) return false;
  try {
    const res = await fetch(`/api/buyers/${encodeURIComponent(buyer.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buyer),
    });
    if (res.status === 503) return false;
    return res.ok;
  } catch (err) {
    console.warn('patchBuyer failed:', err.message);
    return false;
  }
}

export async function deleteBuyer(id) {
  if (!id) return false;
  try {
    const res = await fetch(`/api/buyers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.status === 503) return false;
    return res.ok;
  } catch (err) {
    console.warn('deleteBuyer failed:', err.message);
    return false;
  }
}

// Server-side note deletion. The PATCH endpoint union-merges noteLog so it
// can't be used to drop notes — this route is the explicit deletion path.
export async function deleteNote(buyerId, noteId) {
  if (!buyerId || !noteId) return false;
  try {
    const res = await fetch(
      `/api/buyers/${encodeURIComponent(buyerId)}/notes/${encodeURIComponent(noteId)}`,
      { method: 'DELETE' }
    );
    if (res.status === 503) return false;
    return res.ok;
  } catch (err) {
    console.warn('deleteNote failed:', err.message);
    return false;
  }
}

export async function fetchRescans(limit = 25) {
  try {
    const res = await fetch(`/api/rescans?limit=${limit}`);
    if (res.status === 503) return { available: false, rescans: [] };
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    return { available: true, rescans: data.rescans || [] };
  } catch (err) {
    console.warn('fetchRescans failed:', err.message);
    return { available: false, rescans: [] };
  }
}

// Generic debouncer keyed by an identifier so workspace and buyers can
// debounce independently without canceling each other.
const timers = new Map();
export function debouncedPush(key, fn, ms = SYNC_DEBOUNCE_MS) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    fn();
  }, ms));
}

