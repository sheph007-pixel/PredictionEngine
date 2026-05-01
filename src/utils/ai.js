export async function claudeComplete(prompt) {
  const res = await fetch('/api/ai/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'AI request failed');
  }
  const data = await res.json();
  return data.text;
}

export async function claudeChat({ messages, system, tools, fileIds }) {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, system, tools, file_ids: fileIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'AI chat failed');
  }
  return res.json();
}

export async function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch('/api/files/upload', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'upload failed');
  }
  return res.json();
}

export async function classifyFile({ fileId, filename, buyers }) {
  const res = await fetch('/api/files/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: fileId,
      filename,
      buyer_names: buyers.map(b => ({ id: b.id, name: b.name })),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'classify failed');
  }
  return res.json();
}

export async function deleteFile(fileId) {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'delete failed');
  }
  return res.json();
}
